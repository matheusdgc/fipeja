import pino, { Logger, LoggerOptions } from 'pino';
import fs from 'fs';
import path from 'path';

/**
 * Logger raiz do projeto.
 *
 * - Em produção (NODE_ENV=production) emite JSON estruturado, ideal
 *   para ingestão em ferramentas de observabilidade (grep, Datadog,
 *   Loki, etc.).
 * - Em desenvolvimento usa o transport `pino-pretty` para imprimir
 *   linhas legíveis e coloridas, que facilitam a leitura no terminal.
 *
 * Uso recomendado nos módulos:
 *
 *   import { logger } from '../utils/logger.js';
 *   const log = logger.child({ module: 'pdf-service' });
 *   log.info({ phoneHash, vehicleCount }, 'PDF processado');
 *
 * Convenção: o primeiro argumento é o objeto com contexto estruturado;
 * o segundo é a mensagem humana. Nunca use template-literals com dados
 * embutidos — o pino indexa muito melhor quando os dados ficam fora da
 * mensagem.
 */

const isProduction = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

const baseOptions: LoggerOptions = {
  level,
  base: { app: 'fipeja' },
  // Garante chave 'time' em milissegundos (default do pino) e formata
  // o nível como string ("info", "warn", ...) em vez do número.
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  // Redaciona campos sensíveis em qualquer profundidade. Sintaxe do
  // pino-redact: `*` cobre 1 nivel, mas precisamos de wildcards
  // explicitos para multiplos niveis. Listamos os caminhos conhecidos
  // do projeto + alguns globais.
  redact: {
    paths: [
      'apiKey',
      '*.apiKey',
      '*.*.apiKey',
      'OPENAI_API_KEY',
      '*.OPENAI_API_KEY',
      'PHONE_HASH_PEPPER',
      '*.PHONE_HASH_PEPPER',
      'authorization',
      'headers.authorization',
      'headers.cookie',
      'config.OPENAI_API_KEY',
      'config.PHONE_HASH_PEPPER',
    ],
    censor: '[REDACTED]',
  },
};

const transport = isProduction
  ? undefined
  : {
      target: 'pino-pretty',
      options: {
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,app',
        singleLine: false,
        colorize: true,
      },
    };

export const logger: Logger = pino({
  ...baseOptions,
  ...(transport ? { transport } : {}),
});

/**
 * Atalho para criar um logger filho com o nome do módulo já injetado.
 * Equivalente a `logger.child({ module })`, mas com tipo explícito.
 */
export function moduleLogger(moduleName: string): Logger {
  return logger.child({ module: moduleName });
}

/**
 * Heartbeat em disco para o healthcheck do container conferir que o
 * processo nao travou. Atualizado periodicamente assim que o modulo e
 * carregado. Path configuravel via HEARTBEAT_PATH (default
 * /app/data/heartbeat em prod, ./data/heartbeat fora).
 */
const HEARTBEAT_PATH =
  process.env.HEARTBEAT_PATH ||
  (isProduction ? '/app/data/heartbeat' : path.resolve(process.cwd(), 'data', 'heartbeat'));

function touchHeartbeat(): void {
  try {
    fs.mkdirSync(path.dirname(HEARTBEAT_PATH), { recursive: true });
    fs.writeFileSync(HEARTBEAT_PATH, String(Date.now()));
  } catch (err) {
    // Heartbeat falhar nao deve derrubar o app — apenas degrada o
    // healthcheck. Log uma vez por hora pra nao spammar.
    logger.warn({ err, path: HEARTBEAT_PATH }, 'Falha ao atualizar heartbeat');
  }
}

// Atualiza imediatamente e a cada 30s. unref() para nao impedir o
// shutdown do processo.
touchHeartbeat();
setInterval(touchHeartbeat, 30_000).unref();
