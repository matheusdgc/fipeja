/**
 * Script de avaliacao de precisao do pipeline de PDF.
 *
 * Uso:
 *
 *   # Cria/atualiza o gabarito (fixture) a partir do output atual do pipeline.
 *   npm run eval-pdf:bootstrap
 *
 *   # Roda o pipeline e compara com o gabarito existente. Sai com codigo
 *   # de erro != 0 se houver regressao.
 *   npm run eval-pdf
 *
 *   # Para avaliar outro PDF:
 *   npx tsx scripts/eval-pdf.ts --pdf=tests/fixtures/pdfs/outro.pdf --fixture=tests/fixtures/outro.expected.json
 *
 * Por que existe:
 *
 * Sem um gabarito, qualquer mudanca no scoring/prompt e palpite. Este
 * script transforma o pipeline em algo mensuravel: voce roda, salva o
 * snapshot, depois confere se as proximas mudancas mantem ou melhoram
 * a taxa de acerto.
 *
 * Fluxo recomendado:
 *  1) Rode `eval-pdf:bootstrap` uma vez. Vai gerar um JSON.
 *  2) Abra o JSON e revise/corrija os campos `expected.*` que estiverem
 *     errados. Salve. Esse arquivo agora e a fonte da verdade.
 *  3) Toda vez que mexer no pipeline, rode `eval-pdf`. Se quebrar algo,
 *     o script aponta exatamente em qual veiculo.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractTextFromPdf } from '../src/pdf/parser.js';
import { extractVehiclesFromPdf, VehicleFromPdf } from '../src/ai/openai.js';
import {
  fetchPrice,
  fetchPriceByFipeCode,
  VehicleType,
  FipePrice,
  Brand,
} from '../src/fipe/api.js';
import { findBrand } from '../src/fipe/search.js';
import {
  rankModels,
  detectFuel,
  isHighConfidence,
} from '../src/fipe/match.js';
import {
  getCachedBrands,
  getCachedModels,
  getCachedYears,
} from '../src/fipe/cache.js';

interface ExpectedEntry {
  sourceText: string | null;
  brand: string;
  model: string;
  year: number | null;
  fuel: string | null;
  vehicleType: string;
  expectedMatch: {
    brand: string | null;
    model: string | null;
    year: string | null;
    fipeCode: string | null;
    score: number | null;
    confidence: 'high' | 'low' | null;
  };
}

interface FixtureFile {
  pdf: string;
  generatedAt: string;
  pdfSha256: string;
  totalVehicles: number;
  matched: number;
  expected: ExpectedEntry[];
}

interface CliArgs {
  pdf: string;
  fixture: string;
  bootstrap: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (name: string, fallback: string) => {
    const found = args.find((a) => a.startsWith(`--${name}=`));
    return found ? found.split('=', 2)[1] : fallback;
  };
  return {
    pdf: get('pdf', 'pdf-exemplo/burci-seguros.pdf'),
    fixture: get('fixture', 'tests/fixtures/burci-seguros.expected.json'),
    bootstrap: args.includes('--bootstrap'),
  };
}

/**
 * Roda o pipeline atual sobre um PDF e devolve, para cada veiculo
 * extraido pela IA, o resultado do matching contra a tabela FIPE.
 *
 * Esta funcao replica o caminho de `pdf-service.resolveVehicle` mas
 * sem persistencia em banco e sem mensagens para usuario, para que o
 * eval seja determinstico e rapido.
 */
async function runPipeline(pdfPath: string): Promise<{
  vehicles: VehicleFromPdf[];
  results: ExpectedEntry[];
}> {
  const buffer = fs.readFileSync(pdfPath);
  const text = await extractTextFromPdf(buffer);
  const vehicles = await extractVehiclesFromPdf(text);

  const results: ExpectedEntry[] = [];
  for (const v of vehicles) {
    const fuel = v.fuel ?? detectFuel(v.sourceText) ?? detectFuel(v.model);
    const entry: ExpectedEntry = {
      sourceText: v.sourceText,
      brand: v.brand,
      model: v.model,
      year: v.year,
      fuel,
      vehicleType: v.vehicleType,
      expectedMatch: {
        brand: null,
        model: null,
        year: null,
        fipeCode: null,
        score: null,
        confidence: null,
      },
    };

    // Tentar codigo FIPE direto, se houver
    if (v.fipeCode) {
      try {
        const prices = await fetchPriceByFipeCode(v.fipeCode);
        if (prices.length > 0) {
          const p = prices[0];
          entry.expectedMatch = {
            brand: p.Marca,
            model: p.Modelo,
            year: String(p.AnoModelo),
            fipeCode: p.CodigoFipe,
            score: 1,
            confidence: 'high',
          };
          results.push(entry);
          continue;
        }
      } catch {
        // segue para o fallback
      }
    }

    const match = await resolveByBrandModel(v, fuel);
    if (match) entry.expectedMatch = match;
    results.push(entry);
  }

  return { vehicles, results };
}

async function resolveByBrandModel(
  v: VehicleFromPdf,
  fuel: ReturnType<typeof detectFuel>
): Promise<ExpectedEntry['expectedMatch'] | null> {
  const type = v.vehicleType as VehicleType;
  let brands: Brand[];
  try {
    brands = await getCachedBrands(type);
  } catch {
    return null;
  }

  const candidates = [v.brand, ...getBrandFallbacks(v.brand)];
  for (const brandName of candidates) {
    const brand = findBrand(brands, brandName);
    if (!brand) continue;

    let modelsResp;
    try {
      modelsResp = await getCachedModels(type, brand.codigo);
    } catch {
      continue;
    }

    const ranked = rankModels(v.model, modelsResp.modelos, {
      fuel,
      limit: 5,
      minScore: 0.3,
    });
    if (ranked.length === 0) continue;

    for (const scored of ranked) {
      const years = await getCachedYears(type, brand.codigo, scored.model.codigo).catch(() => null);
      if (!years) continue;
      const usable = years.filter((y) => !y.codigo.startsWith('32000'));
      let yearCode = null;
      if (v.year !== null) {
        yearCode = usable.find((y) => y.nome.startsWith(String(v.year))) ?? null;
        if (!yearCode) continue;
      } else {
        yearCode = usable[0] ?? null;
      }
      if (!yearCode) continue;

      let price: FipePrice;
      try {
        price = await fetchPrice(type, brand.codigo, scored.model.codigo, yearCode.codigo);
      } catch {
        continue;
      }

      return {
        brand: brand.nome,
        model: scored.model.nome,
        year: yearCode.nome,
        fipeCode: price.CodigoFipe,
        score: Number(scored.breakdown.total.toFixed(3)),
        confidence: isHighConfidence(ranked) ? 'high' : 'low',
      };
    }
  }
  return null;
}

function getBrandFallbacks(brandName: string): string[] {
  const normalized = brandName.toLowerCase().replace(/-/g, ' ').trim();
  if (normalized.includes('saab') || normalized === 'saab scania') return ['Scania'];
  if (normalized === 'scania') return ['Saab-Scania'];
  return [];
}

function sha256OfFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function bootstrap(args: CliArgs): Promise<void> {
  console.log(`[eval-pdf] bootstrap: rodando pipeline contra ${args.pdf}`);
  const { vehicles, results } = await runPipeline(args.pdf);
  const matched = results.filter((r) => r.expectedMatch.fipeCode).length;

  const fixture: FixtureFile = {
    pdf: path.basename(args.pdf),
    generatedAt: new Date().toISOString(),
    pdfSha256: sha256OfFile(args.pdf),
    totalVehicles: vehicles.length,
    matched,
    expected: results,
  };

  fs.mkdirSync(path.dirname(args.fixture), { recursive: true });
  fs.writeFileSync(args.fixture, JSON.stringify(fixture, null, 2), 'utf-8');
  console.log(
    `[eval-pdf] gabarito salvo em ${args.fixture}: ${matched}/${vehicles.length} veiculos resolvidos`
  );
  console.log('[eval-pdf] ATENCAO: revise os campos expectedMatch.* manualmente antes de usar!');
}

async function evaluate(args: CliArgs): Promise<void> {
  if (!fs.existsSync(args.fixture)) {
    console.error(
      `[eval-pdf] gabarito nao existe: ${args.fixture}. Rode primeiro: npm run eval-pdf:bootstrap`
    );
    process.exit(2);
  }

  const fixture: FixtureFile = JSON.parse(fs.readFileSync(args.fixture, 'utf-8'));
  console.log(`[eval-pdf] avaliando ${args.pdf} contra ${args.fixture}`);
  console.log(`[eval-pdf] gabarito tem ${fixture.expected.length} veiculos esperados`);

  const { results } = await runPipeline(args.pdf);

  // Indexa expected por sourceText (chave estavel mais comum). Se nao
  // tiver sourceText, cai para `${brand} ${model} ${year}`.
  const keyOf = (e: ExpectedEntry) =>
    e.sourceText?.trim() || `${e.brand} ${e.model} ${e.year ?? ''}`.trim();

  const expectedMap = new Map<string, ExpectedEntry>();
  for (const e of fixture.expected) expectedMap.set(keyOf(e), e);

  let pass = 0;
  let fail = 0;
  let missing = 0;
  const failures: string[] = [];

  for (const got of results) {
    const key = keyOf(got);
    const exp = expectedMap.get(key);
    if (!exp) {
      missing += 1;
      failures.push(`MISSING (nao estava no gabarito): ${key}`);
      continue;
    }

    const ok =
      exp.expectedMatch.fipeCode === got.expectedMatch.fipeCode &&
      exp.expectedMatch.brand === got.expectedMatch.brand &&
      exp.expectedMatch.model === got.expectedMatch.model;

    if (ok) {
      pass += 1;
    } else {
      fail += 1;
      failures.push(
        `FAIL ${key}\n` +
          `  esperado: ${exp.expectedMatch.brand} | ${exp.expectedMatch.model} | ${exp.expectedMatch.fipeCode}\n` +
          `  obtido:   ${got.expectedMatch.brand} | ${got.expectedMatch.model} | ${got.expectedMatch.fipeCode}`
      );
    }
  }

  // Veiculos do gabarito que sumiram do output atual
  for (const e of fixture.expected) {
    const key = keyOf(e);
    if (!results.find((r) => keyOf(r) === key)) {
      fail += 1;
      failures.push(`DROPPED (presente no gabarito, ausente no output): ${key}`);
    }
  }

  const total = fixture.expected.length;
  const passRate = total === 0 ? 0 : (pass / total) * 100;

  console.log('');
  console.log(`[eval-pdf] resultados: ${pass}/${total} passaram (${passRate.toFixed(1)}%)`);
  if (fail || missing) {
    console.log(`[eval-pdf] falhas: ${fail} | extras nao esperados: ${missing}`);
    console.log('');
    for (const line of failures) console.log(line);
    process.exit(1);
  }
  console.log('[eval-pdf] OK');
}

(async () => {
  const args = parseArgs();
  if (args.bootstrap) await bootstrap(args);
  else await evaluate(args);
})().catch((err) => {
  console.error('[eval-pdf] erro fatal:', err);
  process.exit(2);
});
