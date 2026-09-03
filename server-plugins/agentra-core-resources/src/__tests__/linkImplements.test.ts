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
import traceability, { traceLinkId, type TraceLink } from '@hcengineering/traceability'
import tracker, { type Issue } from '@hcengineering/tracker'
import serverAgentraCore, { commandExecutionId, type CommandExecution } from '@hcengineering/server-agentra-core'

import {
  LINK_IMPLEMENTS,
  LINK_IMPLEMENTS_PAIR,
  LinkImplementsError,
  linkImplements,
  linkImplementsCommandNamespace,
  linkImplementsPairKey
} from '../commands/linkImplements'
import { makeHarness, seed, type Harness } from './harness'

const ISSUE_ID = 'aaaaaaaaaaaaaaaaaaaaai01' as Ref<Issue>
const OTHER_ISSUE_ID = 'aaaaaaaaaaaaaaaaaaaaai02' as Ref<Issue>
const REQ_ID = 'aaaaaaaaaaaaaaaaaaaaar01' as Ref<Requirement>
const OTHER_REQ_ID = 'aaaaaaaaaaaaaaaaaaaaar02' as Ref<Requirement>
const PROJECT = 'aaaaaaaaaaaaaaaaaaaaap01' as Ref<any>

/**
 * The idempotency key the CLIENT derives — a pure function of the pair, exactly
 * as `traceability-resources` computes it. Duplicated here on purpose: if the
 * two ever drift, the two entry points stop collapsing onto the same ledger row
 * and this test is what says so.
 */
function clientKey (workItem: Ref<Issue> = ISSUE_ID, requirement: Ref<Requirement> = REQ_ID): string {
  return `traceability:link-implements:v1:${workItem}:${requirement}`
}

async function harness (opts: { isLatest?: boolean } = {}): Promise<Harness> {
  const h = await makeHarness()
  seed<Issue>(h.db, {
    _id: ISSUE_ID,
    _class: tracker.class.Issue,
    space: PROJECT,
    title: 'Wire up the SSO callback',
    identifier: 'AGE-1'
  } as any)
  seed<Issue>(h.db, {
    _id: OTHER_ISSUE_ID,
    _class: tracker.class.Issue,
    space: PROJECT,
    title: 'Unrelated work',
    identifier: 'AGE-2'
  } as any)
  seed<Requirement>(h.db, {
    _id: REQ_ID,
    _class: requirements.masterTag.Requirement as Ref<any>,
    space: requirements.space.Requirements as Ref<any>,
    title: 'Single sign-on',
    status: 'Approved',
    ...(opts.isLatest !== undefined ? { isLatest: opts.isLatest } : {})
  } as any)
  seed<Requirement>(h.db, {
    _id: OTHER_REQ_ID,
    _class: requirements.masterTag.Requirement as Ref<any>,
    space: requirements.space.Requirements as Ref<any>,
    title: 'Audit log',
    status: 'Approved'
  } as any)
  return h
}

function edgeCount (h: Harness): number {
  return h.db.find(traceability.class.TraceLink, {}).length
}

describe('the endpoint registry', () => {
  it('lets tracker.class.Issue play the WorkItem role the implements row needs', async () => {
    const { agentraTraceEndpoints } = await import('../commands/traceEndpoints')
    const { traceEndpointRoles, validateTraceLink } = await import('@hcengineering/traceability')
    // 🔴 One class, two roles. Registering only `Bug` would make every
    // `implements` edge fail closed with `unknown-source-class` at runtime while
    // every model test stayed green.
    expect(traceEndpointRoles(agentraTraceEndpoints, tracker.class.Issue)).toEqual(['Bug', 'WorkItem'])
    expect(
      validateTraceLink(
        agentraTraceEndpoints,
        'implements',
        tracker.class.Issue,
        requirements.masterTag.Requirement as Ref<any>,
        ISSUE_ID,
        REQ_ID
      ).valid
    ).toBe(true)
  })
})

describe('linkImplements', () => {
  it('creates the edge and activity on BOTH endpoints', async () => {
    const h = await harness()
    const outcome = await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
    )

    expect(outcome.replayed).toBe(false)
    expect(outcome.result.alreadyLinked).toBe(false)

    const linkId = traceLinkId('implements', ISSUE_ID, REQ_ID)
    expect(outcome.result.traceLink).toBe(linkId)

    const link = h.db.docs.get(linkId) as TraceLink
    expect(link).toBeDefined()
    // Persisted under docA/docB — the only two names the Postgres relation
    // schema promotes to indexed columns. Direction is WorkItem -> Requirement.
    expect(link.docA).toBe(ISSUE_ID)
    expect(link.docB).toBe(REQ_ID)
    expect(link.kind).toBe('implements')
    expect(link.state).toBe('active')
    expect(link.space).toBe(core.space.Workspace)

    // 🔴 DOMAIN_RELATION is excluded from Activity, so these exist only because
    // the command wrote them explicitly. `TraceLink`'s doc comment makes both
    // records a requirement of creating any edge.
    const messages = h.db.find(activity.class.DocUpdateMessage, {}) as DocUpdateMessage[]
    expect(messages.map((m) => m.attachedTo).sort()).toEqual([ISSUE_ID, REQ_ID].sort())
    expect(messages.every((m) => m.objectId === linkId)).toBe(true)
    expect(messages.every((m) => m.objectClass === traceability.class.TraceLink)).toBe(true)
  })

  it('is idempotent for a repeated click: one edge, one ledger row, no second activity', async () => {
    const h = await harness()
    const key = clientKey()
    const first = await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: key }
    )
    const second = await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: key }
    )

    expect(first.result.traceLink).toBe(second.result.traceLink)
    expect(second.replayed).toBe(true)
    expect(edgeCount(h)).toBe(1)
    expect(h.db.find(activity.class.DocUpdateMessage, {}).length).toBe(2)

    const executions = h.db.find(serverAgentraCore.class.CommandExecution, {}) as CommandExecution[]
    expect(executions.length).toBe(2)
    expect(executions.map((e) => e.command).sort()).toEqual(
      [linkImplementsCommandNamespace(ISSUE_ID, REQ_ID, 0), LINK_IMPLEMENTS_PAIR].sort()
    )
    // ⚠️ The BARE command name is never a row: a row addressed by the command
    // alone would be shared by every pair.
    expect(executions.map((e) => e.command)).not.toContain(LINK_IMPLEMENTS)
    expect(executions.every((e) => e.status === 'succeeded')).toBe(true)
  })

  it('collapses BOTH directions onto one edge through one command', async () => {
    // Entry point 1 is the requirement page ("pick work items"), entry point 2
    // is the issue page ("pick requirements"). They differ only in what the UI
    // pinned, so both arrive here as the same (workItem, requirement) input and
    // both derive the same key.
    const h = await harness()
    const fromRequirementPage = await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: clientKey(ISSUE_ID, REQ_ID) }
    )
    const fromIssuePage = await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: clientKey(ISSUE_ID, REQ_ID) }
    )

    expect(fromIssuePage.result.traceLink).toBe(fromRequirementPage.result.traceLink)
    expect(edgeCount(h)).toBe(1)
    expect(h.db.find(activity.class.DocUpdateMessage, {}).length).toBe(2)
  })

  it('collapses different entry keys onto one edge via the pair claim', async () => {
    // A bulk dialog that invented a batch key must not race a single-pair
    // caller: only the inner pair claim can make them converge.
    const h = await harness()
    const keys = [clientKey(), 'bulk-batch-7', 'issue-page-click']
    const results = []
    for (const idempotencyKey of keys) {
      results.push(
        await linkImplements(
          { ctx: h.ctx, client: h.client, runner: h.runner },
          { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey }
        )
      )
    }

    expect(new Set(results.map((r) => r.result.traceLink)).size).toBe(1)
    expect(results[0].result.alreadyLinked).toBe(false)
    expect(results[1].result.alreadyLinked).toBe(true)
    expect(results[2].result.alreadyLinked).toBe(true)
    expect(edgeCount(h)).toBe(1)
    expect(h.db.find(activity.class.DocUpdateMessage, {}).length).toBe(2)

    const executions = h.db.find(serverAgentraCore.class.CommandExecution, {}) as CommandExecution[]
    expect(executions.filter((e) => e.command === linkImplementsCommandNamespace(ISSUE_ID, REQ_ID, 0)).length).toBe(3)
    expect(executions.filter((e) => e.command === LINK_IMPLEMENTS_PAIR).length).toBe(1)
  })

  it('derives the pair ledger row from the pair alone', async () => {
    const h = await harness()
    await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: 'anything-at-all' }
    )
    const expected = commandExecutionId(LINK_IMPLEMENTS_PAIR, linkImplementsPairKey(ISSUE_ID, REQ_ID, 0))
    expect(h.db.docs.get(expected)).toBeDefined()
  })

  it('keeps one key from replaying across a DIFFERENT work item', async () => {
    // 🔴 Iron law ①. `commandExecutionId` is `sha256(command ‖ key)`; with a
    // constant command name the row would be addressed by the caller's key
    // alone, and `resume` returns a stored result WITHOUT entering the body —
    // so a key that succeeded for (issue A, requirement R) would hand back
    // issue A's edge while naming issue B.
    const h = await harness()
    const key = 'one-key-two-subjects'
    const first = await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: key }
    )
    const second = await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: OTHER_ISSUE_ID, requirement: REQ_ID, idempotencyKey: key }
    )

    expect(second.replayed).toBe(false)
    expect(second.result.workItem).toBe(OTHER_ISSUE_ID)
    expect(second.result.traceLink).not.toBe(first.result.traceLink)
    expect(second.result.traceLink).toBe(traceLinkId('implements', OTHER_ISSUE_ID, REQ_ID))
    expect(edgeCount(h)).toBe(2)
  })

  it('keeps one key from replaying across a DIFFERENT requirement', async () => {
    // ⚠️ The SECOND half of iron law ①, and the reason BOTH ids go into the
    // namespace: binding only the work item would leave the row shared by every
    // requirement that work item is linked to.
    const h = await harness()
    const key = 'one-key-two-requirements'
    const first = await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: key }
    )
    const second = await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: OTHER_REQ_ID, idempotencyKey: key }
    )

    expect(second.replayed).toBe(false)
    expect(second.result.requirement).toBe(OTHER_REQ_ID)
    expect(second.result.traceLink).not.toBe(first.result.traceLink)
    expect(edgeCount(h)).toBe(2)
  })

  it('refuses a superseded requirement revision', async () => {
    const h = await harness({ isLatest: false })
    await expect(
      linkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
      )
    ).rejects.toMatchObject({ name: 'LinkImplementsError', reason: 'requirement-not-latest' })
    expect(edgeCount(h)).toBe(0)
  })

  it('accepts a requirement with no isLatest flag at all', async () => {
    const h = await harness()
    const outcome = await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
    )
    expect(outcome.result.alreadyLinked).toBe(false)
  })

  it('refuses when either endpoint is unreadable for the caller', async () => {
    const h = await harness()
    h.db.hidden.add(REQ_ID)
    await expect(
      linkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
      )
    ).rejects.toMatchObject({ reason: 'requirement-not-found' })
    expect(edgeCount(h)).toBe(0)

    h.db.hidden.delete(REQ_ID)
    h.db.hidden.add(ISSUE_ID)
    await expect(
      linkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: 'k2' }
      )
    ).rejects.toMatchObject({ reason: 'work-item-not-found' })
    expect(edgeCount(h)).toBe(0)
  })

  it('refuses a REPLAY to a caller who lost access to the REQUIREMENT', async () => {
    // 🔴 Iron law ②, direction 1. The ledger replays a stored result without
    // re-entering the body, so without the pre-runner check a caller with no
    // access would get a clean success and learn that the pair is linked.
    // ⚠️ This is a DIFFERENT hole from iron law ①: the namespacing above stops a
    // key crossing between subjects, it does nothing about a replay of the
    // caller's own subject after access is withdrawn.
    const h = await harness()
    await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
    )
    h.db.hidden.add(REQ_ID)
    await expect(
      linkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
      )
    ).rejects.toMatchObject({ reason: 'requirement-not-found' })
    // A different outer key still replays the inner pair claim — same answer.
    await expect(
      linkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: 'another-key' }
      )
    ).rejects.toMatchObject({ reason: 'requirement-not-found' })
  })

  it('refuses a REPLAY to a caller who lost access to the WORK ITEM', async () => {
    // 🔴 Iron law ②, direction 2. The issue-page entry point pins the issue, so
    // the guard has to cover that end too — checking only the requirement would
    // leak the existence of a linked issue in a project the caller cannot see.
    const h = await harness()
    await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
    )
    h.db.hidden.add(ISSUE_ID)
    await expect(
      linkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
      )
    ).rejects.toMatchObject({ reason: 'work-item-not-found' })
    await expect(
      linkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: 'yet-another-key' }
      )
    ).rejects.toMatchObject({ reason: 'work-item-not-found' })
  })

  it('re-enters cleanly after a partial run (edge written, activity not)', async () => {
    const h = await harness()
    const linkId = traceLinkId('implements', ISSUE_ID, REQ_ID)
    seed<TraceLink>(h.db, {
      _id: linkId,
      _class: traceability.class.TraceLink,
      docA: ISSUE_ID,
      sourceClass: tracker.class.Issue,
      docB: REQ_ID,
      targetClass: requirements.masterTag.Requirement as Ref<any>,
      kind: 'implements',
      sourceBaseId: ISSUE_ID,
      targetBaseId: REQ_ID,
      state: 'active'
    } as any)

    const outcome = await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
    )
    expect(outcome.result.alreadyLinked).toBe(true)
    expect(edgeCount(h)).toBe(1)
    // The missing half of the previous run is completed, not skipped.
    expect(h.db.find(activity.class.DocUpdateMessage, {}).length).toBe(2)
  })

  it('refuses a concurrent second caller rather than silently succeeding', async () => {
    const h = await harness()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = h.client.findOne.bind(h.client)
    // ⚠️ The SECOND issue read is gated, not the first: the pre-runner
    // readability guard (iron law ②) already consumed one, so gating the first
    // would hold the request before it ever reached the claim.
    let seenIssueReads = 0
    ;(h.client as any).findOne = async (_class: any, query: any, options?: any) => {
      if (_class === tracker.class.Issue) {
        seenIssueReads++
        if (seenIssueReads === 2) {
          await gate
        }
      }
      return await original(_class, query, options)
    }

    const first = linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: 'key-a' }
    ).catch((err: unknown) => err)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: 'key-b' }
    ).catch((err: unknown) => err)

    release()
    const outcomes = [await first, await second]

    // 🔴 THE INVARIANT IS "EXACTLY ONE EDGE", not "both succeed".
    for (const outcome of outcomes) {
      if (outcome instanceof Error) {
        expect(['CommandInProgressError', 'CommandPreemptedError']).toContain(outcome.name)
      } else {
        expect((outcome as any).result.traceLink).toBe(traceLinkId('implements', ISSUE_ID, REQ_ID))
      }
    }
    expect(outcomes.some((it) => !(it instanceof Error))).toBe(true)
    expect(edgeCount(h)).toBe(1)
  })

  it('reports an unknown class instead of writing an edge the matrix forbids', async () => {
    const h = await harness()
    await expect(
      linkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner, endpoints: new Map() },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: clientKey() }
      )
    ).rejects.toBeInstanceOf(LinkImplementsError)
    expect(edgeCount(h)).toBe(0)
  })

  it('does not widen the matrix: only WorkItem -> Requirement is accepted', async () => {
    // The dual `['Bug', 'WorkItem']` registration on `tracker.class.Issue` must
    // not let any OTHER combination through. `validateTraceLink` intersects the
    // class's roles with the matrix row, so `implements` still refuses
    // everything the spec does not list.
    const { agentraTraceEndpoints } = await import('../commands/traceEndpoints')
    const { validateTraceLink } = await import('@hcengineering/traceability')
    const testManagement = (await import('@hcengineering/test-management')).default
    const products = (await import('@hcengineering/products')).default
    const crmLite = (await import('@hcengineering/crm-lite')).default
    const A = ISSUE_ID as Ref<any>
    const B = REQ_ID as Ref<any>

    // Reversed direction.
    expect(
      validateTraceLink(
        agentraTraceEndpoints,
        'implements',
        requirements.masterTag.Requirement as Ref<any>,
        tracker.class.Issue,
        A,
        B
      )
    ).toEqual({ valid: false, reason: 'combination-not-allowed' })
    // A test case does not implement anything.
    expect(
      validateTraceLink(
        agentraTraceEndpoints,
        'implements',
        testManagement.class.TestCase,
        requirements.masterTag.Requirement as Ref<any>,
        A,
        B
      )
    ).toEqual({ valid: false, reason: 'combination-not-allowed' })
    // A work item does not implement a lead, a version or a test case.
    for (const target of [
      crmLite.masterTag.Lead as Ref<any>,
      products.class.ProductVersion as Ref<any>,
      testManagement.class.TestCase as Ref<any>
    ]) {
      expect(validateTraceLink(agentraTraceEndpoints, 'implements', tracker.class.Issue, target, A, B)).toEqual({
        valid: false,
        reason: 'combination-not-allowed'
      })
    }
    // And a self-link is still refused before any role is consulted.
    expect(
      validateTraceLink(
        agentraTraceEndpoints,
        'implements',
        tracker.class.Issue,
        requirements.masterTag.Requirement as Ref<any>,
        A,
        A
      )
    ).toEqual({ valid: false, reason: 'self-link' })
  })
})
