import { WASocket, WAMessage, downloadMediaMessage } from '@whiskeysockets/baileys';
import { handleTextQuery } from '../services/query-service.js';
import { handlePdfQuery } from '../services/pdf-service.js';
import { moduleLogger } from '../utils/logger.js';
import { isJidAllowed, getDenyMessage } from './auth.js';
import { config } from '../config.js';
import {
  UserRateLimiter,
  formatRetryHint,
} from '../utils/user-rate-limiter.js';
import {
  setPending,
  getPending,
  clearPending,
  gcExpired,
} from './pending-selection.js';

const log = moduleLogger('whatsapp/handler');

const GREETING_PATTERNS = /^(oi|olá|ola|hey|hello|hi|bom dia|boa tarde|boa noite|e ai|eai)$/i;

const GREETING_MESSAGE = `Olá! Eu sou o *FipeJá* 🚗, seu assistente de consulta FIPE.

Envie o nome de um veículo para consultar o preço.
Exemplo: *Civic 2020* ou *Fiat Uno 2015*

Você também pode enviar um *PDF* com uma lista de veículos!

Digite */ajuda* para mais opções.`;

const HELP_MESSAGE = `*Comandos disponíveis:*

• Envie o nome de um veículo: _Corolla 2019_
• Envie um código FIPE: _014193-0_
• Envie um PDF com lista de veículos
• */ajuda* - Mostra esta mensagem`;

const UNSUPPORTED_MESSAGE = 'Desculpe, aceito apenas mensagens de texto ou PDFs.';

const PDF_TOO_BIG_MESSAGE =
  'Esse PDF e muito grande. Envie um arquivo de ate {MAX} MB ou divida em partes.';

const MEDIA_EXPIRED_MESSAGE =
  'Nao consegui baixar o PDF (mensagem antiga ou expirada). Envie o arquivo novamente, por favor.';

const PDF_LIMIT = ` (limite ${(config.PDF_MAX_BYTES / 1024 / 1024).toFixed(0)} MB)`;

/**
 * Tipos de mensagem que o WhatsApp entrega mas que NAO sao input do
 * usuario (reacoes a outras mensagens, edicoes, atualizacoes de
 * protocolo, enquetes etc.). Devem ser silenciosamente ignorados.
 */
const IGNORABLE_MESSAGE_KEYS = new Set([
  'reactionMessage',
  'editedMessage',
  'protocolMessage',
  'pollUpdateMessage',
  'pollCreationMessage',
  'pollCreationMessageV2',
  'pollCreationMessageV3',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
]);

function isIgnorableMessage(msg: WAMessage): boolean {
  const m = msg.message;
  if (!m) return true;

  const keys = Object.keys(m).filter(
    (k) => m[k as keyof typeof m] !== undefined && m[k as keyof typeof m] !== null
  );
  if (keys.length === 0) return true;

  return keys.every((k) => IGNORABLE_MESSAGE_KEYS.has(k));
}

// ---------------------------------------------------------------------------
// Lock de processamento por JID (#2): evita corrida quando consultor manda
// duas mensagens em sequencia. Cada JID tem uma "fila" de uma promessa em
// voo: a proxima mensagem espera a anterior terminar antes de comecar.
// ---------------------------------------------------------------------------
const inflightByJid = new Map<string, Promise<void>>();

function enqueuePerJid(jid: string, work: () => Promise<void>): Promise<void> {
  const previous = inflightByJid.get(jid) ?? Promise.resolve();
  const next = previous
    .catch(() => {
      /* erros do anterior nao devem bloquear o seguinte */
    })
    .then(work);

  inflightByJid.set(jid, next);

  // Quando esta promessa terminar, remove do mapa SE ninguem encadeou
  // depois (do contrario o ultimo elo ja sobrescreveu o entry).
  next.finally(() => {
    if (inflightByJid.get(jid) === next) {
      inflightByJid.delete(jid);
    }
  });

  return next;
}

// ---------------------------------------------------------------------------
// Rate-limiters por usuario (#12)
// ---------------------------------------------------------------------------
const messageLimiter = new UserRateLimiter(
  config.USER_RATE_LIMIT_MSG_PER_MIN,
  60_000,
  'msg'
);
const pdfLimiter = new UserRateLimiter(
  config.USER_RATE_LIMIT_PDF_PER_HOUR,
  60 * 60_000,
  'pdf'
);

export function registerMessageHandler(sock: WASocket): void {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Ignora mensagens históricas (carregadas ao reconectar). Só processa novas.
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      // Aceita @s.whatsapp.net (formato antigo) e @lid (formato novo com LID anônimo)
      const jidOk =
        msg.key.remoteJid?.endsWith('@s.whatsapp.net') ||
        msg.key.remoteJid?.endsWith('@lid');
      if (!jidOk) continue;

      // Reacoes, edicoes e mensagens de protocolo nao devem gerar resposta.
      if (isIgnorableMessage(msg)) {
        log.debug(
          { jid: msg.key.remoteJid, msgId: msg.key.id },
          'Mensagem ignoravel descartada'
        );
        continue;
      }

      // Allow-list (desabilitada por default).
      if (!isJidAllowed(msg.key.remoteJid!)) {
        const denyMsg = getDenyMessage();
        log.info({ jid: msg.key.remoteJid }, 'JID nao autorizado bloqueado');
        if (denyMsg) {
          await sendText(sock, msg.key.remoteJid!, denyMsg).catch(() => {});
        }
        continue;
      }

      const jid = msg.key.remoteJid!;
      // Serializa por JID — mensagens do mesmo usuario nao processam em
      // paralelo. Permite paralelismo entre usuarios diferentes.
      enqueuePerJid(jid, async () => {
        try {
          await processMessage(sock, msg);
        } catch (err) {
          log.error(
            { err, jid, msgId: msg.key.id },
            'Erro ao processar mensagem'
          );
          await sendText(
            sock,
            jid,
            'Ocorreu um erro interno. Tente novamente em alguns instantes.'
          ).catch(() => {});
        }
      });
    }
  });
}

async function processMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  const jid = msg.key.remoteJid!;
  const textContent = getTextContent(msg);
  const isDocument =
    msg.message?.documentMessage || msg.message?.documentWithCaptionMessage;

  // Texto
  if (textContent) {
    return handleText(sock, jid, textContent.trim());
  }

  // PDF
  if (isDocument) {
    return handlePdf(sock, jid, msg);
  }

  // Tipo não suportado (imagem, áudio, etc.) — so responde se o
  // payload tiver algum conteudo "real" (ja filtramos ignoraveis).
  if (msg.message) {
    return sendText(sock, jid, UNSUPPORTED_MESSAGE);
  }
}

async function handleText(
  sock: WASocket,
  jid: string,
  text: string
): Promise<void> {
  // Rate-limit por usuario para mensagens de texto.
  const rl = messageLimiter.check(jid);
  if (!rl.allowed) {
    return sendText(
      sock,
      jid,
      `Voce esta enviando mensagens muito rapido. Tente de novo em ${formatRetryHint(rl.retryAt!)}.`
    );
  }

  // Comandos
  if (text === '/ajuda' || text === '/help') {
    return sendText(sock, jid, HELP_MESSAGE);
  }

  if (GREETING_PATTERNS.test(text)) {
    return sendText(sock, jid, GREETING_MESSAGE);
  }

  // Resposta de desambiguacao (numero)?
  const pending = await getPending(jid);
  if (pending) {
    const num = parseInt(text, 10);
    if (Number.isFinite(num) && num >= 1 && num <= pending.options.length) {
      const selected = pending.options[num - 1];
      await sendText(sock, jid, '🔍 Buscando preço...');
      const result = await handleTextQuery(pending.originalQuery, jid, {
        selectedBrandId: selected.brandId,
        selectedModelId: selected.modelId,
        selectedModelName: selected.name,
        vehicleType: selected.vehicleType,
        year: pending.year,
      });
      // Limpa apos sucesso para nao perder estado se houve falha de envio
      // intermitente (usuario pode tentar repetir o numero).
      await clearPending(jid);
      const chunks = splitMessage(result.message, 4000);
      for (const c of chunks) await sendText(sock, jid, c);
      return;
    } else {
      // Numero invalido: limpa e trata como nova consulta
      await clearPending(jid);
    }
  }

  // Consulta normal — feedback "Consultando..." e enviado pelo
  // query-service apos a classificacao. Aqui so chamamos o service.
  const result = await handleTextQuery(text, jid, undefined, {
    sendProgress: (msg2) => sendText(sock, jid, msg2).catch(() => {}),
  });

  if (result.disambiguation) {
    await setPending(jid, {
      options: result.disambiguation.options,
      year: result.disambiguation.year,
      originalQuery: text,
    });
    return sendText(sock, jid, result.message);
  }

  const chunks = splitMessage(result.message, 4000);
  for (const c of chunks) await sendText(sock, jid, c);
}

async function handlePdf(
  sock: WASocket,
  jid: string,
  msg: WAMessage
): Promise<void> {
  // Rate-limit dedicado para PDFs (custo OpenAI maior).
  const rl = pdfLimiter.check(jid);
  if (!rl.allowed) {
    return sendText(
      sock,
      jid,
      `Limite de PDFs atingido. Tente novamente em ${formatRetryHint(rl.retryAt!)}.`
    );
  }

  const docMsg =
    msg.message?.documentMessage ||
    msg.message?.documentWithCaptionMessage?.message?.documentMessage;
  if (docMsg?.mimetype !== 'application/pdf') {
    return sendText(sock, jid, UNSUPPORTED_MESSAGE);
  }

  // Validacao de tamanho ANTES de baixar — protege RAM e custo OpenAI.
  const fileLength = docMsg.fileLength
    ? Number(docMsg.fileLength)
    : null;
  if (fileLength !== null && fileLength > config.PDF_MAX_BYTES) {
    log.warn(
      { jid, fileLength, max: config.PDF_MAX_BYTES },
      'PDF excede tamanho maximo'
    );
    return sendText(
      sock,
      jid,
      PDF_TOO_BIG_MESSAGE.replace(
        '{MAX}',
        (config.PDF_MAX_BYTES / 1024 / 1024).toFixed(0)
      ) + PDF_LIMIT
    );
  }

  await sendText(sock, jid, '📄 Processando PDF...');

  let buffer: Buffer;
  try {
    buffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
  } catch (err) {
    log.warn(
      { err, jid, msgId: msg.key.id },
      'Falha ao baixar midia PDF (provavelmente expirada)'
    );
    return sendText(sock, jid, MEDIA_EXPIRED_MESSAGE);
  }

  // Defensivo: alguns clientes nao informam fileLength, conferimos
  // depois do download tambem.
  if (buffer.byteLength > config.PDF_MAX_BYTES) {
    log.warn(
      { jid, byteLength: buffer.byteLength, max: config.PDF_MAX_BYTES },
      'PDF baixado excede tamanho maximo'
    );
    return sendText(
      sock,
      jid,
      PDF_TOO_BIG_MESSAGE.replace(
        '{MAX}',
        (config.PDF_MAX_BYTES / 1024 / 1024).toFixed(0)
      ) + PDF_LIMIT
    );
  }

  const result = await handlePdfQuery(buffer, jid);
  const chunks = splitMessage(result, 4000);
  for (const chunk of chunks) {
    await sendText(sock, jid, chunk);
  }
}

function getTextContent(msg: WAMessage): string | null {
  return (
    msg.message?.conversation || msg.message?.extendedTextMessage?.text || null
  );
}

async function sendText(
  sock: WASocket,
  jid: string,
  text: string
): Promise<void> {
  await sock.sendMessage(jid, { text });
}

/**
 * Quebra mensagem em chunks <= maxLength, preservando markdown bold do
 * WhatsApp (`*texto*`) e evitando cortar palavras.
 *
 * Estrategia em ordem de preferencia:
 *   1. Quebrar em duas linhas em branco (separador de "blocos").
 *   2. Quebrar em uma quebra de linha.
 *   3. Quebrar em ". " (fim de sentenca).
 *   4. Quebrar em espaco.
 *   5. Cortar cego no maxLength (so se nao houver espaco util).
 *
 * Apos cada corte, contamos asteriscos no chunk para detectar bold
 * desbalanceado (numero impar de `*`); se desbalanceado, fechamos o
 * chunk e abrimos o proximo com `*` para preservar o estilo.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  // Pequena heuristica de minimo razoavel para nao colar tudo no fim
  // do chunk. 60% do maxLength.
  const minTail = Math.floor(maxLength * 0.6);

  while (remaining.length > maxLength) {
    let splitIndex = -1;

    const tryFind = (needle: string): number => {
      const idx = remaining.lastIndexOf(needle, maxLength);
      return idx >= minTail ? idx + needle.length : -1;
    };

    splitIndex = tryFind('\n\n');
    if (splitIndex === -1) splitIndex = tryFind('\n');
    if (splitIndex === -1) splitIndex = tryFind('. ');
    if (splitIndex === -1) splitIndex = tryFind(' ');
    if (splitIndex === -1) splitIndex = maxLength;

    let chunk = remaining.substring(0, splitIndex);

    // Bold (`*...*`) desbalanceado: fecha aqui e abre no proximo
    // para nao quebrar a renderizacao do WhatsApp.
    const stars = (chunk.match(/\*/g) ?? []).length;
    let prefixNext = '';
    if (stars % 2 === 1) {
      chunk = chunk + '*';
      prefixNext = '*';
    }

    chunks.push(chunk);
    remaining = prefixNext + remaining.substring(splitIndex).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);

  return chunks;
}

// GC de PendingSelections expiradas a cada 5 min.
setInterval(() => {
  void gcExpired();
}, 5 * 60 * 1000).unref();

// Exports para teste.
export const _internal = {
  splitMessage,
  isIgnorableMessage,
};
