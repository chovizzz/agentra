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

import type { Client, Doc, DomainParams, Ref } from '@hcengineering/core'
import { ProductVersionState, type ProductVersion } from '@hcengineering/products'

import {
  AGENTRA_COMMAND_DOMAIN,
  AGENTRA_OP_RELEASE_PRODUCT_VERSION,
  RELEASABLE_FROM,
  RELEASE_KEY_PREFIX,
  blockerLabel,
  canReleaseProductVersionState,
  parseGateReport,
  parseReleaseResult,
  passRateDisplay,
  releaseProductVersion,
  releaseProductVersionIdempotencyKey,
  releaseReasonLabel,
  visibleBlockers,
  type ReleaseGateReport
} from '../release'
import products from '../plugin'

const VERSION = 'version-1' as Ref<ProductVersion>

function gate (over: Partial<ReleaseGateReport> = {}): ReleaseGateReport {
  return {
    version: VERSION,
    passed: true,
    waived: false,
    blockers: [],
    restricted: false,
    passRateThreshold: 100,
    notEvaluated: [],
    ...over
  }
}

describe('the wire contract with `agentra-command`', () => {
  it('pins the domain and the operation name to the server spellings', () => {
    // 🔴 LITERALS ON PURPOSE. Both are plain strings on the wire; a typo does
    // not fail to compile, it falls through `provideDomainRequest` to
    // `{ domain, value: null }` and this client would report `unavailable`
    // forever while looking perfectly healthy.
    expect(AGENTRA_COMMAND_DOMAIN).toBe('agentra-command')
    expect(AGENTRA_OP_RELEASE_PRODUCT_VERSION).toBe('releaseProductVersion')
  })

  it('derives the idempotency key exactly as the server does', () => {
    // 🔴 THE LITERAL IS THE ASSERTION. `releaseProductVersionIdempotencyKey` in
    // `server-plugins/agentra-core-resources/src/commands/releaseProductVersion.ts`
    // returns `products:release-product-version:v1:${version}`. This package
    // cannot import it (a browser bundle must not depend on a `server-*` one),
    // so the copy is pinned here instead. A divergence would silently point
    // every future request away from the executions already recorded.
    expect(RELEASE_KEY_PREFIX).toBe('products:release-product-version:v1')
    expect(releaseProductVersionIdempotencyKey(VERSION)).toBe('products:release-product-version:v1:version-1')
  })

  it('is a PURE FUNCTION of the version — no clock, no nonce, no identity', () => {
    // 🔴 THE POINT OF THE WHOLE LEDGER. A double click, a reopened popup, an F5
    // mid-flight and a second tab must present the SAME key, or the outer claim
    // has nothing to deduplicate and the second caller races the first instead
    // of replaying it.
    const first = releaseProductVersionIdempotencyKey(VERSION)
    const second = releaseProductVersionIdempotencyKey(VERSION)
    expect(second).toBe(first)
    expect(releaseProductVersionIdempotencyKey('version-2' as Ref<Doc>)).not.toBe(first)
    // No timestamp anywhere in it.
    expect(first).not.toMatch(/\d{10,}/)
  })

  it('sends the params under the inner key `params`, not `query`', async () => {
    // 🔴 `AgentraCommandRequestMiddleware.handleCommand` destructures
    // `args.releaseProductVersion.params`. `DomainParams` is
    // `Record<string, any>`, so `query` would not be a type error on either
    // side — the server would simply read `undefined`.
    let seenDomain: string | undefined
    let seenParams: DomainParams | undefined
    const client = {
      domainRequest: async (domain: string, params: DomainParams) => {
        seenDomain = domain
        seenParams = params
        return { domain, value: null }
      }
    } as unknown as Client

    await releaseProductVersion(client, { version: VERSION, idempotencyKey: 'k' })

    expect(seenDomain).toBe('agentra-command')
    expect(seenParams).toEqual({ releaseProductVersion: { params: { version: VERSION, idempotencyKey: 'k' } } })
    expect((seenParams as any).releaseProductVersion.query).toBeUndefined()
  })

  it('reports an unrouted domain request as `unavailable` rather than as success', async () => {
    const client = {
      domainRequest: async (domain: string) => ({ domain, value: null })
    } as unknown as Client
    expect(await releaseProductVersion(client, { version: VERSION, idempotencyKey: 'k' })).toEqual({
      kind: 'unavailable',
      retryable: false
    })
  })

  it('turns a thrown platform error into a rendered state, not an escape', async () => {
    const client = {
      domainRequest: async () => {
        throw new Error('socket closed')
      }
    } as unknown as Client
    const outcome = await releaseProductVersion(client, { version: VERSION, idempotencyKey: 'k' })
    expect(outcome.kind).toBe('errored')
    expect(outcome.retryable).toBe(false)
  })
})

describe('parseReleaseResult', () => {
  it('reads a fresh success', () => {
    const outcome = parseReleaseResult({
      ok: true,
      executionId: 'exec-1',
      replayed: false,
      preempted: false,
      result: { version: VERSION, released: true, gate: gate(), requirementsReleased: 3 }
    })
    expect(outcome).toMatchObject({ kind: 'released', executionId: 'exec-1', retryable: false })
    expect(outcome.kind === 'released' && outcome.result.requirementsReleased).toBe(3)
  })

  it('never claims "released just now" for a replay or an already-released version', () => {
    const base = { ok: true, executionId: 'e', result: { version: VERSION, gate: gate() } }
    expect(parseReleaseResult({ ...base, replayed: true }).kind).toBe('replayed')
    expect(parseReleaseResult({ ...base, result: { ...base.result, alreadyReleased: true } }).kind).toBe('replayed')
  })

  it('refuses to call a success a success without a readable gate report', () => {
    // 🔴 REL-003's evidence is the gate. "Released" with nothing saying why it
    // was allowed is the one thing the report exists to prevent.
    expect(parseReleaseResult({ ok: true, executionId: 'e', result: { version: VERSION } }).kind).toBe('unavailable')
    expect(parseReleaseResult({ ok: true, result: { version: VERSION, gate: gate() } }).kind).toBe('unavailable')
  })

  it('separates a retryable 409 from a non-retryable 400', () => {
    expect(parseReleaseResult({ ok: false, code: 409, reason: 'command-in-progress', message: 'x' })).toEqual({
      kind: 'in-progress',
      code: 409,
      reason: 'command-in-progress',
      message: 'x',
      retryable: true
    })
    expect(parseReleaseResult({ ok: false, code: 400, reason: 'gate-failed', message: 'x' })).toMatchObject({
      kind: 'refused',
      retryable: false
    })
  })

  it('treats an unrecognised code as NOT retryable', () => {
    expect(parseReleaseResult({ ok: false, code: 503, reason: 'whatever', message: '' })).toMatchObject({
      kind: 'refused',
      retryable: false
    })
  })
})

describe('the gate report as §7.5 allows it to be shown', () => {
  it('keeps an ABSENT pass rate absent — never 0, never 100', () => {
    // 🔴 THE BUG THIS PINS. `passRate` is omitted entirely when no test
    // produced a verdict; `?? 0` would put "0%" on the release page for a
    // version nobody has tested, and `Number(undefined)` would put "NaN%".
    const report = parseGateReport({
      version: VERSION,
      passed: false,
      blockers: [{ kind: 'test-run-no-verdicts', object: 'run-1', objectClass: 'testManagement:class:TestRun' }],
      restricted: false,
      passRateThreshold: 100,
      notEvaluated: []
    })
    expect(report).toBeDefined()
    expect(report?.passRate).toBeUndefined()
    expect('passRate' in (report as object)).toBe(false)
    expect(passRateDisplay(report as ReleaseGateReport)).toEqual({ kind: 'no-verdicts' })
  })

  it('explains an absent rate under restriction as restriction, not as "no verdicts"', () => {
    // The server suppresses the rate when the caller cannot read the runs, so
    // "no verdicts" would be a claim about test data this caller cannot see.
    expect(passRateDisplay(gate({ restricted: true }))).toEqual({ kind: 'restricted' })
  })

  it('carries a real rate through, including 0', () => {
    // ⚠️ A genuine 0% must survive: the point is that ABSENT is not 0, not that
    // 0 is impossible.
    expect(passRateDisplay(gate({ passRate: 0 }))).toEqual({ kind: 'known', value: 0 })
    expect(passRateDisplay(gate({ passRate: 87.5 }))).toEqual({ kind: 'known', value: 87.5 })
  })

  it('drops a non-numeric pass rate rather than coercing it', () => {
    const report = parseGateReport({
      version: VERSION,
      passed: true,
      blockers: [],
      passRateThreshold: 100,
      passRate: null,
      notEvaluated: []
    })
    expect(report?.passRate).toBeUndefined()
  })

  it('surfaces `restricted` as existence only — NEVER as a count', () => {
    // 🔴 THE SIDE CHANNEL. "3 blockers you may not see" tells the reader how
    // many open P0 defects live in a project they have no access to. The server
    // collapses them into ONE contentless entry; the UI strips that entry from
    // the list and shows a boolean.
    const report = parseGateReport({
      version: VERSION,
      passed: false,
      blockers: [
        { kind: 'blocking-defect', object: 'i-1', objectClass: 'tracker:class:Issue' },
        { kind: 'restricted' }
      ],
      restricted: true,
      passRateThreshold: 100,
      notEvaluated: []
    }) as ReleaseGateReport

    expect(report.restricted).toBe(true)
    // The rendered list contains no `restricted` row at all, so nothing is
    // countable.
    const shown = visibleBlockers(report)
    expect(shown).toHaveLength(1)
    expect(shown.every((it) => it.kind !== 'restricted')).toBe(true)
    // And the marker carries no payload to leak.
    const marker = report.blockers.find((it) => it.kind === 'restricted')
    expect(marker).toEqual({ kind: 'restricted' })
  })

  it('treats a `restricted` ENTRY as a restriction even without the flag', () => {
    const report = parseGateReport({
      version: VERSION,
      passed: false,
      blockers: [{ kind: 'restricted' }],
      passRateThreshold: 100,
      notEvaluated: []
    }) as ReleaseGateReport
    expect(report.restricted).toBe(true)
    expect(passRateDisplay(report)).toEqual({ kind: 'restricted' })
  })

  it('fails closed on an unreadable report rather than showing a green one', () => {
    expect(parseGateReport(null)).toBeUndefined()
    expect(parseGateReport({ passed: true })).toBeUndefined()
    expect(parseGateReport({ blockers: [] })).toBeUndefined()
  })

  it('labels every blocker kind the server can send, and falls back generically', () => {
    const kinds = [
      'requirement-not-ready',
      'work-item-open',
      'blocking-defect',
      'test-run-missing',
      'test-run-no-verdicts',
      'test-run-below-threshold',
      'approval-missing',
      'restricted'
    ]
    const labels = kinds.map(blockerLabel)
    expect(new Set(labels).size).toBe(kinds.length)
    expect(labels).not.toContain(products.string.BlockerUnknown)
    expect(blockerLabel('something-added-later')).toBe(products.string.BlockerUnknown)
  })

  it('labels every refusal reason, and falls back generically', () => {
    expect(releaseReasonLabel('gate-failed')).toBe(products.string.ReasonGateFailed)
    expect(releaseReasonLabel('waiver-without-reason')).toBe(products.string.ReasonWaiverWithoutReason)
    expect(releaseReasonLabel('malformed-input')).toBe(products.string.ReasonMalformedInput)
    expect(releaseReasonLabel('brand-new-reason')).toBe(products.string.ReasonUnknown)
  })
})

describe('which states may be released from', () => {
  it('mirrors the server list rather than comparing enum numbers', () => {
    // ⚠️ `Planning` is 2 and `Released` is 1, so any `state < Released` test
    // would be silently wrong.
    expect([...RELEASABLE_FROM]).toEqual([ProductVersionState.Active, ProductVersionState.ReleaseCandidate])
    expect(canReleaseProductVersionState(ProductVersionState.Active)).toBe(true)
    expect(canReleaseProductVersionState(ProductVersionState.ReleaseCandidate)).toBe(true)
    expect(canReleaseProductVersionState(ProductVersionState.Planning)).toBe(false)
    expect(canReleaseProductVersionState(ProductVersionState.Released)).toBe(false)
    expect(canReleaseProductVersionState(ProductVersionState.Archived)).toBe(false)
  })
})
