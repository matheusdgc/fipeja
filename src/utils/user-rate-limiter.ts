/**
 * Rate-limit por usuario (JID), separado para mensagens (curto prazo)
 * e PDFs (custo OpenAI mais alto, janela maior).
 *
 * Implementacao em memoria com janelas deslizantes simples. Para o
 * caso de uso (1 instancia, dezenas de consultores), e suficiente. Se
 * algum dia tivermos multi-instancia, migrar para SQLite ou Redis.
 *
 * Nao confundir com `RateLimiter` (token bucket) usado para a API
 * FIPE — aquele protege o servico externo, este protege nosso bolso
 * (OpenAI) e a sanidade do bot.
 */

import { moduleLogger } from './logger.js';

const log = moduleLogger('user-rate-limiter');

interface Bucket {
  /** Timestamps das requisicoes recentes (em ms desde epoch). */
  hits: number[];
}

export interface UserRateLimitResult {
  allowed: boolean;
  /** Quando o usuario podera tentar de novo (em ms epoch). Apenas se !allowed. */
  retryAt?: number;
}

export class UserRateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxHits: number,
    private readonly windowMs: number,
    private readonly label: string
  ) {
    // Limpeza periodica de buckets vazios para evitar vazamento de
    // memoria com JIDs descartaveis.
    setInterval(() => this.gc(), Math.max(60_000, this.windowMs)).unref();
  }

  check(key: string): UserRateLimitResult {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { hits: [] };

    // Remove hits fora da janela
    const cutoff = now - this.windowMs;
    bucket.hits = bucket.hits.filter((t) => t > cutoff);

    if (bucket.hits.length >= this.maxHits) {
      const oldest = bucket.hits[0];
      const retryAt = oldest + this.windowMs;
      this.buckets.set(key, bucket);
      log.warn(
        { key, label: this.label, hits: bucket.hits.length, max: this.maxHits, retryAt },
        'Rate-limit por usuario excedido'
      );
      return { allowed: false, retryAt };
    }

    bucket.hits.push(now);
    this.buckets.set(key, bucket);
    return { allowed: true };
  }

  private gc(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [key, bucket] of this.buckets) {
      const filtered = bucket.hits.filter((t) => t > cutoff);
      if (filtered.length === 0) {
        this.buckets.delete(key);
      } else {
        bucket.hits = filtered;
      }
    }
  }

  /** So para testes — limpa o estado. */
  _reset(): void {
    this.buckets.clear();
  }
}

/** Formata "tente em X" amigavelmente em portugues. */
export function formatRetryHint(retryAt: number): string {
  const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  return `${hours}h`;
}
