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

import activity, { type DocUpdateMessage } from '@hcengineering/activity'
import core, { type Ref } from '@hcengineering/core'
import requirements, { type Requirement } from '@hcengineering/requirements'
import testManagement, { type TestCase } from '@hcengineering/test-management'
import traceability, { traceLinkId, type TraceLink } from '@hcengineering/traceability'
import serverAgentraCore, { commandExecutionId, type CommandExecution } from '@hcengineering/server-agentra-core'

import {
  LINK_VERIFIES,
  linkVerifiesCommandNamespace,
  LINK_VERIFIES_PAIR,
  LinkVerifiesError,
  linkVerifies,
  linkVerifiesPairKey
} from '../commands/linkVerifies'
import { makeHarness, seed, type Harness } from './harness'

const CASE_ID = 'aaaaaaaaaaaaaaaaaaaaaac1' as Ref<TestCase>
const REQ_ID = 'aaaaaaaaaaaaaaaaaaaaaar1' as Ref<Requirement>

/**
 * The idempotency key the CLIENT derives — a pure function of the pair, exactly
 * as `traceability-resources` computes it. Duplicated here on purpose: if the
 * two ever drift, the third entry point stops collapsing onto the same ledger
 * row and this test is what says so.
 */
function clientKey (testCase: Ref<TestCase> = CASE_ID, requirement: Ref<Requirement> = REQ_ID): string {
  return `traceability:link-verifies:v1:${testCase}:${requirement}`
}

async function harness (opts: { isLatest?: boolean } = {}): Promise<Harness> {
  const h = await makeHarness()
  seed<TestCase>(h.db, {
    _id: CASE_ID,
    _class: testManagement.class.TestCase,
    space: 'test-project' as Ref<any>,
    name: 'SSO login works'
  })
  seed<Requirement>(h.db, {
    _id: REQ_ID,
    _class: requirements.masterTag.Requirement as Ref<any>,
    space: requirements.space.Requirements as Ref<any>,
    title: 'Single sign-on',
    status: 'Approved',
    ...(opts.isLatest !== undefined ? { isLatest: opts.isLatest } : {})
  } as any)
  return h
}

function edgeCount (h: Harness): number {
  return h.db.find(traceability.class.TraceLink, {}).length
}

describe('the endpoint registry', () => {
  it('registers every role the verifies and defect-of edges need', async () => {
    const { agentraTraceEndpoints } = await import('../commands/traceEndpoints')
    const { traceEndpointRoles } = await import('@hcengineering/traceability')
    // 🔴 An empty registry does not disable the check — `validateTraceLink`
    // fails CLOSED, so every link would be refused at runtime while the model
    // tests stayed green.
    expect(traceEndpointRoles(agentraTraceEndpoints, testManagement.class.TestCase)).toContain('TestCase')
    expect(traceEndpointRoles(agentraTraceEndpoints, testManagement.class.TestResult)).toContain('TestResult')
    const tracker = (await import('@hcengineering/tracker')).default
    // One class, two roles: Technical Spec §3.4 forbids a parallel Issue class.
    expect(traceEndpointRoles(agentraTraceEndpoints, tracker.class.Issue)).toEqual(['Bug', 'WorkItem'])
  })
})

describe('linkVerifies', () => {
  it('creates the edge and activity on BOTH endpoints', async () => {
    const h = await harness()
    const outcome = await linkVerifies(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
    )

    expect(outcome.replayed).toBe(false)
    expect(outcome.result.alreadyLinked).toBe(false)

    const linkId = traceLinkId('verifies', CASE_ID, REQ_ID)
    expect(outcome.result.traceLink).toBe(linkId)

    const link = h.db.docs.get(linkId) as TraceLink
    expect(link).toBeDefined()
    // Persisted under docA/docB — the only two names the Postgres relation
    // schema promotes to indexed columns.
    expect(link.docA).toBe(CASE_ID)
    expect(link.docB).toBe(REQ_ID)
    expect(link.kind).toBe('verifies')
    expect(link.state).toBe('active')
    expect(link.space).toBe(core.space.Workspace)

    // 🔴 DOMAIN_RELATION is excluded from Activity, so these exist only because
    // the command wrote them explicitly.
    const messages = h.db.find(activity.class.DocUpdateMessage, {}) as DocUpdateMessage[]
    expect(messages.map((m) => m.attachedTo).sort()).toEqual([CASE_ID, REQ_ID].sort())
    expect(messages.every((m) => m.objectId === linkId)).toBe(true)
  })

  it('is idempotent for a repeated click: one edge, one ledger row, no second activity', async () => {
    const h = await harness()
    const key = clientKey()
    const first = await linkVerifies(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey: key }
    )
    const second = await linkVerifies(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey: key }
    )

    expect(first.result.traceLink).toBe(second.result.traceLink)
    expect(second.replayed).toBe(true)
    expect(edgeCount(h)).toBe(1)
    expect(h.db.find(activity.class.DocUpdateMessage, {}).length).toBe(2)

    // One outer ledger row for the request, one inner row for the pair.
    const executions = h.db.find(serverAgentraCore.class.CommandExecution, {}) as CommandExecution[]
    expect(executions.length).toBe(2)
    // 🔴 The outer row is namespaced BY THE PAIR, not by the bare command name.
    // A constant name would put every caller's key in the same address space,
    // and a key that succeeded for one pair would replay under another.
    expect(executions.map((e) => e.command).sort()).toEqual(
      [linkVerifiesCommandNamespace(CASE_ID, REQ_ID), LINK_VERIFIES_PAIR].sort()
    )
    // ⚠️ And the BARE command name is never a row: a row addressed by the
    // command alone would be shared by every pair, which is the collision this
    // namespacing exists to prevent.
    expect(executions.map((e) => e.command)).not.toContain(LINK_VERIFIES)
    expect(executions.every((e) => e.status === 'succeeded')).toBe(true)
  })

  it('collapses THREE different entry keys onto one edge via the pair claim', async () => {
    // The three entry points (case page, requirement page, bulk dialog) are
    // modelled here as three DIFFERENT outer keys hitting the SAME command.
    // Only the inner pair claim can make them converge; without it each key
    // would run the body and the second create would surface a raw 23505.
    const h = await harness()
    const keys = [clientKey(), 'bulk-batch-7', 'requirement-page-click']
    const results = []
    for (const idempotencyKey of keys) {
      results.push(
        await linkVerifies(
          { ctx: h.ctx, client: h.client, runner: h.runner },
          { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey }
        )
      )
    }

    expect(new Set(results.map((r) => r.result.traceLink)).size).toBe(1)
    expect(results[0].result.alreadyLinked).toBe(false)
    expect(results[1].result.alreadyLinked).toBe(true)
    expect(results[2].result.alreadyLinked).toBe(true)
    expect(edgeCount(h)).toBe(1)
    expect(h.db.find(activity.class.DocUpdateMessage, {}).length).toBe(2)

    // Three outer rows (one per key) + exactly ONE pair row.
    const executions = h.db.find(serverAgentraCore.class.CommandExecution, {}) as CommandExecution[]
    expect(executions.filter((e) => e.command === linkVerifiesCommandNamespace(CASE_ID, REQ_ID)).length).toBe(3)
    expect(executions.filter((e) => e.command === LINK_VERIFIES_PAIR).length).toBe(1)
  })

  it('derives the pair ledger row from the pair alone', async () => {
    const h = await harness()
    await linkVerifies(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey: 'anything-at-all' }
    )
    // The row id must be a pure function of (case, requirement) — that is what
    // makes a second tab / second user / reload converge.
    const expected = commandExecutionId(LINK_VERIFIES_PAIR, linkVerifiesPairKey(CASE_ID, REQ_ID))
    expect(h.db.docs.get(expected)).toBeDefined()
  })

  it('refuses a concurrent second caller rather than silently succeeding', async () => {
    const h = await harness()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = h.client.findOne.bind(h.client)
    let held = false
    ;(h.client as any).findOne = async (_class: any, query: any, options?: any) => {
      if (!held && _class === testManagement.class.TestCase) {
        held = true
        await gate
      }
      return await original(_class, query, options)
    }

    const first = linkVerifies(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey: 'key-a' }
    ).catch((err: unknown) => err)
    // Let the first attempt reach the gate before the second one arrives.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = linkVerifies(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey: 'key-b' }
    ).catch((err: unknown) => err)

    release()
    const outcomes = [await first, await second]

    // 🔴 THE INVARIANT IS "EXACTLY ONE EDGE", not "both succeed". Whichever
    // caller loses the pair claim gets a 409 (retry, the result is not ready) or
    // replays the winner's result — never a silent success over a second edge.
    for (const outcome of outcomes) {
      if (outcome instanceof Error) {
        expect(['CommandInProgressError', 'CommandPreemptedError']).toContain(outcome.name)
      } else {
        expect((outcome as any).result.traceLink).toBe(traceLinkId('verifies', CASE_ID, REQ_ID))
      }
    }
    expect(outcomes.some((it) => !(it instanceof Error))).toBe(true)
    expect(edgeCount(h)).toBe(1)
  })

  it('refuses a superseded requirement revision', async () => {
    const h = await harness({ isLatest: false })
    await expect(
      linkVerifies(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
      )
    ).rejects.toMatchObject({ name: 'LinkVerifiesError', reason: 'requirement-not-latest' })
    expect(edgeCount(h)).toBe(0)
  })

  it('accepts a requirement with no isLatest flag at all', async () => {
    // `VersioningMiddleware` stamps the flag only on documents it created.
    // Treating "absent" as "superseded" would refuse every fixture and every
    // pre-migration requirement.
    const h = await harness()
    const outcome = await linkVerifies(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
    )
    expect(outcome.result.alreadyLinked).toBe(false)
  })

  it('refuses when either endpoint is unreadable for the caller', async () => {
    // The store's `hidden` set stands in for the space security filter: an
    // object the caller may not read simply does not come back from `findOne`.
    const h = await harness()
    h.db.hidden.add(REQ_ID)
    await expect(
      linkVerifies(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
      )
    ).rejects.toMatchObject({ reason: 'requirement-not-found' })
    expect(edgeCount(h)).toBe(0)

    h.db.hidden.delete(REQ_ID)
    h.db.hidden.add(CASE_ID)
    await expect(
      linkVerifies(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey: 'k2' }
      )
    ).rejects.toMatchObject({ reason: 'test-case-not-found' })
    expect(edgeCount(h)).toBe(0)
  })

  it('re-enters cleanly after a partial run (edge written, activity not)', async () => {
    // The realistic crash: the edge landed, the process died before the two
    // activity records. A replay must finish the job and NOT write a second edge.
    const h = await harness()
    const linkId = traceLinkId('verifies', CASE_ID, REQ_ID)
    seed<TraceLink>(h.db, {
      _id: linkId,
      _class: traceability.class.TraceLink,
      docA: CASE_ID,
      sourceClass: testManagement.class.TestCase,
      docB: REQ_ID,
      targetClass: requirements.masterTag.Requirement as Ref<any>,
      kind: 'verifies',
      sourceBaseId: CASE_ID,
      targetBaseId: REQ_ID,
      state: 'active'
    } as any)

    const outcome = await linkVerifies(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
    )
    expect(outcome.result.alreadyLinked).toBe(true)
    expect(edgeCount(h)).toBe(1)
    // The missing half of the previous run is completed, not skipped.
    expect(h.db.find(activity.class.DocUpdateMessage, {}).length).toBe(2)
  })

  it('refuses a REPLAY to a caller who lost access to an endpoint', async () => {
    // 🔴 The ledger replays a stored result without re-entering the body, and
    // the pair claim is keyed on ids the caller supplies — so without the
    // pre-runner check a caller with no access would get a clean success and
    // learn that the pair is linked.
    const h = await harness()
    await linkVerifies(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
    )
    h.db.hidden.add(REQ_ID)
    await expect(
      linkVerifies(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
      )
    ).rejects.toMatchObject({ reason: 'requirement-not-found' })
    // A different outer key still replays the inner pair claim — same answer.
    await expect(
      linkVerifies(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey: 'another-key' }
      )
    ).rejects.toMatchObject({ reason: 'requirement-not-found' })
  })

  it('reports an unknown class instead of writing an edge the matrix forbids', async () => {
    const h = await harness()
    await expect(
      linkVerifies(
        { ctx: h.ctx, client: h.client, runner: h.runner, endpoints: new Map() },
        { testCase: CASE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
      )
    ).rejects.toBeInstanceOf(LinkVerifiesError)
    expect(edgeCount(h)).toBe(0)
  })
})
