/**
 * Service Definition for the browser automation seam (`ctx.browser`): a
 * provider registry plus per-agent session ownership. A browser is stateful, so
 * unlike the search/fetch seam the runtime also tracks the open session for each
 * agent. Duplicate provider ids are rejected. At open time a usable provider
 * must exist; without one, exactly one usable provider is required, so selection
 * never depends on registration order.
 * @module @deepseek-ai/dsh-web-browser/runtime
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { BrowserOpenOptions, BrowserProvider, BrowserSession } from './types.ts'
import { BrowserError, BROWSER_CODES } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserRuntime
  }
}

/** Config for the browser seam. Intentionally empty (the provider carries its own options). */
export interface BrowserRuntimeConfig {}

/**
 * The browser automation service. Registered as `ctx.browser` (one instance per
 * context). Owns the provider registry and the per-agent open session.
 *
 * Selection semantics (resolved at open time, never order-dependent):
 * - Exactly one registered `available()` provider → that provider.
 * - No usable provider → `BROWSER_UNAVAILABLE`.
 * - Multiple usable providers → `BROWSER_UNAVAILABLE` (configure one).
 */
export class BrowserRuntime extends Service {
  static Config: z<BrowserRuntimeConfig> = z.object({})

  private readonly providers = new Map<string, BrowserProvider>()
  /** Keyed by the agent object, or {@link ANON_KEY} when no agent is present. */
  private readonly sessions = new Map<unknown, BrowserSession>()

  constructor(ctx: Context, config: BrowserRuntimeConfig = {}) {
    super(ctx, 'browser')
    void config
    // Close every open session when this service's fiber is disposed (HMR /
    // context teardown) so no browser process is leaked. The bound method is
    // captured (not `this`) because the generator body does not bind `this`.
    const closeAll = this.closeAll.bind(this)
    ctx.effect(
      function* () {
        yield () => {
          void closeAll()
        }
      },
      'browser.closeAll()',
    )
  }

  /**
   * Register a browser provider. Throws {@link BrowserError}
   * `BROWSER_DUPLICATE_PROVIDER` if its id is already registered. Returns a
   * disposer; disposed with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerProvider(provider: BrowserProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new BrowserError(`a browser provider with id "${provider.id}" is already registered`, BROWSER_CODES.DUPLICATE_PROVIDER)
    }
    const store = this.providers
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'browser.registerProvider()')
    return () => void dispose()
  }

  /**
   * The open session for `agent`, if any.
   * @param agent - the agent whose session to look up (omitted = the anonymous session).
   * @returns the open session, or undefined when none is open.
   */
  session(agent?: unknown): BrowserSession | undefined {
    return this.sessions.get(agent ?? ANON_KEY)
  }

  /**
   * Open a browser session for `agent`. Throws {@link BrowserError}
   * `BROWSER_ALREADY_OPEN` when the agent already has an open session and
   * `BROWSER_UNAVAILABLE` when no usable provider is registered.
   * @param agent - the agent that owns the session (omitted = the anonymous session).
   * @param options - launch options (headless, auth profile, timeout).
   * @param signal - optional cancellation signal.
   * @returns the newly opened session.
   */
  async open(agent?: unknown, options: BrowserOpenOptions = {}, signal?: AbortSignal): Promise<BrowserSession> {
    const key = agent ?? ANON_KEY
    const existing = this.sessions.get(key)
    if (existing !== undefined) {
      throw new BrowserError('a browser session is already open for this agent; call browser_close first', BROWSER_CODES.ALREADY_OPEN)
    }
    const provider = this.resolveProvider()
    const session = await provider.open(options, signal)
    this.sessions.set(key, session)
    return session
  }

  /**
   * Close and drop the open session for `agent`. A no-op when none is open.
   * @param agent - the agent whose session to close (omitted = the anonymous session).
   */
  async close(agent?: unknown): Promise<void> {
    const session = this.sessions.get(agent ?? ANON_KEY)
    if (session === undefined) return
    this.sessions.delete(agent ?? ANON_KEY)
    await session.close()
  }

  /** Close every open session (used on disposal). */
  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map(session => session.close()))
  }

  private resolveProvider(): BrowserProvider {
    const usable = [...this.providers.values()].filter(provider => provider.available())
    const [single] = usable
    if (single === undefined) {
      throw new BrowserError('no usable browser provider is registered', BROWSER_CODES.UNAVAILABLE)
    }
    if (usable.length > 1) {
      const ids = usable.map(provider => provider.id).join(', ')
      throw new BrowserError(`multiple usable browser providers are registered (${ids}); register exactly one`, BROWSER_CODES.UNAVAILABLE)
    }
    return single
  }
}

/** Sentinel key for the session owned when no agent is present (tests, diagnostics). */
const ANON_KEY = Symbol('browser-anon-session')

export default BrowserRuntime
