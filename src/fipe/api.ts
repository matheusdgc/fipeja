import { config } from '../config.js';
import { RateLimiter } from '../utils/rate-limiter.js';

const rateLimiter = new RateLimiter(config.RATE_LIMIT_PER_MINUTE);

export interface Brand {
  nome: string;
  codigo: string;
}

export interface Model {
  nome: string;
  codigo: number;
}

export interface ModelsResponse {
  modelos: Model[];
  anos: YearCode[];
}

export interface YearCode {
  nome: string;
  codigo: string;
}

export interface FipePrice {
  Valor: string;
  Marca: string;
  Modelo: string;
  AnoModelo: number;
  Combustivel: string;
  CodigoFipe: string;
  MesReferencia: string;
  TipoVeiculo: number;
  SiglaCombustivel: string;
}

export type VehicleType = 'carros' | 'motos' | 'caminhoes';

async function fetchJson<T>(url: string): Promise<T> {
  await rateLimiter.acquire();

  // Timeout duro para evitar penduramento da consulta inteira quando a
  // API publica fica lenta. 15s e generoso mas razoavel para uma
  // chamada HTTP em background.
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!response.ok) {
    throw new Error(`FIPE API erro ${response.status}: ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

/** Lista todas as marcas de um tipo de veiculo */
export async function fetchBrands(type: VehicleType): Promise<Brand[]> {
  return fetchJson<Brand[]>(`${config.FIPE_API_BASE}/${type}/marcas`);
}

/** Lista modelos de uma marca */
export async function fetchModels(type: VehicleType, brandId: string): Promise<ModelsResponse> {
  return fetchJson<ModelsResponse>(`${config.FIPE_API_BASE}/${type}/marcas/${brandId}/modelos`);
}

/** Lista anos disponiveis para um modelo */
export async function fetchYears(type: VehicleType, brandId: string, modelId: number): Promise<YearCode[]> {
  return fetchJson<YearCode[]>(`${config.FIPE_API_BASE}/${type}/marcas/${brandId}/modelos/${modelId}/anos`);
}

/** Busca o preco FIPE de um veiculo especifico */
export async function fetchPrice(
  type: VehicleType,
  brandId: string,
  modelId: number,
  yearCode: string
): Promise<FipePrice> {
  return fetchJson<FipePrice>(
    `${config.FIPE_API_BASE}/${type}/marcas/${brandId}/modelos/${modelId}/anos/${yearCode}`
  );
}

/**
 * Schema do retorno da BrasilAPI para preco por codigo FIPE.
 * Diferente do schema do Parallelum (Valor, Marca em CamelCase): a
 * BrasilAPI usa camelCase com primeira letra minuscula.
 */
interface BrasilApiPrice {
  valor: string;
  marca: string;
  modelo: string;
  anoModelo: number;
  combustivel: string;
  codigoFipe: string;
  mesReferencia: string;
  tipoVeiculo?: number;
  siglaCombustivel?: string;
}

/** Converte resposta da BrasilAPI para o tipo FipePrice (Parallelum) */
function mapBrasilApiToFipePrice(p: BrasilApiPrice): FipePrice {
  return {
    Valor: p.valor,
    Marca: p.marca,
    Modelo: p.modelo,
    AnoModelo: p.anoModelo,
    Combustivel: p.combustivel,
    CodigoFipe: p.codigoFipe,
    MesReferencia: p.mesReferencia,
    TipoVeiculo: p.tipoVeiculo ?? 0,
    SiglaCombustivel: p.siglaCombustivel ?? '',
  };
}

/**
 * Busca preco direto pelo codigo FIPE (via BrasilAPI). Retorno ja
 * mapeado para o formato unificado FipePrice.
 */
export async function fetchPriceByFipeCode(fipeCode: string): Promise<FipePrice[]> {
  await rateLimiter.acquire();

  const response = await fetch(`https://brasilapi.com.br/api/fipe/preco/v1/${fipeCode}`, {
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`BrasilAPI erro ${response.status}: codigo FIPE nao encontrado`);
  }

  const raw = (await response.json()) as BrasilApiPrice[];
  return raw.map(mapBrasilApiToFipePrice);
}
