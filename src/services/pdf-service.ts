import { extractTextFromPdf } from '../pdf/parser.js';
import { extractVehiclesFromPdf, VehicleFromPdf } from '../ai/openai.js';
import {
  fetchBrands,
  fetchModels,
  fetchYears,
  fetchPrice,
  fetchPriceByFipeCode,
  VehicleType,
  FipePrice,
} from '../fipe/api.js';
import { findBrand, findModels, findYearCodes, getLatestYear } from '../fipe/search.js';
import { getFromCache, setCache } from '../fipe/cache.js';
import { formatBatchResults } from '../utils/formatter.js';
import { prisma } from '../database/client.js';
import crypto from 'crypto';

/**
 * Processa um PDF com lista de veículos e retorna os preços FIPE.
 */
export async function handlePdfQuery(buffer: Buffer, phone: string): Promise<string> {
  const phoneHash = crypto.createHash('sha256').update(phone).digest('hex').substring(0, 16);

  try {
    // 1. Extrai texto do PDF
    const pdfText = await extractTextFromPdf(buffer);

    // 2. Usa IA para extrair lista de veículos
    const vehicles = await extractVehiclesFromPdf(pdfText);

    if (vehicles.length === 0) {
      await logQuery(phoneHash, 'pdf', '[PDF]', null, null, false, 'Nenhum veículo encontrado');
      return 'Não encontrei nenhum veículo no PDF enviado.\n\nVerifique se o PDF contém informações de veículos (marca, modelo, ano).';
    }

    // 3. Consulta FIPE para cada veículo
    const results: Array<{ vehicle: string; price?: FipePrice; error?: string }> = [];

    for (const vehicle of vehicles) {
      const vehicleName = `${vehicle.brand} ${vehicle.model}${vehicle.year ? ` ${vehicle.year}` : ''}`;

      try {
        // Só usa fipeCode se tiver formato válido: 6 dígitos + traço + 1 dígito (ex: 014193-0)
        const FIPE_CODE_REGEX = /^\d{6}-\d$/;
        if (vehicle.fipeCode && FIPE_CODE_REGEX.test(vehicle.fipeCode)) {
          const prices = await fetchPriceByFipeCode(vehicle.fipeCode);
          if (prices.length > 0) {
            results.push({ vehicle: vehicleName, price: prices[0] as unknown as FipePrice });
            continue;
          }
        }

        // Busca pela cadeia marca → modelo → ano → preço
        const price = await lookupVehicle(vehicle);
        if (price) {
          results.push({ vehicle: vehicleName, price });
        } else {
          results.push({ vehicle: vehicleName, error: 'Não encontrado na tabela FIPE' });
        }
      } catch (err) {
        results.push({ vehicle: vehicleName, error: 'Erro na consulta' });
      }
    }

    const message = formatBatchResults(results);
    const successCount = results.filter((r) => r.price).length;

    await logQuery(
      phoneHash,
      'pdf',
      `[PDF com ${vehicles.length} veículos]`,
      vehicles,
      { total: vehicles.length, found: successCount },
      successCount > 0
    );

    return message;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Erro desconhecido';
    console.error('Erro ao processar PDF:', err);
    await logQuery(phoneHash, 'pdf', '[PDF]', null, null, false, errorMsg);

    if (errorMsg.includes('protegido') || errorMsg.includes('corrompido') || errorMsg.includes('ler')) {
      return errorMsg;
    }

    return 'Erro ao processar o PDF. Tente novamente em alguns instantes.';
  }
}

async function lookupVehicle(vehicle: VehicleFromPdf): Promise<FipePrice | null> {
  const type = vehicle.vehicleType as VehicleType;

  try {
    const cacheKey = `brands:${type}`;
    let brands = await getFromCache<any[]>(cacheKey);
    if (!brands) {
      brands = await fetchBrands(type);
      await setCache(cacheKey, brands, 24);
    }

    // Tenta marca principal + fallbacks (ex: Saab-Scania → Scania e vice-versa)
    const brandCandidates = [vehicle.brand, ...getBrandFallbacks(vehicle.brand)];

    for (const brandName of brandCandidates) {
      const brand = findBrand(brands, brandName);
      if (!brand) continue;

      const modelsCacheKey = `models:${type}:${brand.codigo}`;
      let modelsResponse = await getFromCache<{ modelos: any[] }>(modelsCacheKey);
      if (!modelsResponse) {
        modelsResponse = await fetchModels(type, brand.codigo);
        await setCache(modelsCacheKey, modelsResponse, 24);
      }

      const models = findModels(modelsResponse.modelos, vehicle.model);
      if (models.length === 0) {
        console.log(`[lookup] modelo nao encontrado: "${vehicle.model}" em ${brand.nome}`);
        continue;
      }

      const model = models[0];

      const years = await fetchYears(type, brand.codigo, model.codigo);
      let yearCode;
      if (vehicle.year) {
        const matches = findYearCodes(years, vehicle.year);
        // Se o ano exato não existe, usa o mais recente disponível
        yearCode = matches[0] || getLatestYear(years);
        if (!matches[0]) {
          console.log(`[lookup] ano ${vehicle.year} nao encontrado em ${brand.nome} ${model.nome}, usando mais recente`);
        }
      } else {
        yearCode = getLatestYear(years);
      }

      if (!yearCode) {
        console.log(`[lookup] nenhum ano disponivel para ${brand.nome} ${model.nome}`);
        continue;
      }

      return await fetchPrice(type, brand.codigo, model.codigo, yearCode.codigo);
    }

    console.log(`[lookup] nao encontrado: "${vehicle.brand} ${vehicle.model}" (tipo: ${type})`);
    return null;
  } catch (err) {
    console.log(`[lookup] erro API para "${vehicle.brand} ${vehicle.model}": ${err instanceof Error ? err.message : err}`);
    return null;
  }
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
        userMessage,
        aiResult: aiResult ? JSON.stringify(aiResult) : null,
        fipeResult: fipeResult ? JSON.stringify(fipeResult) : null,
        success,
        errorMsg: errorMsg || null,
      },
    });
  } catch (err) {
    console.error('Erro ao salvar log:', err);
  }
}
