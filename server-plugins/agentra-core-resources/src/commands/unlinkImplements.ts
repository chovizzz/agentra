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

import { type DocUpdateMessage } from '@hcengineering/activity'
import type { Doc, MeasureContext, Ref, SessionData, TxOperations } from '@hcengineering/core'
import requirements, { type Requirement } from '@hcengineering/requirements'
import traceability, { traceLinkId, traceLinkReassertions, type TraceLink } from '@hcengineering/traceability'
import tracker, { type Issue } from '@hcengineering/tracker'
import { commandObjectId, type CommandOutcome, type CommandRequest } from '@hcengineering/server-agentra-core'

import { type CommandRunner } from './convertLeadToRequirement'
import { applyStepFor, ensureTraceActivity } from './traceCommandSupport'

/**
 * Command name. Part of the persisted contract: it is the first component of
 * every derived `_id` this command produces, so renaming it re-points all of
 * them and a replay would write a second set of objects.
 *
 * @public
 */
export const UNLINK_IMPLEMENTS = 'UnlinkImplements'

/**
 * The INNER claim, keyed on the (work item, requirement) PAIR rather than on
 * the caller's idempotency key.
 *
 * 🔴 SAME REASON AS `LINK_IMPLEMENTS_PAIR`. The outer ledger row excludes on
 * `(command, idempotencyKey)`, which stops the SAME request running twice and
 * says nothing about two DIFFERENT keys withdrawing the same assertion — a bulk
 * caller that invented a batch key would otherwise race a single-pair caller.
 * Claiming `(UNLINK_IMPLEMENTS_PAIR, "<work item> <requirement>")` moves the
 * exclusion onto the pair itself.
 *
 * ⚠️ A SEPARATE CLAIM FROM THE LINK ONE, deliberately. Sharing
 * `LINK_IMPLEMENTS_PAIR` would mean the first link of a pair permanently
 * occupies the row a later unlink of the same pair needs, and the unlink would
 * REPLAY the link's stored result instead of running — i.e. "unlink" would
 * silently answer "linked".
 *
 * 🔴 AND IT IS KEYED ON THE PAIR *PLUS THE ASSERTION GENERATION*. A pair-only
 * row is permanent, so `unlink → link → unlink` had its third step replay the
 * first one's "already revoked" about an edge that was `active` — the
 * withdrawal bug's mirror image, one cycle further along than the re-link bug.
 * See {@link unlinkImplementsPairKey} and `TraceLink.assertionGeneration`.
 *
 * @public
 */
export const UNLINK_IMPLEMENTS_PAIR = `${UNLINK_IMPLEMENTS}:pair`

/**
 * How many times the withdrawal compare-and-swap re-reads and retries.
 *
 * 🔴 BOUNDED, and it replaces an `assertCommitted` that reported the DESIRED
 * end state as a failure: losing the CAS here means somebody else revoked the
 * same edge first, which is agreement, not a fault. Mirrors
 * `LINK_IMPLEMENTS_MAX_ATTEMPTS`.
 *
 * @public
 */
export const UNLINK_IMPLEMENTS_MAX_ATTEMPTS = 3

/**
 * Object roles for {@link commandObjectId}. Stable forever — changing one
 * re-points the existence lookup at an id that does not exist, and the replay
 * then writes a duplicate record.
 *
 * ⚠️ DISTINCT FROM `linkImplementsRoles`. The link records and the unlink
 * records describe two different events on the same pair and must not collide;
 * reusing the link roles would make `ensureTraceActivity` find the CREATE
 * announcement and skip writing the revocation one, so the withdrawal would be
 * absent from both endpoints' history.
 *
 * @public
 */
export const unlinkImplementsRoles = {
  workItemActivity: 'activity:unlink-work-item',
  requirementActivity: 'activity:unlink-requirement'
} as const

/**
 * The scope string of the pair claim. Exported so the tests assert the exact
 * key the ledger row is derived from rather than re-deriving it by hand.
 *
 * 🔴 SEPARATOR, NOT CONCATENATION — see `linkImplementsPairKey`.
 *
 * 🔴 THE ASSERTION GENERATION IS PART OF THE KEY — see `linkImplementsPairKey`
 * for why `state` cannot stand in for it, and why each command keys on the
 * counter the OTHER one advances. This command advances
 * `revocationGeneration`, so the value it reads here is frozen for the whole
 * round: a repeated "unlink" click still lands on the same ledger row and still
 * replays, while the next re-link is guaranteed to move
 * `assertionGeneration` before the following withdrawal starts.
 *
 * @public
 */
export function unlinkImplementsPairKey (workItem: Ref<Doc>, requirement: Ref<Doc>, generation: number): string {
  return `${workItem} ${requirement} a${generation}`
}

/**
 * How many times the pair's edge has been re-asserted, or `0` when none exists.
 *
 * 🔴 A PURE QUERY, DELIBERATELY OUTSIDE THE RUNNER (iron law ④), and called
 * only AFTER the endpoint readability guard — see the twin in
 * `linkImplements.ts` for both arguments.
 */
async function readReassertions (
  client: TxOperations,
  workItem: Ref<Issue>,
  requirement: Ref<Requirement>
): Promise<number> {
  const link = await client.findOne<TraceLink>(traceability.class.TraceLink, {
    _id: traceLinkId('implements', workItem, requirement)
  })
  return traceLinkReassertions(link)
}

/**
 * The outer ledger namespace for one (work item, requirement) pair.
 *
 * 🔴 BOTH IDS GO IN. `commandExecutionId` is `sha256(command ‖ idempotencyKey)`,
 * so with a CONSTANT command name the ledger row is decided entirely by a key
 * the CALLER supplies: a caller could present a key that already succeeded for
 * one pair while naming a different one, and `CommandMiddleware.resume` would
 * hand back the first pair's stored result WITHOUT ever entering the body — so
 * a pair that was never unlinked would report itself unlinked. Binding only ONE
 * of the two ids is not enough either: the row would still be shared by every
 * pair holding that id on the bound side.
 *
 * 🔴 AND THE ASSERTION GENERATION GOES IN TOO — an IMPLICIT dimension of the
 * subject. The key the caller presents is a pure function of the pair
 * (`traceability:unlink-implements:v1:<work item>:<requirement>`), so a
 * generation-free namespace makes the outer row permanent and the SECOND
 * withdrawal of a pair — after it was re-linked in between — replay the first
 * one's stored success while the edge stays `active`.
 *
 * @public
 */
export function unlinkImplementsCommandNamespace (
  workItem: Ref<Issue>,
  requirement: Ref<Requirement>,
  generation: number
): string {
  return `${UNLINK_IMPLEMENTS}:${workItem}:${requirement}:g${generation}`
}

/**
 * @public
 */
export interface UnlinkImplementsInput {
  workItem: Ref<Issue>
  requirement: Ref<Requirement>
  idempotencyKey: string
}

/**
 * @public
 */
export interface UnlinkImplementsResult extends Record<string, any> {
  workItem: Ref<Issue>
  requirement: Ref<Requirement>
  traceLink: Ref<TraceLink>
  /**
   * `true` when the edge was ALREADY `revoked` when this attempt looked.
   *
   * ⚠️ Distinct from `CommandOutcome.replayed`, which means "same idempotency
   * key, result served from the ledger". This flag is about the PAIR having been
   * withdrawn before, under any key.
   */
  alreadyRevoked: boolean
}

/**
 * @public
 */
export class UnlinkImplementsError extends Error {
  readonly code = 400

  constructor (
    readonly reason: 'work-item-not-found' | 'requirement-not-found' | 'link-not-found' | 'contended',
    message: string
  ) {
    super(message)
    this.name = 'UnlinkImplementsError'
  }
}

/**
 * @public
 */
export interface UnlinkImplementsContext {
  ctx: MeasureContext<SessionData>
  /** Must carry the CALLING account, so every write is attributed and secured. */
  client: TxOperations
  runner: CommandRunner
  staleTimeoutMs?: number
}

/**
 * Withdraw `WorkItem --implements--> Requirement`, exactly once per pair.
 *
 * 🔴 REVOKE, NOT DELETE. `TraceLinkState` (`plugins/traceability/src/types.ts`)
 * defines `revoked` as "a human explicitly withdrew the assertion", and the
 * traceability matrix is an AUDIT artefact: physically removing the row would
 * erase the fact that this requirement was once claimed to be implemented by
 * this work item, which is precisely the history the matrix exists to keep.
 *
 * ⚠️ `revoked`, NEVER `orphaned`. The third state means "one end was deleted"
 * — an automatic consequence, not a human decision — and nothing in production
 * writes it. Conflating the two would make an explicit withdrawal
 * indistinguishable from a dangling edge.
 *
 * 🔴 REVOKING RELEASES THE DELETE PROTECTION ON BOTH ENDPOINTS, and that
 * consequence lives in ANOTHER FILE where a reader of this one cannot see it.
 * `ArchivableGuard.validateRemove` (`../deleteGuard`) refuses a physical
 * `TxRemoveDoc` of an archivable object that still carries a trace edge, and it
 * queries with `state: { $ne: 'revoked' }` — so the moment this command flips
 * the last edge to `revoked`, a work item or requirement that was undeletable
 * becomes deletable. That is intended (a revoked edge is history, not a live
 * reference, and treating it as one would make an unlinked object permanently
 * undeletable) but it is a real privilege change and must not be discovered by
 * accident.
 *
 * 🔴 REENTRANCY, NOT ATOMICITY. The state flip and the two activity records
 * land as separate database transactions, so a crash in the middle leaves the
 * ledger row `running`; once stale, another attempt preempts it and re-enters
 * here. EVERY step is `findOne`-then-write over a DERIVED `_id` and nothing
 * uses `generateId()`.
 *
 * @public
 */
export async function unlinkImplements (
  context: UnlinkImplementsContext,
  input: UnlinkImplementsInput
): Promise<CommandOutcome<UnlinkImplementsResult>> {
  const { ctx, client, runner } = context

  // 🔴 CHECKED BEFORE THE RUNNER, not only inside the body. `CommandMiddleware`
  // replays a `succeeded` row's stored result WITHOUT re-entering the body, and
  // the pair claim is keyed on the two ids the caller supplies — so once anyone
  // unlinks a pair, a caller with no access to either endpoint would otherwise
  // get a clean success back and learn both that the pair existed and that it
  // was withdrawn.
  //
  // ⚠️ It guards a DIFFERENT hole from the namespacing above, and neither
  // substitutes for the other: the namespace stops a key crossing between
  // subjects, this stops a replay of the caller's OWN subject leaking to
  // somebody who has since lost access to it.
  await assertEndpointsReadable(client, input)

  // ── Which ROUND of this pair's lifecycle is being withdrawn. ─────────────
  // Read ONCE and shared by both claims — see the twin in `linkImplements.ts`.
  const generation = await readReassertions(client, input.workItem, input.requirement)
  const request: CommandRequest = {
    command: unlinkImplementsCommandNamespace(input.workItem, input.requirement, generation),
    idempotencyKey: input.idempotencyKey,
    staleTimeoutMs: context.staleTimeoutMs
  }

  return await runner.run<UnlinkImplementsResult>(ctx, request, async () => {
    const inner = await runner.run<UnlinkImplementsResult>(
      ctx,
      {
        command: UNLINK_IMPLEMENTS_PAIR,
        idempotencyKey: unlinkImplementsPairKey(input.workItem, input.requirement, generation),
        staleTimeoutMs: context.staleTimeoutMs
      },
      async () => await runUnlink(ctx, client, input)
    )
    return { ...inner.result, alreadyRevoked: inner.result.alreadyRevoked || inner.replayed }
  })
}

/**
 * Both endpoints must be readable BY THE CALLER, on every path.
 *
 * The same two reads happen again inside {@link runUnlink}; that is deliberate
 * rather than redundant. This one guards the REPLAY (which never enters the
 * body), the ones inside guard the write.
 */
async function assertEndpointsReadable (client: TxOperations, input: UnlinkImplementsInput): Promise<void> {
  await readWorkItem(client, input.workItem)
  await readRequirement(client, input.requirement)
}

async function readWorkItem (client: TxOperations, _id: Ref<Issue>): Promise<Issue> {
  // Pinned to `tracker.class.Issue`: it stops an id of some unrelated class
  // from being named, and it routes the read through the caller's security
  // filter, so a caller who may not read the issue cannot withdraw anything
  // about it.
  const issue = await client.findOne<Issue>(tracker.class.Issue, { _id })
  if (issue === undefined) {
    throw new UnlinkImplementsError('work-item-not-found', `Work item '${_id}' does not exist`)
  }
  return issue
}

async function readRequirement (client: TxOperations, _id: Ref<Requirement>): Promise<Requirement> {
  const requirement = await client.findOne<Requirement>(requirements.masterTag.Requirement as Ref<any>, { _id })
  if (requirement === undefined) {
    throw new UnlinkImplementsError('requirement-not-found', `Requirement '${_id}' does not exist`)
  }
  return requirement
}

/**
 * ⚠️ NO `isLatest` CHECK, unlike `linkImplements`. Refusing to link a superseded
 * revision keeps a useless edge from being created; refusing to UNLINK one
 * would strand exactly the edges a user most wants to withdraw. Withdrawal is
 * always allowed on a readable pair.
 */
async function runUnlink (
  ctx: MeasureContext<SessionData>,
  client: TxOperations,
  input: UnlinkImplementsInput
): Promise<UnlinkImplementsResult> {
  // ── Step 0: read BOTH endpoints, each pinned to its own class. ────────────
  const workItem = await readWorkItem(client, input.workItem)
  const requirement = await readRequirement(client, input.requirement)

  // ── Step 1: the edge (query, then write). ────────────────────────────────
  // 🔴 `_id` IS DERIVED, and the read is PINNED TO `traceability.class.TraceLink`.
  // The class pin is not decoration: `TraceLink` shares `DOMAIN_RELATION` with
  // upstream `core.class.Relation`, so a query that named only the `_id` could
  // answer with — and this command could then write to — an upstream relation
  // row that happened to collide.
  const linkId = traceLinkId('implements', workItem._id, requirement._id)
  const link = await client.findOne<TraceLink>(traceability.class.TraceLink, { _id: linkId })
  if (link === undefined || link.kind !== 'implements') {
    // Fail closed. Nothing was ever asserted about this pair, so there is
    // nothing to withdraw — and answering "done" would tell a caller that an
    // edge existed.
    throw new UnlinkImplementsError(
      'link-not-found',
      `No implements link between work item '${workItem._id}' and requirement '${requirement._id}'`
    )
  }

  // 🔴 A COMPARE-AND-SWAP, not a blind write. `link.state` is already stale by
  // the time we get here, and `match` makes `ApplyTxMiddleware.verifyApplyIf`
  // re-read the row and refuse the whole `TxApplyIf` if it moved.
  //
  // ⚠️ `match` NAMES THE CLASS TOO, for the same co-tenancy reason as the read.
  //
  // ⚠️ THE GENERATION IS ADVANCED IN A SECOND `TxUpdateDoc` INSIDE THE SAME
  // APPLY BLOCK, not as another field on the first. `DocumentUpdate` has no
  // `$set`, and the mixed payload `{ state: 'revoked', $inc: {...} }` reads as
  // a NON-operator update to `isOperator` — which routes it down the Postgres
  // `jsonb_set` path where the `$inc` is dropped silently. See the twin in
  // `linkImplements.ts`.
  //
  // ⚠️ RETRIED, NOT ASSERTED. Losing this CAS means somebody else revoked the
  // same edge first, which is the outcome we wanted; the old `assertCommitted`
  // reported it as a failure.
  let alreadyRevoked = false
  let settled = false
  for (let attempt = 0; !settled && attempt < UNLINK_IMPLEMENTS_MAX_ATTEMPTS; attempt++) {
    const current =
      attempt === 0 ? link : await client.findOne<TraceLink>(traceability.class.TraceLink, { _id: linkId })
    if (current === undefined || current.kind !== 'implements') {
      throw new UnlinkImplementsError(
        'link-not-found',
        `No implements link between work item '${workItem._id}' and requirement '${requirement._id}'`
      )
    }
    if (current.state === 'revoked') {
      alreadyRevoked = true
      settled = true
      break
    }
    const apply = applyStepFor(client, UNLINK_IMPLEMENTS, 'revoke', `${UNLINK_IMPLEMENTS_PAIR} ${linkId}`)
    apply.match<TraceLink>(traceability.class.TraceLink, { _id: linkId, state: current.state })
    await apply.updateDoc<TraceLink>(traceability.class.TraceLink, current.space, linkId, { state: 'revoked' })
    // ⚠️ THE *REVOCATION* COUNTER, NOT THE ONE THIS COMMAND KEYS ON — see the
    // twin in `linkImplements.ts`. It advances the counter `linkImplements`
    // keys on, so the next assertion gets a fresh row, and leaves this
    // command's own discriminator alone so a re-entry stays on this row.
    await apply.updateDoc<TraceLink>(traceability.class.TraceLink, current.space, linkId, {
      $inc: { revocationGeneration: 1 }
    })
    if ((await apply.commit()).result) {
      settled = true
    }
  }
  if (!settled) {
    throw new UnlinkImplementsError(
      'contended',
      `Trace link '${linkId}' changed underneath ${UNLINK_IMPLEMENTS_MAX_ATTEMPTS} attempts to withdraw it`
    )
  }

  // ── Step 2: activity on BOTH endpoints (query, then write). ──────────────
  // 🔴 `DOMAIN_RELATION` is excluded from Activity, so the update above produced
  // NO history entry on either object. Without these two records the withdrawal
  // is invisible in both endpoints' timelines while the CREATE announcement
  // `linkImplements` wrote stays visible — i.e. the history would read as if the
  // link were still live.
  //
  // ⚠️ THE SCOPE CARRIES THE ASSERTION GENERATION — see the twin in
  // `linkImplements.ts`. Without it the SECOND withdrawal of a pair (after it
  // was re-linked in between) would find round 0's revocation record and write
  // nothing, so the timeline would show one withdrawal for two. Reading it
  // after the write is safe because this command never advances it.
  const pairKey = unlinkImplementsPairKey(workItem._id, requirement._id, traceLinkReassertions(link))
  await ensureTraceActivity(client, UNLINK_IMPLEMENTS, {
    _id: commandObjectId<DocUpdateMessage>(UNLINK_IMPLEMENTS_PAIR, pairKey, unlinkImplementsRoles.workItemActivity),
    attachedTo: workItem._id,
    attachedToClass: workItem._class,
    space: workItem.space,
    link: linkId,
    action: 'remove'
  })
  await ensureTraceActivity(client, UNLINK_IMPLEMENTS, {
    _id: commandObjectId<DocUpdateMessage>(UNLINK_IMPLEMENTS_PAIR, pairKey, unlinkImplementsRoles.requirementActivity),
    attachedTo: requirement._id,
    attachedToClass: requirement._class,
    space: requirement.space,
    link: linkId,
    action: 'remove'
  })

  ctx.info('agentra implements link revoked', {
    workItem: workItem._id,
    requirement: requirement._id,
    traceLink: linkId,
    alreadyRevoked,
    idempotencyKey: input.idempotencyKey
  })

  return {
    workItem: workItem._id,
    requirement: requirement._id,
    traceLink: linkId,
    alreadyRevoked
  }
}
