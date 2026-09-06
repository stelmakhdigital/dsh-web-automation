import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The @deepseek-ai/* peer deps are provided by the host DSH at runtime and are
// NOT installed in this repo's node_modules (peer model). Mock the runtime
// imports so the provider can be exercised in isolation.
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

// Mock node:dns/promises so the SSRF guard resolves hosts deterministically.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}))

import { CachedHttpFetchProvider } from '../src/fetch/provider.ts'
import { normalizeUrl } from '../src/fetch/url.ts'
import { WebStore } from '../src/store/index.ts'

import { lookup } from 'node:dns/promises'
const mockLookup = vi.mocked(lookup)

/** A public address so the SSRF guard lets example.com through. */
function resolvePublic(): void {
  mockLookup.mockImplementation(async (_host: string, options?: { all?: boolean }) => {
    const records = [{ address: '93.184.215.14', family: 4 }]
    return (options?.all ? records : records[0]!) as unknown as Awaited<ReturnType<typeof lookup>>
  })
}

function makeStore(): WebStore {
  return new WebStore({ path: ':memory:' })
}

function makeProvider(store: WebStore, overrides: Record<string, unknown> = {}): CachedHttpFetchProvider {
  return new CachedHttpFetchProvider({
    maxUrlLength: 2048,
    maxResponseBytes: 5_000_000,
    maxBodyChars: 100_000,
    timeoutMs: 10_000,
    maxRedirects: 5,
    userAgent: 'dsh-web-automation-test',
    cacheTtlMs: 60_000,
    store,
    revalidate: true,
    allowPrivateNetworks: false,
    ...overrides,
  })
}

/** Minimal Response stand-in with a real Headers and a one-chunk body stream. */
function fakeResponse(opts: { status?: number; body?: string; headers?: Record<string, string> }): Response {
  const status = opts.status ?? 200
  const bytes = new TextEncoder().encode(opts.body ?? '')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: String(status),
    headers: new Headers(opts.headers ?? {}),
    body: stream,
    url: '',
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  resolvePublic()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CachedHttpFetchProvider — cache behavior', () => {
  it('miss: fetches fresh, caches a 2xx result', async () => {
    const store = makeStore()
    fetchMock.mockImplementation(() => Promise.resolve(fakeResponse({ status: 200, body: '<html>hello</html>', headers: { 'content-type': 'text/html' } })))
    const provider = makeProvider(store)
    const result = await provider.fetch({ url: 'https://example.com' })
    expect(result.statusCode).toBe(200)
    expect(result.body.content).toBe('<html>hello</html>')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const cached = await store.readPage(normalizeUrl('https://example.com'))
    expect(cached).toBeDefined()
    expect(cached!.body).toBe('<html>hello</html>')
    await store.close()
  })

  it('fresh hit: serves from cache with no network round-trip', async () => {
    const store = makeStore()
    fetchMock.mockImplementation(() => Promise.resolve(fakeResponse({ status: 200, body: '<html>hello</html>', headers: { 'content-type': 'text/html' } })))
    const provider = makeProvider(store)
    await provider.fetch({ url: 'https://example.com' })
    // The entry is now fresh (within the 60s TTL); any further network call fails loudly.
    fetchMock.mockRejectedValue(new Error('network must not be touched'))
    const result = await provider.fetch({ url: 'https://example.com' })
    expect(result.body.content).toBe('<html>hello</html>')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await store.close()
  })

  it('expired + revalidate: a 304 serves the stale body and refreshes the timestamp', async () => {
    const store = makeStore()
    const key = normalizeUrl('https://example.com')
    await store.recordPage({
      url: 'https://example.com/',
      normalizedUrl: key,
      fetchedAt: Date.now() - 120_000, // beyond the 60s TTL
      etag: 'W/"v1"',
      statusCode: 200,
      bodyKind: 'html',
      body: '<html>stale</html>',
      truncated: false,
    })
    fetchMock.mockResolvedValue(fakeResponse({ status: 304 }))
    const provider = makeProvider(store)
    const result = await provider.fetch({ url: 'https://example.com' })
    expect(result.body.content).toBe('<html>stale</html>')
    // The conditional request carried the stored ETag.
    const requestHeaders = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>
    expect(requestHeaders['if-none-match']).toBe('W/"v1"')
    // The 304 refreshed the timestamp: the entry is fresh again.
    const refreshed = await store.readPage(key)
    expect(refreshed!.fetchedAt).toBeGreaterThan(Date.now() - 10_000)
    await store.close()
  })

  it('expired + revalidate: a 200 reads the new body from the conditional response (single request)', async () => {
    const store = makeStore()
    const key = normalizeUrl('https://example.com')
    await store.recordPage({
      url: 'https://example.com/',
      normalizedUrl: key,
      fetchedAt: Date.now() - 120_000,
      etag: 'W/"v1"',
      statusCode: 200,
      bodyKind: 'html',
      body: '<html>stale</html>',
      truncated: false,
    })
    fetchMock.mockResolvedValue(fakeResponse({ status: 200, body: '<html>fresh</html>', headers: { 'content-type': 'text/html', etag: 'W/"v2"' } }))
    const provider = makeProvider(store)
    const result = await provider.fetch({ url: 'https://example.com' })
    expect(result.body.content).toBe('<html>fresh</html>')
    // The new body came from the conditional response itself — exactly one request.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The fresh ETag was re-cached to seed the next revalidation cycle.
    const cached = await store.readPage(key)
    expect(cached!.etag).toBe('W/"v2"')
    await store.close()
  })

  it('expired + revalidate: a transport failure serves the stale body (stale-on-error)', async () => {
    const store = makeStore()
    const key = normalizeUrl('https://example.com')
    await store.recordPage({
      url: 'https://example.com/',
      normalizedUrl: key,
      fetchedAt: Date.now() - 120_000,
      etag: 'W/"v1"',
      statusCode: 200,
      bodyKind: 'html',
      body: '<html>stale</html>',
      truncated: false,
    })
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const provider = makeProvider(store)
    const result = await provider.fetch({ url: 'https://example.com' })
    expect(result.body.content).toBe('<html>stale</html>')
    await store.close()
  })

  it('expired + revalidate=false: falls through to a full fetch', async () => {
    const store = makeStore()
    const key = normalizeUrl('https://example.com')
    await store.recordPage({
      url: 'https://example.com/',
      normalizedUrl: key,
      fetchedAt: Date.now() - 120_000,
      etag: 'W/"v1"',
      statusCode: 200,
      bodyKind: 'html',
      body: '<html>stale</html>',
      truncated: false,
    })
    fetchMock.mockImplementation(() => Promise.resolve(fakeResponse({ status: 200, body: '<html>fresh</html>', headers: { 'content-type': 'text/html' } })))
    const provider = makeProvider(store, { revalidate: false })
    const result = await provider.fetch({ url: 'https://example.com' })
    expect(result.body.content).toBe('<html>fresh</html>')
    // No conditional headers on a plain full fetch.
    const requestHeaders = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>
    expect(requestHeaders['if-none-match']).toBeUndefined()
    await store.close()
  })

  it('blocks private targets before any network call', async () => {
    const store = makeStore()
    const provider = makeProvider(store)
    await expect(provider.fetch({ url: 'http://127.0.0.1:8080/' })).rejects.toMatchObject({ code: 'WEB_SSRF_BLOCKED' })
    expect(fetchMock).not.toHaveBeenCalled()
    await store.close()
  })

  it('does not cache non-2xx results', async () => {
    const store = makeStore()
    fetchMock.mockImplementation(() => Promise.resolve(fakeResponse({ status: 404, body: 'nope', headers: { 'content-type': 'text/plain' } })))
    const provider = makeProvider(store)
    const result = await provider.fetch({ url: 'https://example.com/missing' })
    expect(result.statusCode).toBe(404)
    const cached = await store.readPage(normalizeUrl('https://example.com/missing'))
    expect(cached).toBeUndefined()
    await store.close()
  })
})
