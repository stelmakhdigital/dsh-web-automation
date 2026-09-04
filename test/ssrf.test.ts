import { describe, expect, it, vi, beforeEach } from 'vitest'
import { checkSsrf } from '../src/fetch/ssrf.ts'

// Mock node:dns/promises so domain tests control the resolved addresses.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}))

import { lookup } from 'node:dns/promises'
const mockLookup = vi.mocked(lookup)

beforeEach(() => {
  mockLookup.mockReset()
})

describe('checkSsrf — IP literals (no DNS)', () => {
  it('allows a public IPv4 literal', async () => {
    const result = await checkSsrf('http://8.8.8.8/')
    expect(result.allowed).toBe(true)
    expect(result.addresses).toEqual(['8.8.8.8'])
  })

  it('allows a public IPv4 literal (https)', async () => {
    const result = await checkSsrf('https://1.1.1.1/')
    expect(result.allowed).toBe(true)
  })

  it.each([
    ['http://10.0.0.1/', '10/8 private'],
    ['http://172.16.0.1/', '172.16/12 private'],
    ['http://172.31.255.255/', '172.16/12 private (upper bound)'],
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
    ['http://[::]/', 'IPv6 unspecified'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
    ['http://[fc00::1]/', 'IPv6 ULA (fc)'],
    ['http://[fd00::1]/', 'IPv6 ULA (fd)'],
  ])('blocks %s (%s)', async (url, _label) => {
    const result = await checkSsrf(url)
    expect(result.allowed).toBe(false)
  })
})

describe('checkSsrf — protocol / parse guards', () => {
  it.each([
    ['ftp://example.com/', 'ftp'],
    ['file:///etc/passwd', 'file'],
    ['gopher://example.com/', 'gopher'],
  ])('blocks %s protocol', async (url) => {
    const result = await checkSsrf(url)
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/protocol/)
  })

  it('blocks an unparseable URL', async () => {
    const result = await checkSsrf('not-a-url')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/unparseable/)
  })
})

describe('checkSsrf — domain resolution (DNS mock)', () => {
  it('allows a domain that resolves to a public IP', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
    const result = await checkSsrf('https://example.com/')
    expect(result.allowed).toBe(true)
    expect(result.addresses).toEqual(['93.184.216.34'])
  })

  it('blocks a domain that resolves to a private IP', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }])
    const result = await checkSsrf('https://internal.example.com/')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/private|reserved/)
  })

  it('blocks a domain with mixed public+private addresses (anti-rebinding)', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])
    const result = await checkSsrf('https://rebinding.example.com/')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/private|reserved/)
  })

  it('blocks when DNS resolution fails', async () => {
    mockLookup.mockRejectedValueOnce(new Error('ENOTFOUND'))
    const result = await checkSsrf('https://missing.example.com/')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/DNS resolution failed/)
  })

  it('blocks when no addresses resolve', async () => {
    mockLookup.mockResolvedValueOnce([])
    const result = await checkSsrf('https://empty.example.com/')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/no addresses/)
  })
})

describe('checkSsrf — allowPrivate bypass', () => {
  it('allows a private IP when allowPrivate is true', async () => {
    const result = await checkSsrf('http://10.0.0.1/', { allowPrivate: true })
    expect(result.allowed).toBe(true)
  })

  it('allows any URL when allowPrivate is true', async () => {
    const result = await checkSsrf('http://127.0.0.1/admin', { allowPrivate: true })
    expect(result.allowed).toBe(true)
  })
})
