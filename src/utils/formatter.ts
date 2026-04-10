import { FipePrice } from '../fipe/api.js';

/**
 * Formata o resultado FIPE para uma mensagem WhatsApp legível.
 */
export function formatFipeResult(price: FipePrice): string {
  return [
    `*${price.Marca} ${price.Modelo}*`,
    `Ano: ${price.AnoModelo}`,
    `Preço FIPE: *${price.Valor}*`,
    `Combustível: ${price.Combustivel}`,
    `Código FIPE: ${price.CodigoFipe}`,
    `Referência: ${price.MesReferencia}`,
  ].join('\n');
}

/**
 * Formata múltiplos resultados FIPE (para consulta em lote).
 */
export function formatBatchResults(
  results: Array<{ vehicle: string; price?: FipePrice; error?: string }>
): string {
  const lines: string[] = ['*Resultado da consulta em lote:*\n'];

  results.forEach((r, i) => {
    lines.push(`*${i + 1}. ${r.vehicle}*`);
    if (r.price) {
      lines.push(`   Preço FIPE: *${r.price.Valor}*`);
      lines.push(`   Código: ${r.price.CodigoFipe} | ${r.price.Combustivel}`);
    } else {
      lines.push(`   ❌ ${r.error || 'Não encontrado'}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Formata lista de opções para desambiguação.
 */
export function formatDisambiguation(modelNames: string[]): string {
  const lines = ['Encontrei vários modelos:\n'];

  modelNames.forEach((name, i) => {
    lines.push(`*${i + 1}.* ${name}`);
  });

  lines.push('\nResponda com o *número* da opção desejada.');
  return lines.join('\n');
}
