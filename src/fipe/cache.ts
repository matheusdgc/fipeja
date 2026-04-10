import { prisma } from '../database/client.js';

/**
 * Busca dados no cache. Retorna null se não encontrado ou expirado.
 */
export async function getFromCache<T>(key: string): Promise<T | null> {
  const entry = await prisma.fipeCache.findUnique({ where: { cacheKey: key } });

  if (!entry) return null;

  if (new Date() > entry.expiresAt) {
    await prisma.fipeCache.delete({ where: { cacheKey: key } });
    return null;
  }

  return JSON.parse(entry.data) as T;
}

/**
 * Salva dados no cache com TTL em horas.
 */
export async function setCache(key: string, data: unknown, ttlHours: number): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  await prisma.fipeCache.upsert({
    where: { cacheKey: key },
    update: { data: JSON.stringify(data), expiresAt },
    create: { cacheKey: key, data: JSON.stringify(data), expiresAt },
  });
}
