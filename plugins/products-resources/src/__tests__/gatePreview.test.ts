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

import type { Client, DomainParams, Ref } from '@hcengineering/core'
import type { ProductVersion } from '@hcengineering/products'

import {
  AGENTRA_COMMAND_DOMAIN,
  AGENTRA_OP_PREVIEW_RELEASE_GATE,
  parseGatePreviewResult,
  passRateDisplay,
  previewReleaseGate,
  visibleBlockers
} from '../release'

const VERSION = 'version-1' as Ref<ProductVersion>

function reply (value: unknown): Client {
  return {
    domainRequest: async (domain: string) => ({ domain, value })
  } as unknown as Client
}

describe('the wire contract of the read-only gate preview', () => {
  it('pins the operation name to the server spelling', () => {
    // 🔴 A LITERAL. `AGENTRA_OP_PREVIEW_RELEASE_GATE` on the server is the exact
    // key `handleCommand` dispatches on; a typo does not fail to compile, it
    // falls through to `{ domain, value: null }` and this client reports
    // `unavailable` forever while looking healthy.
    expect(AGENTRA_OP_PREVIEW_RELEASE_GATE).toBe('previewReleaseGate')
    expect(AGENTRA_COMMAND_DOMAIN).toBe('agentra-command')
    // And it is NOT the release operation. Sending one to the other's handler
    // is the mistake two separate constants exist to prevent.
    expect(AGENTRA_OP_PREVIEW_RELEASE_GATE).not.toBe('releaseProductVersion')
  })

  it('sends the params under the inner key `params`, not `query`', async () => {
    // 🔴 The server destructures `args.previewReleaseGate.params`. `DomainParams`
    // is `Record<string, any>`, so `query` is not a type error on either side —
    // the server simply reads `undefined` and answers `malformed-input`.
    let seenDomain: string | undefined
    let seenParams: DomainParams | undefined
    const client = {
      domainRequest: async (domain: string, params: DomainParams) => {
        seenDomain = domain
        seenParams = params
        return { domain, value: null }
      }
    } as unknown as Client

    await previewReleaseGate(client, { version: VERSION })

    expect(seenDomain).toBe('agentra-command')
    expect(seenParams).toEqual({ previewReleaseGate: { params: { version: VERSION } } })
    expect((seenParams as any).previewReleaseGate.query).toBeUndefined()
  })

  it('never sends an idempotency key', async () => {
    // ⚠️ A query has no ledger row, so a key would be meaningless — and worse,
    // it would suggest this call can be replayed when it must be recomputed.
    let seenParams: DomainParams | undefined
    const client = {
      domainRequest: async (domain: string, params: DomainParams) => {
        seenParams = params
        return { domain, value: null }
      }
    } as unknown as Client

    await previewReleaseGate(client, { version: VERSION, approval: 'a-1' as any, excludeSkipped: false })

    expect(JSON.stringify(seenParams)).not.toContain('idempotencyKey')
  })

  it('reports an unrouted domain request as `unavailable`, never as a passing gate', async () => {
    expect(await previewReleaseGate(reply(null), { version: VERSION })).toEqual({ kind: 'unavailable' })
  })

  it('turns a thrown platform error into a rendered state, not an escape', async () => {
    const client = {
      domainRequest: async () => {
        throw new Error('socket closed')
      }
    } as unknown as Client
    const outcome = await previewReleaseGate(client, { version: VERSION })
    expect(outcome).toEqual({ kind: 'errored', message: 'socket closed' })
  })
})

describe('parseGatePreviewResult', () => {
  const okGate = {
    version: VERSION,
    passed: false,
    waived: false,
    blockers: [{ kind: 'blocking-defect', object: 'issue-1', detail: 'priority Urgent' }],
    restricted: false,
    passRate: 82.5,
    passRateThreshold: 100,
    notEvaluated: ['pull-request-merged']
  }

  it('reads a well formed preview', () => {
    expect(
      parseGatePreviewResult({
        ok: true,
        result: { version: VERSION, gate: okGate, releasable: true, alreadyReleased: false }
      })
    ).toEqual({
      kind: 'ready',
      result: {
        version: VERSION,
        gate: expect.objectContaining({ passed: false, passRate: 82.5 }),
        releasable: true,
        alreadyReleased: false
      }
    })
  })

  it('🔴 FAILS CLOSED: an unreadable gate is `unavailable`, not an empty green report', () => {
    // Rendering "ready to release" because the answer could not be parsed is the
    // one claim this page has no evidence for.
    expect(parseGatePreviewResult({ ok: true, result: { version: VERSION } })).toEqual({ kind: 'unavailable' })
    expect(parseGatePreviewResult({ ok: true, result: { version: VERSION, gate: { passed: true } } })).toEqual({
      kind: 'unavailable'
    })
    expect(parseGatePreviewResult({ ok: true })).toEqual({ kind: 'unavailable' })
    expect(parseGatePreviewResult(undefined)).toEqual({ kind: 'unavailable' })
    expect(parseGatePreviewResult('nope')).toEqual({ kind: 'unavailable' })
  })

  it('reads a refusal, and has NO `in-progress` state to fall into', () => {
    // There is no ledger claim behind a query, so 409 cannot arise. A 409 that
    // somehow did would land on `refused` — never on a retry button.
    expect(
      parseGatePreviewResult({
        ok: false,
        code: 400,
        reason: 'version-not-found',
        message: "Product version 'version-1' does not exist"
      })
    ).toEqual({
      kind: 'refused',
      code: 400,
      reason: 'version-not-found',
      message: "Product version 'version-1' does not exist"
    })
    expect(parseGatePreviewResult({ ok: false, code: 409, reason: 'command-in-progress', message: '' })).toEqual({
      kind: 'refused',
      code: 409,
      reason: 'command-in-progress',
      message: ''
    })
  })

  it('🔴 keeps `restricted` a BOOLEAN and never reconstructs the count', () => {
    // The server collapses every withheld blocker into ONE contentless entry so
    // that "how many P0 defects are open in a project you cannot read" stays
    // unanswerable. The preview is not a wider door than the release.
    const outcome = parseGatePreviewResult({
      ok: true,
      result: {
        version: VERSION,
        gate: { ...okGate, blockers: [{ kind: 'restricted' }], restricted: true, passRate: undefined },
        releasable: true,
        alreadyReleased: false
      }
    })

    expect(outcome.kind).toBe('ready')
    const gate = (outcome as any).result.gate
    expect(gate.restricted).toBe(true)
    // Stripped from the rendered list and re-surfaced as one sentence.
    expect(visibleBlockers(gate)).toEqual([])
    // 🔴 ABSENT IS NOT 0%. Under restriction the rate is suppressed, and the
    // page must say "not shown", never a number derived from unreadable runs.
    expect(gate.passRate).toBeUndefined()
    expect(passRateDisplay(gate)).toEqual({ kind: 'restricted' })
  })

  it('carries a NO-VERDICTS gate through as "no verdicts", not as 0%', () => {
    const outcome = parseGatePreviewResult({
      ok: true,
      result: {
        version: VERSION,
        gate: { ...okGate, blockers: [{ kind: 'test-run-no-verdicts' }], passRate: undefined },
        releasable: true,
        alreadyReleased: false
      }
    })
    expect(passRateDisplay((outcome as any).result.gate)).toEqual({ kind: 'no-verdicts' })
  })

  it('defaults the lifecycle flags to the SAFE side when the server omits them', () => {
    // `releasable` missing means "do not offer the button", never "offer it".
    const outcome = parseGatePreviewResult({ ok: true, result: { version: VERSION, gate: okGate } })
    expect((outcome as any).result.releasable).toBe(false)
    expect((outcome as any).result.alreadyReleased).toBe(false)
  })
})
