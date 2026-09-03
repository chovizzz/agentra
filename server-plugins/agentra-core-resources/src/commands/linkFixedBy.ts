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
import traceability, {
  normId,
  traceEndpointRoles,
  traceLinkId,
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
 * `Defect --fixed-by--> PullRequest`, the last trace kind with no creation path.
 *
 * ## The shape of this command differs from `linkImplements`, on purpose
 *
 * `implements` is asserted by a human once and withdrawn by a human once.
 * `fixed-by` is asserted by a MACHINE, repeatedly: a pull request body is edited,
 * re-parsed, and the set of closing references it names changes. A reference
 * that disappears must revoke the edge; a reference that comes back must revive
 * it — and it must be able to do so an unbounded number of times.
 *
 * 🔴 THAT IS WHY THERE IS NO INNER PAIR CLAIM HERE.
 *
 * `linkImplements` runs its body inside a SECOND ledger claim, and that claim
 * WAS keyed on the pair alone (`LINK_IMPLEMENTS_PAIR` + `"<work item>
 * <requirement>"`). Such a row is written once and succeeds forever, so the
 * sequence
 *
 *   link → unlink → link
 *
 * had its third step REPLAY the first step's stored result without ever entering
 * the body — the reactivation branch never ran, the caller was told "linked",
 * and the edge stayed `revoked`. The bug is invisible to a test that links once.
 *
 * A pair-keyed claim can only be made repeatable by folding a GENERATION
 * ("which round of link/revoke is this") into its key. Observed STATE cannot
 * stand in for one: it alternates rather than increasing, so
 * `revoke → link → revoke` reuses the first revoke's key and replays it.
 *
 * 🔴 THAT GENERATION NOW EXISTS — AND THIS COMMAND STILL DOES NOT USE IT.
 * `TraceLink` carries `revocationGeneration` / `assertionGeneration`, and
 * `linkImplements` / `unlinkImplements` fold them into their claims (see
 * `linkImplementsPairKey`). This command does not, for a reason that is about
 * its CALLER rather than about the mechanism: its outer key already varies with
 * the pull request body revision, which is the event that changes the answer,
 * so the round is already distinguished one level up. Adding a second
 * discriminator would buy nothing and would put a WRITE (the `$inc`) on a path
 * that currently reaches its end state with `state` alone. If a caller ever
 * appears that cannot vary its key — a manual "mark fixed by" button, say —
 * this is the change to make, and `linkImplements` is the worked example.
 *
 * ⚠️ So this command leaves both counters untouched. They are per-edge and
 * per-kind, a `fixed-by` edge is a different row from an `implements` one, and
 * nothing reads them for `fixed-by` — but a future reader should not mistake a
 * `fixed-by` edge sitting at generation 0 after ten revocations for a bug in
 * the counters.
 *
 * So the inner claim is dropped and its two jobs are done by the mechanisms that
 * are genuinely cross-process:
 *
 * - the derived `_id` (`traceLinkId`) under the Postgres
 *   `PRIMARY KEY("workspaceId", _id)`, which makes a duplicate create a `23505`;
 * - a `state` compare-and-swap on every transition.
 *
 * Both losers RETRY rather than surface an error ({@link FIXED_BY_MAX_ATTEMPTS}),
 * which is what the pair claim bought and the only thing it bought.
 *
 * 🔴 THE OUTER CLAIM STAYS, AND ITS KEY IS THE CALLER'S CONTRACT. The outer
 * ledger row is `(LinkFixedBy:<defect>:<pull request>, idempotencyKey)`. A
 * caller that reuses ONE key for a pair forever re-creates the same trap one
 * level up — the second assertion after a revocation would replay. The key must
 * therefore vary with the PULL REQUEST BODY REVISION, which is exactly the event
 * that changes the answer; {@link fixedByIdempotencyKey} builds it and
 * {@link LinkFixedByInput.idempotencyKey} is documented as such.
 *
 * ## Leftovers, deliberately not done here
 *
 * Nothing calls this command yet. `services/github/pod-github` has no dependency
 * on any Agentra package (checked: none of its 113 dependencies), so wiring the
 * webhook would mean adding one, which is out of scope for this change. The
 * webhook side must, when a pull request is opened / edited / synchronised:
 * parse the body with `parseClosingReferences` (`@hcengineering/traceability`),
 * resolve each reference onto an `Issue` (`#123` needs the repository binding,
 * `AGENTRA-45` is a lookup on `Issue.identifier`), and hand the resolved set to
 * {@link reconcileFixedBy}.
 */

/**
 * Command name. Part of the persisted contract: it is the first component of
 * every derived `_id` this command produces, so renaming it re-points all of
 * them and a replay would write a second set of objects.
 *
 * @public
 */
export const LINK_FIXED_BY = 'LinkFixedBy'

/**
 * @public
 */
export const REVOKE_FIXED_BY = 'RevokeFixedBy'

/**
 * Object roles for {@link commandObjectId}. Stable forever.
 *
 * ⚠️ The link roles and the revoke roles are DISTINCT, for the same reason
 * `unlinkImplementsRoles` differs from `linkImplementsRoles`: reusing them would
 * make `ensureTraceActivity` find the assertion record and skip writing the
 * withdrawal one, so the revocation would be missing from both timelines.
 *
 * @public
 */
export const fixedByRoles = {
  defectActivity: 'activity:fixed-by-defect',
  pullRequestActivity: 'activity:fixed-by-pull-request',
  revokeDefectActivity: 'activity:revoke-fixed-by-defect',
  revokePullRequestActivity: 'activity:revoke-fixed-by-pull-request'
} as const

/**
 * How many times a transition re-reads and retries before giving up.
 *
 * 🔴 BOUNDED. The retry replaces the inner pair claim, and an unbounded loop
 * would turn a pathological contention pattern into a hung webhook handler.
 * Three attempts covers "somebody else won the race, re-read and agree with
 * them", which converges in one extra pass; anything beyond that is a genuine
 * fault and is reported as one.
 *
 * @public
 */
export const FIXED_BY_MAX_ATTEMPTS = 3

/**
 * The scope string identifying one (defect, pull request) pair.
 *
 * 🔴 SEPARATOR, NOT CONCATENATION — see `linkImplementsPairKey`.
 *
 * @public
 */
export function fixedByPairKey (defect: Ref<Doc>, pullRequest: Ref<Doc>): string {
  return `${defect} ${pullRequest}`
}

/**
 * The outer ledger namespace for one (defect, pull request) pair.
 *
 * 🔴 BOTH IDS GO IN. `commandExecutionId` is `sha256(command ‖ idempotencyKey)`,
 * so with a CONSTANT command name the ledger row is decided entirely by a key
 * the CALLER supplies — and the caller here is a webhook handler that invents
 * keys from GitHub payloads. A key that already succeeded for one pair, presented
 * while naming a different one, would have `CommandMiddleware.resume` hand back
 * the first pair's stored result without ever entering the body. Binding only
 * ONE of the two ids is not enough either: the row would still be shared by
 * every pair that holds that id on the bound side, so a key that succeeded for
 * (defect A, PR 1) would replay for (defect A, PR 2).
 *
 * @public
 */
export function linkFixedByCommandNamespace (defect: Ref<Doc>, pullRequest: Ref<Doc>): string {
  return `${LINK_FIXED_BY}:${defect}:${pullRequest}`
}

/**
 * @public
 */
export function revokeFixedByCommandNamespace (defect: Ref<Doc>, pullRequest: Ref<Doc>): string {
  return `${REVOKE_FIXED_BY}:${defect}:${pullRequest}`
}

/**
 * Build the idempotency key for one assertion about one pair.
 *
 * 🔴 `revision` IS THE "WHICH ROUND" ALGEBRA, and omitting it is the whole bug
 * this command is written to avoid. It must change whenever the FACT could have
 * changed — in practice the pull request's `updatedAt`, the webhook delivery id,
 * or the head commit sha. A constant here makes the outer ledger row permanent
 * and a revoked edge unrevivable.
 *
 * @public
 */
export function fixedByIdempotencyKey (defect: Ref<Doc>, pullRequest: Ref<Doc>, revision: string): string {
  return `traceability:fixed-by:v1:${defect}:${pullRequest}:${revision}`
}

/**
 * @public
 */
export interface LinkFixedByInput {
  /** The defect. `tracker.class.Issue` carries both the `Bug` and `WorkItem` role. */
  defect: Ref<Issue>
  /**
   * The pull request.
   *
   * ⚠️ A bare `Ref<Doc>` plus its class, NOT a typed `Ref<GithubPullRequest>`.
   * The GitHub classes live in `services/github/github`, which this package does
   * not and must not depend on; a `TraceLink` stores `Ref<Doc>` and a class
   * string anyway, so the type would buy nothing but a dependency.
   */
  pullRequest: Ref<Doc>
  pullRequestClass: Ref<Class<Doc>>
  /** @see fixedByIdempotencyKey — MUST vary with the pull request body revision. */
  idempotencyKey: string
  /**
   * Provenance stored on the edge.
   *
   * ⚠️ A CLOSED KEY SET, not free-form. See `traceLinkMetadata.ts` — the blob
   * is readable workspace-wide, so nothing read off the defect or the pull
   * request may go in it.
   */
  metadata?: TraceLinkMetadataInput
}

/**
 * @public
 */
export interface RevokeFixedByInput {
  defect: Ref<Issue>
  pullRequest: Ref<Doc>
  pullRequestClass: Ref<Class<Doc>>
  /** @see fixedByIdempotencyKey — MUST vary with the pull request body revision. */
  idempotencyKey: string
}

/**
 * @public
 */
export interface LinkFixedByResult extends Record<string, any> {
  defect: Ref<Issue>
  pullRequest: Ref<Doc>
  traceLink: Ref<TraceLink>
  /** `true` when the edge was already `active` when this attempt looked. */
  alreadyLinked: boolean
  /** `true` when this attempt brought a `revoked` (or `orphaned`) edge back. */
  revived: boolean
}

/**
 * @public
 */
export interface RevokeFixedByResult extends Record<string, any> {
  defect: Ref<Issue>
  pullRequest: Ref<Doc>
  traceLink: Ref<TraceLink>
  /** `true` when the edge was already `revoked` when this attempt looked. */
  alreadyRevoked: boolean
}

/**
 * @public
 */
export class FixedByError extends Error {
  readonly code = 400

  constructor (
    readonly reason:
    | 'defect-not-found'
    | 'pull-request-not-found'
    | 'pull-request-class-not-registered'
    | 'invalid-trace-link'
    | 'link-not-found'
    | 'link-id-taken'
    | 'contended',
    message: string
  ) {
    super(message)
    this.name = 'FixedByError'
  }
}

/**
 * @public
 */
export interface FixedByContext {
  ctx: MeasureContext<SessionData>
  /** Must carry the CALLING account, so every write is attributed and secured. */
  client: TxOperations
  runner: CommandRunner
  endpoints?: TraceEndpointRegistry
  staleTimeoutMs?: number
}

/**
 * Assert `Defect --fixed-by--> PullRequest`.
 *
 * @public
 */
export async function linkFixedBy (
  context: FixedByContext,
  input: LinkFixedByInput
): Promise<CommandOutcome<LinkFixedByResult>> {
  const { ctx, client, runner } = context
  const endpoints = context.endpoints ?? agentraTraceEndpoints
  const request: CommandRequest = {
    command: linkFixedByCommandNamespace(input.defect, input.pullRequest),
    idempotencyKey: input.idempotencyKey,
    staleTimeoutMs: context.staleTimeoutMs
  }

  // 🔴 CHECKED BEFORE THE RUNNER, not only inside the body. `CommandMiddleware`
  // replays a `succeeded` row's stored result WITHOUT re-entering the body, and
  // the row is keyed on ids the CALLER supplies — so once anyone links a pair, a
  // caller with no access to either endpoint would otherwise get a clean success
  // back and learn that the defect exists, that the pull request exists, and
  // that they are linked. Re-reading here makes the replayed path answer exactly
  // like the fresh one.
  //
  // ⚠️ It guards a DIFFERENT hole from the namespacing above and neither
  // substitutes for the other: the namespace stops a key crossing between
  // subjects, this stops a replay of the caller's OWN subject leaking to
  // somebody who has since lost access to it.
  await assertEndpointsReadable(client, endpoints, input.defect, input.pullRequest, input.pullRequestClass)

  return await runner.run<LinkFixedByResult>(ctx, request, async () => await runLink(ctx, client, endpoints, input))
}

/**
 * Withdraw `Defect --fixed-by--> PullRequest`.
 *
 * 🔴 REVOKE, NOT DELETE, and 🔴 REVOKING RELEASES THE DELETE PROTECTION ON BOTH
 * ENDPOINTS. `ArchivableGuard.validateRemove` (`../deleteGuard`) refuses a
 * physical `TxRemoveDoc` of an archivable object that still carries a trace edge,
 * and it queries with `state: { $ne: 'revoked' }` — so the moment this flips the
 * last edge to `revoked`, a defect that was undeletable becomes deletable. For
 * `fixed-by` that consequence is reached by a MACHINE editing a pull request
 * body, not by a human pressing "unlink", which is the more surprising half.
 *
 * @public
 */
export async function revokeFixedBy (
  context: FixedByContext,
  input: RevokeFixedByInput
): Promise<CommandOutcome<RevokeFixedByResult>> {
  const { ctx, client, runner } = context
  const endpoints = context.endpoints ?? agentraTraceEndpoints
  const request: CommandRequest = {
    command: revokeFixedByCommandNamespace(input.defect, input.pullRequest),
    idempotencyKey: input.idempotencyKey,
    staleTimeoutMs: context.staleTimeoutMs
  }

  await assertEndpointsReadable(client, endpoints, input.defect, input.pullRequest, input.pullRequestClass)

  return await runner.run<RevokeFixedByResult>(ctx, request, async () => await runRevoke(ctx, client, input))
}

/**
 * Both endpoints must be readable BY THE CALLER, on every path.
 *
 * The same two reads happen again inside the bodies; that is deliberate rather
 * than redundant. This one guards the REPLAY (which never enters the body), the
 * ones inside guard the write and additionally supply the documents.
 */
async function assertEndpointsReadable (
  client: TxOperations,
  endpoints: TraceEndpointRegistry,
  defect: Ref<Issue>,
  pullRequest: Ref<Doc>,
  pullRequestClass: Ref<Class<Doc>>
): Promise<void> {
  await readDefect(client, defect)
  await readPullRequest(client, endpoints, pullRequest, pullRequestClass)
}

async function readDefect (client: TxOperations, _id: Ref<Issue>): Promise<Issue> {
  // Pinned to `tracker.class.Issue`: it stops an id of some unrelated class from
  // being linked, and it routes the read through the caller's security filter,
  // so a caller who may not read the defect cannot assert anything about it.
  const issue = await client.findOne<Issue>(tracker.class.Issue, { _id })
  if (issue === undefined) {
    throw new FixedByError('defect-not-found', `Defect '${_id}' does not exist`)
  }
  return issue
}

/**
 * Read the pull request, pinned to the class the CALLER named — after checking
 * that class actually holds the `PullRequest` role.
 *
 * 🔴 THE ROLE CHECK COMES FIRST, and it is what makes accepting a caller-supplied
 * class safe. Without it a caller could name any class at all and this would
 * happily read (and link to) an unrelated document. With it, only a class some
 * module registered as a `PullRequest` gets through, and `validateTraceLink`
 * fails closed on everything else anyway.
 *
 * ⚠️ Pinning the read to that class rather than to `core.class.Doc` is not
 * cosmetic: an unpinned read would let a caller pass a PullRequest class
 * alongside the id of something else entirely and satisfy both this check and
 * the matrix check with two different documents.
 */
async function readPullRequest (
  client: TxOperations,
  endpoints: TraceEndpointRegistry,
  _id: Ref<Doc>,
  _class: Ref<Class<Doc>>
): Promise<Doc> {
  if (!traceEndpointRoles(endpoints, _class).includes('PullRequest')) {
    throw new FixedByError(
      'pull-request-class-not-registered',
      `'${_class}' is not registered as a PullRequest trace endpoint`
    )
  }
  const doc = await client.findOne<Doc>(_class as Ref<any>, { _id })
  if (doc === undefined) {
    throw new FixedByError('pull-request-not-found', `Pull request '${_id}' does not exist`)
  }
  return doc
}

async function runLink (
  ctx: MeasureContext<SessionData>,
  client: TxOperations,
  endpoints: TraceEndpointRegistry,
  input: LinkFixedByInput
): Promise<LinkFixedByResult> {
  const defect = await readDefect(client, input.defect)
  const pullRequest = await readPullRequest(client, endpoints, input.pullRequest, input.pullRequestClass)

  // ── The matrix check, server side. ───────────────────────────────────────
  // ⚠️ `tracker.class.Issue` carries BOTH the `Bug` and the `WorkItem` role, and
  // `validateTraceLink` takes the INTERSECTION with the matrix row: the
  // `fixed-by` row has no `WorkItem` source, so the dual registration cannot
  // widen what this accepts.
  const validation = validateTraceLink(
    endpoints,
    'fixed-by',
    defect._class,
    pullRequest._class,
    defect._id,
    pullRequest._id
  )
  if (!validation.valid) {
    // Fail closed. `unknown-target-class` here means no module registered a
    // PullRequest class in this process — see `traceEndpoints.ts`.
    throw new FixedByError(
      'invalid-trace-link',
      `Trace link Defect --fixed-by--> PullRequest rejected: ${validation.reason ?? 'unknown'}`
    )
  }

  const linkId = traceLinkId('fixed-by', defect._id, pullRequest._id)
  let alreadyLinked = false
  let revived = false
  let settled = false

  // ── The edge: query, then write, then re-read and agree. ─────────────────
  for (let attempt = 0; attempt < FIXED_BY_MAX_ATTEMPTS && !settled; attempt++) {
    // 🔴 PINNED TO `traceability.class.TraceLink`. `TraceLink` shares
    // `DOMAIN_RELATION` with upstream `core.class.Relation`, so a query naming
    // only the `_id` could answer with — and this could then write to — an
    // upstream relation row that happened to collide.
    const link = await client.findOne<TraceLink>(traceability.class.TraceLink, { _id: linkId })
    if (link === undefined) {
      const apply = applyStepFor(client, LINK_FIXED_BY, 'trace-link')
      await apply.createDoc<TraceLink>(
        traceability.class.TraceLink,
        core.space.Workspace,
        {
          // 🔴 `docA` / `docB`, not `source` / `target`: those two names are the
          // only ones the Postgres relation schema promotes to indexed columns.
          docA: defect._id,
          sourceClass: defect._class as Ref<Class<Doc>>,
          docB: pullRequest._id,
          targetClass: pullRequest._class,
          kind: 'fixed-by',
          sourceBaseId: normId(defect),
          targetBaseId: normId(pullRequest),
          state: 'active',
          // ⚠️ WRITE-ONCE. `metadata` is absent from both
          // `TRACE_LINK_MUTABLE_FIELDS` and `TRACE_LINK_INCREMENTABLE_FIELDS`,
          // so whatever goes in here can never be corrected. It records the
          // FIRST assertion only, which is why it holds provenance and not a
          // counter — the counters are their own fields, and `$inc`-only.
          metadata: traceLinkMetadata({ command: LINK_FIXED_BY, ...input.metadata })
        },
        linkId
      )
      try {
        assertCommitted(await apply.commit(), 'create fixed-by link')
        settled = true
      } catch (err: unknown) {
        if (!isDuplicateKeyError(err)) throw err
        // Another attempt won the race between the `findOne` and this write.
        // That is the desired end state, not a failure: loop, re-read and agree
        // with whoever got there first.
        continue
      }
    } else if (link.kind !== 'fixed-by') {
      throw new FixedByError(
        'link-id-taken',
        `Derived trace link id '${linkId}' is already held by a '${link.kind}' edge`
      )
    } else if (link.state === 'active') {
      alreadyLinked = true
      settled = true
    } else {
      // 🔴 THE ESCAPE HATCH OUT OF `revoked`, and the reason this command exists
      // in this shape. The edge `_id` is derived from the pair, so there is
      // exactly ONE row per pair forever; a pull request body that re-adds a
      // closing reference must be able to bring that row back, an unbounded
      // number of times.
      //
      // ⚠️ `orphaned` is revived too. It means "one end was deleted"; we have
      // just read BOTH ends through the caller's security filter, so the
      // condition that produced it no longer holds.
      //
      // ⚠️ CAS, and the class is named in `match` too, for the co-tenancy reason
      // above. `assertCommitted` is NOT used here: a rejected `TxApplyIf` means
      // somebody moved the row underneath us, which is a retry, not a fault.
      const reactivate = applyStepFor(client, LINK_FIXED_BY, 'reactivate', `${LINK_FIXED_BY} ${linkId}`)
      reactivate.match<TraceLink>(traceability.class.TraceLink, { _id: linkId, state: link.state })
      await reactivate.updateDoc<TraceLink>(traceability.class.TraceLink, link.space, linkId, { state: 'active' })
      if ((await reactivate.commit()).result) {
        revived = true
        settled = true
      }
    }
  }
  if (!settled) {
    throw new FixedByError(
      'contended',
      `Trace link '${linkId}' changed underneath ${FIXED_BY_MAX_ATTEMPTS} attempts to assert it`
    )
  }

  // ── Activity on BOTH endpoints (query, then write). ──────────────────────
  // 🔴 `DOMAIN_RELATION` is excluded from Activity, so the writes above produced
  // NO history entry on either object.
  //
  // ⚠️ THE SCOPE CARRIES THE CALLER'S KEY, not just the pair. Every assertion
  // after a revocation is a NEW historical event and must get its own record; a
  // pair-only scope would make `ensureTraceActivity` find the first record and
  // skip writing, so a revive would be silent in both timelines. A true replay
  // presents the same key and correctly writes nothing.
  const scope = `${fixedByPairKey(defect._id, pullRequest._id)} ${input.idempotencyKey}`
  await ensureTraceActivity(client, LINK_FIXED_BY, {
    _id: commandObjectId<DocUpdateMessage>(LINK_FIXED_BY, scope, fixedByRoles.defectActivity),
    attachedTo: defect._id,
    attachedToClass: defect._class,
    space: defect.space,
    link: linkId
  })
  await ensureTraceActivity(client, LINK_FIXED_BY, {
    _id: commandObjectId<DocUpdateMessage>(LINK_FIXED_BY, scope, fixedByRoles.pullRequestActivity),
    attachedTo: pullRequest._id,
    attachedToClass: pullRequest._class,
    space: pullRequest.space,
    link: linkId
  })

  ctx.info('agentra fixed-by link asserted', {
    defect: defect._id,
    pullRequest: pullRequest._id,
    traceLink: linkId,
    alreadyLinked,
    revived,
    idempotencyKey: input.idempotencyKey
  })

  return { defect: defect._id, pullRequest: pullRequest._id, traceLink: linkId, alreadyLinked, revived }
}

async function runRevoke (
  ctx: MeasureContext<SessionData>,
  client: TxOperations,
  input: RevokeFixedByInput
): Promise<RevokeFixedByResult> {
  const defect = await readDefect(client, input.defect)
  const pullRequest = await client.findOne<Doc>(input.pullRequestClass as Ref<any>, { _id: input.pullRequest })
  if (pullRequest === undefined) {
    throw new FixedByError('pull-request-not-found', `Pull request '${input.pullRequest}' does not exist`)
  }

  const linkId = traceLinkId('fixed-by', defect._id, pullRequest._id)
  let alreadyRevoked = false
  let settled = false
  for (let attempt = 0; attempt < FIXED_BY_MAX_ATTEMPTS && !settled; attempt++) {
    const link = await client.findOne<TraceLink>(traceability.class.TraceLink, { _id: linkId })
    if (link === undefined || link.kind !== 'fixed-by') {
      // Fail closed. Nothing was ever asserted about this pair, so there is
      // nothing to withdraw — and answering "done" would tell a caller that an
      // edge existed.
      throw new FixedByError(
        'link-not-found',
        `No fixed-by link between defect '${defect._id}' and pull request '${pullRequest._id}'`
      )
    }
    if (link.state === 'revoked') {
      alreadyRevoked = true
      settled = true
      continue
    }
    const apply = applyStepFor(client, REVOKE_FIXED_BY, 'revoke', `${REVOKE_FIXED_BY} ${linkId}`)
    apply.match<TraceLink>(traceability.class.TraceLink, { _id: linkId, state: link.state })
    await apply.updateDoc<TraceLink>(traceability.class.TraceLink, link.space, linkId, { state: 'revoked' })
    if ((await apply.commit()).result) {
      settled = true
    }
  }
  if (!settled) {
    throw new FixedByError(
      'contended',
      `Trace link '${linkId}' changed underneath ${FIXED_BY_MAX_ATTEMPTS} attempts to withdraw it`
    )
  }

  const scope = `${fixedByPairKey(defect._id, pullRequest._id)} ${input.idempotencyKey}`
  await ensureTraceActivity(client, REVOKE_FIXED_BY, {
    _id: commandObjectId<DocUpdateMessage>(REVOKE_FIXED_BY, scope, fixedByRoles.revokeDefectActivity),
    attachedTo: defect._id,
    attachedToClass: defect._class,
    space: defect.space,
    link: linkId,
    action: 'remove'
  })
  await ensureTraceActivity(client, REVOKE_FIXED_BY, {
    _id: commandObjectId<DocUpdateMessage>(REVOKE_FIXED_BY, scope, fixedByRoles.revokePullRequestActivity),
    attachedTo: pullRequest._id,
    attachedToClass: pullRequest._class,
    space: pullRequest.space,
    link: linkId,
    action: 'remove'
  })

  ctx.info('agentra fixed-by link revoked', {
    defect: defect._id,
    pullRequest: pullRequest._id,
    traceLink: linkId,
    alreadyRevoked,
    idempotencyKey: input.idempotencyKey
  })

  return { defect: defect._id, pullRequest: pullRequest._id, traceLink: linkId, alreadyRevoked }
}

/**
 * @public
 */
export interface ReconcileFixedByInput {
  pullRequest: Ref<Doc>
  pullRequestClass: Ref<Class<Doc>>
  /**
   * The defects the pull request body currently names, already resolved onto
   * documents. An EMPTY array is meaningful: it revokes every edge the pull
   * request still holds.
   */
  defects: readonly Ref<Issue>[]
  /** @see fixedByIdempotencyKey — MUST vary with the pull request body revision. */
  revision: string
  /** @see LinkFixedByInput.metadata — the same closed key set. */
  metadata?: TraceLinkMetadataInput
}

/**
 * @public
 */
export interface ReconcileFixedByResult {
  linked: Ref<Issue>[]
  revoked: Ref<Issue>[]
  /**
   * Whatever this attempt could not settle, with the reason. Never thrown.
   *
   * ⚠️ `subject` is a bare `Ref<Doc>` rather than `Ref<Issue>`: the one failure
   * that is not about a defect — the "which edges exist now" read itself — is
   * reported here too, naming the pull request.
   */
  skipped: Array<{ subject: Ref<Doc>, reason: string }>
}

/**
 * Bring the `fixed-by` edges of one pull request in line with the references its
 * body currently names.
 *
 * 🔴 NEVER THROWS, AND NEVER BLOCKS THE CALLER. The caller is a webhook handler
 * on GitHub's delivery path: an unresolvable reference, a defect the integration
 * account cannot read, or a deleted document must all end as "no edge", not as a
 * failed delivery that GitHub retries forever. Per-pair failures are collected
 * in {@link ReconcileFixedByResult.skipped}.
 *
 * 🔴 THE "WHICH EDGES EXIST NOW" READ DOES NOT GO THROUGH THE RUNNER. It is a
 * pure query, and `CommandMiddleware.resume` would replay a stale answer to it —
 * which for a reconciler means revoking edges that were re-added, or missing
 * edges that were removed. Only the two mutating commands are claimed.
 *
 * @public
 */
export async function reconcileFixedBy (
  context: FixedByContext,
  input: ReconcileFixedByInput
): Promise<ReconcileFixedByResult> {
  const result: ReconcileFixedByResult = { linked: [], revoked: [], skipped: [] }
  const wanted = new Set<Ref<Issue>>(input.defects)

  // The edges this pull request still holds, read live. `docB` is the indexed
  // target column, and `state` narrows to the ones a revocation would change.
  let existing: TraceLink[] = []
  try {
    existing = Array.from(
      await context.client.findAll<TraceLink>(traceability.class.TraceLink, {
        docB: input.pullRequest,
        kind: 'fixed-by',
        state: 'active'
      })
    )
  } catch (err: unknown) {
    result.skipped.push({ subject: input.pullRequest, reason: describe(err) })
    return result
  }

  for (const defect of wanted) {
    try {
      const outcome = await linkFixedBy(context, {
        defect,
        pullRequest: input.pullRequest,
        pullRequestClass: input.pullRequestClass,
        idempotencyKey: fixedByIdempotencyKey(defect, input.pullRequest, input.revision),
        metadata: input.metadata
      })
      result.linked.push(outcome.result.defect)
    } catch (err: unknown) {
      result.skipped.push({ subject: defect, reason: describe(err) })
    }
  }

  for (const link of existing) {
    const defect = link.docA as Ref<Issue>
    if (wanted.has(defect)) continue
    try {
      await revokeFixedBy(context, {
        defect,
        pullRequest: input.pullRequest,
        pullRequestClass: input.pullRequestClass,
        idempotencyKey: fixedByIdempotencyKey(defect, input.pullRequest, input.revision)
      })
      result.revoked.push(defect)
    } catch (err: unknown) {
      result.skipped.push({ subject: defect, reason: describe(err) })
    }
  }

  context.ctx.info('agentra fixed-by edges reconciled', {
    pullRequest: input.pullRequest,
    revision: input.revision,
    linked: result.linked.length,
    revoked: result.revoked.length,
    skipped: result.skipped.length
  })
  return result
}

function describe (err: unknown): string {
  if (err instanceof FixedByError) return err.reason
  return err instanceof Error ? err.message : String(err)
}
