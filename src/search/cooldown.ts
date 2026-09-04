/**
 * Per-engine failure cooldown with exponential backoff. A failing engine is
 * skipped for `baseMs * 2^(consecutiveFailures - 1)` (capped at `maxMs`); a
 * success resets the counter. Keeps the router from hammering a blocked or
 * down engine on every search.
 * @module @deepseek-ai/dsh-web-search-multi/cooldown
 */

export interface EngineCooldownOptions {
  /** Base cooldown after the first failure (ms). */
  baseMs: number
  /** Maximum cooldown (ms). */
  maxMs: number
  /** Injectable clock (ms) for tests. */
  now?: () => number
}

interface CooldownState {
  /** Epoch ms until which the engine is cooling down. */
  until: number
  /** Consecutive failure count (drives the backoff exponent). */
  consecutive: number
}

/** The per-engine failure cooldown tracker. */
export class EngineCooldown {
  private readonly states = new Map<string, CooldownState>()

  constructor(private readonly options: EngineCooldownOptions) {}

  /** True while the engine is cooling down. */
  isCoolingDown(engineId: string): boolean {
    const state = this.states.get(engineId)
    if (state === undefined) return false
    return (this.options.now ?? Date.now)() < state.until
  }

  /** Record a failure and extend the cooldown (exponential backoff). */
  recordFailure(engineId: string): void {
    const now = (this.options.now ?? Date.now)()
    const previous = this.states.get(engineId)
    const consecutive = (previous?.consecutive ?? 0) + 1
    const delay = Math.min(this.options.baseMs * 2 ** (consecutive - 1), this.options.maxMs)
    this.states.set(engineId, { until: now + delay, consecutive })
  }

  /** Record a success and clear the cooldown. */
  recordSuccess(engineId: string): void {
    this.states.delete(engineId)
  }

  /** Cooldown state for diagnostics (engine id → remaining ms, 0 when idle). */
  remainingMs(engineId: string): number {
    const state = this.states.get(engineId)
    if (state === undefined) return 0
    const remaining = state.until - (this.options.now ?? Date.now)()
    return remaining > 0 ? remaining : 0
  }
}
