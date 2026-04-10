import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória não definida: ${name}`);
  }
  return value;
}

export const config = {
  OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  FIPE_API_BASE: process.env.FIPE_API_BASE || 'https://parallelum.com.br/fipe/api/v1',
  DATABASE_URL: process.env.DATABASE_URL || 'file:./fipeja.db',
  BOT_NAME: process.env.BOT_NAME || 'FipeJá',
  RATE_LIMIT_PER_MINUTE: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '30', 10),
};
