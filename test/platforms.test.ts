import { afterEach, describe, expect, it, vi } from 'vitest'

// The @deepseek-ai/* peer deps are provided by the host DSH at runtime and are
// NOT installed in this repo's node_modules (peer model). Mock the two runtime
// imports so the platform search module can be exercised in isolation.
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

import { BUILTIN_PLATFORMS } from '../src/platforms/builtins.ts'
import { searchPlatform } from '../src/platforms/search.ts'
import { PlatformRegistry } from '../src/platforms/registry.ts'

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

const RSS_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title>
<item><title>First post</title><link>http://8.8.8.8/a</link><description>First description</description><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
<item><title>Second post</title><link>http://8.8.8.8/b</link><description>Second description</description></item>
</channel></rss>`

const registry = new PlatformRegistry({ builtins: BUILTIN_PLATFORMS, configured: [], rulePackPaths: [] })
const signal = new AbortController().signal

function makeDeps(allowPrivateNetworks = false) {
  return { registry, timeoutMs: 5_000, maxBytes: 1_000_000, maxResults: 20, allowPrivateNetworks }
}

function errorOf(error: unknown): { message: string; code?: string } {
  return { message: error instanceof Error ? error.message : String(error), code: (error as { code?: string })?.code }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('searchPlatform — SSRF guard (rss platform: the query IS the URL)', () => {
  it('blocks a cloud-metadata feed URL and never fetches it', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const error = await searchPlatform(
      { platform: 'rss', query: 'http://169.254.169.254/latest/meta-data/' },
      makeDeps(),
      signal,
    ).catch(e => e)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errorOf(error).code).toBe('WEB_SSRF_BLOCKED')
    expect(errorOf(error).message).toMatch(/SSRF guard/)
  })

  it('blocks a loopback feed URL', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const error = await searchPlatform({ platform: 'rss', query: 'http://127.0.0.1:8080/feed.xml' }, makeDeps(), signal).catch(e => e)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errorOf(error).code).toBe('WEB_SSRF_BLOCKED')
  })

  it('blocks a redirect hop that lands on a private target', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(302, { location: 'http://10.0.0.5/feed.xml' }))
    vi.stubGlobal('fetch', fetchMock)
    const error = await searchPlatform({ platform: 'rss', query: 'http://8.8.8.8/feed' }, makeDeps(), signal).catch(e => e)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errorOf(error).code).toBe('WEB_SSRF_BLOCKED')
  })

  it('fetches a public feed and parses its entries', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200, { 'content-type': 'application/rss+xml' }, RSS_XML))
    vi.stubGlobal('fetch', fetchMock)
    const result = await searchPlatform({ platform: 'rss', query: 'http://8.8.8.8/feed.xml' }, makeDeps(), signal)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.sources).toHaveLength(2)
    expect(result.sources[0]).toMatchObject({ url: 'http://8.8.8.8/a', title: 'First post' })
    expect(result.truncated).toBe(false)
  })

  it('fetches a private feed when allowPrivateNetworks is enabled', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200, { 'content-type': 'application/rss+xml' }, RSS_XML))
    vi.stubGlobal('fetch', fetchMock)
    const result = await searchPlatform({ platform: 'rss', query: 'http://127.0.0.1/feed.xml' }, makeDeps(true), signal)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.sources).toHaveLength(2)
  })
})
