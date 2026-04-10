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

const logger = pino({ level: 'silent' });

let sock: WASocket;
let waVersion: WAVersion | null = null;

export function getSocket(): WASocket {
  return sock;
}

async function getVersion(): Promise<WAVersion> {
  if (waVersion) return waVersion;

  try {
    console.log('Buscando versao do WhatsApp Web...');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Versao: ${version.join('.')} | isLatest: ${isLatest}`);
    waVersion = version;
    return version;
  } catch {
    console.log('Falha ao buscar versao remota. Usando versao local.');
    waVersion = [2, 3000, 1019707846];
    return waVersion;
  }
}

export async function startWhatsApp(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const version = await getVersion();

  sock = makeWASocket({
    auth: state,
    version,
    logger,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nEscaneie o QR code abaixo com o WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      console.log('Conexao fechada. statusCode:', statusCode, '| erro:', lastDisconnect?.error?.message);

      if (statusCode === DisconnectReason.loggedOut) {
        console.log('Sessao encerrada ou credenciais invalidas. Limpando sessao...');
        fs.rmSync('auth_info_baileys', { recursive: true, force: true });
        console.log('Reconectando para gerar novo QR...');
        setTimeout(() => startWhatsApp(), 3000);
        return;
      }

      console.log('Reconectando em 3 segundos...');
      setTimeout(() => startWhatsApp(), 3000);
    }

    if (connection === 'open') {
      console.log('WhatsApp conectado!');
    }
  });

  registerMessageHandler(sock);
}
