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
  AGENTRA_OP_CREATE_WORK_ITEMS,
  AGENTRA_OP_LINK_IMPLEMENTS,
  createWorkItems,
  createWorkItemsIdempotencyKey,
  linkImplements,
  linkImplementsIdempotencyKey,
  linkImplementsPairs
} from '../commands'

const ISSUE_A = 'issue-a' as Ref<Doc>
const ISSUE_B = 'issue-b' as Ref<Doc>
const REQ = 'req-1' as Ref<Doc>
const REQ_B = 'req-2' as Ref<Doc>
const PROJECT = 'project-1' as Ref<Doc>

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

describe('the implements idempotency key', () => {
  it('is a pure function of the pair', () => {
    // 🔴 THE WHOLE POINT. A per-click key would make every repetition a new
    // ledger row, so the ledger would stay correct and never be consulted.
    expect(linkImplementsIdempotencyKey(ISSUE_A, REQ)).toBe(linkImplementsIdempotencyKey(ISSUE_A, REQ))
    expect(linkImplementsIdempotencyKey(ISSUE_A, REQ)).not.toBe(linkImplementsIdempotencyKey(ISSUE_B, REQ))
    expect(linkImplementsIdempotencyKey(ISSUE_A, REQ)).not.toBe(linkImplementsIdempotencyKey(ISSUE_A, REQ_B))
  })

  it('is directional: (work item, requirement) is not (requirement, work item)', () => {
    expect(linkImplementsIdempotencyKey(ISSUE_A, REQ)).not.toBe(linkImplementsIdempotencyKey(REQ, ISSUE_A))
  })

  it('carries the versioned prefix that pins it to the persisted ledger rows', () => {
    expect(linkImplementsIdempotencyKey(ISSUE_A, REQ)).toBe(`traceability:link-implements:v1:${ISSUE_A}:${REQ}`)
  })

  it('separates two deliberate batches of work items', () => {
    expect(createWorkItemsIdempotencyKey(REQ, 'b1')).toBe(`traceability:create-work-items:v1:${REQ}:b1`)
    expect(createWorkItemsIdempotencyKey(REQ, 'b1')).not.toBe(createWorkItemsIdempotencyKey(REQ, 'b2'))
    expect(createWorkItemsIdempotencyKey(REQ, 'b1')).not.toBe(createWorkItemsIdempotencyKey(REQ_B, 'b1'))
  })
})

describe('the two implements entry points', () => {
  it('send the SAME operation and the SAME key from either direction', async () => {
    // 🔴 THE ACCEPTANCE CRITERION FOR TASK 12a. The requirement page pins the
    // requirement and picks work items; the issue page pins the issue and picks
    // requirements. Modelled here as the two argument orders a caller might be
    // tempted to write — the wrapper takes (work item, requirement) always, so
    // both produce one operation, one key, one ledger row and one edge.
    const fromRequirementPage: Call[] = []
    const fromIssuePage: Call[] = []
    await linkImplements(
      fakeClient(() => ok({ alreadyLinked: false }), fromRequirementPage),
      ISSUE_A,
      REQ
    )
    await linkImplements(
      fakeClient(() => ok({ alreadyLinked: true }), fromIssuePage),
      ISSUE_A,
      REQ
    )

    expect(fromRequirementPage[0].domain).toBe(AGENTRA_COMMAND_DOMAIN)
    expect(fromIssuePage[0].domain).toBe(AGENTRA_COMMAND_DOMAIN)
    const a = fromRequirementPage[0].params[AGENTRA_OP_LINK_IMPLEMENTS]
    const b = fromIssuePage[0].params[AGENTRA_OP_LINK_IMPLEMENTS]
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    // ⚠️ `params`, not `query`. `DomainParams` is `Record<string, any>`, so the
    // wrong spelling is not a type error on either side — the server just reads
    // `undefined`.
    expect(a.params).toEqual(b.params)
    expect(a.params.workItem).toBe(ISSUE_A)
    expect(a.params.requirement).toBe(REQ)
    expect(a.params.idempotencyKey).toBe(linkImplementsIdempotencyKey(ISSUE_A, REQ))
  })

  it('never sends a reversed operation name', async () => {
    const calls: Call[] = []
    await linkImplements(
      fakeClient(() => ok({ alreadyLinked: false }), calls),
      ISSUE_A,
      REQ
    )
    expect(Object.keys(calls[0].params)).toEqual([AGENTRA_OP_LINK_IMPLEMENTS])
  })
})

describe('linkImplementsPairs', () => {
  it('calls the ONE command once per pair, each on its own pair key', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => ok({ alreadyLinked: false }), calls)
    const batch = await linkImplementsPairs(client, [
      { workItem: ISSUE_A, requirement: REQ },
      { workItem: ISSUE_B, requirement: REQ }
    ])
    expect(batch.linked).toBe(2)
    expect(batch.alreadyLinked).toBe(0)
    expect(calls.length).toBe(2)
    expect(calls.map((c) => c.params[AGENTRA_OP_LINK_IMPLEMENTS].params.idempotencyKey)).toEqual([
      linkImplementsIdempotencyKey(ISSUE_A, REQ),
      linkImplementsIdempotencyKey(ISSUE_B, REQ)
    ])
  })

  it('counts an already-asserted pair as a success, not a failure', async () => {
    const batch = await linkImplementsPairs(
      fakeClient(() => ok({ alreadyLinked: true })),
      [{ workItem: ISSUE_A, requirement: REQ }]
    )
    expect(batch.alreadyLinked).toBe(1)
    expect(batch.linked).toBe(0)
    expect(batch.failures).toEqual([])
  })

  it('does NOT stop on the first failure', async () => {
    // 🔴 A bulk link is a set of independent assertions; abandoning the rest
    // because one endpoint was unreadable would silently drop work the user
    // asked for, and the retry (which replays the pairs that landed) is free.
    let seen = 0
    const client = fakeClient(() => {
      seen++
      return seen === 1
        ? { ok: false, code: 400, reason: 'requirement-not-found', message: 'no' }
        : ok({ alreadyLinked: false })
    })
    const batch = await linkImplementsPairs(client, [
      { workItem: ISSUE_A, requirement: REQ },
      { workItem: ISSUE_B, requirement: REQ }
    ])
    expect(batch.failures.length).toBe(1)
    expect(batch.failures[0].pair.workItem).toBe(ISSUE_A)
    expect(batch.linked).toBe(1)
  })

  it('reports "no handler" as unavailable, never as a refusal', async () => {
    // `{ domain, value: null }` is what an unrouted domain request returns.
    const outcome = await linkImplements(
      fakeClient(() => null),
      ISSUE_A,
      REQ
    )
    expect(outcome.kind).toBe('unavailable')
  })

  it('marks a 409 as retryable and everything else as terminal', async () => {
    const busy = await linkImplements(
      fakeClient(() => ({ ok: false, code: 409, reason: 'command-in-progress', message: 'wait' })),
      ISSUE_A,
      REQ
    )
    expect(busy).toMatchObject({ kind: 'refused', retryable: true })
    const refused = await linkImplements(
      fakeClient(() => ({ ok: false, code: 400, reason: 'requirement-not-latest', message: 'no' })),
      ISSUE_A,
      REQ
    )
    expect(refused).toMatchObject({ kind: 'refused', retryable: false })
  })
})

describe('createWorkItems', () => {
  it('sends the requirement, the project, the drafts and the batch key', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => ok({ requirement: REQ, workItems: [] }), calls)
    await createWorkItems(client, REQ, PROJECT, [{ title: 'Slice one' }], 'batch-7')
    const payload = calls[0].params[AGENTRA_OP_CREATE_WORK_ITEMS]
    expect(payload.params.requirement).toBe(REQ)
    expect(payload.params.project).toBe(PROJECT)
    expect(payload.params.items).toEqual([{ title: 'Slice one' }])
    expect(payload.params.idempotencyKey).toBe(createWorkItemsIdempotencyKey(REQ, 'batch-7'))
  })

  it('turns a thrown transport error into a rendered state', async () => {
    // Not swallowed — `toCommandResult` rethrows what it does not recognise, so
    // without this the exception would escape the click handler and the dialog
    // would sit on its opening hint as if nothing had happened.
    const client = {
      async domainRequest (): Promise<DomainResult<unknown>> {
        throw new Error('socket closed')
      }
    } as unknown as Client
    const outcome = await createWorkItems(client, REQ, PROJECT, [{ title: 'x' }], 'b')
    expect(outcome).toMatchObject({ kind: 'errored', message: 'socket closed' })
  })
})
