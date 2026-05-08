import {
  extractTextFromPdf,
  PDF_ERR_PROTECTED,
  PDF_ERR_CORRUPTED,
  PDF_ERR_SCANNED,
} from '../pdf/parser.js';
import { extractVehiclesFromPdf, VehicleFromPdf } from '../ai/openai.js';
import {
  fetchPrice,
  fetchPriceByFipeCode,
  VehicleType,
  FipePrice,
  Brand,
} from '../fipe/api.js';
import { findBrand } from '../fipe/search.js';
import {
  rankModels,
  detectFuel,
  isHighConfidence,
  ScoredModel,
  MatchableModel,
  Fuel,
} from '../fipe/match.js';
import {
  getCachedBrands,
  getCachedModels,
  getCachedYears,
} from '../fipe/cache.js';
import { formatBatchResults } from '../utils/formatter.js';
import { prisma } from '../database/client.js';
import { moduleLogger } from '../utils/logger.js';
import { phoneHash, redactPii, redactPiiDeep } from '../utils/privacy.js';

const log = moduleLogger('pdf-service');

const FIPE_CODE_REGEX = /^\d{6}-\d$/;

/**
 * Diagnostico estruturado de cada veiculo do lote. Sai junto com o
 * resultado e tambem e persistido em QueryLog.fipeResult, para que a
 * gente consiga depois explicar por que um modelo foi escolhido.
 */
interface VehicleMatchDiagnosis {
  vehicleName: string;
  ok: boolean;
  reason?: string;
  matchedBrand?: string;
  matchedModel?: string;
  matchedYear?: string;
  score?: number;
  confidence?: 'high' | 'low';
  /** Topo da lista de candidatos avaliados, para auditoria. */
  topCandidates?: Array<{ name: string; score: number }>;
  /** Combustivel inferido (LLM ou regex local). */
  fuel?: Fuel | null;
  /** Codigo FIPE do match final, se houver. */
  fipeCode?: string;
}

interface VehicleMatchResult {
  diagnosis: VehicleMatchDiagnosis;
  price: FipePrice | null;
}

/**
 * Concorrencia maxima ao resolver veiculos individuais (#17). 5
 * paralelos respeita o rate-limiter da FIPE com folga e reduz tempo
 * de resposta de PDFs grandes em 5x.
 */
const VEHICLE_RESOLVE_CONCURRENCY = 5;

/** Roda `worker` sobre `items` com no maximo `limit` em voo simultaneo. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runner(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    () => runner()
  );
  await Promise.all(runners);
  return results;
}

/**
 * Processa um PDF com lista de veiculos e retorna os precos FIPE.
 */
export async function handlePdfQuery(buffer: Buffer, phone: string): Promise<string> {
  const phoneId = phoneHash(phone);
  const startedAt = Date.now();

  try {
    // 1. Extrai texto do PDF
    const pdfText = await extractTextFromPdf(buffer);

    // 2. Usa IA para extrair lista de veiculos
    const extraction = await extractVehiclesFromPdf(pdfText);
    const { vehicles, truncated, originalChars } = extraction;

    if (vehicles.length === 0) {
      await logQuery(phoneId, 'pdf', '[PDF]', null, null, false, 'Nenhum veiculo encontrado');
      return 'Não encontrei nenhum veículo no PDF enviado.\n\nVerifique se o PDF contém informações de veículos (marca, modelo, ano).';
    }

    // 3. Resolve cada veiculo (em paralelo controlado #17)
    const results = await mapWithLimit(
      vehicles,
      VEHICLE_RESOLVE_CONCURRENCY,
      async (vehicle) => {
        const r = await resolveVehicle(vehicle);
        log.info(
          {
            phoneId,
            vehicle: r.diagnosis.vehicleName,
            ok: r.diagnosis.ok,
            score: r.diagnosis.score,
            confidence: r.diagnosis.confidence,
            matchedModel: r.diagnosis.matchedModel,
            fuel: r.diagnosis.fuel,
          },
          r.diagnosis.ok ? 'Veiculo resolvido' : 'Veiculo nao resolvido'
        );
        return r;
      }
    );

    // 4. Monta mensagem para o usuario
    const formatted = results.map((r) => ({
      vehicle: r.diagnosis.vehicleName,
      price: r.price ?? undefined,
      error: r.diagnosis.ok ? undefined : r.diagnosis.reason ?? 'Não encontrado',
    }));
    let message = formatBatchResults(formatted);

    // Se o PDF foi truncado (#16), avisamos antes do resultado.
    if (truncated) {
      message =
        `_PDF muito longo: processei os primeiros veiculos. Envie em partes para garantir que nada fique de fora (texto original: ${originalChars} chars)._\n\n` +
        message;
    }

    const successCount = results.filter((r) => r.price).length;
    const elapsedMs = Date.now() - startedAt;

    log.info(
      { phoneId, total: vehicles.length, found: successCount, elapsedMs, truncated },
      'Lote PDF processado'
    );

    await logQuery(
      phoneId,
      'pdf',
      `[PDF com ${vehicles.length} veiculos]`,
      vehicles,
      {
        total: vehicles.length,
        found: successCount,
        elapsedMs,
        truncated,
        diagnoses: results.map((r) => r.diagnosis),
      },
      successCount > 0
    );

    return message;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Erro desconhecido';
    log.error({ err, phoneId }, 'Erro ao processar PDF');
    await logQuery(phoneId, 'pdf', '[PDF]', null, null, false, errorMsg);

    // Erros tratados pelo parser ja vem com mensagem amigavel — passa
    // direto para o usuario.
    if (
      errorMsg === PDF_ERR_PROTECTED ||
      errorMsg === PDF_ERR_CORRUPTED ||
      errorMsg === PDF_ERR_SCANNED
    ) {
      return errorMsg;
    }

    return 'Erro ao processar o PDF. Tente novamente em alguns instantes.';
  }
}

/**
 * Tenta resolver um veiculo individual: primeiro pelo codigo FIPE
 * (caminho mais barato), depois pela cadeia marca > modelo (com
 * scoring) > ano > preco.
 */
async function resolveVehicle(vehicle: VehicleFromPdf): Promise<VehicleMatchResult> {
  const vehicleName = `${vehicle.brand} ${vehicle.model}${vehicle.year ? ` ${vehicle.year}` : ''}`;
  const baseDiagnosis: VehicleMatchDiagnosis = {
    vehicleName,
    ok: false,
    fuel: vehicle.fuel ?? detectFuel(vehicle.sourceText) ?? detectFuel(vehicle.model),
  };

  // 1. Tentar via codigo FIPE direto
  if (vehicle.fipeCode && FIPE_CODE_REGEX.test(vehicle.fipeCode)) {
    try {
      const prices = await fetchPriceByFipeCode(vehicle.fipeCode);
      if (prices.length > 0) {
        const p = prices[0];
        return {
          price: p,
          diagnosis: {
            ...baseDiagnosis,
            ok: true,
            matchedBrand: p.Marca,
            matchedModel: p.Modelo,
            matchedYear: String(p.AnoModelo),
            fipeCode: p.CodigoFipe,
            confidence: 'high',
          },
        };
      }
    } catch (err) {
      log.warn(
        { err, fipeCode: vehicle.fipeCode, vehicle: vehicleName },
        'Falha ao consultar por codigo FIPE; caira no fallback marca/modelo'
      );
    }
  }

  // 2. Cadeia marca > modelo > ano
  return resolveByBrandModel(vehicle, baseDiagnosis, vehicleName);
}

async function resolveByBrandModel(
  vehicle: VehicleFromPdf,
  baseDiagnosis: VehicleMatchDiagnosis,
  vehicleName: string
): Promise<VehicleMatchResult> {
  const type = vehicle.vehicleType as VehicleType;

  let brands: Brand[];
  try {
    brands = await getCachedBrands(type);
  } catch (err) {
    log.error({ err, type, vehicle: vehicleName }, 'Falha ao listar marcas');
    return {
      price: null,
      diagnosis: { ...baseDiagnosis, reason: 'Erro ao consultar marcas FIPE' },
    };
  }

  // Tenta a marca declarada e seus fallbacks (ex: Saab-Scania <-> Scania).
  const brandCandidates = [vehicle.brand, ...getBrandFallbacks(vehicle.brand)];

  for (const brandName of brandCandidates) {
    const brand = findBrand(brands, brandName);
    if (!brand) continue;

    let modelsResp;
    try {
      modelsResp = await getCachedModels(type, brand.codigo);
    } catch (err) {
      log.warn({ err, brand: brand.nome }, 'Falha ao listar modelos da marca');
      continue;
    }

    // Score! Aqui esta o coracao da melhoria de precisao.
    const fuel = baseDiagnosis.fuel ?? null;
    const ranked = rankModels(vehicle.model, modelsResp.modelos, {
      fuel,
      limit: 5,
      minScore: 0.3,
    });

    const topCandidates = ranked.slice(0, 3).map((r) => ({
      name: r.model.nome,
      score: Number(r.breakdown.total.toFixed(3)),
    }));

    if (ranked.length === 0) {
      log.debug(
        { brand: brand.nome, query: vehicle.model, vehicle: vehicleName },
        'Nenhum modelo passou no threshold de scoring'
      );
      continue;
    }

    // Para cada candidato, ve se existem anos disponiveis compativeis
    // com vehicle.year. Quem casar primeiro (na ordem de score) ganha.
    for (const scored of ranked) {
      const yearMatch = await findYearForCandidate(type, brand.codigo, scored, vehicle.year);
      if (!yearMatch) continue;

      try {
        const price = await fetchPrice(type, brand.codigo, scored.model.codigo, yearMatch.codigo);
        return {
          price,
          diagnosis: {
            ...baseDiagnosis,
            ok: true,
            matchedBrand: brand.nome,
            matchedModel: scored.model.nome,
            matchedYear: yearMatch.nome,
            score: Number(scored.breakdown.total.toFixed(3)),
            confidence: isHighConfidence(ranked) ? 'high' : 'low',
            topCandidates,
            fipeCode: price.CodigoFipe,
          },
        };
      } catch (err) {
        log.warn(
          { err, brand: brand.nome, model: scored.model.nome },
          'Falha ao buscar preco; tentando proximo candidato'
        );
      }
    }

    // Se chegou aqui, todos os top-K falharam para esta marca. Salva
    // diagnostico parcial e segue para fallback (proxima marca, se
    // houver).
    return {
      price: null,
      diagnosis: {
        ...baseDiagnosis,
        reason: 'Modelos encontrados mas nenhum com ano compativel',
        matchedBrand: brand.nome,
        topCandidates,
      },
    };
  }

  return {
    price: null,
    diagnosis: { ...baseDiagnosis, reason: 'Marca/modelo nao encontrado' },
  };
}

/**
 * Busca anos disponiveis para um candidato e devolve o que melhor
 * corresponde ao ano-alvo. Quando o ano nao foi informado, usa o mais
 * recente (excluindo "32000" que e 0km).
 */
async function findYearForCandidate(
  type: VehicleType,
  brandId: string,
  scored: ScoredModel<MatchableModel>,
  targetYear: number | null
) {
  let years;
  try {
    years = await getCachedYears(type, brandId, scored.model.codigo);
  } catch (err) {
    log.warn(
      { err, model: scored.model.nome },
      'Falha ao listar anos do modelo; descartando candidato'
    );
    return null;
  }

  // Filtra "32000" (0km) — geralmente nao e o que o usuario quer em
  // consulta de PDF de seguro.
  const usable = years.filter((y) => !y.codigo.startsWith('32000'));

  if (targetYear !== null) {
    const exact = usable.find((y) => y.nome.startsWith(String(targetYear)));
    if (exact) return exact;
    // Diferente do comportamento antigo (que forcava o mais recente),
    // aqui devolvemos null para que o proximo candidato em scoring
    // tenha chance. Isso melhora muito a precisao quando o ano-alvo
    // existe em outra variante do modelo.
    return null;
  }

  return usable[0] ?? null;
}

function getBrandFallbacks(brandName: string): string[] {
  const normalized = brandName.toLowerCase().replace(/-/g, ' ').trim();
  if (normalized.includes('saab') || normalized === 'saab scania') return ['Scania'];
  if (normalized === 'scania') return ['Saab-Scania'];
  return [];
}

async function logQuery(
  phone: string,
  queryType: string,
  userMessage: string,
  aiResult: unknown,
  fipeResult: unknown,
  success: boolean,
  errorMsg?: string
): Promise<void> {
  try {
    await prisma.queryLog.create({
      data: {
        phone,
        queryType,
        userMessage: redactPii(userMessage),
        aiResult: aiResult ? JSON.stringify(redactPiiDeep(aiResult)) : null,
        // fipeResult e dado da FIPE — nao contem PII do consultor.
        fipeResult: fipeResult ? JSON.stringify(fipeResult) : null,
        success,
        errorMsg: errorMsg ? redactPii(errorMsg) : null,
      },
    });
  } catch (err) {
    log.error({ err }, 'Erro ao salvar QueryLog');
  }
}
