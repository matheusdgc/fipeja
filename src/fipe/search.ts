import { Brand, Model, YearCode } from './api.js';

/**
 * Normaliza string para comparação: minúscula, sem acentos.
 */
function normalize(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Busca a marca mais próxima na lista.
 * Retorna a primeira que contém o termo de busca como substring.
 */
export function findBrand(brands: Brand[], query: string): Brand | null {
  const normalizedQuery = normalize(query);

  // Primeiro tenta match exato
  const exact = brands.find((b) => normalize(b.nome) === normalizedQuery);
  if (exact) return exact;

  // Depois tenta substring (query contido no nome da marca)
  const partial = brands.find((b) => normalize(b.nome).includes(normalizedQuery));
  if (partial) return partial;

  // Tenta o inverso (nome da marca contido na query)
  const reverse = brands.find((b) => normalizedQuery.includes(normalize(b.nome)));
  if (reverse) return reverse;

  return null;
}

// Palavras de especificação técnica que a FIPE geralmente omite nos nomes dos modelos
const NOISE_WORDS = new Set(['4x2', '6x2', '8x2', '6x4', '4x4', '8x4', 'turbo', 'e3', 'e4', 'e5', 'e6', 'p', 'g', 'r', 's']);

/**
 * Busca modelos que correspondem ao termo de busca.
 * Retorna todos os matches (pode ter várias versões de um modelo).
 */
export function findModels(models: Model[], query: string): Model[] {
  const normalizedQuery = normalize(query);
  const queryWords = normalizedQuery.split(/\s+/);

  // 1. Tenta match com todas as palavras da query
  const fullMatches = models.filter((m) => {
    const normalizedName = normalize(m.nome);
    return queryWords.every((word) => normalizedName.includes(word));
  });
  if (fullMatches.length > 0) return fullMatches;

  // 2. Tenta sem palavras de ruído (4x2, 6x2, turbo, etc.)
  const coreWords = queryWords.filter((w) => !NOISE_WORDS.has(w));
  if (coreWords.length > 0 && coreWords.length < queryWords.length) {
    const coreMatches = models.filter((m) => {
      const normalizedName = normalize(m.nome);
      return coreWords.every((word) => normalizedName.includes(word));
    });
    if (coreMatches.length > 0) return coreMatches;
  }

  // 3. Fallback: modelos que contêm pelo menos a primeira palavra significativa
  const mainWord = queryWords[0];
  return models.filter((m) => normalize(m.nome).includes(mainWord));
}

/**
 * Busca o código do ano na lista de anos disponíveis.
 * Retorna todos os matches (podem ter variantes de combustível).
 */
export function findYearCodes(years: YearCode[], targetYear: number): YearCode[] {
  return years.filter((y) => y.nome.startsWith(String(targetYear)));
}

/**
 * Se não tem ano específico, retorna o mais recente (exclui "32000" que é 0km).
 */
export function getLatestYear(years: YearCode[]): YearCode | null {
  const filtered = years.filter((y) => !y.codigo.startsWith('32000'));
  return filtered[0] || null;
}
