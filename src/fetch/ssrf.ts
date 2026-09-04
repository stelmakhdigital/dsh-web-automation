/**
 * SSRF guard for the cached fetch provider. Blocks requests to private,
 * loopback, link-local, and otherwise non-public network targets so the
 * plugin cannot be used to probe internal infrastructure (cloud metadata
 * endpoints, LAN services, localhost) through the model's `web_fetch` tool.
 *
 * The check runs twice: once on the literal hostname (catches IP-literal
 * URLs) and once after DNS resolution (catches domains that resolve to
 * private addresses, including DNS-rebinding). A request is allowed only if
 * every resolved address is public.
 * @module dsh-web-automation/fetch/ssrf
 */

import { lookup } from 'node:dns/promises'

/** A resolved network address (IPv4 or IPv6). */
interface ResolvedAddress {
  address: string
  family: number
}

/**
 * IPv4 private/reserved ranges (CIDR). Loopback, private, link-local,
 * carrier-grade NAT, and "this network" are all blocked.
 */
const IPV4_BLOCKED: Array<[number, number]> = [
  // [network (uint32), prefix length]
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (cloud metadata)
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xfc000000, 7], // fc00::/7 IPv6 ULA (kept here for symmetry; IPv6 handled separately)
]

/**
 * Parse an IPv4 address into a uint32. Returns undefined if not a valid IPv4.
 * @param text - the address string.
 * @returns the uint32 value, or undefined.
 */
function ipv4ToUint32(text: string): number | undefined {
  const parts = text.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = (value << 8) | octet
  }
  return value >>> 0
}

/**
 * Whether a uint32 IPv4 address falls within a blocked CIDR.
 * @param value - the uint32 address.
 * @param network - the uint32 network address.
 * @param prefix - the prefix length.
 * @returns true if the address is within the network.
 */
function inCidr(value: number, network: number, prefix: number): boolean {
  if (prefix === 0) return true
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) === (network & mask)
}

/**
 * Whether an IPv4 address string is private/reserved.
 * @param text - the IPv4 address string.
 * @returns true if the address is blocked.
 */
function isPrivateIpv4(text: string): boolean {
  const value = ipv4ToUint32(text)
  if (value === undefined) return false
  return IPV4_BLOCKED.some(([network, prefix]) => inCidr(value, network, prefix))
}

/**
 * Whether an IPv6 address string is private/reserved. Blocks loopback,
 * link-local, unique-local, and unspecified.
 * @param text - the IPv6 address string.
 * @returns true if the address is blocked.
 */
function isPrivateIpv6(text: string): boolean {
  const lower = text.toLowerCase()
  // Loopback (::1), unspecified (::).
  if (lower === '::1' || lower === '::') return true
  // Link-local (fe80::/10).
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
  // Unique-local (fc00::/7): fc00::/8 and fd00::/8.
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  return false
}

/**
 * Whether a hostname is a literal IP address (IPv4 or IPv6).
 * @param host - the hostname.
 * @returns true if the hostname is an IP literal.
 */
function isIpLiteral(host: string): boolean {
  // IPv6 literals are wrapped in brackets in URLs; the hostname may or may not
  // carry the brackets depending on the parser. Strip them.
  const bare = host.replace(/^\[|\]$/g, '')
  if (bare.includes(':')) return true // IPv6
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) // IPv4
}

/**
 * Whether a single resolved address is public (allowed).
 * @param address - the resolved address.
 * @returns true if the address is public.
 */
function isPublicAddress(address: string): boolean {
  if (address.includes(':')) return !isPrivateIpv6(address)
  return !isPrivateIpv4(address)
}

/**
 * Result of an SSRF check for one URL.
 */
export interface SsrfCheckResult {
  /** Whether the URL is allowed (public). */
  allowed: boolean
  /** The reason the URL was blocked (when not allowed). */
  reason?: string
  /** The resolved addresses (for diagnostics). */
  addresses?: string[]
}

/**
 * Check a URL against the SSRF policy. The hostname is checked as a literal
 * (catches IP-literal URLs) and, when it is a domain, resolved via DNS and
 * every resolved address is checked (catches private domains and
 * DNS-rebinding). A URL is allowed only if every resolved address is public.
 * @param url - the absolute http(s) URL to check.
 * @param options - optional overrides.
 * @param options.allowPrivate - when true, skip the check (allow all).
 * @returns the check result.
 */
export async function checkSsrf(url: string, options: { allowPrivate?: boolean } = {}): Promise<SsrfCheckResult> {
  if (options.allowPrivate) return { allowed: true }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, reason: 'unparseable URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `protocol ${parsed.protocol} is not allowed (only http/https)` }
  }
  const host = parsed.hostname
  if (host === '') return { allowed: false, reason: 'empty hostname' }

  // Literal IP: check directly (no DNS).
  if (isIpLiteral(host)) {
    const bare = host.replace(/^\[|\]$/g, '')
    if (!isPublicAddress(bare)) {
      return { allowed: false, reason: `host ${host} is a private/reserved address`, addresses: [bare] }
    }
    return { allowed: true, addresses: [bare] }
  }

  // Domain: resolve and check every address.
  let addresses: ResolvedAddress[]
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    return { allowed: false, reason: `DNS resolution failed for ${host}` }
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: `no addresses resolved for ${host}` }
  }
  const ipStrings = addresses.map(a => a.address)
  const blocked = ipStrings.filter(ip => !isPublicAddress(ip))
  if (blocked.length > 0) {
    return { allowed: false, reason: `host ${host} resolves to private/reserved address(es): ${blocked.join(', ')}`, addresses: ipStrings }
  }
  return { allowed: true, addresses: ipStrings }
}
