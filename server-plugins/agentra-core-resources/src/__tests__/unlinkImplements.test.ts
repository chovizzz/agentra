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
import core, { ClassifierKind, Hierarchy, TxFactory, type Class, type Doc, type Ref } from '@hcengineering/core'
import requirements, { type Requirement } from '@hcengineering/requirements'
import traceability, { traceLinkId, type TraceLink } from '@hcengineering/traceability'
import tracker, { type Issue } from '@hcengineering/tracker'
import serverAgentraCore, { commandExecutionId, type CommandExecution } from '@hcengineering/server-agentra-core'

import { ensureImplementsLink, linkImplements } from '../commands/linkImplements'
import {
  UNLINK_IMPLEMENTS,
  UNLINK_IMPLEMENTS_PAIR,
  UnlinkImplementsError,
  unlinkImplements,
  unlinkImplementsCommandNamespace,
  unlinkImplementsPairKey
} from '../commands/unlinkImplements'
import { ArchivableGuard, ArchivableGuardError } from '../deleteGuard'
import { makeCtx, seed, type Harness, type MemoryDb } from './harness'
import { makeHarness } from './harness'

const ISSUE_ID = 'aaaaaaaaaaaaaaaaaaaaai01' as Ref<Issue>
const OTHER_ISSUE_ID = 'aaaaaaaaaaaaaaaaaaaaai02' as Ref<Issue>
const REQ_ID = 'aaaaaaaaaaaaaaaaaaaaar01' as Ref<Requirement>
const OTHER_REQ_ID = 'aaaaaaaaaaaaaaaaaaaaar02' as Ref<Requirement>
const PROJECT = 'aaaaaaaaaaaaaaaaaaaaap01' as Ref<any>

/** The key the CLIENT derives, duplicated here exactly as `linkImplements.test.ts` does. */
function linkKey (workItem: Ref<Issue> = ISSUE_ID, requirement: Ref<Requirement> = REQ_ID): string {
  return `traceability:link-implements:v1:${workItem}:${requirement}`
}

function unlinkKey (workItem: Ref<Issue> = ISSUE_ID, requirement: Ref<Requirement> = REQ_ID): string {
  return `traceability:unlink-implements:v1:${workItem}:${requirement}`
}

async function harness (): Promise<Harness> {
  const h = await makeHarness()
  for (const _id of [ISSUE_ID, OTHER_ISSUE_ID]) {
    seed<Issue>(h.db, {
      _id,
      _class: tracker.class.Issue,
      space: PROJECT,
      title: 'Wire up the SSO callback',
      identifier: 'AGE-1'
    } as any)
  }
  for (const _id of [REQ_ID, OTHER_REQ_ID]) {
    seed<Requirement>(h.db, {
      _id,
      _class: requirements.masterTag.Requirement as Ref<any>,
      space: requirements.space.Requirements as Ref<any>,
      title: 'Single sign-on',
      status: 'Approved'
    } as any)
  }
  return h
}

/** Link the pair so there is something to withdraw. */
async function linked (
  h: Harness,
  workItem: Ref<Issue> = ISSUE_ID,
  requirement: Ref<Requirement> = REQ_ID
): Promise<void> {
  await linkImplements(
    { ctx: h.ctx, client: h.client, runner: h.runner },
    { workItem, requirement, idempotencyKey: linkKey(workItem, requirement) }
  )
}

function edge (h: Harness, workItem: Ref<Issue> = ISSUE_ID, requirement: Ref<Requirement> = REQ_ID): TraceLink {
  return h.db.docs.get(traceLinkId('implements', workItem, requirement)) as TraceLink
}

function edgeCount (h: Harness): number {
  return h.db.find(traceability.class.TraceLink, {}).length
}

describe('unlinkImplements', () => {
  it('REVOKES the edge rather than deleting it, and announces it on BOTH endpoints', async () => {
    const h = await harness()
    await linked(h)
    const before = h.db.find(activity.class.DocUpdateMessage, {}).length
    expect(before).toBe(2)

    const outcome = await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
    )

    expect(outcome.replayed).toBe(false)
    expect(outcome.result.alreadyRevoked).toBe(false)
    expect(outcome.result.traceLink).toBe(traceLinkId('implements', ISSUE_ID, REQ_ID))

    // 🔴 THE ROW SURVIVES. The matrix is an audit artefact: deleting it would
    // erase the fact that the assertion was ever made.
    expect(edgeCount(h)).toBe(1)
    expect(edge(h).state).toBe('revoked')
    // Every audit-bearing field is untouched.
    expect(edge(h).docA).toBe(ISSUE_ID)
    expect(edge(h).docB).toBe(REQ_ID)
    expect(edge(h).kind).toBe('implements')

    // 🔴 `DOMAIN_RELATION` is excluded from Activity, so these two exist only
    // because the command wrote them. Without them the CREATE announcement would
    // stand alone and the history would read as if the link were still live.
    const messages = h.db.find(activity.class.DocUpdateMessage, {}) as DocUpdateMessage[]
    expect(messages.length).toBe(4)
    const removals = messages.filter((m) => m.action === 'remove')
    expect(removals.map((m) => m.attachedTo).sort()).toEqual([ISSUE_ID, REQ_ID].sort())
    expect(removals.every((m) => m.objectClass === traceability.class.TraceLink)).toBe(true)
  })

  it('is idempotent for a repeated click: one ledger row, no second announcement', async () => {
    const h = await harness()
    await linked(h)
    const key = unlinkKey()
    const first = await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: key }
    )
    const second = await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: key }
    )

    expect(first.result.traceLink).toBe(second.result.traceLink)
    expect(second.replayed).toBe(true)
    // ⚠️ NOT `alreadyRevoked`. The OUTER row replays the stored result verbatim
    // without entering the body, and that stored result is the first attempt's
    // `false`. `alreadyRevoked` is about a DIFFERENT key finding the pair
    // already withdrawn — covered by the next test.
    expect(edge(h).state).toBe('revoked')
    expect(h.db.find(activity.class.DocUpdateMessage, {}).length).toBe(4)

    const executions = (h.db.find(serverAgentraCore.class.CommandExecution, {}) as CommandExecution[]).map(
      (e) => e.command
    )
    expect(executions).toContain(unlinkImplementsCommandNamespace(ISSUE_ID, REQ_ID, 0))
    expect(executions).toContain(UNLINK_IMPLEMENTS_PAIR)
    // ⚠️ The BARE command name is never a row: it would be shared by every pair.
    expect(executions).not.toContain(UNLINK_IMPLEMENTS)
  })

  it('collapses different entry keys onto one withdrawal via the pair claim', async () => {
    const h = await harness()
    await linked(h)
    const results = []
    for (const idempotencyKey of [unlinkKey(), 'bulk-batch-7', 'issue-page-click']) {
      results.push(
        await unlinkImplements(
          { ctx: h.ctx, client: h.client, runner: h.runner },
          { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey }
        )
      )
    }
    expect(results[0].result.alreadyRevoked).toBe(false)
    expect(results[1].result.alreadyRevoked).toBe(true)
    expect(results[2].result.alreadyRevoked).toBe(true)
    expect(h.db.find(activity.class.DocUpdateMessage, {}).length).toBe(4)

    const executions = h.db.find(serverAgentraCore.class.CommandExecution, {}) as CommandExecution[]
    expect(executions.filter((e) => e.command === UNLINK_IMPLEMENTS_PAIR).length).toBe(1)
  })

  it('derives the pair ledger row from the pair alone', async () => {
    const h = await harness()
    await linked(h)
    await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: 'anything-at-all' }
    )
    expect(
      h.db.docs.get(commandExecutionId(UNLINK_IMPLEMENTS_PAIR, unlinkImplementsPairKey(ISSUE_ID, REQ_ID, 0)))
    ).toBeDefined()
  })

  it('does NOT share a ledger row with the link of the same pair', async () => {
    // 🔴 If `unlinkImplements` reused `LINK_IMPLEMENTS_PAIR`, the link would
    // already own the row and the unlink would REPLAY "linked" without ever
    // entering its body — i.e. the edge would stay active and the caller would
    // be told it was withdrawn.
    const h = await harness()
    await linked(h)
    const outcome = await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
    )
    expect(outcome.replayed).toBe(false)
    expect(edge(h).state).toBe('revoked')
  })

  it('keeps one key from replaying across a DIFFERENT work item', async () => {
    // 🔴 Iron law ①. `commandExecutionId` is `sha256(command ‖ key)`; with a
    // constant command name the row is addressed by the caller's key alone, and
    // `resume` returns a stored result WITHOUT entering the body — so a key that
    // withdrew (issue A, requirement R) would report issue B withdrawn too,
    // while B's edge stayed live.
    const h = await harness()
    await linked(h, ISSUE_ID, REQ_ID)
    await linked(h, OTHER_ISSUE_ID, REQ_ID)
    const key = 'one-key-two-subjects'
    const first = await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: key }
    )
    const second = await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: OTHER_ISSUE_ID, requirement: REQ_ID, idempotencyKey: key }
    )

    expect(second.replayed).toBe(false)
    expect(second.result.workItem).toBe(OTHER_ISSUE_ID)
    expect(second.result.traceLink).not.toBe(first.result.traceLink)
    expect(edge(h, ISSUE_ID, REQ_ID).state).toBe('revoked')
    expect(edge(h, OTHER_ISSUE_ID, REQ_ID).state).toBe('revoked')
  })

  it('keeps one key from replaying across a DIFFERENT requirement', async () => {
    // ⚠️ The SECOND half of iron law ①, and the reason BOTH ids go into the
    // namespace: binding only the work item would leave the row shared by every
    // requirement that work item is linked to.
    const h = await harness()
    await linked(h, ISSUE_ID, REQ_ID)
    await linked(h, ISSUE_ID, OTHER_REQ_ID)
    const key = 'one-key-two-requirements'
    await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: key }
    )
    const second = await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: OTHER_REQ_ID, idempotencyKey: key }
    )

    expect(second.replayed).toBe(false)
    expect(second.result.requirement).toBe(OTHER_REQ_ID)
    expect(edge(h, ISSUE_ID, OTHER_REQ_ID).state).toBe('revoked')
  })

  it('refuses a pair that was never linked instead of reporting success', async () => {
    const h = await harness()
    await expect(
      unlinkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
      )
    ).rejects.toMatchObject({ name: 'UnlinkImplementsError', reason: 'link-not-found' })
  })

  it('refuses when either endpoint is unreadable for the caller', async () => {
    const h = await harness()
    await linked(h)
    h.db.hidden.add(REQ_ID)
    await expect(
      unlinkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
      )
    ).rejects.toMatchObject({ reason: 'requirement-not-found' })
    expect(edge(h).state).toBe('active')

    h.db.hidden.delete(REQ_ID)
    h.db.hidden.add(ISSUE_ID)
    await expect(
      unlinkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: 'k2' }
      )
    ).rejects.toMatchObject({ reason: 'work-item-not-found' })
    expect(edge(h).state).toBe('active')
  })

  it('refuses a REPLAY to a caller who lost access to the REQUIREMENT', async () => {
    // 🔴 Iron law ②, direction 1. The ledger replays a stored result without
    // re-entering the body, so without the pre-runner check a caller with no
    // access would get a clean success and learn both that the pair existed and
    // that it was withdrawn.
    // ⚠️ A DIFFERENT hole from iron law ①: namespacing stops a key crossing
    // between subjects, it does nothing about a replay of the caller's own
    // subject after access is withdrawn.
    const h = await harness()
    await linked(h)
    await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
    )
    h.db.hidden.add(REQ_ID)
    await expect(
      unlinkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
      )
    ).rejects.toMatchObject({ reason: 'requirement-not-found' })
    // A different outer key still replays the inner pair claim — same answer.
    await expect(
      unlinkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: 'another-key' }
      )
    ).rejects.toMatchObject({ reason: 'requirement-not-found' })
  })

  it('refuses a REPLAY to a caller who lost access to the WORK ITEM', async () => {
    // 🔴 Iron law ②, direction 2 — the issue-page entry point pins the issue.
    const h = await harness()
    await linked(h)
    await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
    )
    h.db.hidden.add(ISSUE_ID)
    await expect(
      unlinkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
      )
    ).rejects.toMatchObject({ reason: 'work-item-not-found' })
    await expect(
      unlinkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: 'yet-another-key' }
      )
    ).rejects.toMatchObject({ reason: 'work-item-not-found' })
  })

  it('re-enters cleanly after a partial run (state flipped, activity not)', async () => {
    const h = await harness()
    await linked(h)
    // Simulate a crash between the two steps: the edge is revoked, no removal
    // announcement exists.
    ;(h.db.docs.get(traceLinkId('implements', ISSUE_ID, REQ_ID)) as TraceLink).state = 'revoked'

    const outcome = await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
    )
    expect(outcome.result.alreadyRevoked).toBe(true)
    // The missing half of the previous run is completed, not skipped.
    const removals = (h.db.find(activity.class.DocUpdateMessage, {}) as DocUpdateMessage[]).filter(
      (m) => m.action === 'remove'
    )
    expect(removals.length).toBe(2)
  })

  it('refuses a concurrent second caller rather than silently succeeding', async () => {
    const h = await harness()
    await linked(h)
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

    const first = unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: 'key-a' }
    ).catch((err: unknown) => err)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: 'key-b' }
    ).catch((err: unknown) => err)

    release()
    const outcomes = [await first, await second]

    // 🔴 THE INVARIANT IS "ONE REVOKED EDGE", not "both succeed".
    for (const outcome of outcomes) {
      if (outcome instanceof Error) {
        expect(['CommandInProgressError', 'CommandPreemptedError']).toContain(outcome.name)
      } else {
        expect((outcome as any).result.traceLink).toBe(traceLinkId('implements', ISSUE_ID, REQ_ID))
      }
    }
    expect(outcomes.some((it) => !(it instanceof Error))).toBe(true)
    expect(edgeCount(h)).toBe(1)
    expect(edge(h).state).toBe('revoked')
  })

  it('is exported through the error family the request layer knows', async () => {
    const h = await harness()
    const err = await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnlinkImplementsError)
    expect((err as UnlinkImplementsError).code).toBe(400)
  })
})

describe('re-asserting a withdrawn pair', () => {
  it('reactivates the SAME edge instead of silently doing nothing', async () => {
    // 🔴 `revoked` MUST NOT BE A DEAD END FOR THE BODY. The edge `_id` is derived
    // from the pair, so there is exactly ONE row forever; without the
    // reactivation branch `ensureImplementsLink` would find the revoked row,
    // report `created: false` and return — the caller would be told the link was
    // made and the delivery view would still show nothing.
    //
    // ⚠️ EXERCISED THROUGH `ensureImplementsLink`, NOT THROUGH THE
    // `linkImplements` COMMAND, and that is not a shortcut — it is the honest
    // scope of the fix. The command's INNER claim is
    // `(LINK_IMPLEMENTS_PAIR, pairKey)`, keyed on the pair ALONE, and that row
    // is already `succeeded` from the original link, so a second
    // `linkImplements` on the pair REPLAYS and never enters the body at all.
    // `createWorkItems` reaches this function under its own claim and therefore
    // does hit the branch. Closing the command-level gap needs a revocation
    // GENERATION in the claim key, i.e. a counter on `TraceLink` — a change to
    // the contract package, outside this delivery's file boundary. See the
    // handover notes.
    const h = await harness()
    await linked(h)
    await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
    )
    expect(edge(h).state).toBe('revoked')

    const { agentraTraceEndpoints } = await import('../commands/traceEndpoints')
    const issue = (await h.client.findOne(tracker.class.Issue, { _id: ISSUE_ID })) as Issue
    const requirement = (await h.client.findOne(requirements.masterTag.Requirement as Ref<any>, {
      _id: REQ_ID
    })) as Requirement
    const result = await ensureImplementsLink(h.client, agentraTraceEndpoints, 'LinkImplements', issue, requirement, {})

    expect(result.link).toBe(traceLinkId('implements', ISSUE_ID, REQ_ID))
    expect(result.created).toBe(true)
    expect(edgeCount(h)).toBe(1)
    expect(edge(h).state).toBe('active')
  })

  it('re-links through the COMMAND, with the caller reusing its constant key', async () => {
    // 🔴 THE FIX FOR THE BUG THIS TEST USED TO PIN. It was called "records the
    // command-level replay honestly rather than pretending" and it asserted
    // `edge(h).state === 'revoked'` AFTER a re-link — a deliberate pin on a
    // known gap, written so that whoever added the revocation generation would
    // be forced to change it on purpose. Both of its old assertions are now
    // wrong on purpose: the edge comes back `active`, and the outcome is not a
    // replay. The gap was that both ledger claims were keyed on the pair ALONE,
    // so the row from the first link was `succeeded` forever and the third step
    // of `link → unlink → link` never entered the body.
    //
    // ⚠️ THE CALLER'S KEY IS THE ONE THE UI ACTUALLY SENDS — a pure function of
    // the pair, identical to the first link's. Passing a fresh key here would
    // make the test pass against the OLD code too and prove nothing: the whole
    // point is that the SERVER, not the caller, distinguishes the rounds.
    const h = await harness()
    await linked(h)
    await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
    )
    expect(edge(h).state).toBe('revoked')
    expect(edge(h).revocationGeneration).toBe(1)

    const relink = await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: linkKey() }
    )

    expect(relink.replayed).toBe(false)
    expect(relink.result.alreadyLinked).toBe(false)
    expect(relink.result.traceLink).toBe(traceLinkId('implements', ISSUE_ID, REQ_ID))
    // 🔴 THE ASSERTION THE OLD TEST INVERTED.
    expect(edge(h).state).toBe('active')
    // Still ONE row: the edge `_id` is derived from the pair and never changes.
    expect(edgeCount(h)).toBe(1)
    // The re-assertion advanced the counter `unlinkImplements` keys on, and
    // left the one `linkImplements` keys on alone.
    expect(edge(h).assertionGeneration).toBe(1)
    expect(edge(h).revocationGeneration).toBe(1)
    // 🔴 THE REVIVE IS VISIBLE IN BOTH TIMELINES. 2 (link) + 2 (unlink) +
    // 2 (re-link). A pair-only activity scope would have found round 0's
    // announcement and written nothing, so the history would still read as
    // withdrawn.
    expect(h.db.find(activity.class.DocUpdateMessage, {}).length).toBe(6)
  })

  it('survives four rounds of withdraw / re-assert on the SAME two caller keys', async () => {
    // 🔴 ONE ROUND PROVES NOTHING. The pair-keyed claim was wrong in both
    // directions and each bug hides one cycle further along than the other: the
    // re-link bug shows up at step 3, and the "unlink replays already-revoked
    // about an active edge" bug only at step 6. A counter that advanced on
    // EVERY transition would pass the first and fail here.
    const h = await harness()
    for (let round = 0; round < 4; round++) {
      const link = await linkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: linkKey() }
      )
      expect(link.result.alreadyLinked).toBe(false)
      expect(edge(h).state).toBe('active')
      expect(edge(h).revocationGeneration).toBe(round)

      const unlink = await unlinkImplements(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
      )
      expect(unlink.result.alreadyRevoked).toBe(false)
      expect(edge(h).state).toBe('revoked')
      expect(edge(h).revocationGeneration).toBe(round + 1)
      expect(edge(h).assertionGeneration).toBe(round)
    }
    // Never more than the one derived row, and every round announced on both
    // endpoints: 4 rounds x 2 events x 2 endpoints.
    expect(edgeCount(h)).toBe(1)
    expect(h.db.find(activity.class.DocUpdateMessage, {}).length).toBe(16)
  })

  it('advances the counter ONCE when the reactivation CAS has to be retried', async () => {
    // 🔴 THE CAS AND THE INCREMENT RIDE IN THE SAME APPLY BLOCK, so a rejected
    // `TxApplyIf` must leave BOTH undone. If the increment could land while the
    // state change was refused, the counter would run ahead of the lifecycle and
    // strand the ledger row the next round is going to look for.
    //
    // ⚠️ `ApplyTxMiddleware` reports a rejection by RETURNING `{ result: false }`
    // rather than throwing, which is what `applyOutcome` reproduces here. The
    // command used to `assertCommitted` this step and turn "somebody else
    // reactivated it first" into a user-visible failure; it now re-reads and
    // agrees, bounded by `LINK_IMPLEMENTS_MAX_ATTEMPTS`.
    const h = await harness()
    await linked(h)
    await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
    )

    let refused = 0
    h.fake.applyOutcome = (tx) => {
      if (typeof tx.scope === 'string' && tx.scope.includes('LinkImplements:pair') && refused === 0) {
        refused++
        return false
      }
      return true
    }
    const relink = await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: linkKey() }
    )

    expect(refused).toBe(1)
    expect(relink.result.traceLink).toBe(traceLinkId('implements', ISSUE_ID, REQ_ID))
    expect(edge(h).state).toBe('active')
    // ONE transition, ONE step — not two.
    expect(edge(h).assertionGeneration).toBe(1)
    expect(edge(h).revocationGeneration).toBe(1)
    expect(edgeCount(h)).toBe(1)
  })

  it('still replays a repeated click INSIDE a round, on both commands', async () => {
    // 🔴 THE PROPERTY THE SECOND COUNTER BUYS. Each command keys on the counter
    // the OTHER one advances, so the value it reads is frozen for the whole
    // round and a duplicate delivery of the same request still collapses onto
    // one ledger row. A single shared counter would send the second unlink
    // click to a fresh row — and that row is the one the NEXT withdrawal needs.
    const h = await harness()
    await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: linkKey() }
    )
    const linkAgain = await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: linkKey() }
    )
    expect(linkAgain.replayed).toBe(true)

    await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
    )
    const unlinkAgain = await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
    )
    expect(unlinkAgain.replayed).toBe(true)

    // 🔴 AND THE ROUND AFTER THAT STILL RUNS. This is the exact sequence that
    // poisons a single-counter design: the repeat click above would have burnt
    // the row this withdrawal needs and made it answer "already revoked" about
    // an edge that is active.
    await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: linkKey() }
    )
    expect(edge(h).state).toBe('active')
    const third = await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
    )
    expect(third.replayed).toBe(false)
    expect(third.result.alreadyRevoked).toBe(false)
    expect(edge(h).state).toBe('revoked')
  })
})

//
// The cross-file consequence, tested here because it is invisible from
// `unlinkImplements.ts`: `ArchivableGuard.validateRemove` queries with
// `state: { $ne: 'revoked' }`, so withdrawing the last edge turns an object
// that could not be deleted into one that can.
//
function makeHierarchy (): Hierarchy {
  const hierarchy = new Hierarchy()
  const factory = new TxFactory(core.account.System)
  const stub = (_id: Ref<Class<Doc>>, ext?: Ref<Class<Doc>>): void => {
    hierarchy.tx(
      factory.createTxCreateDoc(
        core.class.Class,
        core.space.Model,
        { kind: ClassifierKind.CLASS, label: '', extends: ext } as any,
        _id
      )
    )
  }
  stub(core.class.Doc)
  stub(tracker.class.Issue as Ref<Class<Doc>>, core.class.Doc)
  stub(requirements.masterTag.Requirement as Ref<Class<Doc>>, core.class.Doc)
  return hierarchy
}

function guardFor (db: MemoryDb): ArchivableGuard {
  return new ArchivableGuard({
    hierarchy: makeHierarchy(),
    findAll: async (_ctx, _class, query) => db.find(_class as any, query) as any
  })
}

describe('the delete protection the withdrawal releases', () => {
  it('blocks the work item while the edge is live and admits it once revoked', async () => {
    const h = await harness()
    await linked(h)
    const guard = guardFor(h.db)
    const factory = new TxFactory(core.account.System)
    const remove = factory.createTxRemoveDoc(tracker.class.Issue, PROJECT, ISSUE_ID)

    // Before: `ArchivableGuard` refuses, because a non-revoked edge names it.
    await expect(guard.validate(makeCtx(), [remove])).rejects.toBeInstanceOf(ArchivableGuardError)

    await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
    )

    // After: the same delete passes. 🔴 THIS IS A REAL PRIVILEGE CHANGE and the
    // reason the confirmation copy mentions it — the edge survives as history,
    // but it no longer protects either endpoint.
    await expect(guard.validate(makeCtx(), [remove])).resolves.toBeUndefined()
  })

  it('admits the requirement end too', async () => {
    const h = await harness()
    await linked(h)
    const guard = guardFor(h.db)
    const factory = new TxFactory(core.account.System)
    const remove = factory.createTxRemoveDoc(
      requirements.masterTag.Requirement as Ref<any>,
      requirements.space.Requirements as Ref<any>,
      REQ_ID
    )
    await expect(guard.validate(makeCtx(), [remove])).rejects.toBeInstanceOf(ArchivableGuardError)
    await unlinkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem: ISSUE_ID, requirement: REQ_ID, idempotencyKey: unlinkKey() }
    )
    await expect(guard.validate(makeCtx(), [remove])).resolves.toBeUndefined()
  })
})
