/**
 * A small token-bucket rate limiter with jitter, for polite sustained access
 * to a public endpoint. In-process only; no state crosses a boundary.
 * @module @deepseek-ai/dsh-web-search-multi/rate-limit
 */

/** Options for a {@link RateLimiter}. */
export interface RateLimiterOptions {
  /** Sustained rate in tokens per second (must be > 0). */
  perSec: number
  /** Burst capacity (defaults to `perSec`, minimum 1). */
  burst?: number
  /** Jitter in milliseconds added to each wait (defaults to 100). */
  jitterMs?: number
  /** Injectable clock for tests (defaults to `Date.now`). */
  now?: () => number
  /** Injectable wait for tests (defaults to a real timer). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Token-bucket rate limiter. */
export class RateLimiter {
  private readonly capacity: number
  private readonly refillPerMs: number
  private tokens: number
  private lastRefill: number

  constructor(private readonly options: RateLimiterOptions) {
    if (!(options.perSec > 0)) throw new Error('RateLimiter: perSec must be positive')
    this.capacity = Math.max(1, options.burst ?? Math.ceil(options.perSec))
    this.refillPerMs = options.perSec / 1000
    this.tokens = this.capacity
    this.lastRefill = (options.now ?? Date.now)()
  }

  /**
   * Wait until one token is available, then consume it.
   * @param signal - optional caller cancellation; an aborted wait rejects with an `AbortError`.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      this.refill()
      if (signal?.aborted) throw new DOMException('rate limit wait aborted', 'AbortError')
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      const deficit = 1 - this.tokens
      const waitMs = Math.ceil(deficit / this.refillPerMs) + this.jitter()
      await (this.options.sleep ?? defaultSleep)(waitMs, signal)
    }
  }

  private refill(): void {
    const now = (this.options.now ?? Date.now)()
    const elapsed = now - this.lastRefill
    if (elapsed <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs)
    this.lastRefill = now
  }

  private jitter(): number {
    const max = this.options.jitterMs ?? 100
    return Math.floor(Math.random() * (max + 1))
  }
}

/** Default wait: a timer that rejects with an `AbortError` on abort. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('rate limit wait aborted', 'AbortError'))
      return
    }
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(id)
      reject(new DOMException('rate limit wait aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
