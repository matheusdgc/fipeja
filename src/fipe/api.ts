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

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`FIPE API erro ${response.status}: ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

/** Lista todas as marcas de um tipo de veículo */
export async function fetchBrands(type: VehicleType): Promise<Brand[]> {
  return fetchJson<Brand[]>(`${config.FIPE_API_BASE}/${type}/marcas`);
}

/** Lista modelos de uma marca */
export async function fetchModels(type: VehicleType, brandId: string): Promise<ModelsResponse> {
  return fetchJson<ModelsResponse>(`${config.FIPE_API_BASE}/${type}/marcas/${brandId}/modelos`);
}

/** Lista anos disponíveis para um modelo */
export async function fetchYears(type: VehicleType, brandId: string, modelId: number): Promise<YearCode[]> {
  return fetchJson<YearCode[]>(`${config.FIPE_API_BASE}/${type}/marcas/${brandId}/modelos/${modelId}/anos`);
}

/** Busca o preço FIPE de um veículo específico */
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

/** Busca preço direto pelo código FIPE (via BrasilAPI) */
export async function fetchPriceByFipeCode(fipeCode: string): Promise<FipePrice[]> {
  await rateLimiter.acquire();

  const response = await fetch(`https://brasilapi.com.br/api/fipe/preco/v1/${fipeCode}`);

  if (!response.ok) {
    throw new Error(`BrasilAPI erro ${response.status}: código FIPE não encontrado`);
  }

  return response.json() as Promise<FipePrice[]>;
}
