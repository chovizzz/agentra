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

import activity, { type ActivityInfoMessage } from '@hcengineering/activity'
import type { Class, Doc, MeasureContext, Ref, SessionData, TxOperations } from '@hcengineering/core'
import type { Asset, IntlString } from '@hcengineering/platform'
import products, { ProductVersionState, type ProductVersion } from '@hcengineering/products'
import requirements, { type Requirement } from '@hcengineering/requirements'
import traceability, {
  inheritableTraceEdges,
  normId,
  traceLinkId,
  type CoverageEdge,
  type TraceLink
} from '@hcengineering/traceability'
import { commandObjectId, type CommandOutcome, type CommandRequest } from '@hcengineering/server-agentra-core'

import { assertCommitted } from '../commandMiddleware'
import { traceLinkMetadata } from '../traceLinkMetadata'
import type { CommandRunner } from './convertLeadToRequirement'
import { evaluateReleaseGate, releaseGateVerdict, type ReleaseGateReader, type ReleaseGateVerdict } from './releaseGate'
import { applyStepFor } from './traceCommandSupport'

/**
 * Command name. Part of the persisted contract: the first component of every
 * derived `_id` this command produces, so renaming it re-points all of them and
 * a replay would write a second audit record.
 *
 * @public
 */
export const RELEASE_PRODUCT_VERSION = 'ReleaseProductVersion'

/**
 * The INNER claim, keyed on the ProductVersion rather than on the caller's
 * idempotency key.
 *
 * 🔴 WHY BOTH. The outer ledger row excludes on `(command, idempotencyKey)`,
 * which stops the SAME request running twice and says nothing about two
 * DIFFERENT keys releasing the same version — and `idempotencyKey` is caller
 * supplied. Claiming `(RELEASE_PRODUCT_VERSION_LOCK, versionId)` moves the
 * exclusion onto the VERSION, where the ledger table's Postgres primary key can
 * enforce it.
 *
 * ⚠️ THE PRIMARY KEY IS THE ARBITER, NOT `match`. `ApplyTxMiddleware`'s
 * `match` / `notMatch` are a read-then-write inside ONE transactor process and
 * `scopes` is a per-process `Map`; across replicas they exclude nothing. The
 * genuine cross-process mutual exclusion here is a `23505` on the derived
 * ledger `_id`.
 *
 * @public
 */
export const RELEASE_PRODUCT_VERSION_LOCK = `${RELEASE_PRODUCT_VERSION}:version`

/**
 * The OUTER ledger namespace, bound to the version.
 *
 * 🔴 THE COMMAND NAME ALONE IS NOT ENOUGH, AND THIS IS A SECURITY FIX.
 * `commandExecutionId` derives the ledger row's `_id` from
 * `(command, idempotencyKey)`, and `idempotencyKey` is CALLER SUPPLIED. With a
 * constant command name, presenting version A's succeeded key while naming
 * version B lands on A's ledger row: `CommandMiddleware.resume` returns A's
 * stored result verbatim, which both leaks A's gate report to someone who only
 * proved they can read B, and tells them B was released when nothing happened.
 * Folding the version into the namespace makes the two rows different by
 * construction, so a key can only ever replay the version it was used on.
 *
 * ⚠️ The inner claim is already keyed on the version, which is why the damage
 * was confined to the outer row — but the outer row is the one that answers
 * first.
 *
 * @public
 */
export function releaseCommandNamespace (version: Ref<Doc>): string {
  return `${RELEASE_PRODUCT_VERSION}:${version}`
}

/**
 * Object roles for {@link commandObjectId}. Stable forever — changing one
 * re-points the existence lookup at an id that does not exist, and the next
 * replay writes a duplicate record.
 *
 * @public
 */
export const releaseProductVersionRoles = {
  audit: 'activity:release-audit'
} as const

/** `products.string.ProductVersionStateReleased`, reused as the audit label. */
const RELEASE_MESSAGE = 'products:string:ProductVersionStateReleased' as IntlString
/** `products.icon.ProductVersion`. */
const RELEASE_ICON = 'products:icon:ProductVersion' as Asset

/**
 * The idempotency key the shipped client derives.
 *
 * 🔴 A PURE FUNCTION OF THE VERSION, exactly like `convertLeadIdempotencyKey`
 * is of the lead. The key must not carry a timestamp, a nonce or the caller's
 * identity: a retry after a dropped connection has to present the SAME key or
 * the ledger cannot recognise it and the release runs twice.
 *
 * The `v1` component is a schema marker, not a version counter — bumping it is
 * how a future incompatible result shape gets a fresh ledger namespace instead
 * of replaying results this build cannot read.
 *
 * @public
 */
export function releaseProductVersionIdempotencyKey (version: Ref<Doc>): string {
  return `products:release-product-version:v1:${version}`
}

/**
 * @public
 */
export interface ReleaseProductVersionInput {
  version: Ref<ProductVersion>
  idempotencyKey: string
  /** REL-003: the approval backing this release. Absent is a gate blocker. */
  approval?: Ref<Doc>
  /** REL-006: an administrator waiver. Must carry a reason; it is audited. */
  waiverReason?: string
  passRateThreshold?: number
  excludeSkipped?: boolean
}

/**
 * @public
 */
export interface ReleaseProductVersionResult extends Record<string, any> {
  version: Ref<ProductVersion>
  released: boolean
  /**
   * The VERDICT — never a blocker list.
   *
   * 🔴 THIS RESULT IS PERSISTED, WORLD READABLY. `CommandRunner` stores what
   * the body returns in `CommandExecution.result`, and the ledger row is
   * written into `core.space.Workspace` (`commandMiddleware.ts`'s `claim`) —
   * a space `SpaceSecurityMiddleware` hands to EVERY account unconditionally
   * (`spaceSecurity.ts:82` and `:535`). Anything sensitive returned from here
   * is therefore readable by anyone in the workspace, whatever the pre-runner
   * guard says. The blocker DETAIL lives on the read-only twin instead:
   * `previewReleaseGate` recomputes it per caller and writes nothing.
   */
  gate: ReleaseGateVerdict
  /** Requirements moved `Validating -> Released` by this release. */
  requirementsReleased: number
  /**
   * `true` when scope remained in `Validating` after the write-back.
   *
   * 🔴 A ONE-BIT FLAG, DELIBERATELY NOT A COUNT. The gate DECIDES over the
   * global view but every write goes through the caller, so a `Validating`
   * requirement in a space the caller cannot read is release-ready (not a
   * blocker) yet cannot be written back — it would sit in `Validating` behind
   * a `Released` version with nothing saying so. This flag is what says so.
   * Reporting how many would be the same cross-space side channel as reporting
   * hidden blocker counts; the number is logged server side instead.
   *
   * ⚠️ Writing those requirements through the privileged auditor is NOT the
   * fix: that reader exists to COUNT, and writing with it would stamp the
   * workspace's audit trail with edits the caller had no right to make.
   */
  writeBackIncomplete: boolean
  /**
   * `true` when the version was ALREADY `Released` when this attempt read it.
   *
   * ⚠️ Distinct from `CommandOutcome.replayed`, which means "same idempotency
   * key, result served from the ledger". This flag is about the VERSION, under
   * any key.
   */
  alreadyReleased: boolean
}

/**
 * @public
 */
export class ReleaseProductVersionError extends Error {
  readonly code = 400

  constructor (
    readonly reason: 'version-not-found' | 'illegal-transition' | 'gate-failed' | 'waiver-without-reason',
    message: string
  ) {
    super(message)
    this.name = 'ReleaseProductVersionError'
  }
}

/**
 * @public
 */
export interface ReleaseProductVersionContext {
  ctx: MeasureContext<SessionData>
  /** Must carry the CALLING account, so every write is attributed and secured. */
  client: TxOperations
  /**
   * An UNFILTERED reader used only to DECIDE the gate.
   *
   * 🔴 Read-only by construction, and its results are never echoed back
   * unredacted — {@link evaluateReleaseGate} re-reads every blocker through
   * `client` before reporting it. Defaults to `client`, in which case the
   * decision is only as complete as the caller's access; the middleware wires a
   * real system reader so PRD REL-003's "判定用全局视图" holds.
   */
  auditor?: ReleaseGateReader
  runner: CommandRunner
  staleTimeoutMs?: number
}

/**
 * The states a version may legally be released FROM.
 *
 * ⚠️ A LIST, not a numeric comparison. The lifecycle order
 * `Planning -> Active -> ReleaseCandidate -> Released -> Archived` has nothing
 * to do with the enum's numbers (`Planning` is 2, `Released` is 1), so any
 * `state < Released` style check would be silently wrong.
 *
 * @public
 */
export const RELEASABLE_FROM: readonly ProductVersionState[] = [
  ProductVersionState.Active,
  ProductVersionState.ReleaseCandidate
]

/**
 * Release a product version, exactly once per `idempotencyKey`.
 *
 * 🔴 REENTRANCY, NOT ATOMICITY. `PostgresAdapter.tx()` groups transactions by
 * domain and commits each group as its own `BEGIN`/`COMMIT`, so the audit
 * record, the N requirement write-backs, the carried-forward edges and the
 * state change below are many unrelated database transactions. A crash in the
 * middle leaves the ledger row `running`; once stale another attempt preempts
 * it and re-enters this body. EVERY step is therefore `findOne`-then-write over
 * a DERIVED `_id`, or a per-object "is it already done?" check. Nothing here
 * calls `generateId()`, and this command burns no sequence numbers — a replay
 * writes nothing twice.
 *
 * 🔴 THE AUDIT RECORD IS WRITTEN BEFORE THE WRITE-BACK, AND THAT ORDER IS LOAD
 * BEARING. The gate report is only measurable while the scope is still in its
 * pre-release state; once the write-back has moved every requirement to
 * `Released`, a re-entry that recomputed the gate would report a clean sheet
 * and the record of WHY the version was allowed to ship would be lost.
 * Persisting it first, under a derived id, makes the reported gate identical
 * across every replay.
 *
 * 🔴 EVERY `commit()` IS ASSERTED. `ApplyTxMiddleware` reports a rejected
 * `TxApplyIf` by RETURNING `{ result: false }`; it does not throw. An unchecked
 * commit would let the runner mark the execution `succeeded` over writes that
 * never landed, and the ledger would replay that phantom forever.
 *
 * @public
 */
export async function releaseProductVersion (
  context: ReleaseProductVersionContext,
  input: ReleaseProductVersionInput
): Promise<CommandOutcome<ReleaseProductVersionResult>> {
  const { ctx, client, runner } = context
  const auditor = context.auditor ?? client
  const request: CommandRequest = {
    // 🔴 Namespaced by version — see {@link releaseCommandNamespace}. A bare
    // `RELEASE_PRODUCT_VERSION` here lets one version's key replay another's
    // stored result.
    command: releaseCommandNamespace(input.version),
    idempotencyKey: input.idempotencyKey,
    staleTimeoutMs: context.staleTimeoutMs
  }

  // 🔴 CHECKED BEFORE THE RUNNER, not only inside the body. `CommandMiddleware`
  // replays a `succeeded` row's stored result WITHOUT re-entering the body, and
  // BOTH claims are keyed on data the caller supplies — the outer key is a pure
  // function of the version id, the inner one IS the version id. So once anyone
  // releases a version, an unauthorised caller naming it would otherwise be
  // handed the stored result: the gate report, the blocker list, the scope
  // sizes, and the fact that the version exists at all.
  //
  // ⚠️ A PRE-RUNNER ASSERT rather than post-runner redaction (the shape
  // `createDefect` uses). Redaction fits a result whose sensitive part is ONE
  // ref; this result is sensitive nearly end to end — `gate.blockers`,
  // `gate.passRate`, `requirementsReleased` and `alreadyReleased` all describe
  // the version's scope — so stripping it down would leave an empty envelope
  // that still confirms the version exists. Refusing at the door is both
  // simpler and strictly tighter here.
  //
  // The same read happens again inside the body; that is deliberate rather than
  // redundant. This one guards the REPLAY, the one inside guards the write and
  // additionally supplies the document.
  await assertVersionReadable(client, input.version)

  if (input.waiverReason !== undefined && input.waiverReason.trim() === '') {
    // 🔴 REFUSED, NOT IGNORED. A blank waiver reason would silently downgrade
    // to "no waiver" and the caller would be told the gate simply failed, or —
    // worse, if the gate happened to pass — that the waiver had been recorded.
    // REL-006 requires the reason to be auditable, so an unusable one is an
    // error.
    throw new ReleaseProductVersionError('waiver-without-reason', 'A gate waiver must carry a non-empty reason')
  }

  const outcome = await runner.run<ReleaseProductVersionResult>(ctx, request, async () => {
    const inner = await runner.run<ReleaseProductVersionResult>(
      ctx,
      {
        command: RELEASE_PRODUCT_VERSION_LOCK,
        idempotencyKey: input.version,
        staleTimeoutMs: context.staleTimeoutMs
      },
      async () => await runRelease(ctx, client, auditor, input)
    )
    return { ...inner.result, alreadyReleased: inner.result.alreadyReleased || inner.replayed }
  })

  // 🔴 NO POST-RUNNER REDACTION, AND ITS ABSENCE IS THE FIX RATHER THAN AN
  // OMISSION. This used to re-filter `result.gate` for the caller, because
  // `CommandMiddleware.resume` answers a `succeeded` row WITHOUT entering the
  // body and the stored payload was shaped for whoever ran the first pass. That
  // treated the symptom: the payload it was filtering had ALREADY been written
  // into `CommandExecution.result`, in `core.space.Workspace`, which every
  // account may read. Redacting the copy on its way out changed nothing about
  // the copy on disk. The body now computes a {@link ReleaseGateVerdict} that
  // carries no document identity at all, so there is nothing left to filter —
  // on the fresh path, on the replay path, or in the ledger.
  //
  // ⚠️ `assertVersionReadable` above is still required and is a DIFFERENT
  // guard: it decides whether this caller may learn that the version exists and
  // was released, which the verdict does state.
  return outcome
}

/**
 * The version must be readable BY THE CALLER, on every path.
 */
async function assertVersionReadable (client: TxOperations, version: Ref<ProductVersion>): Promise<void> {
  const found = await client.findOne<ProductVersion>(products.class.ProductVersion, { _id: version })
  if (found === undefined) {
    throw new ReleaseProductVersionError('version-not-found', `Product version '${version}' does not exist`)
  }
}

async function runRelease (
  ctx: MeasureContext<SessionData>,
  client: TxOperations,
  auditor: ReleaseGateReader,
  input: ReleaseProductVersionInput
): Promise<ReleaseProductVersionResult> {
  // ── Step 0: read the version THROUGH THE CALLER's filter. ────────────────
  const version = await client.findOne<ProductVersion>(products.class.ProductVersion, { _id: input.version })
  if (version === undefined) {
    throw new ReleaseProductVersionError('version-not-found', `Product version '${input.version}' does not exist`)
  }
  const alreadyReleased = version.state === ProductVersionState.Released

  // ── Step 0b: validate BEFORE writing anything. ──────────────────────────
  // Ordering is load bearing: writing back requirement statuses first and only
  // then discovering the transition is illegal would leave a scope marked
  // `Released` around a version that never shipped, and nothing would put it
  // back.
  if (!alreadyReleased && !RELEASABLE_FROM.includes(version.state)) {
    throw new ReleaseProductVersionError(
      'illegal-transition',
      `Product version '${version._id}' cannot be released from state '${ProductVersionState[version.state]}'`
    )
  }

  // ── Step 1: the gate, or the one an earlier pass already recorded. ──────
  // 🔴 THE PERSISTED VERDICT WINS. The scope is only measurable BEFORE the
  // write-back; a re-entry that recomputed it would find every requirement
  // already `Released` and record a clean sheet, erasing the reason this
  // release was allowed. Same trick, and the same reason, as
  // `completeCycle`'s snapshot.
  const record = await findAuditRecord(client, version._id)
  // 🔴 A PINNED VERDICT NEEDS NO REDACTION, BY CONSTRUCTION. It used to be a
  // report shaped for whoever ran the first pass, which had to be re-filtered
  // for this one; it is now a {@link ReleaseGateVerdict}, which is the same for
  // every caller because it names no document. That is what makes it safe to
  // sit in `DOMAIN_TX` forever.
  let gate = readVerdict(record?.props)
  if (gate === undefined) {
    const report = await evaluateReleaseGate(auditor, client, version, {
      passRateThreshold: input.passRateThreshold,
      excludeSkipped: input.excludeSkipped,
      approval: input.approval,
      waiverReason: input.waiverReason
    })
    if (!report.passed) {
      // Refused BEFORE the audit record is written, so a failed gate leaves no
      // pinned verdict behind: the next attempt (after the blockers are
      // cleared) must re-evaluate rather than replay the refusal.
      //
      // ⚠️ The counts in this MESSAGE come from the live report, which is
      // redacted for this caller, and the message reaches only this caller —
      // the refusal throws, so no ledger row records it.
      throw new ReleaseProductVersionError(
        'gate-failed',
        `Release gate failed for '${version._id}': ${report.blockers.length} blocker(s)${
          report.restricted ? ' plus restricted items' : ''
        }`
      )
    }
    gate = releaseGateVerdict(report)
  }

  if (!gate.passed) {
    // Unreachable: a failed gate throws above and is never persisted, so a
    // pinned verdict always says `passed`. Kept as a fail-closed backstop —
    // a record this build cannot trust must not release a version.
    throw new ReleaseProductVersionError('gate-failed', `Release gate failed for '${version._id}'`)
  }

  // ── Step 2: the audit record (query, then write). ───────────────────────
  await ensureAuditRecord(client, version, gate, record, input)

  // ── Step 3: carry forward the edges the inheritance table allows. ───────
  const carried = await carryForwardParentEdges(client, version)

  // ── Step 4: the scope write-back, REQUIREMENT BY REQUIREMENT. ───────────
  const requirementsReleased = await releaseScopedRequirements(client, version)
  // Counted through the AUDITOR, so the answer is global rather than "whatever
  // this caller can see". Only the boolean leaves the server.
  const stillValidating = await countValidatingScope(auditor, version)

  // ── Step 5: the version state (compare-and-swap, not a blind write). ────
  // 🔴 The `state` read at Step 0 is stale by now — the audit record and up to
  // N requirement writes happened in between. A bare `updateDoc` would happily
  // stamp `Released` over an `Archived` somebody set meanwhile. `match` makes
  // `ApplyTxMiddleware.verifyApplyIf` re-read the version immediately before
  // applying and refuse the whole `TxApplyIf` if the state moved.
  //
  // ⚠️ NOT a database conditional update: `verifyApplyIf` is read-then-write
  // inside one transactor and `scopes` is a per-process `Map`. It narrows the
  // window from "the whole command" to "between the match query and the write";
  // the genuine cross-process exclusion is the ledger claim's primary key.
  if (!alreadyReleased) {
    const apply = applyStepFor(
      client,
      RELEASE_PRODUCT_VERSION,
      'version-state',
      `${RELEASE_PRODUCT_VERSION_LOCK} ${version._id}`
    )
    apply.match<ProductVersion>(products.class.ProductVersion, { _id: version._id, state: version.state })
    await apply.updateDoc<ProductVersion>(products.class.ProductVersion, version.space, version._id, {
      state: ProductVersionState.Released,
      readonly: true
    })
    assertCommitted(await apply.commit(), 'set product version state to Released')
  }

  ctx.info('agentra product version released', {
    version: version._id,
    waived: gate.waived,
    requirementsReleased,
    // Server-side only. The caller gets the boolean, never the number.
    requirementsLeftValidating: stillValidating,
    carriedEdges: carried,
    alreadyReleased
  })

  return {
    version: version._id,
    released: true,
    gate,
    requirementsReleased,
    writeBackIncomplete: stillValidating > 0,
    alreadyReleased
  }
}

/**
 * How much of the scope is still `Validating`, over the GLOBAL view.
 *
 * Used only to set {@link ReleaseProductVersionResult.writeBackIncomplete}; the
 * number never crosses the wire.
 */
async function countValidatingScope (auditor: ReleaseGateReader, version: ProductVersion): Promise<number> {
  const left = await auditor.findAll<Requirement>(requirements.masterTag.Requirement as Ref<any>, {
    targetVersion: version._id,
    status: 'Validating'
  })
  return left.length
}

/**
 * Move the version's scope from `Validating` to `Released`.
 *
 * 🔴 RE-ENTRANT BY QUERY, not by counting. The query only returns requirements
 * still in `Validating`, so a requirement an earlier pass already released is
 * not in the list and cannot be written twice; and the count this returns is
 * "how many this pass moved", which is why the audit record — not this number —
 * is the durable statement of what the release contained.
 *
 * ⚠️ Guarded per requirement: `match` pins the status this pass read, so a
 * requirement somebody moved in between is refused rather than overwritten, and
 * the replay re-reads a list that no longer contains it.
 */
async function releaseScopedRequirements (client: TxOperations, version: ProductVersion): Promise<number> {
  const scoped = await client.findAll<Requirement>(requirements.masterTag.Requirement as Ref<any>, {
    targetVersion: version._id,
    status: 'Validating'
  })
  let moved = 0
  for (const requirement of scoped) {
    const apply = applyStepFor(
      client,
      RELEASE_PRODUCT_VERSION,
      'requirement',
      `${RELEASE_PRODUCT_VERSION_LOCK} ${requirement._id}`
    )
    apply.match<Requirement>(requirements.masterTag.Requirement as Ref<any>, {
      _id: requirement._id,
      status: 'Validating'
    })
    await apply.updateDoc<Requirement>(
      requirements.masterTag.Requirement as Ref<any>,
      requirement.space,
      requirement._id,
      { status: 'Released' }
    )
    assertCommitted(await apply.commit(), `release requirement ${requirement._id}`)
    moved++
  }
  return moved
}

/**
 * Carry forward the trace edges that survive succeeding one version with
 * another.
 *
 * 🔴 THE DECISION IS {@link inheritableTraceEdges}'s, NEVER A LOCAL FILTER.
 * That function is the executable form of Technical Spec §3.2.1's inheritance
 * table, and it is the only place the table is applied. Writing a second filter
 * here — even one that agreed today — is how the table and the behaviour drift
 * apart, and the drift would be invisible: edges would silently appear on, or
 * vanish from, a released version.
 *
 * ⚠️ WITH TODAY'S TABLE THIS CARRIES NOTHING, AND THAT IS THE POINT.
 * `traceLinkMatrix` allows exactly one kind to target a ProductVersion —
 * `delivered-in` — and `traceLinkInheritsOnRevision['delivered-in']` is
 * `false`, because a release is a point-in-time snapshot: v2 must not inherit
 * v1's deliveries or every version would claim everything ever shipped. So the
 * loop below is a no-op today BY DECISION rather than by omission, and if the
 * table ever changes, the behaviour changes with it instead of needing to be
 * remembered.
 *
 * ⚠️ `parent` is the PREDECESSOR version, and `products.ids.NoParentVersion` is
 * the sentinel for "none" — a bare `undefined` check would treat the sentinel
 * as a real predecessor and query for edges pointing at it.
 */
async function carryForwardParentEdges (client: TxOperations, version: ProductVersion): Promise<number> {
  const parent = version.parent
  if (parent === undefined || parent === products.ids.NoParentVersion) {
    return 0
  }
  const edges = await client.findAll<TraceLink>(traceability.class.TraceLink, {
    docB: parent as Ref<Doc>,
    state: 'active'
  })
  const candidates: Array<CoverageEdge & { link: TraceLink }> = edges.map((link) => ({
    kind: link.kind,
    target: link.docB,
    targetBaseId: link.targetBaseId,
    source: link.docA,
    link
  }))
  const inheritable = inheritableTraceEdges(candidates, parent as Ref<Doc>)
  for (const edge of inheritable) {
    await carryEdge(client, edge.link, version)
  }
  return inheritable.length
}

/**
 * Re-point one inheritable edge at the successor version.
 *
 * Unreachable with today's table (see {@link carryForwardParentEdges}); it
 * exists so that flipping a row in `traceLinkInheritsOnRevision` is a
 * one-line change with working code behind it rather than a TODO.
 */
async function carryEdge (client: TxOperations, link: TraceLink, version: ProductVersion): Promise<void> {
  const _id = traceLinkId(link.kind, link.docA, version._id)
  const existing = await client.findOne<TraceLink>(traceability.class.TraceLink, { _id })
  if (existing !== undefined) {
    return
  }
  const apply = applyStepFor(client, RELEASE_PRODUCT_VERSION, 'carry-edge')
  await apply.createDoc<TraceLink>(
    traceability.class.TraceLink,
    link.space,
    {
      docA: link.docA,
      sourceClass: link.sourceClass,
      docB: version._id,
      targetClass: version._class as Ref<Class<Doc>>,
      kind: link.kind,
      sourceBaseId: link.sourceBaseId,
      targetBaseId: normId(version),
      state: 'active',
      metadata: traceLinkMetadata({ command: RELEASE_PRODUCT_VERSION, inheritedFrom: link._id })
    },
    _id
  )
  assertCommitted(await apply.commit(), `carry trace edge ${link._id} forward`)
}

/**
 * The audit record as an `ActivityInfoMessage` on the version (query, then
 * write).
 *
 * 🔴 IT IS THE RE-ENTRANCY ANCHOR, not decoration: it pins the gate report that
 * only existed before the write-back. Derived `_id`, so two passes — and two
 * racing callers — converge on ONE record.
 *
 * ⚠️ An `ActivityInfoMessage` rather than a `DocUpdateMessage` because this one
 * has to CARRY DATA: `props` is what makes the verdict readable back, and
 * REL-006 requires the waiver and its reason to be auditable.
 *
 * 🔴 WHAT IT DELIBERATELY DOES NOT CARRY: the blocker list. See
 * {@link ReleaseGateVerdict} — a record's `props` is copied verbatim into the
 * `TxCreateDoc` that lives in `DOMAIN_TX` forever and into the broadcast of
 * that transaction, and neither can be filtered per reader. REL-006 asks for
 * the WAIVER and its REASON to be auditable, and both are here, next to
 * `createdBy` / `createdOn` and the approval: the record still answers "who
 * waived this release, when, against which approval, and why". What no reader
 * gets from the record any more is WHICH documents were waived past — that
 * would be a permanent projection of Requirements, Issues and TestRuns into
 * the version's space. An auditor reconstructs it from the scope itself, with
 * their own permissions.
 *
 * @public
 */
export function auditRecordId (version: Ref<Doc>): Ref<ActivityInfoMessage> {
  return commandObjectId<ActivityInfoMessage>(RELEASE_PRODUCT_VERSION_LOCK, version, releaseProductVersionRoles.audit)
}

async function findAuditRecord (client: TxOperations, version: Ref<Doc>): Promise<ActivityInfoMessage | undefined> {
  return await client.findOne<ActivityInfoMessage>(activity.class.ActivityInfoMessage, {
    _id: auditRecordId(version)
  })
}

async function ensureAuditRecord (
  client: TxOperations,
  version: ProductVersion,
  gate: ReleaseGateVerdict,
  found: ActivityInfoMessage | undefined,
  input: ReleaseProductVersionInput
): Promise<void> {
  if (found !== undefined) {
    return
  }
  const apply = applyStepFor(client, RELEASE_PRODUCT_VERSION, 'audit')
  await apply.addCollection<Doc, ActivityInfoMessage>(
    activity.class.ActivityInfoMessage,
    version.space,
    version._id,
    products.class.ProductVersion,
    'activity',
    {
      message: RELEASE_MESSAGE,
      icon: RELEASE_ICON,
      props: {
        // The VERDICT. `releaseGateVerdict` is the allow-list that keeps this
        // from ever being a report again.
        gate,
        ...(input.approval !== undefined ? { approval: input.approval } : {}),
        // REL-006: the waiver and its reason are part of the permanent record.
        ...(input.waiverReason !== undefined ? { waiverReason: input.waiverReason } : {})
      }
    },
    auditRecordId(version._id)
  )
  assertCommitted(await apply.commit(), 'record release audit')
}

/**
 * Read back the pinned verdict. `undefined` when the record carries something
 * this build cannot read — in which case the caller re-evaluates, which is the
 * old behaviour rather than a crash.
 *
 * ⚠️ THE SHAPE TEST DOES NOT DEMAND `blockers`. The persisted verdict carries
 * `blockers: []` for wire compatibility with the client's parser, but a record
 * is recognised by its two booleans; keying recognition on the array would make
 * the field load bearing again and invite somebody to fill it.
 */
function readVerdict (props: Record<string, any> | undefined): ReleaseGateVerdict | undefined {
  const gate = props?.gate
  if (gate == null || typeof gate !== 'object') {
    return undefined
  }
  if (typeof gate.passed !== 'boolean' || typeof gate.waived !== 'boolean') {
    return undefined
  }
  return releaseGateVerdict(gate as ReleaseGateVerdict)
}

/**
 * Sanitise the gate payload carried by ONE audit record on the way out.
 *
 * 🔴 A BACKSTOP, NOT THE MECHANISM. Since {@link ensureAuditRecord} writes a
 * {@link ReleaseGateVerdict} rather than a report, a record produced by this
 * build has nothing sensitive to remove and this function is an identity
 * transform. It stays because the read path is the one place that sees records
 * this build did not write — a restored backup, a record forged through some
 * future write path, an `ActivityInfoMessage` somebody else stamps with a
 * `props.gate` — and for those the allow-list is the difference between
 * echoing a blocker list and not.
 *
 * ⚠️ NO VIEWER, AND THAT IS THE POINT. The previous shape re-read every blocker
 * through the CALLER's client so it could keep the ones they may see. That was
 * the right filter for the wrong problem: whatever it kept had already been
 * written verbatim into `DOMAIN_TX` and broadcast, where no per-reader filter
 * reaches. Dropping the blockers unconditionally is both stronger and, being
 * synchronous and read-free, very much cheaper on the hottest method in the
 * pipeline.
 *
 * ⚠️ Only `props.gate` is touched. `props.approval` is a single ref the caller
 * already had to be able to name to get here, and `props.waiverReason` is
 * REL-006's permanent record — free text written BY a human FOR the audit
 * trail, not a projection of documents the reader cannot see.
 *
 * @public
 */
export function sanitizeAuditRecord<T extends Doc> (doc: T): T {
  const props = (doc as unknown as ActivityInfoMessage).props
  const gate = readVerdict(props)
  if (gate === undefined) {
    return doc
  }
  return {
    ...doc,
    props: { ...props, gate }
  }
}

/**
 * `true` when the document MIGHT be a release audit record, decided without a
 * single read.
 *
 * Used by the read-path filter to skip the rebuild for every other document.
 *
 * @public
 */
export function carriesReleaseGate (doc: Doc): boolean {
  return readVerdict((doc as unknown as ActivityInfoMessage).props) !== undefined
}
