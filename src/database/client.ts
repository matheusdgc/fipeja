import { PrismaClient } from '@prisma/client';

/**
 * Em prod ficamos calados (so warn/error). Em dev mostramos query
 * pra ajudar debug local — Prisma loga as queries SQL emitidas.
 *
 * Cuidado: em prod, queries com filtros sensiveis (numero do consultor,
 * userMessage) NAO sao logadas. Se precisar debug em prod, usar
 * variavel DEBUG_PRISMA=1 que ativa o nivel "info".
 */
const isProduction = process.env.NODE_ENV === 'production';
const debugPrisma = process.env.DEBUG_PRISMA === '1';

export const prisma = new PrismaClient({
  log: isProduction
    ? debugPrisma
      ? ['warn', 'error', 'info']
      : ['warn', 'error']
    : ['query', 'warn', 'error'],
});
