import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória não definida: ${name}`);
  }
  return value;
}

function parseCsvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  FIPE_API_BASE: process.env.FIPE_API_BASE || 'https://parallelum.com.br/fipe/api/v1',
  DATABASE_URL: process.env.DATABASE_URL || 'file:./fipeja.db',
  BOT_NAME: process.env.BOT_NAME || 'FipeJá',
  RATE_LIMIT_PER_MINUTE: parseIntEnv(process.env.RATE_LIMIT_PER_MINUTE, 30),

  // Allow-list de JIDs autorizados. Vazio = bot publico (default atual).
  // Ver src/whatsapp/auth.ts para formatos aceitos.
  ALLOWED_JIDS: parseCsvList(process.env.ALLOWED_JIDS),
  ALLOW_LIST_DENY_MESSAGE: process.env.ALLOW_LIST_DENY_MESSAGE || '',

  // Rate-limit por usuario (mensagens e PDFs separados).
  USER_RATE_LIMIT_MSG_PER_MIN: parseIntEnv(process.env.USER_RATE_LIMIT_MSG_PER_MIN, 30),
  USER_RATE_LIMIT_PDF_PER_HOUR: parseIntEnv(process.env.USER_RATE_LIMIT_PDF_PER_HOUR, 10),

  // Limite de tamanho de PDF aceito (bytes). WhatsApp pode entregar ate
  // ~100MB mas processar PDFs gigantes estoura RAM e custo OpenAI.
  PDF_MAX_BYTES: parseIntEnv(process.env.PDF_MAX_BYTES, 16 * 1024 * 1024),

  // Pepper opcional para hash de telefone em logs. Quando presente,
  // o phoneId vira HMAC-SHA256(pepper, phone), inviabilizando ataque
  // de dicionario sobre o range de numeros BR.
  PHONE_HASH_PEPPER: process.env.PHONE_HASH_PEPPER || '',
};
