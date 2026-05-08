import crypto from 'crypto';
import { config } from '../config.js';

/**
 * Identificador de telefone para logs internos.
 *
 * - Sem PHONE_HASH_PEPPER: usa SHA-256 truncado (16 chars hex). E uma
 *   correlacao consistente entre logs, mas e brute-forceavel — o range
 *   de telefones BR e pequeno (~10^11). NAO chame de "anonimizado".
 * - Com PHONE_HASH_PEPPER: usa HMAC-SHA256(pepper, phone), inviavel
 *   reverter sem o pepper. Recomendado em producao.
 */
export function phoneHash(phone: string): string {
  if (config.PHONE_HASH_PEPPER && config.PHONE_HASH_PEPPER.length > 0) {
    return crypto
      .createHmac('sha256', config.PHONE_HASH_PEPPER)
      .update(phone)
      .digest('hex')
      .substring(0, 16);
  }

  return crypto.createHash('sha256').update(phone).digest('hex').substring(0, 16);
}

/**
 * Mascara CPFs e CNPJs em texto livre antes de salvar em log.
 *
 * Padroes cobertos:
 *   - CPF: 999.999.999-99 ou 99999999999
 *   - CNPJ: 99.999.999/9999-99 ou 99999999999999
 *   - Placa Mercosul: AAA1A11
 *   - Placa antiga: AAA-1111 ou AAA1111
 *
 * Nao pretende ser bullet-proof — e defesa em profundidade contra PII
 * vazar pra QueryLog quando consultor manda PDF de apolice. Vide LGPD.
 */
const CPF_RE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const CNPJ_RE = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
const PLACA_MERCOSUL_RE = /\b[A-Z]{3}\d[A-Z]\d{2}\b/g;
const PLACA_ANTIGA_RE = /\b[A-Z]{3}-?\d{4}\b/g;

export function redactPii(text: string): string {
  return text
    .replace(CNPJ_RE, '[CNPJ]')
    .replace(CPF_RE, '[CPF]')
    .replace(PLACA_MERCOSUL_RE, '[PLACA]')
    .replace(PLACA_ANTIGA_RE, '[PLACA]');
}

/**
 * Aplica `redactPii` recursivamente em valores string de um objeto/array
 * arbitrario. Util pra sanitizar `aiResult` antes do JSON.stringify.
 */
export function redactPiiDeep<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return redactPii(input) as unknown as T;
  if (Array.isArray(input)) {
    return input.map((item) => redactPiiDeep(item)) as unknown as T;
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = redactPiiDeep(v);
    }
    return out as unknown as T;
  }
  return input;
}
