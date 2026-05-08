import { prisma } from '../database/client.js';
import { moduleLogger } from '../utils/logger.js';
import {
  Brand,
  ModelsResponse,
  YearCode,
  VehicleType,
  fetchBrands,
  fetchModels,
  fetchYears,
} from './api.js';

const log = moduleLogger('fipe/cache');

/**
 * Busca dados no cache. Retorna null se nao encontrado ou expirado.
 */
export async function getFromCache<T>(key: string): Promise<T | null> {
  const entry = await prisma.fipeCache.findUnique({ where: { cacheKey: key } });
  if (!entry) return null;

  if (new Date() > entry.expiresAt) {
    await prisma.fipeCache.delete({ where: { cacheKey: key } });
    return null;
  }

  try {
    return JSON.parse(entry.data) as T;
  } catch (err) {
    // Cache corrompido nao pode derrubar a consulta. Apaga e segue
    // como cache miss.
    log.warn({ err, key }, 'Cache corrompido; removendo entrada');
    await prisma.fipeCache.delete({ where: { cacheKey: key } });
    return null;
  }
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

// =============================================================================
// Helpers de alto nivel — encapsulam a logica de chave de cache, evitando que
// pdf-service e query-service repitam as mesmas strings (e cometam typos).
// =============================================================================

const TTL_HOURS = 24;

export async function getCachedBrands(type: VehicleType): Promise<Brand[]> {
  const key = `brands:${type}`;
  const cached = await getFromCache<Brand[]>(key);
  if (cached) return cached;

  const data = await fetchBrands(type);
  await setCache(key, data, TTL_HOURS);
  return data;
}

export async function getCachedModels(
  type: VehicleType,
  brandId: string
): Promise<ModelsResponse> {
  const key = `models:${type}:${brandId}`;
  const cached = await getFromCache<ModelsResponse>(key);
  if (cached) return cached;

  const data = await fetchModels(type, brandId);
  await setCache(key, data, TTL_HOURS);
  return data;
}

export async function getCachedYears(
  type: VehicleType,
  brandId: string,
  modelId: number
): Promise<YearCode[]> {
  const key = `years:${type}:${brandId}:${modelId}`;
  const cached = await getFromCache<YearCode[]>(key);
  if (cached) return cached;

  const data = await fetchYears(type, brandId, modelId);
  await setCache(key, data, TTL_HOURS);
  return data;
}
