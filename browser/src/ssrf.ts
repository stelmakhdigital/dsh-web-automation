/**
 * SSRF guard for the browser automation tools. Blocks navigation to private,
 * loopback, link-local, and otherwise non-public network targets so the
 * `browser_*` tools cannot be used to probe internal infrastructure (cloud
 * metadata endpoints, LAN services, localhost) through the model.
 *
 * Standalone copy of the root package's guard (`src/fetch/ssrf.ts`): the
 * browser sub-package is a separate npm package with its own peer
 * dependencies, so it cannot import across packages. The check runs on the
 * literal hostname (catches IP-literal URLs) and after DNS resolution
 * (catches domains that resolve to private addresses, including
 * DNS-rebinding). A URL is allowed only if every resolved address is public.
 * Embedded-IPv4 forms (IPv4-mapped `::ffff:a.b.c.d`, IPv4-compatible
 * `::a.b.c.d`, NAT64 `64:ff9b::a.b.c.d`) are checked through their IPv4
 * tail, so `[::ffff:127.0.0.1]` is blocked like `127.0.0.1`.
 * @module @deepseek-ai/dsh-web-browser/ssrf
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
 * Parse an IPv6 address (hex groups with `::` compression, optional zone id)
 * into its eight 16-bit groups.
 * @param text - the IPv6 address string.
 * @returns the eight 16-bit groups, or undefined when the text is not a
 *   well-formed IPv6 address.
 */
function ipv6ToGroups(text: string): number[] | undefined {
  const bare = (text.split('%')[0] ?? '').toLowerCase()
  if (bare.length === 0) return undefined
  const separatorIndex = bare.indexOf('::')
  const head = separatorIndex === -1 ? bare : bare.slice(0, separatorIndex)
  const tail = separatorIndex === -1 ? undefined : bare.slice(separatorIndex + 2)
  const headGroups = head.length > 0 ? head.split(':') : []
  const tailGroups = tail !== undefined && tail.length > 0 ? tail.split(':') : []
  const groups = [...headGroups, ...tailGroups]
  if (tail === undefined && groups.length !== 8) return undefined
  if (tail !== undefined && groups.length > 7) return undefined
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined
  }
  const values = groups.map(group => Number.parseInt(group, 16))
  const missing = 8 - values.length
  const expanded = [
    ...values.slice(0, headGroups.length),
    ...Array.from({ length: missing }, () => 0),
    ...values.slice(headGroups.length),
  ]
  return expanded.length === 8 ? expanded : undefined
}

/**
 * Whether an IPv6 address string is private/reserved. Blocks loopback,
 * link-local, unique-local, unspecified, and the embedded-IPv4 forms whose
 * IPv4 tail is private: IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible
 * (`::/96`, deprecated), and NAT64 (`64:ff9b::/96`). Node's fetch connects
 * through these to the mapped IPv4 host — `[::ffff:127.0.0.1]` reaches
 * loopback — so the tail must pass the IPv4 rules, not just the IPv6 ones.
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
  // Embedded-IPv4 forms: extract the 32-bit IPv4 tail and apply the IPv4 rules.
  const groups = ipv6ToGroups(lower)
  if (groups !== undefined) {
    const g0 = groups[0] ?? 0
    const g1 = groups[1] ?? 0
    const g2 = groups[2] ?? 0
    const g3 = groups[3] ?? 0
    const g4 = groups[4] ?? 0
    const g5 = groups[5] ?? 0
    const g6 = groups[6] ?? 0
    const g7 = groups[7] ?? 0
    const mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff
    const compatible = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0
    const nat64 = g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0
    if (mapped || compatible || nat64) {
      const ipv4 = ((g6 << 16) | g7) >>> 0
      const dotted = `${ipv4 >>> 24}.${(ipv4 >>> 16) & 0xff}.${(ipv4 >>> 8) & 0xff}.${ipv4 & 0xff}`
      if (isPrivateIpv4(dotted)) return true
    }
  }
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
