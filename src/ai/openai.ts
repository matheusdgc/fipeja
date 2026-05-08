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
//
// Timeout/retry explicitos: o default do SDK openai-node e 600s (10min).
// Se a OpenAI fica lenta, o handler do WhatsApp prende a mensagem do
// usuario por minutos sem feedback. 30s + 2 retries cobre lentidao
// transitoria sem deixar o bot pendurado.
let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      timeout: 30_000,
      maxRetries: 2,
    });
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
 * Limite de chars enviados pra OpenAI. 50k chars ~ 12.5k tokens, mais
 * do que suficiente pra uma apolice tipica. Acima disso protegemos
 * custo (PDFs de 500 paginas existem).
 */
export const PDF_TEXT_CHAR_LIMIT = 50_000;

export interface PdfExtractionResult {
  vehicles: VehicleFromPdf[];
  /** True se o texto enviado pra OpenAI foi cortado por causa do limite. */
  truncated: boolean;
  /** Tamanho original em chars (uso de log/UX). */
  originalChars: number;
}

/**
 * Extrai lista de veículos a partir do texto de um PDF.
 *
 * Quando o PDF excede PDF_TEXT_CHAR_LIMIT, o texto e truncado e
 * sinalizamos via `truncated: true` para que o handler avise o
 * consultor — do contrario, veiculos no fim do PDF "somem"
 * silenciosamente.
 */
export async function extractVehiclesFromPdf(
  pdfText: string
): Promise<PdfExtractionResult> {
  const truncated = pdfText.length > PDF_TEXT_CHAR_LIMIT;
  const trimmedText = truncated
    ? pdfText.slice(0, PDF_TEXT_CHAR_LIMIT)
    : pdfText;

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
    {
      rawCount: rawList.length,
      sanitizedCount: sanitized.length,
      originalChars: pdfText.length,
      truncated,
    },
    'Veiculos extraidos do PDF'
  );

  return { vehicles: sanitized, truncated, originalChars: pdfText.length };
}
