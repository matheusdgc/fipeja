import { config } from './config.js';
import { prisma } from './database/client.js';
import { startWhatsApp, getSocket } from './whatsapp/connection.js';
import { logger, moduleLogger } from './utils/logger.js';

const log = moduleLogger('index');

async function main() {
  log.info({ botName: config.BOT_NAME }, 'Iniciando aplicacao');

  await prisma.$connect();
  log.info('Banco de dados conectado');

  await startWhatsApp();
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'Encerrando aplicacao');

  // Encerra o socket WhatsApp ANTES de desconectar Prisma — handlers em
  // andamento podem tentar gravar QueryLog. End() e idempotente em
  // Baileys e devolve a conexao limpa pro servidor WA.
  try {
    const sock = getSocket();
    if (sock) {
      sock.end(undefined);
    }
  } catch (err) {
    log.warn({ err }, 'Falha ao encerrar socket WhatsApp');
  }

  try {
    await prisma.$disconnect();
  } catch (err) {
    log.error({ err }, 'Falha ao desconectar Prisma');
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Sem isso, uma promise rejeitada em algum lugar do pipeline (ex: handler
// async assincrono) derrubaria o processo silenciosamente.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
  // Nao chamamos process.exit aqui: deixamos o orquestrador (docker) reiniciar.
});

main().catch((err) => {
  log.fatal({ err }, 'Erro fatal na inicializacao');
  process.exit(1);
});
