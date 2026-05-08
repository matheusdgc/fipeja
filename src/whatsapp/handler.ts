import { WASocket, WAMessage, downloadMediaMessage } from '@whiskeysockets/baileys';
import { handleTextQuery } from '../services/query-service.js';
import { handlePdfQuery } from '../services/pdf-service.js';
import { moduleLogger } from '../utils/logger.js';

const log = moduleLogger('whatsapp/handler');

// Estado de desambiguação: quando o bot pergunta "qual modelo?" e espera resposta numérica
interface PendingSelection {
  options: Array<{ name: string; brandId: string; modelId: number; vehicleType: string }>;
  year: number | null;
  createdAt: number;
}

const pendingSelections = new Map<string, PendingSelection>();

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

export function registerMessageHandler(sock: WASocket): void {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Ignora mensagens históricas (carregadas ao reconectar). Só processa novas.
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      // Aceita @s.whatsapp.net (formato antigo) e @lid (formato novo com LID anônimo)
      const jidOk = msg.key.remoteJid?.endsWith('@s.whatsapp.net') || msg.key.remoteJid?.endsWith('@lid');
      if (!jidOk) continue;

      try {
        await processMessage(sock, msg);
      } catch (err) {
        log.error(
          { err, jid: msg.key.remoteJid, msgId: msg.key.id },
          'Erro ao processar mensagem'
        );
        await sendText(sock, msg.key.remoteJid!, 'Ocorreu um erro interno. Tente novamente em alguns instantes.');
      }
    }
  });
}

async function processMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  const jid = msg.key.remoteJid!;
  const textContent = getTextContent(msg);
  const isDocument = msg.message?.documentMessage || msg.message?.documentWithCaptionMessage;

  // Texto
  if (textContent) {
    const text = textContent.trim();

    // Comandos
    if (text === '/ajuda' || text === '/help') {
      return sendText(sock, jid, HELP_MESSAGE);
    }

    if (GREETING_PATTERNS.test(text)) {
      return sendText(sock, jid, GREETING_MESSAGE);
    }

    // Verifica se é resposta de desambiguação (número)
    const pending = pendingSelections.get(jid);
    if (pending) {
      const num = parseInt(text, 10);
      if (num >= 1 && num <= pending.options.length) {
        pendingSelections.delete(jid);
        const selected = pending.options[num - 1];
        await sendText(sock, jid, '🔍 Buscando preço...');
        const result = await handleTextQuery(text, jid, {
          selectedBrandId: selected.brandId,
          selectedModelId: selected.modelId,
          selectedModelName: selected.name,
          vehicleType: selected.vehicleType,
          year: pending.year,
        });
        return sendText(sock, jid, result.message);
      } else {
        // Número inválido: limpar e tratar como nova consulta
        pendingSelections.delete(jid);
      }
    }

    // Consulta normal
    await sendText(sock, jid, 'Consultando tabela FIPE...');
    const result = await handleTextQuery(text, jid);

    // Verifica se o resultado é uma desambiguação
    if (result.disambiguation) {
      pendingSelections.set(jid, {
        options: result.disambiguation.options,
        year: result.disambiguation.year,
        createdAt: Date.now(),
      });
      return sendText(sock, jid, result.message);
    }

    return sendText(sock, jid, result.message);
  }

  // PDF
  if (isDocument) {
    const docMsg = msg.message?.documentMessage || msg.message?.documentWithCaptionMessage?.message?.documentMessage;
    if (docMsg?.mimetype === 'application/pdf') {
      await sendText(sock, jid, '📄 Processando PDF...');
      const buffer = await downloadMediaMessage(msg, 'buffer', {}) as Buffer;
      const result = await handlePdfQuery(buffer, jid);
      // Divide em mensagens se muito longo (WhatsApp limite ~65k chars)
      const chunks = splitMessage(result, 4000);
      for (const chunk of chunks) {
        await sendText(sock, jid, chunk);
      }
      return;
    }
  }

  // Tipo não suportado (imagem, áudio, etc.)
  if (msg.message && !textContent) {
    return sendText(sock, jid, UNSUPPORTED_MESSAGE);
  }
}

function getTextContent(msg: WAMessage): string | null {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    null
  );
}

async function sendText(sock: WASocket, jid: string, text: string): Promise<void> {
  await sock.sendMessage(jid, { text });
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Tenta quebrar na última quebra de linha antes do limite
    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trimStart();
  }

  return chunks;
}

// Limpa seleções pendentes a cada 5 minutos (evita vazamento de memória)
setInterval(() => {
  const now = Date.now();
  for (const [jid, pending] of pendingSelections) {
    if (now - pending.createdAt > 5 * 60 * 1000) {
      pendingSelections.delete(jid);
    }
  }
}, 5 * 60 * 1000);
