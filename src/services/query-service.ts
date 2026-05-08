import { interpretVehicleQuery, VehicleInterpretation } from '../ai/openai.js';
import {
  fetchPrice,
  fetchPriceByFipeCode,
  VehicleType,
  Brand,
  FipePrice,
  YearCode,
} from '../fipe/api.js';
import {
  getCachedBrands,
  getCachedModels,
  getCachedYears,
} from '../fipe/cache.js';
import { findBrand } from '../fipe/search.js';
import { rankModels, isHighConfidence, MatchableModel } from '../fipe/match.js';
import { formatFipeResult, formatDisambiguation } from '../utils/formatter.js';
import { prisma } from '../database/client.js';
import { moduleLogger } from '../utils/logger.js';
import { phoneHash, redactPii, redactPiiDeep } from '../utils/privacy.js';

const log = moduleLogger('query-service');

interface QueryResult {
  message: string;
  disambiguation?: {
    options: Array<{ name: string; brandId: string; modelId: number; vehicleType: string }>;
    year: number | null;
  };
}

interface SelectionContext {
  selectedBrandId: string;
  selectedModelId: number;
  selectedModelName: string;
  vehicleType: string;
  year: number | null;
}

export interface QueryCallbacks {
  sendProgress?: (msg: string) => void | Promise<void>;
}

/**
 * Processa uma consulta de texto do usuario.
 *
 * Fluxo:
 *   1. Se ha selection (resposta numerica de desambiguacao), busca o
 *      preco direto.
 *   2. Caso contrario, classifica via OpenAI.
 *   3. Se a classificacao indicar veiculo, AVISA o usuario que vai
 *      buscar (#6) e segue o caminho marca > modelo > ano > preco.
 */
export async function handleTextQuery(
  userMessage: string,
  phone: string,
  selection?: SelectionContext,
  callbacks: QueryCallbacks = {}
): Promise<QueryResult> {
  const phoneId = phoneHash(phone);

  try {
    if (selection) {
      const { price, fallbackYear } = await lookupPriceForModel(
        selection.vehicleType as VehicleType,
        selection.selectedBrandId,
        selection.selectedModelId,
        selection.year
      );

      let message: string;
      if (price) {
        message = formatFipeResult(price);
        if (fallbackYear) {
          message =
            `_Ano ${selection.year} indisponivel; mostrando ${fallbackYear}._\n\n` +
            message;
        }
      } else {
        message = `Não encontrei preço para *${selection.selectedModelName}*${selection.year ? ` ${selection.year}` : ''}.`;
      }

      await logQuery(phoneId, 'text', userMessage, null, price, !!price);
      return { message };
    }

    // Classificacao com IA — antes de avisar o usuario que estamos
    // consultando, para nao mandar "Consultando..." quando a mensagem
    // nao for sobre veiculo.
    const interpretation = await interpretVehicleQuery(userMessage);

    if (!interpretation.isVehicleQuery) {
      return {
        message:
          'Não entendi sua consulta. Envie o nome de um veículo, como *Civic 2020* ou *Fiat Uno 2015*.\n\nDigite */ajuda* para mais opções.',
      };
    }

    if (callbacks.sendProgress) {
      await callbacks.sendProgress('🔍 Consultando tabela FIPE...');
    }

    if (interpretation.fipeCode) {
      return await handleFipeCodeQuery(interpretation.fipeCode, phoneId, userMessage);
    }

    if (!interpretation.brand || !interpretation.model) {
      return {
        message:
          'Não consegui identificar o veículo. Tente ser mais específico, como *Honda Civic 2020*.',
      };
    }

    return await handleBrandModelQuery(interpretation, phoneId, userMessage);
  } catch (err) {
    log.error({ err, phoneId }, 'Erro na consulta de texto');
    await logQuery(
      phoneId,
      'text',
      userMessage,
      null,
      null,
      false,
      err instanceof Error ? err.message : String(err)
    );
    return {
      message: 'Estou com dificuldades técnicas. Tente novamente em alguns minutos.',
    };
  }
}

async function handleFipeCodeQuery(
  fipeCode: string,
  phoneId: string,
  userMessage: string
): Promise<QueryResult> {
  try {
    const results = await fetchPriceByFipeCode(fipeCode);
    if (results.length === 0) {
      return { message: `Código FIPE *${fipeCode}* não encontrado.` };
    }

    // Pega o resultado mais recente.
    const price = results[0];
    await logQuery(phoneId, 'text', userMessage, { fipeCode }, price, true);
    return { message: formatFipeResult(price) };
  } catch (err) {
    log.warn({ err, fipeCode }, 'Falha ao consultar codigo FIPE');
    return { message: `Código FIPE *${fipeCode}* não encontrado na tabela FIPE.` };
  }
}

async function handleBrandModelQuery(
  interpretation: VehicleInterpretation,
  phoneId: string,
  userMessage: string
): Promise<QueryResult> {
  const declaredType = interpretation.vehicleType as VehicleType;
  const typesToTry: VehicleType[] = [...new Set([declaredType, 'carros', 'motos', 'caminhoes'])];

  // Encontra a marca testando cada tipo (cache evita custo).
  let matchedBrand: Brand | null = null;
  let matchedType: VehicleType = declaredType;
  for (const type of typesToTry) {
    const brands = await getCachedBrands(type);
    matchedBrand = findBrand(brands, interpretation.brand!);
    if (matchedBrand) {
      matchedType = type;
      break;
    }
  }

  if (!matchedBrand) {
    return {
      message: `Não encontrei a marca *${interpretation.brand}* na tabela FIPE.\n\nDicas:\n- Verifique a ortografia\n- Tente o nome completo da marca`,
    };
  }

  const modelsResp = await getCachedModels(matchedType, matchedBrand.codigo);

  // Unifica matching com rankModels (#13). Antes, o fluxo de texto
  // usava substring (`findModels`) e o de PDF usava scoring — mesma
  // query dava resultados diferentes em cada caminho.
  const ranked = rankModels(interpretation.model!, modelsResp.modelos as MatchableModel[], {
    minScore: 0.3,
    limit: 10,
  });

  if (ranked.length === 0) {
    return {
      message: `Não encontrei o modelo *${interpretation.model}* da *${matchedBrand.nome}* na tabela FIPE.\n\nDica: tente ser mais específico, como *${matchedBrand.nome} ${interpretation.model} Sedan*`,
    };
  }

  // Se ha um claro vencedor (alta confianca), pula desambiguacao.
  if (ranked.length === 1 || isHighConfidence(ranked, 0.15)) {
    const top = ranked[0];
    const { price, fallbackYear } = await lookupPriceForModel(
      matchedType,
      matchedBrand.codigo,
      top.model.codigo,
      interpretation.year
    );

    if (!price) {
      return {
        message: `Não encontrei preço para *${matchedBrand.nome} ${top.model.nome}*${interpretation.year ? ` ${interpretation.year}` : ''} na tabela FIPE.`,
      };
    }

    let message = formatFipeResult(price);
    if (fallbackYear) {
      message =
        `_Ano ${interpretation.year} indisponivel; mostrando ${fallbackYear}._\n\n` + message;
    }

    await logQuery(phoneId, 'text', userMessage, interpretation, price, true);
    return { message };
  }

  // Multiplos candidatos com confianca similar: pede desambiguacao.
  const options = ranked.slice(0, 10).map((s) => ({
    name: s.model.nome,
    brandId: matchedBrand!.codigo,
    modelId: s.model.codigo,
    vehicleType: matchedType,
  }));

  return {
    message: formatDisambiguation(options.map((o) => o.name)),
    disambiguation: {
      options,
      year: interpretation.year,
    },
  };
}

/**
 * Resolve preco para um modelo dado tipo/marca/codigo, com fallback
 * para ano mais proximo quando o ano-alvo nao existe na FIPE (#14).
 *
 * Retorna `fallbackYear` populado quando precisou cair em ano vizinho —
 * usado pra avisar o consultor "Ano 2010 indisponivel; mostrando 2011".
 */
async function lookupPriceForModel(
  type: VehicleType,
  brandId: string,
  modelId: number,
  year: number | null
): Promise<{ price: FipePrice | null; fallbackYear: string | null }> {
  try {
    const years = await getCachedYears(type, brandId, modelId);
    // Filtra "32000" (0km) — geralmente nao e o que o usuario quer.
    const usable = years.filter((y) => !y.codigo.startsWith('32000'));
    if (usable.length === 0) return { price: null, fallbackYear: null };

    let yearCode: YearCode | null = null;
    let fallbackYear: string | null = null;

    if (year) {
      const exact = usable.find((y) => y.nome.startsWith(String(year)));
      if (exact) {
        yearCode = exact;
      } else {
        // Fallback: ano mais proximo numericamente.
        const closest = pickClosestYear(usable, year);
        if (closest) {
          yearCode = closest;
          fallbackYear = closest.nome.split(' ')[0];
        }
      }
    } else {
      yearCode = usable[0]; // mais recente (lista vem ordenada decresc.)
    }

    if (!yearCode) return { price: null, fallbackYear: null };

    const price = await fetchPrice(type, brandId, modelId, yearCode.codigo);
    return { price, fallbackYear };
  } catch (err) {
    log.warn({ err, type, brandId, modelId, year }, 'Falha em lookupPriceForModel');
    return { price: null, fallbackYear: null };
  }
}

/**
 * Escolhe o ano mais proximo do alvo entre os disponiveis. Empate em
 * distancia favorece o ano mais novo (mais relevante pra cotacao).
 */
function pickClosestYear(years: YearCode[], target: number): YearCode | null {
  let best: YearCode | null = null;
  let bestDist = Infinity;

  for (const y of years) {
    const numStr = y.nome.match(/^\d{4}/)?.[0];
    if (!numStr) continue;
    const candidate = parseInt(numStr, 10);
    const dist = Math.abs(candidate - target);
    if (
      dist < bestDist ||
      (dist === bestDist && best && parseInt(best.nome.match(/^\d{4}/)?.[0] ?? '0', 10) < candidate)
    ) {
      best = y;
      bestDist = dist;
    }
  }

  return best;
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
        fipeResult: fipeResult ? JSON.stringify(fipeResult) : null,
        success,
        errorMsg: errorMsg || null,
      },
    });
  } catch (err) {
    log.error({ err }, 'Erro ao salvar QueryLog');
  }
}
