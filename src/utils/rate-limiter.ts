/**
 * Rate limiter simples usando token bucket.
 * Controla quantas requisições por minuto podem ser feitas à API FIPE.
 */
export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillInterval: number; // ms entre cada token
  private lastRefill: number;

  constructor(tokensPerMinute: number) {
    this.maxTokens = tokensPerMinute;
    this.tokens = tokensPerMinute;
    this.refillInterval = (60 * 1000) / tokensPerMinute;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = Math.floor(elapsed / this.refillInterval);

    if (newTokens > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
      this.lastRefill = now;
    }
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens > 0) {
      this.tokens--;
      return;
    }

    // Espera até o próximo token estar disponível
    const waitTime = this.refillInterval - (Date.now() - this.lastRefill);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
    this.refill();
    this.tokens--;
  }
}
