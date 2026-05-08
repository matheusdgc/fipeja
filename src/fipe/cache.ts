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
 * TTLs por tipo de dado:
 *
 *  - Marcas, modelos, anos: estaveis. 24h e generoso e poupa quotas.
 *  - Precos: a tabela FIPE atualiza mensalmente (entre dias 5 e 10).
 *    Nao podemos guardar preco antigo por mais de algumas horas no
 *    inicio do mes, do contrario consultor cota com numero defasado.
 *
 * Cobertura adicional: validamos `MesReferencia` na entrada de cache e
 * invalidamos quando muda — defesa em profundidade pra cobrir o caso
 * "FIPE atualizou mais cedo que o esperado".
 */
const TTL_HOURS = {
  STRUCTURE: 24, // marcas/modelos/anos
  PRICE: 1, // preco fipe
};

const CURRENT_MES_REF_KEY = '__current_mes_referencia__';

interface CacheEntry<T> {
  data: T;
  /** MesReferencia conhecido no momento do set. So preenchido para precos. */
  mesReferencia?: string;
}

/**
 * Busca dados no cache. Retorna null se nao encontrado, expirado, ou
 * (se aplicavel) com MesReferencia diferente do atual.
 */
export async function getFromCache<T>(
  key: string,
  expectedMesRef?: string
): Promise<T | null> {
  const entry = await prisma.fipeCache.findUnique({ where: { cacheKey: key } });
  if (!entry) return null;

  if (new Date() > entry.expiresAt) {
    await prisma.fipeCache.delete({ where: { cacheKey: key } }).catch(() => {});
    return null;
  }

  let parsed: CacheEntry<T>;
  try {
    parsed = JSON.parse(entry.data) as CacheEntry<T>;
  } catch (err) {
    log.warn({ err, key }, 'Cache corrompido; removendo entrada');
    await prisma.fipeCache.delete({ where: { cacheKey: key } }).catch(() => {});
    return null;
  }

  // Compatibilidade: entradas antigas (formato cru, sem `data`) — assume
  // que sao validas e devolve o conteudo.
  if (parsed && typeof parsed === 'object' && 'data' in parsed) {
    if (expectedMesRef && parsed.mesReferencia && parsed.mesReferencia !== expectedMesRef) {
      log.info(
        { key, was: parsed.mesReferencia, now: expectedMesRef },
        'Cache invalidado por mudanca de MesReferencia'
      );
      await prisma.fipeCache.delete({ where: { cacheKey: key } }).catch(() => {});
      return null;
    }
    return parsed.data;
  }

  // Formato legado (dado direto)
  return parsed as unknown as T;
}

/**
 * Salva dados no cache com TTL em horas. mesReferencia opcional para
 * dados de preco — invalida em mudanca da tabela FIPE.
 */
export async function setCache(
  key: string,
  data: unknown,
  ttlHours: number,
  mesReferencia?: string
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  const entry: CacheEntry<unknown> = mesReferencia
    ? { data, mesReferencia }
    : { data };

  const serialized = JSON.stringify(entry);
  await prisma.fipeCache.upsert({
    where: { cacheKey: key },
    update: { data: serialized, expiresAt },
    create: { cacheKey: key, data: serialized, expiresAt },
  });
}

// =============================================================================
// Helpers de alto nivel — encapsulam a logica de chave de cache, evitando que
// pdf-service e query-service repitam as mesmas strings (e cometam typos).
// =============================================================================

export async function getCachedBrands(type: VehicleType): Promise<Brand[]> {
  const key = `brands:${type}`;
  const cached = await getFromCache<Brand[]>(key);
  if (cached) return cached;

  const data = await fetchBrands(type);
  await setCache(key, data, TTL_HOURS.STRUCTURE);
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
  await setCache(key, data, TTL_HOURS.STRUCTURE);
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
  await setCache(key, data, TTL_HOURS.STRUCTURE);
  return data;
}

/**
 * Registra qual MesReferencia esta vigente. Quando vemos preco com
 * MesReferencia novo, atualizamos esta chave — usada para invalidar
 * outros caches de preco em batch.
 */
export async function getCurrentMesReferencia(): Promise<string | null> {
  const cached = await getFromCache<string>(CURRENT_MES_REF_KEY);
  return cached ?? null;
}

export async function setCurrentMesReferencia(mesRef: string): Promise<void> {
  await setCache(CURRENT_MES_REF_KEY, mesRef, 24 * 7); // sobrevive 1 semana
}
