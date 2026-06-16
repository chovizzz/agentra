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

import { SsrfError, createPinnedLookup, isBlockedHost, resolveSafeAddress, validateFetchUrl } from '../ssrf'

describe('isBlockedHost', () => {
  it('blocks localhost and *.localhost', () => {
    expect(isBlockedHost('localhost')).toBe(true)
    expect(isBlockedHost('app.localhost')).toBe(true)
    expect(isBlockedHost('LOCALHOST')).toBe(true)
  })

  it('blocks loopback IPv4', () => {
    expect(isBlockedHost('127.0.0.1')).toBe(true)
    expect(isBlockedHost('127.255.255.254')).toBe(true)
  })

  it('blocks private IPv4 ranges', () => {
    expect(isBlockedHost('10.0.0.1')).toBe(true)
    expect(isBlockedHost('172.16.0.1')).toBe(true)
    expect(isBlockedHost('172.31.255.255')).toBe(true)
    expect(isBlockedHost('192.168.1.1')).toBe(true)
  })

  it('blocks link-local and unspecified IPv4', () => {
    expect(isBlockedHost('169.254.169.254')).toBe(true)
    expect(isBlockedHost('0.0.0.0')).toBe(true)
  })

  it('does not block public IPv4', () => {
    expect(isBlockedHost('8.8.8.8')).toBe(false)
    expect(isBlockedHost('1.1.1.1')).toBe(false)
    expect(isBlockedHost('172.32.0.1')).toBe(false)
    expect(isBlockedHost('172.15.255.255')).toBe(false)
  })

  it('blocks CGNAT, multicast, reserved and broadcast IPv4', () => {
    expect(isBlockedHost('100.64.0.1')).toBe(true)
    expect(isBlockedHost('100.127.255.255')).toBe(true)
    expect(isBlockedHost('224.0.0.1')).toBe(true)
    expect(isBlockedHost('240.0.0.1')).toBe(true)
    expect(isBlockedHost('255.255.255.255')).toBe(true)
  })

  it('does not block addresses just outside CGNAT', () => {
    expect(isBlockedHost('100.63.255.255')).toBe(false)
    expect(isBlockedHost('100.128.0.1')).toBe(false)
  })

  it('blocks loopback / unspecified / unique-local / link-local IPv6', () => {
    expect(isBlockedHost('::1')).toBe(true)
    expect(isBlockedHost('0:0:0:0:0:0:0:1')).toBe(true)
    expect(isBlockedHost('::')).toBe(true)
    expect(isBlockedHost('fc00::1')).toBe(true)
    expect(isBlockedHost('fd12:3456::1')).toBe(true)
    expect(isBlockedHost('fe80::1')).toBe(true)
    expect(isBlockedHost('febf::1')).toBe(true)
  })

  it('blocks IPv6-mapped IPv4 loopback in both dotted and hex forms', () => {
    expect(isBlockedHost('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedHost('::ffff:7f00:1')).toBe(true)
    expect(isBlockedHost('[::ffff:7f00:1]')).toBe(true)
  })

  it('blocks IPv4-compatible IPv6 and NAT64 embedded-IPv4 forms', () => {
    // ::127.0.0.1 -> ::7f00:1, ::169.254.169.254 -> ::a9fe:a9fe
    expect(isBlockedHost('::127.0.0.1')).toBe(true)
    expect(isBlockedHost('::7f00:1')).toBe(true)
    expect(isBlockedHost('::169.254.169.254')).toBe(true)
    expect(isBlockedHost('::a9fe:a9fe')).toBe(true)
    // NAT64 64:ff9b::/96 wrapping loopback / metadata
    expect(isBlockedHost('64:ff9b::7f00:1')).toBe(true)
    expect(isBlockedHost('64:ff9b::169.254.169.254')).toBe(true)
  })

  it('strips IPv6 zone ids before checking', () => {
    expect(isBlockedHost('fe80::1%eth0')).toBe(true)
  })

  it('does not block public IPv6', () => {
    expect(isBlockedHost('2606:4700:4700::1111')).toBe(false)
    expect(isBlockedHost('2001:4860:4860::8888')).toBe(false)
  })

  it('handles bracketed and trailing-dot hostnames', () => {
    expect(isBlockedHost('[::1]')).toBe(true)
    expect(isBlockedHost('localhost.')).toBe(true)
    expect(isBlockedHost('localhost...')).toBe(true)
    expect(isBlockedHost('127.0.0.1.')).toBe(true)
    expect(isBlockedHost('example.com.')).toBe(false)
  })

  it('strips trailing dots in linear time on hostile input (ReDoS regression)', () => {
    const hostile = '.'.repeat(100000) + 'x'
    const start = Date.now()
    expect(isBlockedHost(hostile)).toBe(false)
    expect(Date.now() - start).toBeLessThan(1000)
  })
})

describe('validateFetchUrl', () => {
  it('returns a parsed URL for an allowed public https URL', () => {
    const url = validateFetchUrl('https://example.com/path?x=1')
    expect(url).toBeInstanceOf(URL)
    expect(url.hostname).toBe('example.com')
  })

  it('rejects malformed URLs', () => {
    try {
      validateFetchUrl('not a url')
      fail('expected SsrfError')
    } catch (e) {
      expect(e).toBeInstanceOf(SsrfError)
      expect((e as SsrfError).code).toBe('INVALID_URL')
    }
  })

  it('rejects disallowed protocols', () => {
    expect(() => validateFetchUrl('ftp://example.com')).toThrow(SsrfError)
    try {
      validateFetchUrl('file:///etc/passwd')
      fail('expected SsrfError')
    } catch (e) {
      expect((e as SsrfError).code).toBe('INVALID_PROTOCOL')
    }
  })

  it('honours a restricted allowedProtocols list', () => {
    expect(() => validateFetchUrl('http://example.com', { allowedProtocols: ['https:'] })).toThrow(SsrfError)
    expect(validateFetchUrl('https://example.com', { allowedProtocols: ['https:'] }).protocol).toBe('https:')
  })

  it('rejects internal/private IP-literal and localhost targets synchronously', () => {
    expect(() => validateFetchUrl('https://127.0.0.1/admin')).toThrow(SsrfError)
    expect(() => validateFetchUrl('https://[::ffff:7f00:1]/')).toThrow(SsrfError)
    expect(() => validateFetchUrl('https://localhost:4060/api')).toThrow(SsrfError)
    try {
      validateFetchUrl('https://10.0.0.5/')
      fail('expected SsrfError')
    } catch (e) {
      expect((e as SsrfError).code).toBe('BLOCKED_URL')
    }
  })

  it('does NOT block an internal DNS name on its own (DNS resolution closes that gap)', () => {
    // Hostname is not an IP literal, so the synchronous check passes; resolveSafeAddress must catch it.
    expect(() => validateFetchUrl('https://link-preview.svc.cluster.local:4060/api')).not.toThrow()
  })
})

describe('resolveSafeAddress', () => {
  it('returns the resolved address for a public host', async () => {
    const resolver = async (): Promise<Array<{ address: string, family: number }>> => [
      { address: '93.184.216.34', family: 4 }
    ]
    const result = await resolveSafeAddress('example.com', resolver)
    expect(result.address).toBe('93.184.216.34')
    expect(result.family).toBe(4)
  })

  it('blocks an internal DNS name that resolves to a private address (the report PoC)', async () => {
    const resolver = async (): Promise<Array<{ address: string, family: number }>> => [
      { address: '10.42.0.7', family: 4 }
    ]
    await expect(resolveSafeAddress('link-preview.svc.cluster.local', resolver)).rejects.toBeInstanceOf(SsrfError)
  })

  it('blocks if ANY resolved address is internal (split-horizon / rebinding defence)', async () => {
    const resolver = async (): Promise<Array<{ address: string, family: number }>> => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 }
    ]
    await expect(resolveSafeAddress('rebind.example.com', resolver)).rejects.toBeInstanceOf(SsrfError)
  })

  it('throws BLOCKED_URL when DNS returns no addresses', async () => {
    const resolver = async (): Promise<Array<{ address: string, family: number }>> => []
    try {
      await resolveSafeAddress('nowhere.example.com', resolver)
      fail('expected SsrfError')
    } catch (e) {
      expect((e as SsrfError).code).toBe('BLOCKED_URL')
    }
  })
})

describe('createPinnedLookup', () => {
  it('always returns the pinned address (single form)', (done) => {
    const lookup = createPinnedLookup({ address: '93.184.216.34', family: 4 })
    lookup('evil.example.com', {}, (err, address, family) => {
      expect(err).toBeNull()
      expect(address).toBe('93.184.216.34')
      expect(family).toBe(4)
      done()
    })
  })

  it('always returns the pinned address (all form)', (done) => {
    const lookup = createPinnedLookup({ address: '93.184.216.34', family: 4 })
    lookup('evil.example.com', { all: true }, (err, addresses) => {
      expect(err).toBeNull()
      expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
      done()
    })
  })
})
