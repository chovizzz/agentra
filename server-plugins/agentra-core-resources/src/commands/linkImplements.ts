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
import core, {
  type Class,
  type Doc,
  type MeasureContext,
  type Ref,
  type SessionData,
  type TxOperations
} from '@hcengineering/core'
import requirements, { type Requirement } from '@hcengineering/requirements'
import traceability, {
  normId,
  traceLinkId,
  traceLinkRevocations,
  validateTraceLink,
  type TraceEndpointRegistry,
  type TraceLink
} from '@hcengineering/traceability'
import tracker, { type Issue } from '@hcengineering/tracker'
import { commandObjectId, type CommandOutcome, type CommandRequest } from '@hcengineering/server-agentra-core'

import { assertCommitted, isDuplicateKeyError } from '../commandMiddleware'
import { traceLinkMetadata, type TraceLinkMetadataInput } from '../traceLinkMetadata'
import { agentraTraceEndpoints } from './traceEndpoints'
import { type CommandRunner } from './convertLeadToRequirement'
import { applyStepFor, ensureTraceActivity } from './traceCommandSupport'

/**
 * Command name. Part of the persisted contract: it is the first component of
 * every derived `_id` this command produces, so renaming it re-points all of
 * them and a replay would write a second set of objects.
 *
 * @public
 */
export const LINK_IMPLEMENTS = 'LinkImplements'

/**
 * The INNER claim, keyed on the (work item, requirement) PAIR rather than on
 * the caller's idempotency key.
 *
 * 🔴 WHY BOTH CLAIMS EXIST. The outer ledger row excludes on `(command,
 * idempotencyKey)` — it stops the SAME request running twice and says nothing
 * about two DIFFERENT keys linking the same pair. Task 12a requires BOTH
 * directions (from the requirement, pick work items; from the issue, pick
 * requirements) plus Task 12's batch creation to collapse onto ONE edge, and a
 * bulk caller that invented a batch key would otherwise race a single-pair
 * caller. Claiming `(LINK_IMPLEMENTS_PAIR, "<work item> <requirement>")` moves
 * the exclusion onto the pair itself, where the Postgres primary key on the
 * ledger table can enforce it.
 *
 * ⚠️ The pair claim is BELT, the deterministic edge `_id` is BRACES. Even with
 * no claim at all, two racing creates derive the same `traceLinkId` and one of
 * them takes a `23505`; the claim exists so the loser REPLAYS a result instead
 * of surfacing a duplicate-key error to a user who did nothing wrong.
 *
 * 🔴 AND IT IS KEYED ON THE PAIR *PLUS THE REVOCATION GENERATION*, never on the
 * pair alone. A pair-only row is written once and succeeds forever, so
 * `link → unlink → link` had its third step replay the first step's stored
 * result without entering the body: the reactivation branch never ran, the user
 * was told "linked", and the edge stayed `revoked`. See
 * {@link linkImplementsPairKey} and `TraceLink.revocationGeneration`.
 *
 * @public
 */
export const LINK_IMPLEMENTS_PAIR = `${LINK_IMPLEMENTS}:pair`

/**
 * How many times the reactivation compare-and-swap re-reads and retries.
 *
 * 🔴 BOUNDED, and it exists because the CAS out of `revoked` can legitimately
 * lose. Before the generation counter this step used `assertCommitted`, which
 * turned "somebody else reactivated the same edge one millisecond earlier" into
 * a hard failure the user saw. Re-reading and agreeing with the winner is the
 * correct answer and converges in one extra pass; anything beyond that is a
 * genuine fault and is reported as `contended`. Mirrors
 * `FIXED_BY_MAX_ATTEMPTS`.
 *
 * @public
 */
export const LINK_IMPLEMENTS_MAX_ATTEMPTS = 3

/**
 * Object roles for {@link commandObjectId}. Stable forever — changing one
 * re-points the existence lookup at an id that does not exist, and the replay
 * then creates a duplicate.
 *
 * ⚠️ Shared with {@link createWorkItems}: a work item created from a
 * requirement gets its edge and its two activity records under exactly these
 * ids, so a later manual `linkImplements` on the same pair finds them rather
 * than writing a second announcement of the same fact.
 *
 * @public
 */
export const linkImplementsRoles = {
  workItemActivity: 'activity:work-item',
  requirementActivity: 'activity:requirement'
} as const

/**
 * The scope string of the pair claim. Exported so the tests assert the exact
 * key the ledger row is derived from rather than re-deriving it by hand.
 *
 * 🔴 SEPARATOR, NOT CONCATENATION. `Ref`s are fixed-length here, but the pair
 * key is written once and read forever; a bare concatenation would stop being
 * injective the moment either side gained a prefix.
 *
 * 🔴 THE REVOCATION GENERATION IS PART OF THE KEY, AND THAT IS THE WHOLE FIX.
 * `state` is not a substitute for it: state ALTERNATES, so a later round comes
 * back to a key that already succeeded. `TraceLink.revocationGeneration` only
 * ever increases, so every round of the pair's lifecycle gets a key that has
 * never been used before and can never be used again.
 *
 * 🔴 THE *REVOCATION* COUNTER, NOT A SINGLE COUNTER OVER ALL TRANSITIONS, and
 * the distinction is the difference between fixing the bug and moving it. This
 * command never advances the revocation counter — only `unlinkImplements` does
 * — so the value it reads is FROZEN for the whole round, and a repeated click
 * with the same caller key still lands on the same ledger row and still
 * replays. A counter this command advanced itself would send its own repeat
 * click to a fresh row, spending the row the NEXT round needs. See
 * `TraceLink.assertionGeneration`.
 *
 * ⚠️ The generation is READ, not chosen: it is whatever the edge carries when
 * the caller arrives (`0` when there is no edge yet — creation is not a
 * transition). Two callers who observe the same generation are, by definition,
 * making the same assertion about the same round, which is exactly when they
 * should collapse onto one claim.
 *
 * @public
 */
export function linkImplementsPairKey (workItem: Ref<Doc>, requirement: Ref<Doc>, generation: number): string {
  return `${workItem} ${requirement} r${generation}`
}

/**
 * How many times the pair's edge has been withdrawn, or `0` when there is none.
 *
 * 🔴 A PURE QUERY, DELIBERATELY OUTSIDE THE RUNNER (iron law ④). It decides
 * WHICH ledger row the request belongs to, so routing it through the ledger
 * would be circular — and `CommandMiddleware.resume` would answer it from a
 * stored result, i.e. with the generation of some earlier round.
 *
 * ⚠️ CALL IT AFTER the endpoint readability guard, never before. It reads the
 * edge by a `_id` derived from two ids the caller supplied, so on its own it
 * would tell a caller with no access to either endpoint whether the pair has
 * ever been linked.
 *
 * ⚠️ PINNED TO `traceability.class.TraceLink`: the class shares
 * `DOMAIN_RELATION` with upstream `core.class.Relation`, so a query naming only
 * the `_id` could answer with an upstream relation row that happened to collide.
 */
async function readRevocations (
  client: TxOperations,
  workItem: Ref<Issue>,
  requirement: Ref<Requirement>
): Promise<number> {
  const link = await client.findOne<TraceLink>(traceability.class.TraceLink, {
    _id: traceLinkId('implements', workItem, requirement)
  })
  return traceLinkRevocations(link)
}

/**
 * @public
 */
export interface LinkImplementsInput {
  workItem: Ref<Issue>
  requirement: Ref<Requirement>
  idempotencyKey: string
}

/**
 * @public
 */
export interface LinkImplementsResult extends Record<string, any> {
  workItem: Ref<Issue>
  requirement: Ref<Requirement>
  traceLink: Ref<TraceLink>
  /**
   * `true` when the edge was already there when this attempt looked.
   *
   * ⚠️ Distinct from `CommandOutcome.replayed`, which means "same idempotency
   * key, result served from the ledger". This flag is about the PAIR having been
   * linked before, under any key and from either direction.
   */
  alreadyLinked: boolean
}

/**
 * @public
 */
export class LinkImplementsError extends Error {
  readonly code = 400

  constructor (
    readonly reason:
    | 'work-item-not-found'
    | 'requirement-not-found'
    | 'requirement-not-latest'
    | 'invalid-trace-link'
    | 'link-id-taken'
    | 'contended',
    message: string
  ) {
    super(message)
    this.name = 'LinkImplementsError'
  }
}

/**
 * @public
 */
export interface LinkImplementsContext {
  ctx: MeasureContext<SessionData>
  /** Must carry the CALLING account, so every write is attributed and secured. */
  client: TxOperations
  runner: CommandRunner
  endpoints?: TraceEndpointRegistry
  staleTimeoutMs?: number
}

/**
 * The outer ledger namespace for one (work item, requirement) pair.
 *
 * 🔴 BOTH IDS GO IN. `commandExecutionId` is `sha256(command ‖ idempotencyKey)`,
 * so with a CONSTANT command name the ledger row is decided entirely by a key
 * the CALLER supplies — a caller could present a key that already succeeded for
 * one pair while naming a different one, and `CommandMiddleware.resume` would
 * hand back the first pair's stored result without ever entering the body.
 * Binding only ONE of the two ids is not enough either: the row would still be
 * shared by every pair that holds that id on the bound side, so a key that
 * succeeded for (issue A, requirement R) would replay for (issue A,
 * requirement S).
 *
 * 🔴 AND THE REVOCATION GENERATION GOES IN TOO — it is an IMPLICIT dimension of
 * the subject, and leaving it out is what made re-linking impossible. The key the
 * caller presents is a pure function of the pair
 * (`traceability:link-implements:v1:<work item>:<requirement>`, derived in
 * `traceability-resources`), so with a generation-free namespace the outer row
 * is decided once and for all by the pair: the FIRST link succeeds, and every
 * later click — including the one after a withdrawal — replays that stored
 * success without entering the body. Folding the generation in gives each round
 * of the pair's lifecycle its own row while keeping a genuine retry of the SAME
 * round (a lost response, a crash) on the row it belongs to, because a link
 * does not change the generation of an edge that is already active.
 *
 * @public
 */
export function linkImplementsCommandNamespace (
  workItem: Ref<Issue>,
  requirement: Ref<Requirement>,
  generation: number
): string {
  return `${LINK_IMPLEMENTS}:${workItem}:${requirement}:g${generation}`
}

/**
 * Assert `WorkItem --implements--> Requirement`, exactly once per pair.
 *
 * 🔴 ONE COMMAND, BOTH DIRECTIONS. "Link a work item to this requirement" and
 * "link a requirement to this issue" are the same assertion read from opposite
 * ends; the input names the two endpoints by role, never by "near" and "far".
 * A second command for the reverse direction would need its own claim, its own
 * derived ids and its own activity records, and the first divergence between
 * them would produce two edges for one fact.
 *
 * 🔴 REENTRANCY, NOT ATOMICITY. The edge and the two activity records land as
 * separate database transactions (`PostgresAdapter.tx()` groups by domain and
 * commits each group on its own), so a crash in the middle leaves the ledger row
 * `running`; once stale, another attempt preempts it and re-enters here. EVERY
 * step is therefore `findOne`-then-write over a DERIVED `_id` and nothing uses
 * `generateId()`.
 *
 * 🔴 EVERY `commit()` IS ASSERTED. `ApplyTxMiddleware` reports a rejected
 * `TxApplyIf` by RETURNING `{ result: false }` rather than throwing; an
 * unchecked commit would let the runner record `succeeded` over writes that
 * never landed, and the ledger would replay that phantom forever.
 *
 * @public
 */
export async function linkImplements (
  context: LinkImplementsContext,
  input: LinkImplementsInput
): Promise<CommandOutcome<LinkImplementsResult>> {
  const { ctx, client, runner } = context
  const endpoints = context.endpoints ?? agentraTraceEndpoints

  // 🔴 CHECKED BEFORE THE RUNNER, not only inside the body. `CommandMiddleware`
  // replays a `succeeded` row's stored result WITHOUT re-entering the body, and
  // the pair claim is keyed on the two ids the caller supplies — so once anyone
  // links a pair, a caller with no access to either endpoint would otherwise
  // get a clean success back and learn that the link exists. Re-reading here
  // makes the replayed path answer exactly like the fresh one.
  //
  // ⚠️ It guards a DIFFERENT hole from the namespacing above, and neither
  // substitutes for the other: the namespace stops a key crossing between
  // subjects, this stops a replay of the caller's OWN subject leaking to
  // somebody who has since lost access to it.
  await assertEndpointsReadable(client, input)

  // ── Which ROUND of this pair's lifecycle is being asserted. ──────────────
  // 🔴 READ ONCE, USED BY BOTH CLAIMS. The outer namespace and the inner pair
  // key must name the same round or they would disagree about which request
  // this is; reading twice could straddle a concurrent withdrawal and produce
  // exactly that. A generation that goes stale between here and the write is
  // harmless: the body re-reads and compare-and-swaps on what it finds, so the
  // stale value can only mis-file the BOOKKEEPING, never the write.
  const generation = await readRevocations(client, input.workItem, input.requirement)
  const request: CommandRequest = {
    command: linkImplementsCommandNamespace(input.workItem, input.requirement, generation),
    idempotencyKey: input.idempotencyKey,
    staleTimeoutMs: context.staleTimeoutMs
  }

  return await runner.run<LinkImplementsResult>(ctx, request, async () => {
    const inner = await runner.run<LinkImplementsResult>(
      ctx,
      {
        command: LINK_IMPLEMENTS_PAIR,
        idempotencyKey: linkImplementsPairKey(input.workItem, input.requirement, generation),
        staleTimeoutMs: context.staleTimeoutMs
      },
      async () => await runLink(ctx, client, endpoints, input)
    )
    return { ...inner.result, alreadyLinked: inner.result.alreadyLinked || inner.replayed }
  })
}

/**
 * Both endpoints must be readable BY THE CALLER, on every path.
 *
 * The same two reads happen again inside {@link runLink}; that is deliberate
 * rather than redundant. This one guards the REPLAY (which never enters the
 * body), the ones inside guard the write and additionally supply the documents.
 */
async function assertEndpointsReadable (client: TxOperations, input: LinkImplementsInput): Promise<void> {
  await readWorkItem(client, input.workItem)
  await readRequirement(client, input.requirement)
}

async function readWorkItem (client: TxOperations, _id: Ref<Issue>): Promise<Issue> {
  // Pinned to `tracker.class.Issue`: it stops an id of some unrelated class
  // from being linked, and it routes the read through the caller's security
  // filter, so a caller who may not read the issue cannot assert anything
  // about it.
  const issue = await client.findOne<Issue>(tracker.class.Issue, { _id })
  if (issue === undefined) {
    throw new LinkImplementsError('work-item-not-found', `Work item '${_id}' does not exist`)
  }
  return issue
}

async function readRequirement (client: TxOperations, _id: Ref<Requirement>): Promise<Requirement> {
  const requirement = await client.findOne<Requirement>(requirements.masterTag.Requirement as Ref<any>, { _id })
  if (requirement === undefined) {
    throw new LinkImplementsError('requirement-not-found', `Requirement '${_id}' does not exist`)
  }
  return requirement
}

async function runLink (
  ctx: MeasureContext<SessionData>,
  client: TxOperations,
  endpoints: TraceEndpointRegistry,
  input: LinkImplementsInput
): Promise<LinkImplementsResult> {
  // ── Step 0: read BOTH endpoints, each pinned to its own class. ────────────
  const workItem = await readWorkItem(client, input.workItem)
  const requirement = await readRequirement(client, input.requirement)

  // ── Step 0b: only the CURRENT revision may be implemented. ────────────────
  // ⚠️ `implements` DOES inherit across a revision (`traceLinkInheritsOnRevision`
  // in `plugins/traceability`), which is exactly why creating one against an
  // ALREADY superseded revision is refused rather than allowed. Inheritance is
  // performed by `TraceabilityMiddleware` at the moment a new revision is
  // written; an edge attached to a revision that has already been superseded is
  // therefore never carried forward, and Technical Spec §3.2.1 measures at
  // "current version" scope — so the edge would exist, be permanent, and be
  // invisible to every delivery view.
  //
  // ⚠️ `isLatest === undefined` is ACCEPTED, not rejected. `VersioningMiddleware`
  // stamps the flag only on documents created through it; a requirement written
  // by a fixture, a migration or an older build carries no flag at all, and
  // treating "absent" as "superseded" would refuse every such requirement.
  if ((requirement as { isLatest?: boolean }).isLatest === false) {
    throw new LinkImplementsError(
      'requirement-not-latest',
      `Requirement '${requirement._id}' is a superseded revision; link the current one`
    )
  }

  const { link: linkId, created } = await ensureImplementsLink(
    client,
    endpoints,
    LINK_IMPLEMENTS,
    workItem,
    requirement,
    {
      command: LINK_IMPLEMENTS,
      idempotencyKey: input.idempotencyKey
    }
  )
  const alreadyLinked = !created

  ctx.info('agentra implements link asserted', {
    workItem: workItem._id,
    requirement: requirement._id,
    traceLink: linkId,
    alreadyLinked,
    idempotencyKey: input.idempotencyKey
  })

  return {
    workItem: workItem._id,
    requirement: requirement._id,
    traceLink: linkId,
    alreadyLinked
  }
}

/**
 * Create `WorkItem --implements--> Requirement` and announce it on BOTH ends,
 * re-entrantly.
 *
 * 🔴 THE ONE PLACE AN `implements` EDGE IS WRITTEN. {@link linkImplements} (both
 * UI directions) and {@link createWorkItems} (the batch split) both come through
 * here, so the matrix check, the derived edge id and the two activity records
 * cannot drift apart between the manual and the generated path. The activity
 * ids are derived from `(LINK_IMPLEMENTS_PAIR, pairKey, role)` rather than from
 * the calling command, which is what lets a manual link on a pair a batch
 * already created find the existing records instead of writing a second pair.
 *
 * Returns the edge id plus whether THIS attempt was the one that wrote it.
 * Idempotent: a second call over the same pair writes nothing and reports
 * `created: false`.
 *
 * @public
 */
export async function ensureImplementsLink (
  client: TxOperations,
  endpoints: TraceEndpointRegistry,
  command: string,
  workItem: Issue,
  requirement: Requirement,
  metadata: TraceLinkMetadataInput
): Promise<{ link: Ref<TraceLink>, created: boolean }> {
  // ── The matrix check, server side. ───────────────────────────────────────
  // ⚠️ `tracker.class.Issue` carries BOTH the `Bug` and the `WorkItem` role
  // (Technical Spec §3.4 forbids a parallel Issue class), and
  // `validateTraceLink` takes the INTERSECTION with the matrix row: the
  // `implements` row has no `Bug` source, so the dual registration cannot widen
  // what this accepts.
  const validation = validateTraceLink(
    endpoints,
    'implements',
    workItem._class,
    requirement._class,
    workItem._id,
    requirement._id
  )
  if (!validation.valid) {
    // Fail closed. `unknown-source-class` here means the endpoint registry was
    // not populated in this process — see `traceEndpoints.ts`.
    throw new LinkImplementsError(
      'invalid-trace-link',
      `Trace link WorkItem --implements--> Requirement rejected: ${validation.reason ?? 'unknown'}`
    )
  }

  // ── The edge (query, then write). ────────────────────────────────────────
  const linkId = traceLinkId('implements', workItem._id, requirement._id)
  let link = await client.findOne<TraceLink>(traceability.class.TraceLink, { _id: linkId })
  // ⚠️ Reported from the state BEFORE the write, and a lost race counts as "not
  // created": whoever wrote the row is the creator, and two callers both
  // claiming to have made the edge would double-count in a batch summary.
  let created = false
  if (link === undefined) {
    created = true
    const apply = applyStepFor(client, command, 'trace-link')
    await apply.createDoc<TraceLink>(
      traceability.class.TraceLink,
      // Workspace scoped by design; per-endpoint permission filtering happens at
      // READ time in `server-traceability-resources`.
      core.space.Workspace,
      {
        // 🔴 `docA` / `docB`, not `source` / `target`: those two names are the
        // only ones the Postgres relation schema promotes to indexed columns.
        docA: workItem._id,
        sourceClass: workItem._class as Ref<Class<Doc>>,
        docB: requirement._id,
        targetClass: requirement._class as Ref<Class<Doc>>,
        kind: 'implements',
        sourceBaseId: normId(workItem),
        targetBaseId: normId(requirement),
        state: 'active',
        // 🔴 BOTH COUNTERS START AT 0, WRITTEN EXPLICITLY. Creation is not a
        // transition, so `0` is the truthful value — and stating it here rather
        // than relying on the readers' `?? 0` keeps the persisted row
        // self-describing for anyone reading the table directly.
        revocationGeneration: 0,
        assertionGeneration: 0,
        metadata: traceLinkMetadata(metadata)
      },
      linkId
    )
    try {
      assertCommitted(await apply.commit(), 'create implements link')
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
        // Another attempt won the race between our `findOne` and this write.
        // That is the desired end state, not a failure: re-read and continue so
        // the activity records still get written.
        link = await client.findOne<TraceLink>(traceability.class.TraceLink, { _id: linkId })
        if (link === undefined) {
          throw new LinkImplementsError(
            'link-id-taken',
            `Derived trace link id '${linkId}' is already held by another document`
          )
        }
        created = false
      } else {
        throw err
      }
    }
    if (link === undefined) {
      link = await client.findOne<TraceLink>(traceability.class.TraceLink, { _id: linkId })
      if (link === undefined) {
        throw new Error(`Trace link '${linkId}' vanished immediately after being created`)
      }
    }
  }

  // ── Re-assertion after a withdrawal (query, then write). ─────────────────
  // 🔴 THE ESCAPE HATCH OUT OF `revoked`. The edge `_id` is derived from the
  // pair, so there is exactly ONE row per pair forever; without this branch the
  // `findOne` above would find the revoked row, report `created: false` and
  // return — i.e. re-linking a pair somebody had unlinked would be a SILENT
  // NO-OP, the edge would stay `revoked`, and `revoked` would be a terminal
  // state no user action could leave.
  //
  // ⚠️ CAS, and the class is named in `match` too: `TraceLink` shares
  // `DOMAIN_RELATION` with upstream `core.class.Relation`.
  //
  // ⚠️ THE INCREMENT IS A SECOND `TxUpdateDoc` IN THE SAME APPLY BLOCK, not a
  // second field on the first one. `DocumentUpdate` has no `$set` (it is absent
  // from `_getOperator`'s table entirely), so the only way to combine them
  // would be the MIXED payload `{ state: 'active', $inc: {...} }` — and
  // `isOperator` reads that as a non-operator update because `state` does not
  // start with `$`, which routes it down the Postgres `jsonb_set` path where
  // the `$inc` is dropped without a word. Two transactions inside one
  // `TxApplyIf` land together and each takes the path it needs.
  //
  // ⚠️ RETRIED, NOT ASSERTED. `assertCommitted` here used to turn "another
  // caller reactivated the same edge first" — the desired end state — into a
  // user-visible failure.
  let reactivated = false
  for (let attempt = 0; !reactivated && link.state === 'revoked' && attempt < LINK_IMPLEMENTS_MAX_ATTEMPTS; attempt++) {
    const reactivate = applyStepFor(client, command, 'reactivate', `${LINK_IMPLEMENTS_PAIR} ${linkId}`)
    reactivate.match<TraceLink>(traceability.class.TraceLink, { _id: linkId, state: 'revoked' })
    await reactivate.updateDoc<TraceLink>(traceability.class.TraceLink, link.space, linkId, { state: 'active' })
    // ⚠️ THE *ASSERTION* COUNTER, NOT THE ONE THIS COMMAND KEYS ON. Advancing
    // its own discriminator would move a re-entry (crash between here and the
    // activity records) onto a different ledger row and a different set of
    // derived activity ids, i.e. it would announce the same event twice. It
    // advances the counter `unlinkImplements` keys on, so the NEXT withdrawal
    // gets a fresh row.
    await reactivate.updateDoc<TraceLink>(traceability.class.TraceLink, link.space, linkId, {
      $inc: { assertionGeneration: 1 }
    })
    if ((await reactivate.commit()).result) {
      reactivated = true
      // Reported as a creation: from the caller's point of view this attempt is
      // the one that made the assertion live again, and a batch summary that
      // counted it as "already linked" would under-report the work done.
      created = true
      break
    }
    const fresh = await client.findOne<TraceLink>(traceability.class.TraceLink, { _id: linkId })
    if (fresh === undefined) {
      throw new LinkImplementsError('link-id-taken', `Trace link '${linkId}' vanished while being reactivated`)
    }
    // Somebody moved the row underneath us. If they reactivated it, the loop
    // ends here and this attempt honestly reports `created: false`.
    link = fresh
  }
  if (!reactivated && link.state === 'revoked') {
    throw new LinkImplementsError(
      'contended',
      `Trace link '${linkId}' changed underneath ${LINK_IMPLEMENTS_MAX_ATTEMPTS} attempts to reactivate it`
    )
  }

  // ── Activity on BOTH endpoints (query, then write). ──────────────────────
  // 🔴 `DOMAIN_RELATION` is excluded from Activity, so creating the edge above
  // produced NO history entry on either object. `TraceLink`'s own doc comment
  // makes writing both records a requirement of creating any edge.
  //
  // ⚠️ THE SCOPE CARRIES THE REVOCATION GENERATION. Every assertion after a
  // withdrawal is a NEW historical event and must get its own pair of records:
  // a generation-free scope would make `ensureTraceActivity` find round 0's
  // "linked" announcement and skip writing, so a revive would be invisible in
  // both timelines while the withdrawal stayed visible — the history would read
  // as if the link were still withdrawn. It is safe to read it here, AFTER the
  // write, precisely because this command never advances that counter: the
  // value is the same one the ledger keys used, so a re-entry lands on exactly
  // these ids.
  const pairKey = linkImplementsPairKey(workItem._id, requirement._id, traceLinkRevocations(link))
  await ensureTraceActivity(client, command, {
    _id: commandObjectId<DocUpdateMessage>(LINK_IMPLEMENTS_PAIR, pairKey, linkImplementsRoles.workItemActivity),
    attachedTo: workItem._id,
    attachedToClass: workItem._class,
    space: workItem.space,
    link: linkId
  })
  await ensureTraceActivity(client, command, {
    _id: commandObjectId<DocUpdateMessage>(LINK_IMPLEMENTS_PAIR, pairKey, linkImplementsRoles.requirementActivity),
    attachedTo: requirement._id,
    attachedToClass: requirement._class,
    space: requirement.space,
    link: linkId
  })

  return { link: linkId, created }
}
