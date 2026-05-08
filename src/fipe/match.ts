/**
 * Heuristicas de matching entre uma consulta livre (extraida do PDF ou
 * do texto do usuario) e os nomes de modelos retornados pela tabela
 * FIPE.
 *
 * O modulo e proposital e cuidadosamente puro: nao faz I/O, nao chama
 * API externa, nao usa Prisma. Isso o torna trivial de testar e de
 * usar tanto no fluxo de PDF (lote) quanto no de texto (interativo).
 *
 * Estrategia (em alto nivel):
 *
 *  1. Normaliza ambos os lados (minuscula, sem acento, separadores
 *     padronizados).
 *  2. Tokeniza em palavras "core" (descartando ruidos como "turbo",
 *     "4x2", "flex"), e lista a parte os tokens numericos (que sao o
 *     sinal mais forte: "1517", "1620", "330").
 *  3. Compara cobertura de tokens nos dois sentidos (query -> candidato
 *     e candidato -> query) e premia tambem o casamento de tokens
 *     numericos.
 *  4. Bonifica casamento de combustivel quando essa informacao esta
 *     disponivel.
 *
 * O retorno inclui um breakdown detalhado para auditoria via logs e
 * fixtures: assim conseguimos entender, depois, por que um modelo
 * ganhou de outro.
 */

export type Fuel =
  | 'flex'
  | 'gasoline'
  | 'diesel'
  | 'ethanol'
  | 'electric'
  | 'hybrid';

export interface MatchableModel {
  /** Nome legivel do modelo, vindo da API FIPE. */
  nome: string;
  /** Codigo FIPE-interno do modelo. */
  codigo: number;
}

export interface ScoreBreakdown {
  /** Score final no intervalo [0, 1]. Acima de 0.6 e match razoavel. */
  total: number;
  /** Cobertura de tokens core da query no nome do candidato. */
  queryCoverage: number;
  /** Cobertura inversa: tokens core do candidato presentes na query. */
  reverseCoverage: number;
  /** Casamento de tokens numericos da query (ex: "1517", "1620"). */
  numericMatch: number;
  /** 1 = combustivel bate, 0.5 = nao informado, 0 = conflito. */
  fuelMatch: number;
  /** Penalidade por tokens da query ausentes no candidato. */
  missingPenalty: number;
}

export interface ScoredModel<T extends MatchableModel> {
  model: T;
  breakdown: ScoreBreakdown;
}

/**
 * Palavras de "ruido" que aparecem nos nomes de modelos FIPE mas que
 * raramente sao distinguidoras do veiculo. Mantidas em conjunto unico
 * compartilhado por scoreModel e detectFuel.
 *
 * IMPORTANTE: combustivel (flex, diesel, etc.) NAO entra aqui pois
 * tratamos como sinal explicito separado.
 */
/**
 * NAO incluimos aqui:
 *  - configuracoes de eixo (4x2, 6x2, 6x4, ...): a FIPE tem entradas
 *    distintas para cada uma, sao distinguidores fortes.
 *  - padrao de emissao (E5, E6): idem, geram entradas separadas.
 *  - numero de portas/valvulas (16V, 4p): tambem distinguem.
 * Esses tokens permanecem como tokens "core" e contribuem para o score.
 */
const NOISE_WORDS = new Set([
  // turbinacao / cambio
  'turbo', 'aspirado', 'tb', 'mt', 'at', 'cvt', 'mpi', 'gdi', 'aut', 'mec',
  // sufixos genericos de uma letra (raramente distintivos isolados)
  'p', 'g', 's', 'a', 'h', 'i',
  // cabines / assentos
  'pass', 'passageiros', 'cab', 'cd', 'cs',
  // marketing (sem peso real para identificacao)
  'plus', 'comfort', 'comfortline', 'highline', 'sportback', 'sport',
  'advance', 'limited', 'edition', 'premium', 'extreme',
]);

const FUEL_KEYWORDS: Record<Fuel, string[]> = {
  flex: ['flex', 'flexfuel', 'totalflex'],
  gasoline: ['gasolina', 'gas', 'gasol'],
  diesel: ['diesel', 'dsl'],
  ethanol: ['alcool', 'etanol'],
  electric: ['eletrico', 'eletric', 'ev', 'bev'],
  hybrid: ['hibrido', 'hibrida', 'hev', 'phev'],
};

/**
 * Normaliza string: minuscula, sem acentos, com separadores padronizados.
 */
export function normalize(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\/_\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokeniza separando por espacos e descartando vazios. */
export function tokenize(str: string): string[] {
  const norm = normalize(str);
  return norm.length === 0 ? [] : norm.split(' ');
}

/** Tokens "core" sao todos exceto NOISE_WORDS. */
function isNumeric(token: string): boolean {
  return /^\d+[a-z]?$/i.test(token);
}

function partitionTokens(tokens: string[]): {
  core: string[];
  numeric: string[];
  noise: string[];
} {
  const core: string[] = [];
  const numeric: string[] = [];
  const noise: string[] = [];

  for (const t of tokens) {
    if (isNumeric(t)) {
      numeric.push(t);
      core.push(t); // numeros tambem entram em core (sao distinguidores fortes)
    } else if (NOISE_WORDS.has(t)) {
      noise.push(t);
    } else {
      core.push(t);
    }
  }

  return { core, numeric, noise };
}

/**
 * Detecta combustivel a partir de um texto livre (ex: trecho do PDF,
 * nome do modelo). Retorna null quando nao consegue inferir.
 */
export function detectFuel(text: string | null | undefined): Fuel | null {
  if (!text) return null;
  const norm = normalize(text);

  for (const [fuel, keywords] of Object.entries(FUEL_KEYWORDS) as Array<
    [Fuel, string[]]
  >) {
    for (const kw of keywords) {
      // \b para evitar matches dentro de outras palavras
      const re = new RegExp(`\\b${kw}\\b`);
      if (re.test(norm)) return fuel;
    }
  }
  return null;
}

/**
 * Confronta dois combustiveis.
 *  - Se algum dos lados e null, devolve 0.5 (sem info, neutro).
 *  - Match perfeito = 1.
 *  - Conflito (ex: gasoline vs diesel) = 0.
 *  - "flex" e considerado compativel com gasoline e ethanol.
 */
function compareFuel(a: Fuel | null, b: Fuel | null): number {
  if (!a || !b) return 0.5;
  if (a === b) return 1;
  if ((a === 'flex' && (b === 'gasoline' || b === 'ethanol')) ||
      (b === 'flex' && (a === 'gasoline' || a === 'ethanol'))) {
    return 0.8;
  }
  return 0;
}

/**
 * Pontua o quanto um candidato bate com a query.
 *
 * @param query texto da consulta (ex: "Cargo 1517 Turbo")
 * @param candidate nome do modelo na FIPE (ex: "Cargo 1517E Turbo 4x2 (E5)")
 * @param queryFuel combustivel inferido na consulta, ou null
 */
export function scoreModel(
  query: string,
  candidate: string,
  queryFuel: Fuel | null = null
): ScoreBreakdown {
  const queryTokens = tokenize(query);
  const candidateTokens = tokenize(candidate);

  const q = partitionTokens(queryTokens);
  const c = partitionTokens(candidateTokens);

  const candidateSet = new Set(c.core);

  // Quantos tokens core da query aparecem no candidato?
  const queryHits = q.core.filter((t) => candidateSet.has(t));
  const queryCoverage =
    q.core.length === 0 ? 0 : queryHits.length / q.core.length;

  // E o caminho inverso: o nome do candidato e "sobre" a query?
  // Penaliza candidatos com palavras core que a query nao tem.
  const querySet = new Set(q.core);
  const reverseHits = c.core.filter((t) => querySet.has(t));
  const reverseCoverage =
    c.core.length === 0 ? 0 : reverseHits.length / c.core.length;

  // Casamento numerico: o sinal mais forte (ex: "1517" bater "1517").
  let numericMatch = 0.5; // neutro quando nao ha numeros
  if (q.numeric.length > 0) {
    const candNumericSet = new Set(c.numeric);
    const numHits = q.numeric.filter((n) => {
      // Aceita match exato OU prefixo (ex: "1517" casa "1517e")
      if (candNumericSet.has(n)) return true;
      return c.numeric.some((cn) => cn.startsWith(n) || n.startsWith(cn));
    }).length;
    numericMatch = numHits / q.numeric.length;
  }

  // Combustivel: se nao foi explicitado na query, tentamos inferir do
  // proprio texto da query como ultimo recurso.
  const inferredQueryFuel = queryFuel ?? detectFuel(query);
  const candidateFuel = detectFuel(candidate);
  const fuelMatch = compareFuel(inferredQueryFuel, candidateFuel);

  // Penaliza tokens core da query que nao aparecem no candidato. E
  // diferente de "queryCoverage" porque esta versao escala com a
  // quantidade absoluta de palavras ausentes (3 ausencias doem mais
  // do que 1).
  const missingCount = q.core.length - queryHits.length;
  const missingPenalty = Math.min(0.3, missingCount * 0.05);

  // Pesos calibrados para favorecer numericos (sinal mais discriminante)
  // e cobertura, sem deixar a cobertura inversa dominar.
  const total =
    Math.max(
      0,
      queryCoverage * 0.4 +
        numericMatch * 0.3 +
        reverseCoverage * 0.15 +
        fuelMatch * 0.15 -
        missingPenalty
    );

  return {
    total: Math.min(1, total),
    queryCoverage,
    reverseCoverage,
    numericMatch,
    fuelMatch,
    missingPenalty,
  };
}

/**
 * Pontua e ordena uma lista de modelos contra a query.
 * Retorna apenas modelos com score acima do threshold (default 0.3),
 * preservando o melhor-pior em ordem decrescente.
 */
export function rankModels<T extends MatchableModel>(
  query: string,
  candidates: T[],
  options: { fuel?: Fuel | null; minScore?: number; limit?: number } = {}
): ScoredModel<T>[] {
  const { fuel = null, minScore = 0.3, limit = 10 } = options;

  const scored: ScoredModel<T>[] = candidates.map((model) => ({
    model,
    breakdown: scoreModel(query, model.nome, fuel),
  }));

  return scored
    .filter((s) => s.breakdown.total >= minScore)
    .sort((a, b) => b.breakdown.total - a.breakdown.total)
    .slice(0, limit);
}

/**
 * Indica se a margem entre o melhor e o segundo candidato e suficiente
 * para considerar o resultado "alta confianca". Util para decidir se
 * vale logar como warning (ex: dois Cargo 1517 muito parecidos).
 */
export function isHighConfidence(
  ranked: ScoredModel<MatchableModel>[],
  margin = 0.1
): boolean {
  if (ranked.length === 0) return false;
  if (ranked.length === 1) return ranked[0].breakdown.total >= 0.6;
  return ranked[0].breakdown.total - ranked[1].breakdown.total >= margin;
}
