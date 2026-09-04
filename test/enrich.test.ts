import { afterEach, describe, expect, it, vi } from 'vitest'

// The @deepseek-ai/* peer deps are provided by the host DSH at runtime and are
// NOT installed in this repo's node_modules (peer model). Mock the two runtime
// imports so the enrichment module can be exercised in isolation.
vi.mock('@deepseek-ai/dsh-web', () => {
  class WebError extends Error {
    readonly code: string
    constructor(message: string, code: string, options?: { cause?: unknown }) {
      super(message, options)
      this.code = code
    }
  }
  return { WebError }
})
vi.mock('@deepseek-ai/dsh-timeout', () => ({
  deadline: (signal: AbortSignal | undefined, _ms: number, _code: string) => ({
    signal: signal ?? new AbortController().signal,
    [Symbol.dispose]: () => undefined,
  }),
  timeoutOf: () => undefined,
}))

import { enrichSources, type EnrichOptions } from '../src/search/enrich.ts'
import type { WebStore } from '../src/store/index.ts'

/** Build a minimal fetch Response stand-in (ok/status/headers/body stream). */
function fakeResponse(status: number, headers: Record<string, string>, body = ''): Response {
  const bytes = new TextEncoder().encode(body)
  let served = false
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: {
      cancel: async () => undefined,
      getReader: () => ({
        read: async () => (served ? { done: true, value: undefined } : (served = true, { done: false, value: bytes })),
        cancel: async () => undefined,
        releaseLock: () => undefined,
      }),
    },
  } as unknown as Response
}

/** A fake web store (no SQLite): nothing cached, records accepted. */
function fakeStore() {
  return {
    readPage: vi.fn(async () => undefined),
    recordPage: vi.fn(async () => 1),
  } as unknown as WebStore
}

function makeOptions(overrides: Partial<EnrichOptions> = {}): EnrichOptions {
  return {
    store: fakeStore(),
    pageTimeoutMs: 5_000,
    pageCacheTtlMs: 60_000,
    maxPageBytes: 1_000_000,
    maxBodyChars: 10_000,
    snippetChars: 120,
    userAgent: 'test-agent/1.0',
    concurrency: 2,
    allowPrivateNetworks: false,
    ...overrides,
  }
}

const signal = new AbortController().signal

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('enrichSources — SSRF guard', () => {
  it('never fetches a private IP literal from a SERP result', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const sources = [{ url: 'http://127.0.0.1/secret', title: 'Internal', snippet: 'original snippet' }]
    const result = await enrichSources('internal secret', sources, 1, makeOptions(), signal)
    expect(fetchMock).not.toHaveBeenCalled()
    // The source keeps its engine snippet (no enrichment).
    expect(result[0]?.snippet).toBe('original snippet')
  })

  it('blocks a redirect hop that lands on a private target', async () => {
    const fetchMock = vi.fn(async (_url: string) => fakeResponse(302, { location: 'http://169.254.169.254/latest/meta-data/' }))
    vi.stubGlobal('fetch', fetchMock)
    const sources = [{ url: 'http://8.8.8.8/redirect', title: 'Public', snippet: 'original snippet' }]
    const result = await enrichSources('cloud metadata', sources, 1, makeOptions(), signal)
    // Only the first (public) hop is fetched; the private hop is blocked.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://8.8.8.8/redirect')
    expect(result[0]?.snippet).toBe('original snippet')
  })

  it('follows a redirect to a public target and enriches', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(302, { location: 'http://9.9.9.9/final' }))
      .mockResolvedValueOnce(fakeResponse(200, { 'content-type': 'text/html; charset=utf-8' }, '<html><body><p>the unique query words live here</p></body></html>'))
    vi.stubGlobal('fetch', fetchMock)
    const sources = [{ url: 'http://8.8.8.8/start', title: 'Public', snippet: 'original snippet' }]
    const result = await enrichSources('unique query words', sources, 1, makeOptions(), signal)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The snippet was replaced with a query-focused window from the page.
    expect(result[0]?.snippet).not.toBe('original snippet')
    expect(result[0]?.snippet).toContain('unique query words')
  })

  it('fetches a private target when allowPrivateNetworks is enabled', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200, { 'content-type': 'text/html' }, '<html><body><p>local service text</p></body></html>'))
    vi.stubGlobal('fetch', fetchMock)
    const sources = [{ url: 'http://127.0.0.1/local', title: 'Local', snippet: 'original snippet' }]
    const result = await enrichSources('local service', sources, 1, makeOptions({ allowPrivateNetworks: true }), signal)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result[0]?.snippet).toContain('local service text')
  })
})
