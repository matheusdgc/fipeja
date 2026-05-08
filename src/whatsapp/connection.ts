import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
  WAVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import { registerMessageHandler } from './handler.js';
import { moduleLogger } from '../utils/logger.js';

const log = moduleLogger('whatsapp/connection');

// O Baileys aceita um logger pino interno separado. Mantemos silencioso
// por padrao para nao poluir o terminal, mas e configuravel via env.
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });

let sock: WASocket;
let waVersion: WAVersion | null = null;
let reconnectAttempts = 0;

export function getSocket(): WASocket {
  return sock;
}

async function getVersion(): Promise<WAVersion> {
  if (waVersion) return waVersion;

  try {
    log.info('Buscando versao do WhatsApp Web');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    log.info({ version: version.join('.'), isLatest }, 'Versao Baileys obtida');
    waVersion = version;
    return version;
  } catch (err) {
    log.warn({ err }, 'Falha ao buscar versao remota; usando fallback local');
    waVersion = [2, 3000, 1019707846];
    return waVersion;
  }
}

/**
 * Calcula o atraso para a proxima tentativa de reconexao usando backoff
 * exponencial com teto de 60 segundos. Evita martelar o servidor quando
 * o WhatsApp Web esta instavel.
 */
function nextBackoffMs(attempt: number): number {
  const base = 3000; // 3s
  const cap = 60_000; // 60s
  return Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
}

export async function startWhatsApp(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const version = await getVersion();

  sock = makeWASocket({
    auth: state,
    version,
    logger: baileysLogger,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // O QR-code precisa ser visivel ao usuario, mantemos no stdout
      // direto (nao queremos JSON aqui, e um desenho ASCII).
      process.stdout.write('\nEscaneie o QR code abaixo com o WhatsApp:\n\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      log.warn(
        { statusCode, reason: lastDisconnect?.error?.message },
        'Conexao WhatsApp fechada'
      );

      if (statusCode === DisconnectReason.loggedOut) {
        log.warn('Sessao invalida; limpando credenciais e gerando novo QR');
        try {
          fs.rmSync('auth_info_baileys', { recursive: true, force: true });
        } catch (err) {
          log.error({ err }, 'Falha ao limpar diretorio auth_info_baileys');
        }
        reconnectAttempts = 0;
        setTimeout(() => startWhatsApp(), 3000);
        return;
      }

      reconnectAttempts += 1;
      const delay = nextBackoffMs(reconnectAttempts);
      log.info({ attempt: reconnectAttempts, delayMs: delay }, 'Reconectando');
      setTimeout(() => startWhatsApp(), delay);
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      log.info('WhatsApp conectado');
    }
  });

  registerMessageHandler(sock);
}
