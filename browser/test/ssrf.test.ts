import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock node:dns/promises so domain tests control the resolved addresses.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}))
// The playwright + @deepseek-ai/* peer deps are provided by the host at
// runtime and are NOT installed here; mock the runtime imports.
vi.mock('playwright', () => ({
  chromium: { executablePath: () => '' },
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

import { lookup } from 'node:dns/promises'
import { checkSsrf } from '../src/ssrf.ts'
import { assertPublicNavigation } from '../src/playwright.ts'
import { BROWSER_CODES, BrowserError } from '../src/types.ts'

const mockLookup = vi.mocked(lookup)

/**
 * `lookup` is overloaded (with/without `all: true`); `vi.mocked` keeps the
 * overloads, so the `all: true` result shape needs a cast to the union.
 */
function resolvedAddresses(addresses: Array<{ address: string; family: number }>): Awaited<ReturnType<typeof lookup>> {
  return addresses as unknown as Awaited<ReturnType<typeof lookup>>
}

beforeEach(() => {
  mockLookup.mockReset()
})

describe('checkSsrf (browser copy) — IP literals (no DNS)', () => {
  it('allows a public IPv4 literal', async () => {
    const result = await checkSsrf('http://8.8.8.8/')
    expect(result.allowed).toBe(true)
    expect(result.addresses).toEqual(['8.8.8.8'])
  })

  it.each([
    ['http://10.0.0.1/', '10/8 private'],
    ['http://172.16.0.1/', '172.16/12 private'],
    ['http://192.168.1.1/', '192.168/16 private'],
    ['http://127.0.0.1/', 'loopback'],
    ['http://169.254.169.254/', 'link-local (cloud metadata)'],
    ['http://0.0.0.0/', 'this network'],
  ])('blocks %s (%s)', async (url, _label) => {
    const result = await checkSsrf(url)
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/private|reserved/)
  })

  it.each([
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
    ['http://[fc00::1]/', 'IPv6 ULA (fc)'],
    ['http://[fd00::1]/', 'IPv6 ULA (fd)'],
  ])('blocks %s (%s)', async (url, _label) => {
    const result = await checkSsrf(url)
    expect(result.allowed).toBe(false)
  })

  it.each([
    ['ftp://example.com/', 'ftp'],
    ['file:///etc/passwd', 'file'],
  ])('blocks %s protocol', async (url, _label) => {
    const result = await checkSsrf(url)
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/protocol/)
  })
})

describe('checkSsrf (browser copy) — embedded-IPv4 forms (mapped/compatible/NAT64)', () => {
  // Regression: Node's fetch connects through these to the mapped IPv4 host,
  // so a private IPv4 tail must be blocked even when the address is written
  // in IPv6 notation (the URL parser keeps it as an IPv6 hostname).
  it.each([
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback'],
    ['http://[::ffff:10.0.0.1]/', 'IPv4-mapped 10/8 private'],
    ['http://[::ffff:169.254.169.254]/', 'IPv4-mapped cloud metadata'],
    ['http://[::ffff:192.168.1.1]/', 'IPv4-mapped 192.168/16 private'],
    ['http://[::ffff:172.16.0.1]/', 'IPv4-mapped 172.16/12 private'],
    ['http://[::ffff:0.0.0.0]/', 'IPv4-mapped this-network'],
    ['http://[::10.0.0.1]/', 'IPv4-compatible 10/8 private'],
    ['http://[64:ff9b::169.254.169.254]/', 'NAT64 cloud metadata'],
  ])('blocks %s (%s)', async (url, _label) => {
    const result = await checkSsrf(url)
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/private|reserved/)
  })

  it('allows an IPv4-mapped address with a public tail', async () => {
    const result = await checkSsrf('http://[::ffff:8.8.8.8]/')
    expect(result.allowed).toBe(true)
  })

  it('allows a plain public IPv6 literal', async () => {
    const result = await checkSsrf('http://[2606:4700:4700::1111]/')
    expect(result.allowed).toBe(true)
  })
})

describe('checkSsrf (browser copy) — domain resolution (DNS mock)', () => {
  it('allows a domain that resolves to a public IP', async () => {
    mockLookup.mockResolvedValueOnce(resolvedAddresses([{ address: '93.184.216.34', family: 4 }]))
    const result = await checkSsrf('https://example.com/')
    expect(result.allowed).toBe(true)
  })

  it('blocks a domain that resolves to a private IP', async () => {
    mockLookup.mockResolvedValueOnce(resolvedAddresses([{ address: '10.0.0.5', family: 4 }]))
    const result = await checkSsrf('https://internal.example.com/')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/private|reserved/)
  })

  it('blocks when DNS resolution fails', async () => {
    mockLookup.mockRejectedValueOnce(new Error('ENOTFOUND'))
    const result = await checkSsrf('https://missing.example.com/')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/DNS resolution failed/)
  })
})

describe('assertPublicNavigation', () => {
  it('throws BROWSER_SSRF_BLOCKED for a private IP literal', async () => {
    const error = await assertPublicNavigation('http://169.254.169.254/latest/meta-data/', false).catch(e => e)
    expect(error).toBeInstanceOf(BrowserError)
    expect((error as BrowserError).code).toBe(BROWSER_CODES.SSRF_BLOCKED)
  })

  it('throws BROWSER_SSRF_BLOCKED for a domain resolving to a private IP', async () => {
    mockLookup.mockResolvedValueOnce(resolvedAddresses([{ address: '192.168.0.10', family: 4 }]))
    const error = await assertPublicNavigation('https://lan.example.com/', false).catch(e => e)
    expect((error as BrowserError).code).toBe(BROWSER_CODES.SSRF_BLOCKED)
  })

  it('allows a public IP literal', async () => {
    await expect(assertPublicNavigation('https://8.8.8.8/', false)).resolves.toBeUndefined()
  })

  it('allows a private target when allowPrivate is true', async () => {
    await expect(assertPublicNavigation('http://127.0.0.1/admin', true)).resolves.toBeUndefined()
  })
})
