import pino, { Logger, LoggerOptions } from 'pino';

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
  // Redaciona campos sensíveis em qualquer profundidade. Adicione novos
  // caminhos aqui se um dia o pipeline propagar tokens/segredos.
  redact: {
    paths: ['*.apiKey', '*.OPENAI_API_KEY', 'headers.authorization'],
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
