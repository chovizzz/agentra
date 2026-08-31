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

import type { Client, Doc, DomainParams, DomainResult, OperationDomain, Ref } from '@hcengineering/core'

import {
  AGENTRA_COMMAND_DOMAIN,
  AGENTRA_OP_UNLINK_IMPLEMENTS,
  linkImplementsIdempotencyKey,
  unlinkImplements,
  unlinkImplementsIdempotencyKey,
  unlinkImplementsPairs
} from '../commands'

const ISSUE_A = 'issue-a' as Ref<Doc>
const ISSUE_B = 'issue-b' as Ref<Doc>
const REQ = 'req-1' as Ref<Doc>
const REQ_B = 'req-2' as Ref<Doc>

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

describe('the unlink idempotency key', () => {
  it('is a pure function of the pair', () => {
    expect(unlinkImplementsIdempotencyKey(ISSUE_A, REQ)).toBe(unlinkImplementsIdempotencyKey(ISSUE_A, REQ))
    // 🔴 BOTH ids matter. A key that bound only one end would let a withdrawal
    // of (A, R) replay for (A, S) and (B, R).
    expect(unlinkImplementsIdempotencyKey(ISSUE_A, REQ)).not.toBe(unlinkImplementsIdempotencyKey(ISSUE_B, REQ))
    expect(unlinkImplementsIdempotencyKey(ISSUE_A, REQ)).not.toBe(unlinkImplementsIdempotencyKey(ISSUE_A, REQ_B))
  })

  it('never collides with the LINK key for the same pair', () => {
    // 🔴 The two intents address rows under two different server command
    // namespaces; a shared key would be one typo away from a link and an unlink
    // of one pair colliding on one ledger row, and "unlink" would answer
    // "linked".
    expect(unlinkImplementsIdempotencyKey(ISSUE_A, REQ)).not.toBe(linkImplementsIdempotencyKey(ISSUE_A, REQ))
  })
})

describe('unlinkImplements', () => {
  it('calls the unlink operation with the pair and the derived key', async () => {
    const calls: Call[] = []
    const client = fakeClient(
      () => ok({ workItem: ISSUE_A, requirement: REQ, traceLink: 'edge-1', alreadyRevoked: false }),
      calls
    )
    const outcome = await unlinkImplements(client, ISSUE_A, REQ)

    expect(outcome.kind).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0].domain).toBe(AGENTRA_COMMAND_DOMAIN)
    // ⚠️ `params`, the same inner key the server destructures. `DomainParams` is
    // `Record<string, any>`, so a different spelling is not a type error on
    // either side — the server would simply read `undefined`.
    expect(calls[0].params[AGENTRA_OP_UNLINK_IMPLEMENTS].params).toEqual({
      workItem: ISSUE_A,
      requirement: REQ,
      idempotencyKey: unlinkImplementsIdempotencyKey(ISSUE_A, REQ)
    })
  })

  it('reports an unrouted domain as unavailable, not as an empty success', async () => {
    const client = fakeClient(() => null)
    expect((await unlinkImplements(client, ISSUE_A, REQ)).kind).toBe('unavailable')
  })

  it('surfaces a refusal rather than swallowing it', async () => {
    const client = fakeClient(() => ({
      ok: false,
      code: 400,
      reason: 'link-not-found',
      message: 'nothing to withdraw'
    }))
    const outcome = await unlinkImplements(client, ISSUE_A, REQ)
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'link-not-found', retryable: false })
  })
})

describe('unlinkImplementsPairs', () => {
  it('counts revoked and already-revoked apart, and does not stop on a failure', async () => {
    const client = fakeClient((params) => {
      const { workItem } = params[AGENTRA_OP_UNLINK_IMPLEMENTS].params
      if (workItem === ISSUE_B) {
        return { ok: false, code: 400, reason: 'work-item-not-found', message: 'no' }
      }
      return ok({
        workItem,
        requirement: REQ,
        traceLink: 'edge',
        alreadyRevoked: workItem === ISSUE_A
      })
    })

    const batch = await unlinkImplementsPairs(client, [
      { workItem: ISSUE_A, requirement: REQ },
      { workItem: ISSUE_B, requirement: REQ },
      { workItem: 'issue-c' as Ref<Doc>, requirement: REQ }
    ])

    expect(batch.alreadyRevoked).toBe(1)
    expect(batch.revoked).toBe(1)
    // 🔴 The loop did NOT abandon the third pair because the second failed.
    expect(batch.failures).toHaveLength(1)
    expect(batch.failures[0].pair.workItem).toBe(ISSUE_B)
  })
})
