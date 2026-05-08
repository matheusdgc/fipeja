import OpenAI from 'openai';
import { config } from '../config.js';
import { VEHICLE_QUERY_PROMPT, PDF_EXTRACTION_PROMPT } from './prompts.js';
import { moduleLogger } from '../utils/logger.js';
import type { Fuel } from '../fipe/match.js';

const log = moduleLogger('ai/openai');

// Lazy init: nao instanciamos o cliente no top-level para que importar
// este modulo em testes nao explodir caso a OPENAI_API_KEY nao esteja
// presente. Tambem evitamos vazar a chave em logs ja que ela so e
// usada quando o cliente e realmente requisitado.
let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }
  return _client;
}

export interface VehicleInterpretation {
  brand: string | null;
  model: string | null;
  year: number | null;
  vehicleType: 'carros' | 'motos' | 'caminhoes';
  fipeCode: string | null;
  isVehicleQuery: boolean;
}

export interface VehicleFromPdf {
  brand: string;
  model: string;
  year: number | null;
  vehicleType: 'carros' | 'motos' | 'caminhoes';
  fipeCode: string | null;
  /** Combustivel inferido pelo LLM. Pode ser null. */
  fuel: Fuel | null;
  /** Trecho literal extraido da linha original do PDF, util para auditoria. */
  sourceText: string | null;
}

const VEHICLE_TYPES = new Set(['carros', 'motos', 'caminhoes']);
const FUEL_VALUES = new Set<Fuel>([
  'flex',
  'gasoline',
  'diesel',
  'ethanol',
  'electric',
  'hybrid',
]);

/**
 * Faz parse seguro do JSON retornado pela OpenAI. Como usamos
 * response_format: json_object, o conteudo deveria sempre ser JSON
 * valido — mas em casos raros (response truncada, error mode), pode
 * vir lixo. Uma falha de parse derruba a conversa inteira.
 */
function safeParse<T>(content: string | null, fallback: T): T {
  if (!content) {
    log.warn('OpenAI retornou content nulo');
    return fallback;
  }
  try {
    return JSON.parse(content) as T;
  } catch (err) {
    log.warn({ err, snippet: content.slice(0, 200) }, 'Falha ao parsear JSON da OpenAI');
    return fallback;
  }
}

/**
 * Sanitiza um veiculo extraido pelo LLM. Garante:
 *  - vehicleType e um dos tres valores aceitos (default "carros");
 *  - fuel e um dos seis valores conhecidos ou null;
 *  - sourceText e string ou null;
 *  - year e numero plausivel ou null.
 */
function sanitizeVehicle(raw: unknown): VehicleFromPdf | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const brand = typeof r.brand === 'string' ? r.brand.trim() : '';
  const model = typeof r.model === 'string' ? r.model.trim() : '';
  if (!brand || !model) return null;

  let vehicleType: VehicleFromPdf['vehicleType'] = 'carros';
  if (typeof r.vehicleType === 'string' && VEHICLE_TYPES.has(r.vehicleType)) {
    vehicleType = r.vehicleType as VehicleFromPdf['vehicleType'];
  }

  let year: number | null = null;
  if (typeof r.year === 'number' && r.year >= 1900 && r.year <= 2100) {
    year = Math.floor(r.year);
  }

  let fipeCode: string | null = null;
  if (typeof r.fipeCode === 'string' && /^\d{6}-\d$/.test(r.fipeCode)) {
    fipeCode = r.fipeCode;
  }

  let fuel: Fuel | null = null;
  if (typeof r.fuel === 'string' && FUEL_VALUES.has(r.fuel as Fuel)) {
    fuel = r.fuel as Fuel;
  }

  const sourceText = typeof r.sourceText === 'string' ? r.sourceText : null;

  return { brand, model, year, vehicleType, fipeCode, fuel, sourceText };
}

/**
 * Interpreta uma mensagem de texto do usuário e extrai informações do veículo.
 */
export async function interpretVehicleQuery(userMessage: string): Promise<VehicleInterpretation> {
  const response = await getClient().chat.completions.create({
    model: config.OPENAI_MODEL,
    messages: [
      { role: 'system', content: VEHICLE_QUERY_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  const fallback: VehicleInterpretation = {
    brand: null,
    model: null,
    year: null,
    vehicleType: 'carros',
    fipeCode: null,
    isVehicleQuery: false,
  };
  return safeParse<VehicleInterpretation>(
    response.choices[0].message.content,
    fallback
  );
}

/**
 * Extrai lista de veículos a partir do texto de um PDF.
 */
export async function extractVehiclesFromPdf(pdfText: string): Promise<VehicleFromPdf[]> {
  // Limita tamanho do prompt para evitar custo absurdo com PDFs gigantes.
  // 50k chars ~ 12.5k tokens, mais do que suficiente para uma apolice.
  const trimmedText = pdfText.length > 50_000 ? pdfText.slice(0, 50_000) : pdfText;

  const response = await getClient().chat.completions.create({
    model: config.OPENAI_MODEL,
    messages: [
      { role: 'system', content: PDF_EXTRACTION_PROMPT },
      { role: 'user', content: trimmedText },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  const parsed = safeParse<{ vehicles?: unknown[] }>(
    response.choices[0].message.content,
    { vehicles: [] }
  );

  const rawList = Array.isArray(parsed.vehicles) ? parsed.vehicles : [];
  const sanitized = rawList
    .map(sanitizeVehicle)
    .filter((v): v is VehicleFromPdf => v !== null);

  log.info(
    { rawCount: rawList.length, sanitizedCount: sanitized.length },
    'Veiculos extraidos do PDF'
  );

  return sanitized;
}
