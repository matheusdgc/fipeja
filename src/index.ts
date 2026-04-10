import { config } from './config.js';
import { prisma } from './database/client.js';
import { startWhatsApp } from './whatsapp/connection.js';

async function main() {
  console.log(`${config.BOT_NAME} iniciando...`);

  await prisma.$connect();
  console.log('Banco de dados conectado');

  await startWhatsApp();
}

async function shutdown() {
  console.log('\nEncerrando...');
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
