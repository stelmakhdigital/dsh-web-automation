import { describe, expect, it, vi } from 'vitest'

// The @deepseek-ai/* peer deps are provided by the host DSH at runtime and are
// NOT installed in this repo's node_modules (peer model). Mock the two runtime
// imports so the tools module can be exercised in isolation.
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (def: unknown) => def,
}))
vi.mock('@deepseek-ai/dsh-llm', () => {
  class HarnessError extends Error {
    readonly code?: string
    constructor(message: string, code?: string, options?: { cause?: unknown }) {
      super(message, options)
      this.code = code
    }
  }
  return { HarnessError }
})

import { registerBrowserTools } from '../src/tools.ts'
import { BROWSER_CODES, BrowserError } from '../src/types.ts'

/** A captured tool definition (defineTool is mocked to the identity). */
interface CapturedTool {
  name: string
  execute: (args: Record<string, unknown>, exec: Record<string, unknown>) => Promise<unknown>
}

/** A fake open browser session (no Playwright involved). */
function makeFakeSession() {
  return {
    providerId: 'playwright',
    url: () => 'https://example.com/',
    navigate: vi.fn(async (url: string) => ({ url, title: 'Example' })),
    snapshot: vi.fn(),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => null),
    screenshot: vi.fn(async () => ({ buffer: Buffer.from('png'), mimeType: 'image/png' as const })),
    close: vi.fn(async () => undefined),
  }
}

/** Build a minimal Cordis-like context capturing the registered tools. */
function makeCtx(options: { approval?: { request: (req: Record<string, unknown>) => Promise<string> } } = {}) {
  const session = makeFakeSession()
  const tools = new Map<string, CapturedTool>()
  const ctx = {
    tools: {
      register: (def: CapturedTool) => {
        tools.set(def.name, def)
      },
    },
    systemPrompt: { section: () => undefined },
    get: (key: string) => (key === 'approval' ? options.approval : undefined),
    browser: {
      session: () => session,
      open: vi.fn(async () => session),
      close: vi.fn(async () => undefined),
    },
  }
  return { ctx, tools, session }
}

/** A tool execution identity. `agent` is omitted to model an agent-less call. */
function makeExec(agent?: unknown): Record<string, unknown> {
  return {
    ...(agent !== undefined ? { agent } : {}),
    callId: 'call-1',
    signal: new AbortController().signal,
  }
}

function toolError(error: unknown): { message: string; code?: string } {
  return { message: error instanceof Error ? error.message : String(error), code: (error as BrowserError)?.code }
}

describe('browser tools — approval gating', () => {
  it('denies (fail-closed) when approval is required but the call has no agent', async () => {
    const { ctx, tools } = makeCtx()
    registerBrowserTools(ctx as never, { approval: 'navigate' })
    const navigate = tools.get('browser_navigate')
    if (navigate === undefined) throw new Error('browser_navigate was not registered')
    const error = await navigate.execute({ url: 'https://example.com/' }, makeExec()).catch(e => e)
    expect(error).toBeInstanceOf(BrowserError)
    expect(toolError(error).code).toBe(BROWSER_CODES.APPROVAL_UNAVAILABLE)
  })

  it('denies (fail-closed) for click under approval "all" with no agent', async () => {
    const { ctx, tools } = makeCtx()
    registerBrowserTools(ctx as never, { approval: 'all' })
    const click = tools.get('browser_click')
    if (click === undefined) throw new Error('browser_click was not registered')
    const error = await click.execute({ ref: '@e1' }, makeExec()).catch(e => e)
    expect(toolError(error).code).toBe(BROWSER_CODES.APPROVAL_UNAVAILABLE)
  })

  it('denies when approval is required, an agent is present, but no approval service is mounted', async () => {
    const { ctx, tools } = makeCtx()
    registerBrowserTools(ctx as never, { approval: 'navigate' })
    const navigate = tools.get('browser_navigate')
    if (navigate === undefined) throw new Error('browser_navigate was not registered')
    const error = await navigate.execute({ url: 'https://example.com/' }, makeExec({})).catch(e => e)
    expect(toolError(error).code).toBe(BROWSER_CODES.APPROVAL_UNAVAILABLE)
  })

  it('denies when the approver rejects', async () => {
    const { ctx, tools } = makeCtx({ approval: { request: async () => 'rejected' } })
    registerBrowserTools(ctx as never, { approval: 'navigate' })
    const navigate = tools.get('browser_navigate')
    if (navigate === undefined) throw new Error('browser_navigate was not registered')
    const error = await navigate.execute({ url: 'https://example.com/' }, makeExec({})).catch(e => e)
    expect(toolError(error).code).toBe(BROWSER_CODES.APPROVAL_DENIED)
  })

  it('proceeds when the approver grants allowed-once', async () => {
    const { ctx, tools, session } = makeCtx({ approval: { request: async () => 'allowed-once' } })
    registerBrowserTools(ctx as never, { approval: 'navigate' })
    const navigate = tools.get('browser_navigate')
    if (navigate === undefined) throw new Error('browser_navigate was not registered')
    const result = await navigate.execute({ url: 'https://example.com/' }, makeExec({})) as { url: string }
    expect(result.url).toBe('https://example.com/')
    expect(session.navigate).toHaveBeenCalledTimes(1)
  })

  it('skips approval entirely under approval "never"', async () => {
    const { ctx, tools, session } = makeCtx()
    registerBrowserTools(ctx as never, { approval: 'never' })
    const navigate = tools.get('browser_navigate')
    if (navigate === undefined) throw new Error('browser_navigate was not registered')
    const result = await navigate.execute({ url: 'https://example.com/' }, makeExec()) as { url: string }
    expect(result.url).toBe('https://example.com/')
    expect(session.navigate).toHaveBeenCalledTimes(1)
  })
})
