import { interpretVehicleQuery, VehicleInterpretation } from '../ai/openai.js';
import {
  fetchBrands,
  fetchModels,
  fetchYears,
  fetchPrice,
  fetchPriceByFipeCode,
  VehicleType,
  Brand,
  FipePrice,
} from '../fipe/api.js';
import { findBrand, findModels, findYearCodes, getLatestYear } from '../fipe/search.js';
import { getFromCache, setCache } from '../fipe/cache.js';
import { formatFipeResult, formatDisambiguation } from '../utils/formatter.js';
import { prisma } from '../database/client.js';
import { moduleLogger } from '../utils/logger.js';
import crypto from 'crypto';

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

/**
 * Processa uma consulta de texto do usuário.
 */
export async function handleTextQuery(
  userMessage: string,
  phone: string,
  selection?: SelectionContext
): Promise<QueryResult> {
  const phoneHash = crypto.createHash('sha256').update(phone).digest('hex').substring(0, 16);

  try {
    // Se é uma seleção de desambiguação, pula a interpretação AI
    if (selection) {
      const price = await lookupPriceForModel(
        selection.vehicleType as VehicleType,
        selection.selectedBrandId,
        selection.selectedModelId,
        selection.year
      );

      const message = price
        ? formatFipeResult(price)
        : `Não encontrei preço para *${selection.selectedModelName}*${selection.year ? ` ${selection.year}` : ''}.`;

      await logQuery(phoneHash, 'text', userMessage, null, price, !!price);
      return { message };
    }

    // Interpreta a mensagem com IA
    const interpretation = await interpretVehicleQuery(userMessage);

    if (!interpretation.isVehicleQuery) {
      return {
        message: 'Não entendi sua consulta. Envie o nome de um veículo, como *Civic 2020* ou *Fiat Uno 2015*.\n\nDigite */ajuda* para mais opções.',
      };
    }

    // Busca direta por código FIPE
    if (interpretation.fipeCode) {
      return await handleFipeCodeQuery(interpretation.fipeCode, phoneHash, userMessage);
    }

    if (!interpretation.brand || !interpretation.model) {
      return {
        message: 'Não consegui identificar o veículo. Tente ser mais específico, como *Honda Civic 2020*.',
      };
    }

    // Busca pela cadeia: marca → modelo → ano → preço
    return await handleBrandModelQuery(interpretation, phoneHash, userMessage);
  } catch (err) {
    log.error({ err, phoneHash }, 'Erro na consulta de texto');
    await logQuery(phoneHash, 'text', userMessage, null, null, false, String(err));
    return {
      message: 'Estou com dificuldades técnicas. Tente novamente em alguns minutos.',
    };
  }
}

async function handleFipeCodeQuery(
  fipeCode: string,
  phoneHash: string,
  userMessage: string
): Promise<QueryResult> {
  try {
    const results = await fetchPriceByFipeCode(fipeCode);
    if (results.length === 0) {
      return { message: `Código FIPE *${fipeCode}* não encontrado.` };
    }

    // Pega o resultado mais recente
    const price = results[0] as unknown as FipePrice;
    await logQuery(phoneHash, 'text', userMessage, { fipeCode }, price, true);
    return { message: formatFipeResult(price) };
  } catch {
    return { message: `Código FIPE *${fipeCode}* não encontrado na tabela FIPE.` };
  }
}

async function handleBrandModelQuery(
  interpretation: VehicleInterpretation,
  phoneHash: string,
  userMessage: string
): Promise<QueryResult> {
  const vehicleType = interpretation.vehicleType as VehicleType;
  const vehicleTypes: VehicleType[] = [vehicleType, 'carros', 'motos', 'caminhoes'];
  // Remove duplicatas mantendo ordem
  const uniqueTypes = [...new Set(vehicleTypes)];

  let matchedBrand: Brand | null = null;
  let matchedType: VehicleType = vehicleType;

  // Tenta encontrar a marca em cada tipo de veículo
  for (const type of uniqueTypes) {
    const cacheKey = `brands:${type}`;
    let brands = await getFromCache<Brand[]>(cacheKey);

    if (!brands) {
      brands = await fetchBrands(type);
      await setCache(cacheKey, brands, 24); // cache 24h
    }

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

  // Busca modelos
  const modelsCacheKey = `models:${matchedType}:${matchedBrand.codigo}`;
  let modelsResponse = await getFromCache<{ modelos: any[] }>(modelsCacheKey);

  if (!modelsResponse) {
    modelsResponse = await fetchModels(matchedType, matchedBrand.codigo);
    await setCache(modelsCacheKey, modelsResponse, 24);
  }

  const matchedModels = findModels(modelsResponse.modelos, interpretation.model!);

  if (matchedModels.length === 0) {
    return {
      message: `Não encontrei o modelo *${interpretation.model}* da *${matchedBrand.nome}* na tabela FIPE.\n\nDica: tente ser mais específico, como *${matchedBrand.nome} ${interpretation.model} Sedan*`,
    };
  }

  // Se múltiplos modelos, pede para o usuário escolher (máximo 10)
  if (matchedModels.length > 1) {
    const options = matchedModels.slice(0, 10).map((m) => ({
      name: m.nome,
      brandId: matchedBrand!.codigo,
      modelId: m.codigo,
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

  // Modelo único: busca preço
  const model = matchedModels[0];
  const price = await lookupPriceForModel(
    matchedType,
    matchedBrand.codigo,
    model.codigo,
    interpretation.year
  );

  if (!price) {
    return {
      message: `Não encontrei preço para *${matchedBrand.nome} ${model.nome}*${interpretation.year ? ` ${interpretation.year}` : ''} na tabela FIPE.`,
    };
  }

  await logQuery(phoneHash, 'text', userMessage, interpretation, price, true);
  return { message: formatFipeResult(price) };
}

async function lookupPriceForModel(
  type: VehicleType,
  brandId: string,
  modelId: number,
  year: number | null
): Promise<FipePrice | null> {
  try {
    const years = await fetchYears(type, brandId, modelId);

    let yearCode;
    if (year) {
      const matches = findYearCodes(years, year);
      yearCode = matches[0] || null;
    } else {
      yearCode = getLatestYear(years);
    }

    if (!yearCode) return null;

    return await fetchPrice(type, brandId, modelId, yearCode.codigo);
  } catch {
    return null;
  }
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
        userMessage,
        aiResult: aiResult ? JSON.stringify(aiResult) : null,
        fipeResult: fipeResult ? JSON.stringify(fipeResult) : null,
        success,
        errorMsg: errorMsg || null,
      },
    });
  } catch (err) {
    log.error({ err }, 'Erro ao salvar QueryLog');
  }
}
