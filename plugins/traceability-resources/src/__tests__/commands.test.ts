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

import type { Class, Client, Doc, DomainParams, DomainResult, OperationDomain, Ref } from '@hcengineering/core'

import {
  AGENTRA_COMMAND_DOMAIN,
  AGENTRA_OP_CREATE_DEFECT,
  AGENTRA_OP_LINK_VERIFIES,
  createDefect,
  createDefectIdempotencyKey,
  createWorkItems,
  outcomeMayHaveWritten,
  outcomeWriteRisk,
  linkVerifies,
  linkVerifiesIdempotencyKey,
  linkVerifiesPairs
} from '../commands'

const CASE_A = 'case-a' as Ref<Doc>
const CASE_B = 'case-b' as Ref<Doc>
const REQ = 'req-1' as Ref<Doc>

interface Call {
  domain: OperationDomain
  params: DomainParams
}

function fakeClient (reply: (params: DomainParams) => unknown, calls: Call[] = []): Client {
  return {
    async domainRequest (domain: OperationDomain, params: DomainParams): Promise<DomainResult<unknown>> {
      calls.push({ domain, params })
      const result: DomainResult<unknown> = { domain, value: reply(params) }
      return result
    }
  } as unknown as Client
}

function ok (result: Record<string, any>): unknown {
  return { ok: true, executionId: 'x', replayed: false, preempted: false, result }
}

describe('the verifies idempotency key', () => {
  it('is a pure function of the pair', () => {
    // 🔴 THE WHOLE POINT. A per-click key would make every repetition a new
    // ledger row, so the ledger would stay correct and never be consulted.
    expect(linkVerifiesIdempotencyKey(CASE_A, REQ)).toBe(linkVerifiesIdempotencyKey(CASE_A, REQ))
    expect(linkVerifiesIdempotencyKey(CASE_A, REQ)).not.toBe(linkVerifiesIdempotencyKey(CASE_B, REQ))
  })

  it('is directional: (case, requirement) is not (requirement, case)', () => {
    expect(linkVerifiesIdempotencyKey(CASE_A, REQ)).not.toBe(linkVerifiesIdempotencyKey(REQ, CASE_A))
  })

  it('carries the versioned prefix that pins it to the persisted ledger rows', () => {
    expect(linkVerifiesIdempotencyKey(CASE_A, REQ)).toBe(`traceability:link-verifies:v1:${CASE_A}:${REQ}`)
  })

  it('keys a defect on its target', () => {
    expect(createDefectIdempotencyKey(REQ)).toBe(`traceability:create-defect:v1:${REQ}`)
    expect(createDefectIdempotencyKey(REQ)).toBe(createDefectIdempotencyKey(REQ))
  })
})

describe('the wire shape', () => {
  it('sends the ONE operation on the Agentra command domain, under the `params` key', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => ok({ alreadyLinked: false }), calls)
    void linkVerifies(client, CASE_A, REQ)
    // ⚠️ `params`, not `query`. `DomainParams` is `Record<string, any>`, so the
    // wrong spelling is not a type error on either side — the server just reads
    // `undefined`.
    await Promise.resolve().then(() => {
      expect(calls[0].domain).toBe(AGENTRA_COMMAND_DOMAIN)
      const payload = calls[0].params[AGENTRA_OP_LINK_VERIFIES]
      expect(payload.params.testCase).toBe(CASE_A)
      expect(payload.params.requirement).toBe(REQ)
      expect(payload.params.idempotencyKey).toBe(linkVerifiesIdempotencyKey(CASE_A, REQ))
    })
  })

  it('reports "no handler" as unavailable, never as a refusal', async () => {
    // `{ domain, value: null }` is what an unrouted domain request returns. A UI
    // that read that as "refused" would tell the user to fix their input when
    // the deployment simply has no Agentra middleware.
    const outcome = await linkVerifies(
      fakeClient(() => null),
      CASE_A,
      REQ
    )
    expect(outcome.kind).toBe('unavailable')
  })

  it('marks a 409 retryable and everything else terminal', async () => {
    const conflict = await linkVerifies(
      fakeClient(() => ({ ok: false, code: 409, reason: 'command-in-progress', message: 'busy' })),
      CASE_A,
      REQ
    )
    expect(conflict).toMatchObject({ kind: 'refused', retryable: true })

    const refused = await linkVerifies(
      fakeClient(() => ({ ok: false, code: 400, reason: 'requirement-not-latest', message: 'old' })),
      CASE_A,
      REQ
    )
    expect(refused).toMatchObject({ kind: 'refused', retryable: false })
  })

  it('turns a thrown platform error into a rendered state instead of escaping the handler', async () => {
    const client = {
      async domainRequest (): Promise<DomainResult<unknown>> {
        throw new Error('socket closed')
      }
    } as unknown as Client
    expect(await linkVerifies(client, CASE_A, REQ)).toMatchObject({ kind: 'errored' })
  })

  it('sends the defect target class and project through unchanged', async () => {
    const calls: Call[] = []
    await createDefect(
      fakeClient(() => ok({ bug: 'b', alreadyReported: false }), calls),
      'result-1' as Ref<Doc>,
      'testManagement:class:TestResult' as Ref<Class<Doc>>,
      'project-1' as Ref<Doc>,
      { actual: 'a 500 page' }
    )
    const payload = calls[0].params[AGENTRA_OP_CREATE_DEFECT]
    expect(payload.params.targetClass).toBe('testManagement:class:TestResult')
    expect(payload.params.actual).toBe('a 500 page')
    expect(payload.params.idempotencyKey).toBe(createDefectIdempotencyKey('result-1' as Ref<Doc>))
  })
})

describe('linkVerifiesPairs', () => {
  it('calls the SAME command once per pair, each on its own pair key', async () => {
    const calls: Call[] = []
    const batch = await linkVerifiesPairs(
      fakeClient(() => ok({ alreadyLinked: false }), calls),
      [
        { testCase: CASE_A, requirement: REQ },
        { testCase: CASE_B, requirement: REQ }
      ]
    )
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.params[AGENTRA_OP_LINK_VERIFIES] !== undefined)).toBe(true)
    expect(calls.map((c) => c.params[AGENTRA_OP_LINK_VERIFIES].params.idempotencyKey)).toEqual([
      linkVerifiesIdempotencyKey(CASE_A, REQ),
      linkVerifiesIdempotencyKey(CASE_B, REQ)
    ])
    expect(batch).toEqual({ linked: 2, alreadyLinked: 0, failures: [] })
  })

  it('counts an already-linked pair as a success, not a failure', async () => {
    const batch = await linkVerifiesPairs(
      fakeClient(() => ok({ alreadyLinked: true })),
      [{ testCase: CASE_A, requirement: REQ }]
    )
    expect(batch.alreadyLinked).toBe(1)
    expect(batch.failures).toHaveLength(0)
  })

  it('does NOT stop at the first failure', async () => {
    // 🔴 Abandoning the rest would silently drop work the user asked for, and
    // the retry is free because the pairs that landed replay.
    const calls: Call[] = []
    const client = fakeClient((params) => {
      const key = params[AGENTRA_OP_LINK_VERIFIES].params.testCase
      return key === CASE_A
        ? { ok: false, code: 400, reason: 'test-case-not-found', message: 'gone' }
        : ok({ alreadyLinked: false })
    }, calls)
    const batch = await linkVerifiesPairs(client, [
      { testCase: CASE_A, requirement: REQ },
      { testCase: CASE_B, requirement: REQ }
    ])
    expect(calls).toHaveLength(2)
    expect(batch.linked).toBe(1)
    expect(batch.failures).toHaveLength(1)
    expect(batch.failures[0].pair.testCase).toBe(CASE_A)
  })
})

describe('a refusal says whether it may have written', () => {
  const PROJECT = 'proj-1' as Ref<Doc>

  function refuse (envelope: Record<string, any>): Client {
    return fakeClient(() => ({ ok: false, code: 400, message: 'no', ...envelope }))
  }

  it('carries the server classification through untouched', async () => {
    const outcome = await createWorkItems(
      refuse({ reason: 'task-type-not-found', partialWrite: 'possible', itemsWritten: 2 }),
      REQ,
      PROJECT,
      [{ title: 'a' }],
      'b1'
    )
    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'task-type-not-found',
      message: 'no',
      retryable: false,
      partialWrite: 'possible',
      itemsWritten: 2
    })
    expect(outcomeMayHaveWritten(outcome)).toBe(true)
  })

  it('lets a clean refusal say nothing was created', async () => {
    const outcome = await createWorkItems(
      refuse({ reason: 'project-not-found', partialWrite: 'none', itemsWritten: 0 }),
      REQ,
      PROJECT,
      [{ title: 'a' }],
      'b1'
    )
    expect(outcomeWriteRisk(outcome)).toBe('none')
    expect(outcomeMayHaveWritten(outcome)).toBe(false)
  })

  it('🔴 reads a MISSING classification as `unclassified`, never as clean', async () => {
    // A server that predates the field has not told us the batch is empty; it
    // has told us nothing, and the safe reading of nothing is "assume it wrote".
    const outcome = await createWorkItems(refuse({ reason: 'whatever' }), REQ, PROJECT, [{ title: 'a' }], 'b1')
    expect(outcomeWriteRisk(outcome)).toBe('unclassified')
    expect(outcomeMayHaveWritten(outcome)).toBe(true)
  })

  it('keeps the write risk orthogonal to retryability', async () => {
    // 409 over a batch another attempt is halfway through: retryable AND dirty.
    const client = fakeClient(() => ({
      ok: false,
      code: 409,
      reason: 'command-in-progress',
      message: 'busy',
      partialWrite: 'possible'
    }))
    const outcome = await createWorkItems(client, REQ, PROJECT, [{ title: 'a' }], 'b1')
    expect(outcome).toMatchObject({ kind: 'refused', retryable: true, partialWrite: 'possible' })
  })

  it('answers for the three outcomes the wire cannot speak about', () => {
    expect(outcomeWriteRisk({ kind: 'unavailable' })).toBe('none')
    expect(outcomeWriteRisk({ kind: 'errored', message: 'lost' })).toBe('possible')
    expect(outcomeWriteRisk({ kind: 'ok', result: {}, replayed: false })).toBe('possible')
    expect(outcomeWriteRisk(undefined)).toBe('none')
  })
})
