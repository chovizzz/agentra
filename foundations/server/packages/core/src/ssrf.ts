//
// Copyright © 2026 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import dns from 'node:dns'
import net from 'node:net'
import type { LookupAddress, LookupOptions } from 'node:dns'
import type { LookupFunction } from 'node:net'

// ============================================================================
// SSRF protection
//
// Shared helpers used by any server-side component that fetches a URL supplied
// (directly or indirectly) by a caller. Blocks loopback, private, link-local
// and unique-local addresses, including IPv6-mapped-IPv4 representations.
//
// The synchronous checks cover IP literals and localhost-style hostnames.
// `resolveSafeAddress` additionally resolves DNS names and validates every
// returned address, which closes the internal-DNS-name vector (e.g.
// `link-preview.svc.cluster.local`) that an IP-literal check alone misses.
// ============================================================================

export type SsrfErrorCode = 'INVALID_URL' | 'INVALID_PROTOCOL' | 'BLOCKED_URL'

export class SsrfError extends Error {
  constructor (
    message: string,
    readonly code: SsrfErrorCode,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'SsrfError'
  }
}

export interface ValidateUrlOptions {
  /** Allowed URL protocols, including the trailing colon. Defaults to `['http:', 'https:']`. */
  allowedProtocols?: string[]
}

export interface ResolvedAddress {
  address: string
  family: number
}

/** Resolves a hostname to one or more IP addresses. Injectable for testing. */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>

const DEFAULT_ALLOWED_PROTOCOLS = ['http:', 'https:']

function normalizeHostnameForChecks (hostname: string): string {
  // URL.hostname is already punycode-normalized by WHATWG URL for IDNs.
  // Keep it lowercase for comparisons.
  const trimmed = hostname.trim().toLowerCase().replace(/\.+$/, '')
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1)
  return trimmed
}

// Expands an IPv6 literal (possibly compressed, zone-suffixed, or carrying an
// embedded dotted-IPv4 tail) into eight 16-bit groups. Returns undefined if it
// cannot be parsed, so callers can fail closed.
function expandIpv6 (input: string): number[] | undefined {
  let host = input.toLowerCase()

  // Strip a zone id, e.g. fe80::1%eth0
  const zone = host.indexOf('%')
  if (zone !== -1) host = host.slice(0, zone)

  // Fold a trailing dotted-IPv4 suffix (::ffff:1.2.3.4 or ::1.2.3.4) into two hextets.
  const v4 = host.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (v4 != null) {
    const octets = v4[1].split('.').map((p) => Number.parseInt(p, 10))
    if (octets.length !== 4 || octets.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return undefined
    const hi = ((octets[0] << 8) | octets[1]).toString(16)
    const lo = ((octets[2] << 8) | octets[3]).toString(16)
    host = host.slice(0, host.length - v4[1].length) + `${hi}:${lo}`
  }

  const halves = host.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] === '' ? [] : halves[0].split(':')

  let groups: string[]
  if (halves.length === 2) {
    const tail = halves[1] === '' ? [] : halves[1].split(':')
    const missing = 8 - head.length - tail.length
    if (missing < 0) return undefined
    groups = [...head, ...new Array<string>(missing).fill('0'), ...tail]
  } else {
    groups = head
  }
  if (groups.length !== 8) return undefined

  const hextets = groups.map((g) => Number.parseInt(g === '' ? '0' : g, 16))
  if (hextets.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return undefined
  return hextets
}

// Renders the low 32 bits of an expanded IPv6 address as a dotted IPv4 string.
function embeddedIpv4 (h: number[]): string {
  return `${(h[6] >> 8) & 0xff}.${h[6] & 0xff}.${(h[7] >> 8) & 0xff}.${h[7] & 0xff}`
}

export function isBlockedIpv4 (ipv4: string): boolean {
  const parts = ipv4.split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true

  const [a, b] = parts

  // 0.0.0.0/8
  if (a === 0) return true
  // 127.0.0.0/8 loopback
  if (a === 127) return true
  // 10.0.0.0/8
  if (a === 10) return true
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true
  // 169.254.0.0/16 link-local (incl. cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true
  // 100.64.0.0/10 carrier-grade NAT (common inside cloud/k8s networks)
  if (a === 100 && b >= 64 && b <= 127) return true
  // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved (incl. 255.255.255.255 broadcast)
  if (a >= 224) return true

  return false
}

export function isBlockedIpv6 (ipv6: string): boolean {
  const h = expandIpv6(ipv6)
  if (h === undefined) return true // fail closed on anything we cannot parse

  // unspecified ::
  if (h.every((x) => x === 0)) return true
  // loopback ::1
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true
  // unique-local fc00::/7
  if ((h[0] & 0xfe00) === 0xfc00) return true
  // link-local fe80::/10
  if ((h[0] & 0xffc0) === 0xfe80) return true

  // Embedded-IPv4 forms — defer to the IPv4 blocklist for the low 32 bits:
  //   IPv4-compatible ::/96, IPv4-mapped ::ffff:0:0/96, NAT64 64:ff9b::/96.
  const high96Zero = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0
  const isV4Compatible = high96Zero && h[5] === 0
  const isV4Mapped = high96Zero && h[5] === 0xffff
  const isNat64 = h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0
  if (isV4Compatible || isV4Mapped || isNat64) {
    return isBlockedIpv4(embeddedIpv4(h))
  }

  return false
}

/**
 * Returns true if the given host (IP literal or hostname) must not be fetched.
 *
 * This performs no DNS resolution: it blocks IP literals in private/internal
 * ranges and localhost-style names. Use `resolveSafeAddress` to also guard
 * against DNS names that resolve to internal addresses.
 */
export function isBlockedHost (hostname: string): boolean {
  const host = normalizeHostnameForChecks(hostname)
  if (host === 'localhost') return true

  const ipType = net.isIP(host)
  if (ipType === 4) return isBlockedIpv4(host)
  if (ipType === 6) return isBlockedIpv6(host)

  // Some Node versions are stricter about IPv6 parsing. If it still looks like an IPv6 literal,
  // apply our IPv6 checks anyway (covers IPv6-mapped IPv4 forms like ::ffff:7f00:1).
  if (host.includes(':') && isBlockedIpv6(host)) return true

  // Hostname is not an IP literal. Keep explicit localhost-ish blocks.
  if (host.endsWith('.localhost')) return true

  return false
}

/**
 * Parses and validates a URL for outbound fetching.
 *
 * Throws {@link SsrfError} on a malformed URL, a disallowed protocol, or an
 * internal/private IP-literal or localhost target. Hostnames that are not IP
 * literals pass this synchronous check and must additionally be validated with
 * {@link resolveSafeAddress} before connecting.
 */
export function validateFetchUrl (urlString: string, options: ValidateUrlOptions = {}): URL {
  let url: URL
  try {
    url = new URL(urlString)
  } catch {
    throw new SsrfError(`Invalid URL: ${urlString}`, 'INVALID_URL')
  }

  const allowed = options.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS
  if (!allowed.includes(url.protocol)) {
    throw new SsrfError(`Invalid protocol: ${url.protocol}. Allowed: ${allowed.join(', ')}.`, 'INVALID_PROTOCOL')
  }

  if (isBlockedHost(url.hostname)) {
    throw new SsrfError('Blocked URL: access to internal addresses is not allowed.', 'BLOCKED_URL')
  }

  return url
}

const defaultResolver: HostResolver = async (hostname) =>
  await new Promise<ResolvedAddress[]>((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err != null) {
        reject(new SsrfError(`DNS resolution failed for ${hostname}`, 'BLOCKED_URL', err))
        return
      }
      resolve(addresses.map((a) => ({ address: a.address, family: a.family })))
    })
  })

/**
 * Resolves a hostname and validates every returned address against the
 * SSRF blocklist. Returns the first resolved address so the caller can pin the
 * connection to it (defeating DNS rebinding between validation and connect).
 *
 * Throws {@link SsrfError} (`BLOCKED_URL`) if resolution yields no addresses or
 * if any resolved address is internal/private.
 */
export async function resolveSafeAddress (
  hostname: string,
  resolver: HostResolver = defaultResolver
): Promise<ResolvedAddress> {
  // IP literals are fully validated synchronously; no resolution required.
  if (net.isIP(normalizeHostnameForChecks(hostname)) !== 0) {
    if (isBlockedHost(hostname)) {
      throw new SsrfError('Blocked URL: access to internal addresses is not allowed.', 'BLOCKED_URL')
    }
    const literal = normalizeHostnameForChecks(hostname)
    return { address: literal, family: net.isIP(literal) }
  }

  const addresses = await resolver(hostname)
  if (addresses.length === 0) {
    throw new SsrfError(`Blocked URL: ${hostname} did not resolve to any address.`, 'BLOCKED_URL')
  }
  for (const { address } of addresses) {
    if (isBlockedHost(address)) {
      throw new SsrfError('Blocked URL: host resolves to an internal address.', 'BLOCKED_URL')
    }
  }
  return addresses[0]
}

/**
 * Builds a `lookup` function (compatible with the `lookup` option of
 * `http.get` / `https.get` / `net.connect`) that always returns the given,
 * already-validated address. Pinning the connection to the validated address
 * prevents DNS rebinding between {@link resolveSafeAddress} and the actual
 * connect, where a hostile resolver could otherwise swap in an internal IP.
 */
export function createPinnedLookup (resolved: ResolvedAddress): LookupFunction {
  return (_hostname: string, options: LookupOptions, callback): void => {
    if (options.all === true) {
      const result: LookupAddress[] = [{ address: resolved.address, family: resolved.family }]
      callback(null, result, resolved.family)
      return
    }
    callback(null, resolved.address, resolved.family)
  }
}
