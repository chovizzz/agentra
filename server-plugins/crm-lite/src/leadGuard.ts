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

import core, {
  toFindResult,
  TxProcessor,
  type Account,
  type Class,
  type Doc,
  type DocumentQuery,
  type FindOptions,
  type FindResult,
  type MeasureContext,
  type Ref,
  type SearchOptions,
  type SearchQuery,
  type SearchResult,
  type SessionData,
  type Tx,
  type TxApplyIf,
  type TxCreateDoc,
  type TxCUD,
  type TxMixin,
  type TxUpdateDoc
} from '@hcengineering/core'
import crmLite, { canTransitionLead, leadStatusOrder, type Lead, type LeadStatus } from '@hcengineering/crm-lite'
import requirements, { type Requirement } from '@hcengineering/requirements'
import serverAgentraCore, { commandExecutionId, commandObjectId } from '@hcengineering/server-agentra-core'
import {
  CONVERT_LEAD_LOCK,
  CONVERTED_LEAD_READONLY_FIELDS,
  convertLeadRoles
} from '@hcengineering/server-agentra-core-resources'
import {
  BaseMiddleware,
  type Middleware,
  type MiddlewareCreator,
  type PipelineContext,
  type TxMiddlewareResult
} from '@hcengineering/server-core'
import traceability, { type TraceLink } from '@hcengineering/traceability'

import { guestScopeKey, isCrmMembershipGrantTx, scopeGuestQuery } from './guestScope'
import {
  checkIntakeSpace,
  intakeRateKey,
  IntakeRateLimiter,
  isIntakeAccount,
  normalizeIntakeAttributes,
  pinIntakeEnvelope,
  pinIntakeVersionChain,
  refuseIntake,
  type IntakeGuardReason
} from './intake'

/**
 * Why every refusal carries a machine readable reason: the client half renders
 * a different sentence per reason (see `convertLeadReasonLabel`), and a bare
 * `Error('not allowed')` would collapse "you skipped a stage", "you forgot the
 * reason" and "that status is command-only" into one useless message.
 *
 * @public
 */
export type LeadGuardReason =
  | 'unknown-status'
  | 'illegal-transition'
  | 'status-removed'
  | 'opaque-operation'
  | 'converted-requires-command'
  | 'disqualify-requires-reason'
  // A converted lead's business content is frozen. Distinct from
  // `illegal-transition`, which is what a STATUS write on it reports.
  | 'lead-converted-readonly'
  // Anonymous intake (see `./intake.ts`). Kept as a separate union so the
  // intake module never has to import this file — the dependency runs one way,
  // guard -> intake, and stays acyclic.
  | IntakeGuardReason

/**
 * @public
 */
export interface LeadGuardRefusal {
  ok: false
  reason: LeadGuardReason
  message: string
}

/**
 * @public
 */
export type LeadGuardVerdict = { ok: true } | LeadGuardRefusal

const ACCEPTED: LeadGuardVerdict = { ok: true }

function refuse (reason: LeadGuardReason, message: string): LeadGuardRefusal {
  return { ok: false, reason, message }
}

/**
 * The one status that no ordinary write may produce.
 *
 * 🔴 `Converted` is not "a status a user may pick"; it is the OBSERVABLE SIDE
 * EFFECT of `convertLeadToRequirement` having run. A Lead that carries it
 * without a Requirement and a `converted-to` trace edge is a lie about the
 * audit trail, and the kanban drag path (`KanbanView.getUpdateProps` returns
 * `{ [groupByKey]: groupValue, space }` with no validation whatsoever) makes
 * producing one a two-second gesture.
 *
 * @public
 */
export const COMMAND_ONLY_STATUS: LeadStatus = 'Converted'

/**
 * @public
 */
export function isLeadStatus (value: unknown): value is LeadStatus {
  return typeof value === 'string' && (leadStatusOrder as string[]).includes(value)
}

/**
 * Is `value` a usable disqualification reason?
 *
 * Whitespace does not count. "Required field" that accepts `'   '` is not a
 * required field, and PRD §5.1 asks for a reason, not for a keystroke.
 *
 * @public
 */
export function hasDisqualifyReason (value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * What a `TxUpdateDoc.operations` object does to ONE named field.
 *
 * 🔴 WHY THIS IS NOT `'status' in operations`. `DocumentUpdate` is either a
 * plain partial or an OPERATOR object (`isOperator` demands every key start with
 * `$`), and the operator vocabulary includes `$rename`, which can move an
 * arbitrary field ONTO `status` without the string `status` ever appearing as a
 * key. The adapters do not agree on what they refuse either: the Mongo adapter
 * hands the operator object to Mongo verbatim, so an operator this codebase does
 * not implement (`$set`) still executes there. A guard that pattern-matched only
 * the plain form would be silently bypassable on both counts.
 *
 * `opaque` is the important verdict: "this update reaches the field in a way I
 * cannot evaluate". The caller refuses it. No legitimate writer in this codebase
 * touches `status` or `disqualifyReason` with an operator — the conversion
 * command writes `{ status: 'Converted' }` and the disqualification popup writes
 * both fields plainly — so refusing is a closed door, not a lost feature.
 *
 * @public
 */
export type FieldWrite =
  | { kind: 'untouched' }
  | { kind: 'plain', value: unknown }
  | { kind: 'unset' }
  | { kind: 'opaque', operator: string }

/**
 * @public
 */
export function readFieldWrite (operations: Record<string, any>, field: string): FieldWrite {
  if (operations == null || typeof operations !== 'object') {
    return { kind: 'untouched' }
  }
  // 🔴 DISPATCH PER KEY, NOT PER PAYLOAD. An earlier version asked
  // `isOperator(operations)` first and, when that was false, looked only for a
  // plain `field in operations`. `isOperator` requires EVERY key to start with
  // `$` (`foundations/core/packages/core/src/operator.ts:198-204`), but
  // `TxProcessor.applyUpdate` dispatches KEY BY KEY
  // (`foundations/core/packages/core/src/tx.ts:378-387`). So a MIXED payload —
  // `{ someOtherField: 'x', $set: { status: 'Converted' } }` — made
  // `isOperator` false, sent the read down the plain branch, found no literal
  // `status` key, and reported `untouched`. The guard then waved it through
  // while every applier in the platform really did write the field.
  //
  // Reading the same way the applier writes is the only shape that cannot drift
  // from it.
  let plain: FieldWrite | undefined
  const prefix = `${field}.`
  for (const [key, payload] of Object.entries(operations)) {
    if (!key.startsWith('$')) {
      // ⚠️ Dotted paths write INTO the field: `setObjectValue('status.x', …)`
      // reaches it just as `status` does.
      if (key === field || key.startsWith(prefix)) {
        plain = key === field ? { kind: 'plain', value: payload } : { kind: 'opaque', operator: key }
      }
      continue
    }
    const operator = key
    if (payload == null || typeof payload !== 'object') {
      continue
    }
    if (operator === '$unset') {
      if (field in payload) return { kind: 'unset' }
      continue
    }
    if (operator === '$rename') {
      // Both halves matter: renaming `status` AWAY removes it, and renaming
      // something else ONTO `status` writes it. Neither is evaluable here.
      if (field in payload || Object.values(payload).includes(field)) {
        return { kind: 'opaque', operator }
      }
      continue
    }
    if (field in payload || Object.keys(payload).some((k) => k === field || k.startsWith(prefix))) {
      return { kind: 'opaque', operator }
    }
  }
  // Operators win when both are present: they are the stricter reading, and a
  // batch that names the field twice is not something to interpret leniently.
  return plain ?? { kind: 'untouched' }
}

/**
 * The state machine half of the guard, as a pure function.
 *
 * Split out from the middleware so the rules are testable without a pipeline,
 * and so the two IO-dependent checks (`Converted` needs evidence) are visibly
 * the only part that touches the database.
 *
 * `from === undefined` means a CREATE: there is no prior state to transition
 * out of, so `canTransitionLead` has nothing to say and the only rules that
 * apply are the two invariants (`Converted` is command-only; `Disqualified`
 * needs a reason).
 *
 * @public
 */
export function checkLeadStatusChange (
  from: LeadStatus | undefined,
  to: LeadStatus,
  reasonAfter: unknown
): LeadGuardVerdict {
  if (!isLeadStatus(to)) {
    return refuse('unknown-status', `'${String(to)}' is not a lead status`)
  }
  if (from !== undefined && !canTransitionLead(from, to)) {
    return refuse('illegal-transition', `Lead cannot move from '${from}' to '${to}'`)
  }
  if (to === 'Disqualified' && !hasDisqualifyReason(reasonAfter)) {
    return refuse('disqualify-requires-reason', "Moving a lead to 'Disqualified' requires a non-empty reason")
  }
  return ACCEPTED
}

/**
 * Server-side enforcement of the Lead state machine.
 *
 * 🔴 WHY A MIDDLEWARE AND NOT A TRIGGER. `TriggersMiddleware.processDerived`
 * runs AFTER `provideTx` — the write has already landed by then — and it wraps
 * every trigger call in a `try/catch` that only logs. A trigger therefore
 * cannot refuse a transaction; it can only comment on one that already
 * happened. `RatingMiddleware` and `CommandMiddleware` are the two in-tree
 * precedents for "check, then `throw`", and this is the third.
 *
 * 🔴 WHY SERVER SIDE AT ALL. `LeadStatusEditor` already refuses illegal picks,
 * but it is ONE path. `plugins/task-resources/.../KanbanView.svelte`'s
 * `getUpdateProps` returns `{ [groupByKey]: groupValue, space: doc.space }` and
 * feeds it straight to `client.diffUpdate`, with no validation and without
 * passing `getAvailableCategories` to the kanban — so a drag from `New` to
 * `Converted` is an unchecked write today. Any future view, any script and any
 * API caller is the same story. The pipeline is the only choke point they all
 * share.
 *
 * ⚠️ REGISTRATION ORDER MATTERS, in both directions:
 *   - AFTER `ApplyTxMiddleware`, which unwraps `TxApplyIf` and forwards
 *     `applyIf.txes` through `provideTx`. The inner writes therefore arrive
 *     here as ordinary `TxUpdateDoc`s and no recursion is needed. (It is done
 *     anyway — see {@link LeadGuardMiddleware.tx} — because "no `TxApplyIf` can
 *     reach us" is a property of the pipeline list, not of this class.)
 *   - BEFORE `TxMiddleware`, so a refused write never reaches the transaction
 *     domain and cannot be replayed out of it.
 *
 * @public
 */
export class LeadGuardMiddleware extends BaseMiddleware implements Middleware {
  /**
   * 🔴 PER PROCESS, and the field lives here rather than in a module-level
   * singleton on purpose: one limiter per pipeline means one per workspace,
   * so a flood against one workspace's intake link cannot exhaust another's
   * budget. It still does not span transactor replicas — see
   * {@link IntakeRateLimiter} for the full statement of that limit.
   */
  private readonly intakeLimiter = new IntakeRateLimiter()

  private constructor (context: PipelineContext, next?: Middleware) {
    super(context, next)
  }

  static create: MiddlewareCreator = async (_ctx, context, next): Promise<Middleware> => {
    return new LeadGuardMiddleware(context, next)
  }

  async tx (ctx: MeasureContext, txes: Tx[]): Promise<TxMiddlewareResult> {
    await this.validate(ctx, txes)
    const scoped = this.dropCrmMembershipGrants(ctx, txes)
    if (scoped.length === 0 && txes.length > 0) {
      return {}
    }
    return await this.provideTx(ctx, scoped)
  }

  /**
   * GUEST SCOPE, WRITE HALF. Remove any transaction that would make the
   * CURRENT below-`User` session a member of the CRM space.
   *
   * The full chain this closes — the public-link action on `CardSpace`, the
   * grant it mints, `OnEmployeeCreate` turning that grant into a `$push` on
   * `members`, and membership being what actually gates lead reads — is
   * documented link by link in the header of `./guestScope.ts`.
   *
   * 🔴 DROPPED, NOT REFUSED, and this is the one place in this middleware that
   * does not throw. The offending transaction is emitted by `OnEmployeeCreate`
   * while the guest's Employee record is being created, i.e. during their
   * FIRST connection. Throwing would propagate out of `processDerivedTxes` and
   * fail that connection, so the effect of tightening the guest's scope would
   * be that guests cannot log in and the intake form is dead. There is also
   * nobody to tell: the transaction is system-generated and no client is
   * waiting on its verdict. `OnEmployeeCreate` emits one `TxUpdateDoc` per
   * space, so dropping the whole transaction removes exactly the CRM space
   * from the batch and leaves the guest's other memberships alone.
   *
   * ⚠️ CLASSIFIED BY SESSION, LIKE EVERYTHING ELSE HERE. The transaction's own
   * `modifiedBy` is `core.account.System` (`OnEmployeeCreate` builds it with a
   * system `TxFactory`), so judging by the writer would exempt precisely the
   * write that needs judging. `ctx.contextData.account` is the guest, because
   * the trigger runs on the guest's own session.
   *
   * ⚠️ THE CONVERSE IS DELIBERATE: when a Maintainer adds a guest to the space
   * by hand, the session is theirs, `isIntakeAccount` is false, and the write
   * goes through. An administrator granting access on purpose is not the bug;
   * a context-menu button doing it silently is.
   */
  private dropCrmMembershipGrants (ctx: MeasureContext, txes: Tx[]): Tx[] {
    const account = this.sessionAccount(ctx)
    if (account === undefined || !isIntakeAccount(account)) return txes
    if (!txes.some(isCrmMembershipGrantTx)) return txes
    return txes.filter((tx) => !isCrmMembershipGrantTx(tx))
  }

  /**
   * GUEST SCOPE, READ HALF. A below-`User` session reads nothing out of the
   * CRM space, whether or not it managed to become a member of it.
   *
   * 🔴 THIS IS THE LAYER THAT SURVIVES BEING WRONG ABOUT THE WRITE HALF. A
   * workspace may already carry a guest member from before this code shipped,
   * a Maintainer may add one by hand, and upstream may grow another path from
   * a grant to a membership. None of those reach
   * {@link LeadGuardMiddleware.dropCrmMembershipGrants}; all of them arrive
   * here.
   *
   * ⚠️ THE QUERY IS REWRITTEN, THE RESULT IS NOT FILTERED. See
   * {@link scopeGuestQuery}: a result filter reads `doc.space`, which a caller
   * with a `projection` can make absent, and a filter that matches nothing
   * passes everything.
   *
   * ⚠️ THE KEY DEPENDS ON THE DOMAIN. {@link guestScopeKey} mirrors
   * `SpaceSecurityMiddleware.getKey`, because the transaction domain carries
   * the real space on `objectSpace` while `space` holds `core.space.DerivedTx`
   * — filtering only on `space` would leave every lead's attributes readable
   * through the raw `TxCreateDoc` that created it.
   */
  override async findAll<T extends Doc>(
    ctx: MeasureContext<SessionData>,
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Promise<FindResult<T>> {
    const account = this.sessionAccount(ctx)
    if (account === undefined || !isIntakeAccount(account)) {
      return await this.provideFindAll(ctx, _class, query, options)
    }

    const domain = this.context.hierarchy.findDomain(_class)
    const key = domain === undefined ? undefined : guestScopeKey(domain)
    if (key === undefined) {
      return await this.provideFindAll(ctx, _class, query, options)
    }

    const scoped = scopeGuestQuery(key, query)
    if (scoped.verdict === 'deny') {
      return toFindResult([], 0)
    }
    return await this.provideFindAll(ctx, _class, scoped.query, options)
  }

  /**
   * GUEST SCOPE, the search half.
   *
   * Fulltext is answered by an index, not by a `DocumentQuery`, so
   * {@link scopeGuestQuery} has nothing to rewrite. A below-`User` session gets
   * no search at all rather than a search this file cannot scope: the intake
   * form issues no reads whatsoever — it calls `client.createDoc` and nothing
   * else — so there is no functionality to preserve here, and "no results" is
   * the only answer that cannot be wrong.
   */
  override async searchFulltext (
    ctx: MeasureContext<SessionData>,
    query: SearchQuery,
    options: SearchOptions
  ): Promise<SearchResult> {
    const account = this.sessionAccount(ctx)
    if (account !== undefined && isIntakeAccount(account)) {
      return { docs: [], total: 0 }
    }
    return await this.provideSearchFulltext(ctx, query, options)
  }

  /**
   * The session behind this batch, or `undefined` when there is none (unit
   * tests, and the internal calls that build their own bare context).
   *
   * 🔴 THIS IS THE ONLY INPUT THAT CLASSIFIES A WRITE AS INTAKE. Deriving it
   * from the transaction — a flag, a marker field, a magic space — would let
   * the caller choose which ruleset to be judged by. See the header of
   * `./intake.ts`.
   */
  private sessionAccount (ctx: MeasureContext): Account | undefined {
    return (ctx as MeasureContext<SessionData>).contextData?.account
  }

  /**
   * Walk a tx batch, descending into `TxApplyIf.txes`.
   *
   * The descent is defensive rather than load bearing: with the registration
   * order documented on the class, `ApplyTxMiddleware` has already flattened
   * every apply block by the time a batch reaches here. Both facts are pinned
   * by tests, because the cost of being wrong is a bypass that looks like
   * nothing at all.
   */
  private async validate (ctx: MeasureContext, txes: Tx[], depth: number = 0): Promise<void> {
    if (depth > 8) {
      // A cycle is not constructible through the wire format, but a bounded
      // walk is cheaper than trusting that.
      throw new Error('crm-lite: refusing to validate a pathologically nested TxApplyIf')
    }
    for (const tx of txes) {
      if (this.context.hierarchy.isDerived(tx._class, core.class.TxApplyIf)) {
        await this.validate(ctx, (tx as TxApplyIf).txes, depth + 1)
        continue
      }
      if (!TxProcessor.isExtendsCUD(tx._class)) {
        continue
      }
      await this.validateCUD(ctx, tx as TxCUD<Doc>)
    }
  }

  private async validateCUD (ctx: MeasureContext, cud: TxCUD<Doc>): Promise<void> {
    // 🔴 FIRST, before any of the state-machine dispatch below. An anonymous
    // submission is judged by a strictly smaller ruleset, and this call is
    // where the transaction is cut down to what that ruleset allows — so it
    // has to run before anything reads `attributes`.
    await this.validateIntake(ctx, cud)

    if (cud._class === core.class.TxCreateDoc) {
      if (!this.isLeadClass(cud.objectClass)) return
      await this.validateCreate(ctx, cud as TxCreateDoc<Lead>)
      return
    }
    if (cud._class === core.class.TxUpdateDoc) {
      if (!this.isLeadClass(cud.objectClass)) return
      await this.validateUpdate(ctx, cud as TxUpdateDoc<Lead>)
      return
    }
    if (cud._class === core.class.TxMixin) {
      // A `Tag` in the card model is a `Mixin<Card>`, so a mixin write CAN in
      // principle carry a redeclared `status`. It only counts when the MIXIN
      // itself descends from the Lead master tag; a mixin hung on an unrelated
      // class writes into its own attribute namespace and never becomes
      // `Lead.status`.
      const mixin = cud as TxMixin<Doc, Doc>
      if (!this.isLeadClass(mixin.mixin as Ref<Class<Doc>>)) return
      await this.validateMixin(ctx, mixin)
    }
  }

  /**
   * ANONYMOUS INTAKE (PRD CRM-008). The full rationale — who the writer is,
   * why that identity cannot be abused, and what each control's real scope is
   * — lives in the header of `./intake.ts`; this method is only its
   * transaction-level application.
   *
   * Six things happen here, in this order, and the order is not arbitrary:
   *
   *  1. classify from the SESSION (never the payload);
   *  2. only leads are this guard's business — anything else an anonymous
   *     session writes was already `GuestPermissionsMiddleware`'s call;
   *  3. CREATE ONLY. An intake submitter may bring a lead into existence and
   *     may never touch one again — not their own, not anybody's. That closes
   *     the whole update/mixin/remove surface with one comparison, including
   *     the `$rename` / `$set` shapes {@link readFieldWrite} exists to unpick
   *     and the `TxMixin` shape that could otherwise redeclare `status`;
   *  4. the space is CHECKED, never rewritten (see {@link checkIntakeSpace});
   *  5. rate limit BEFORE the duplicate read, so a flood cannot be turned into
   *     unbounded database work;
   *  6. duplicate detection LAST, because it is the one control backed by
   *     shared durable state.
   *
   * 🔴 DUPLICATE SUBMISSION IS THE DOCUMENT `_id`, WHICH IS THE DATABASE.
   * `LeadIntakeForm.svelte` allocates ONE id when the form is opened and reuses
   * it for every retry of that submission, regenerating it only after a
   * success. A double click, a flaky network retry and an impatient reload
   * therefore all carry the same `_id`, and the second one finds the row
   * already there. This is deliberately NOT a process-local nonce table: it
   * spans transactor replicas and survives restarts for free, because the
   * lead's own primary key is the ledger.
   *
   * ⚠️ The `provideFindAll` below is therefore a COURTESY, not the control: it
   * turns the common case into a named refusal instead of a raw adapter error.
   * Under an actual race both requests can pass it, and the database settles
   * the tie — the object table's primary key is `(workspaceId, _id)` and the
   * insert carries no `ON CONFLICT`, so the loser gets a duplicate-key error.
   * One document per submission id holds either way; only the wording degrades.
   *
   * ⚠️ The residual oracle, stated rather than hidden: a submitter who guesses
   * an existing lead's `_id` learns that it exists, because they get
   * `intake-duplicate` instead of a success. Ids are 24 random hex characters,
   * the probe costs a rate-limited round trip each, and a hit reveals existence
   * and nothing else — no title, no field, no count. The alternative (accepting
   * the write and letting the adapter fail) leaks the same bit through a
   * 500 instead.
   */
  private async validateIntake (ctx: MeasureContext, cud: TxCUD<Doc>): Promise<void> {
    const account = this.sessionAccount(ctx)
    if (account === undefined || !isIntakeAccount(account)) return

    const targetsLead =
      this.isLeadClass(cud.objectClass) ||
      (cud._class === core.class.TxMixin && this.isLeadClass((cud as TxMixin<Doc, Doc>).mixin as Ref<Class<Doc>>))
    if (!targetsLead) return

    if (cud._class !== core.class.TxCreateDoc) {
      this.enforce(refuseIntake('intake-create-only'), cud)
      return
    }

    const create = cud as TxCreateDoc<Lead>
    this.enforce(checkIntakeSpace(create.objectSpace), create)

    const normalized = normalizeIntakeAttributes(create.attributes)
    if (!normalized.ok) {
      this.enforce(normalized, create)
      return
    }

    if (!this.intakeLimiter.take(intakeRateKey(account, create.objectSpace), Date.now())) {
      this.enforce(refuseIntake('intake-rate-limited'), create)
      return
    }

    const existing = await this.provideFindAll(ctx, create.objectClass, { _id: create.objectId }, { limit: 1 })
    if (existing.length > 0) {
      this.enforce(refuseIntake('intake-duplicate'), create)
      return
    }

    // 🔴 REPLACE, do not merge. Merging would keep whatever the submitter sent
    // under keys the whitelist never looked at, which is the entire hole this
    // exists to close. Mutating the tx in place is the established shape in
    // this pipeline — `ModifiedMiddleware`, `VersioningMiddleware` and
    // `IdentifierMiddleware` all rewrite transactions on their way down.
    // ⚠️ AND THEN RESTATE THE VERSION STAMP. `VersioningMiddleware` runs above
    // this one and has already written `isLatest` / `version` / `baseId` into
    // these attributes; a bare replacement would drop them, and keeping the
    // submitter's `baseId` would let a submission graft itself onto somebody
    // else's version chain. See {@link pinIntakeVersionChain}.
    ;(create as { attributes: unknown }).attributes = pinIntakeVersionChain(
      normalized.attributes,
      create.objectId,
      create.modifiedBy
    )

    // ⚠️ AND THE ENVELOPE, which `attributes` cannot reach. `createDoc2Doc`
    // copies `createdBy`, `attachedTo`, `attachedToClass` and `collection` onto
    // the document from the TRANSACTION, over the top of the attributes — so a
    // whitelist applied only to `attributes` leaves all four wide open. See
    // {@link pinIntakeEnvelope}.
    pinIntakeEnvelope(create as unknown as Record<string, unknown>)
  }

  /**
   * A create has no prior state, so the transition table is silent — but the
   * two invariants are not. Without this a client would simply create the fake
   * `Converted` lead instead of updating one into existence.
   */
  private async validateCreate (ctx: MeasureContext, tx: TxCreateDoc<Lead>): Promise<void> {
    const attributes = tx.attributes as Partial<Lead>
    const status = attributes?.status
    if (status === undefined) return

    // 🔴 CARD VERSIONING MAKES SOME "CREATES" UPDATES. A Lead comes from
    // `createSystemType`, so it carries `core.mixin.VersionableClass`, and a new
    // REVISION of an existing lead arrives as a `TxCreateDoc` with a fresh
    // `objectId` and the original id in `attributes.baseId`.
    // `VersioningMiddleware.setVersionData` runs ABOVE this middleware and has
    // already stamped `baseId` / `version` by the time the tx lands here.
    // Validating a successor as a from-scratch create would reject every new
    // revision of an already-`Converted` lead, because the conversion evidence
    // is keyed on the id the command converted and never on the successor's.
    //
    // ⚠️ The other half of the consequence is deliberate: a successor may KEEP
    // `Converted`, but it can never REACH it, since evidence keyed on a brand
    // new id cannot exist. "Convert by publishing a new revision" is precisely
    // the bypass this guard is for.
    const previous = await this.findPredecessor(ctx, tx)
    this.enforce(checkLeadStatusChange(previous?.status, status, attributes?.disqualifyReason), tx)
    if (status === COMMAND_ONLY_STATUS && previous?.status !== COMMAND_ONLY_STATUS) {
      await this.enforceConversionEvidence(ctx, tx.objectId, tx)
    }
  }

  /**
   * The revision this create supersedes, or `undefined` for a genuinely new
   * lead.
   *
   * `VersioningMiddleware` sets `baseId === objectId` on a first revision, so
   * that case really is a create; anything else names the version chain to look
   * up. The latest member of that chain is the state the new revision
   * transitions out of — the same document `setVersionData` itself reads to
   * compute the next `version`.
   */
  private async findPredecessor (ctx: MeasureContext, tx: TxCreateDoc<Lead>): Promise<Lead | undefined> {
    const baseId = (tx.attributes as { baseId?: Ref<Doc> })?.baseId
    if (baseId === undefined || baseId === (tx.objectId as Ref<Doc>)) {
      return undefined
    }
    const chain = await this.provideFindAll<Lead>(ctx, tx.objectClass, { baseId } as any)
    return chain.find((doc) => (doc as any).isLatest === true) ?? chain[0]
  }

  /**
   * A converted lead's business content is frozen, and this is where that is
   * ENFORCED rather than merely displayed.
   *
   * 🔴 `readonlyFields` IS A UI MARKER, NOT A CONSTRAINT. The conversion command
   * stamps it so the generic card panel renders the form read-only, but the
   * panel is one caller among several: the import tool, the REST surface and
   * any script holding a session write straight past it. Without this check the
   * lead that a Requirement was derived from could be rewritten afterwards, and
   * the trace link would point at a document that no longer says what it said.
   *
   * ⚠️ ONLY `Converted`. `Disqualified` stays editable on purpose — the
   * reason-only branch below exists precisely to let the justification be
   * amended, and freezing it here would contradict that in the same file.
   *
   * ⚠️ `status` IS SKIPPED, deliberately. Writing it on a converted lead is
   * already refused by {@link checkLeadStatusChange} — `Converted` is terminal —
   * and that refusal names the illegal transition, which is a far better error
   * than "the lead is frozen". Every other listed field lands here.
   *
   * 🔴 The list is IMPORTED from the conversion command rather than restated.
   * The two must agree: a field the UI greys out but the server accepts is a
   * lie, and a field the server refuses but the UI offers is a dead control.
   */
  private enforceConvertedFrozen (current: Lead, tx: TxUpdateDoc<Lead>, ops: Record<string, any>): void {
    if (current.status !== COMMAND_ONLY_STATUS) return
    for (const field of CONVERTED_LEAD_READONLY_FIELDS) {
      if (field === 'status') continue
      if (readFieldWrite(ops, field).kind === 'untouched') continue
      this.enforce(refuse('lead-converted-readonly', `'${field}' cannot be changed on a converted lead`), tx)
    }
  }

  private async validateUpdate (ctx: MeasureContext, tx: TxUpdateDoc<Lead>): Promise<void> {
    const ops = tx.operations as Record<string, any>
    const statusWrite = readFieldWrite(ops, 'status')
    const reasonWrite = readFieldWrite(ops, 'disqualifyReason')
    const touchesStatus = statusWrite.kind !== 'untouched'
    // 🔴 THE EARLY RETURN USED TO BE `!touchesStatus && reason untouched`, AND
    // THAT WAS THE HOLE. An update naming only `account` / `contact` / `owner`
    // left the guard immediately, so a converted lead's business content was
    // protected by `readonlyFields` — a UI marker — and by nothing else. Any
    // script, API client or import tool could still rewrite it.
    //
    // Widening the gate to the whole frozen list keeps the cheap path cheap
    // (a tx touching none of these still returns without reading the lead,
    // which is what the platform's own `isLatest` / `readonly` writes do) while
    // making a frozen-field write load the document and answer for itself.
    const touchesFrozen = CONVERTED_LEAD_READONLY_FIELDS.some(
      (field) => readFieldWrite(ops, field).kind !== 'untouched'
    )
    if (!touchesStatus && reasonWrite.kind === 'untouched' && !touchesFrozen) return

    if (statusWrite.kind === 'unset') {
      // A Lead with no status has no position in the state machine, and the
      // next write into it would be evaluated against `from === undefined`,
      // i.e. against nothing. That is a laundering path, not a legitimate edit.
      this.enforce(refuse('status-removed', 'A lead status cannot be removed'), tx)
    }
    // An operator reaching either field cannot be evaluated (see
    // {@link readFieldWrite}), and nothing legitimate does it.
    if (statusWrite.kind === 'opaque') {
      this.enforce(refuse('opaque-operation', `'${statusWrite.operator}' may not be used on a lead status`), tx)
    }
    if (reasonWrite.kind === 'opaque') {
      this.enforce(
        refuse('opaque-operation', `'${reasonWrite.operator}' may not be used on a disqualification reason`),
        tx
      )
    }

    const current = await this.findLead(ctx, tx.objectClass, tx.objectId)
    if (current === undefined) {
      // Nothing to protect: an update addressed at an absent `_id` writes no
      // row. Refusing here would be a false negative for the legitimate
      // create-then-update batch, where the create has not been applied yet.
      return
    }

    this.enforceConvertedFrozen(current, tx, ops)

    const target: LeadStatus = statusWrite.kind === 'plain' ? (statusWrite.value as LeadStatus) : current.status
    const reasonAfter =
      reasonWrite.kind === 'unset'
        ? undefined
        : reasonWrite.kind === 'plain'
          ? reasonWrite.value
          : current.disqualifyReason

    if (!touchesStatus) {
      // Reason-only edit. The only thing that can break here is clearing the
      // justification out from under an already `Disqualified` lead, which
      // would leave exactly the record PRD §5.1 forbids — just reached by a
      // second write instead of the first.
      if (current.status === 'Disqualified' && !hasDisqualifyReason(reasonAfter)) {
        this.enforce(refuse('disqualify-requires-reason', 'A disqualified lead must keep a non-empty reason'), tx)
      }
      return
    }

    this.enforce(checkLeadStatusChange(current.status, target, reasonAfter), tx)
    if (target === COMMAND_ONLY_STATUS && current.status !== COMMAND_ONLY_STATUS) {
      await this.enforceConversionEvidence(ctx, current._id, tx)
    }
  }

  private async validateMixin (ctx: MeasureContext, tx: TxMixin<Doc, Doc>): Promise<void> {
    const attrs = tx.attributes as Record<string, any>
    if (attrs == null || !('status' in attrs)) return
    const current = await this.findLead(ctx, tx.objectClass, tx.objectId as Ref<Lead>)
    const reasonAfter = 'disqualifyReason' in attrs ? attrs.disqualifyReason : current?.disqualifyReason
    this.enforce(checkLeadStatusChange(current?.status, attrs.status, reasonAfter), tx)
    if (attrs.status === COMMAND_ONLY_STATUS && current?.status !== COMMAND_ONLY_STATUS) {
      await this.enforceConversionEvidence(ctx, tx.objectId as Ref<Lead>, tx)
    }
  }

  /**
   * The `Converted` gate. Three facts must all hold, and the FIRST of them is
   * the one a client cannot manufacture:
   *
   * 1. an idempotency-ledger row exists at
   *    `commandExecutionId(CONVERT_LEAD_LOCK, leadId)`.
   *
   *    🔴 THIS IS THE UNFORGEABLE ANCHOR. `CommandMiddleware.tx` throws on ANY
   *    CUD whose `objectClass` is `CommandExecution`, and the middleware writes
   *    the ledger through `provideTx` (i.e. below itself), so no transaction
   *    entering the pipeline can create that row. The only other way in is the
   *    command dispatcher, and `AgentraCommandRequestMiddleware.handleCommand`
   *    routes exactly one operation (`convertLeadToRequirement`) and builds the
   *    inner `CommandRequest` itself — `{ command: CONVERT_LEAD_LOCK,
   *    idempotencyKey: input.lead }` — so the caller controls neither the
   *    command name nor the key. A row at this derived `_id` therefore proves
   *    that `convertLeadToRequirement` really ran FOR THIS LEAD.
   *
   * 2. a Requirement exists at the derived id
   *    `commandObjectId(CONVERT_LEAD_LOCK, leadId, 'requirement')`;
   * 3. an ACTIVE `converted-to` trace edge runs from the lead to it.
   *
   *    Facts 2 and 3 are forgeable in isolation — nothing vetoes direct
   *    `TraceLink` or `Requirement` writes — which is exactly why they are not
   *    the anchor. What they add is that the conversion did not merely start
   *    but got past its Requirement and edge steps, closing the residual window
   *    where a command that claimed the lead and then failed would leave a row
   *    behind. Forging all three means creating a real Requirement at the id
   *    the command would have chosen and a real edge pointing at it, having
   *    already invoked the real command — i.e. performing the conversion.
   *
   * ⚠️ Ordering inside `runConversion` is what makes this pass for the genuine
   * path: the ledger row is claimed before the body, the Requirement is step 1,
   * the edge is step 2, and the status CAS is step 3. All three facts hold by
   * the time the guard sees that write.
   */
  private async enforceConversionEvidence (ctx: MeasureContext, lead: Ref<Lead>, tx: Tx): Promise<void> {
    const ledgerId = commandExecutionId(CONVERT_LEAD_LOCK, lead)
    const ledger = await this.provideFindAll(
      ctx,
      serverAgentraCore.class.CommandExecution,
      { _id: ledgerId },
      {
        limit: 1
      }
    )
    if (ledger.length === 0) {
      this.enforce(
        refuse(
          'converted-requires-command',
          `Lead '${lead}' has no ConvertLeadToRequirement execution; 'Converted' is produced by the conversion command only`
        ),
        tx
      )
    }

    const requirementId = commandObjectId<Requirement>(CONVERT_LEAD_LOCK, lead, convertLeadRoles.requirement)
    const requirement = await this.provideFindAll(
      ctx,
      requirements.masterTag.Requirement as Ref<Class<Requirement>>,
      { _id: requirementId },
      { limit: 1 }
    )
    if (requirement.length === 0) {
      this.enforce(
        refuse('converted-requires-command', `Lead '${lead}' has no converted Requirement at '${requirementId}'`),
        tx
      )
    }

    const links = await this.provideFindAll<TraceLink>(
      ctx,
      traceability.class.TraceLink,
      { docA: lead, docB: requirementId, kind: 'converted-to', state: 'active' },
      { limit: 1 }
    )
    if (links.length === 0) {
      this.enforce(
        refuse('converted-requires-command', `Lead '${lead}' carries no active 'converted-to' trace link`),
        tx
      )
    }
  }

  /**
   * 🔴 `provideFindAll` descends BELOW this middleware and therefore below
   * `SpaceSecurityMiddleware`, `PrivateMiddleware` and `FindSecurityMiddleware`
   * — the same property `CommandMiddleware.findExecution` relies on. That is
   * deliberate: a guard that could only see what the CALLER may read would
   * approve a write precisely when the caller cannot see the evidence against
   * it. Nothing read here is echoed to the client; only its existence changes
   * the verdict.
   *
   * ⚠️ It is NOT an absolute "global read". `PostgresAdapterBase.findAll` still
   * calls `addSecurity`, which appends the space ACL whenever
   * `ctx.contextData.isTriggerCtx !== true` — and an ordinary session has that
   * flag false. So this read is scoped to the caller's spaces on Postgres. That
   * is sound for what the guard asks: every write it evaluates targets a lead in
   * a space the caller is writing to, and the conversion evidence is created by
   * the command through the CALLER's own client, so a caller who cannot see the
   * evidence could not have produced the writes that need it either. Failing
   * closed (no evidence found -> refuse) keeps the invalid direction safe; the
   * cost of the narrower read is a possible false REFUSAL, never a false
   * approval.
   */
  private async findLead (ctx: MeasureContext, _class: Ref<Class<Doc>>, id: Ref<Lead>): Promise<Lead | undefined> {
    const found = await this.provideFindAll<Lead>(ctx, _class as Ref<Class<Lead>>, { _id: id }, { limit: 1 })
    return found[0]
  }

  private isLeadClass (_class: Ref<Class<Doc>>): boolean {
    const hierarchy = this.context.hierarchy
    // An unknown classifier makes `isDerived` walk an empty ancestor chain; ask
    // first so a stale or forged `objectClass` is a clean `false` rather than a
    // dependency on that implementation detail.
    if (!hierarchy.hasClass(_class)) {
      return false
    }
    return hierarchy.isDerived(_class, crmLite.masterTag.Lead as Ref<Class<Doc>>)
  }

  /**
   * 🔴 THROW, do not return. `Middleware.tx` has no "rejected" channel: the
   * only way to stop `provideTx` from being reached is an exception, which
   * `ClientSession` turns into an error reply for the calling client. Anything
   * softer — logging, dropping the tx from the batch — would report success for
   * a write that did not happen.
   */
  private enforce (verdict: LeadGuardVerdict, tx: Tx): void {
    if (verdict.ok) return
    throw new LeadGuardError(verdict.reason, verdict.message, tx._class)
  }
}

/**
 * @public
 */
export class LeadGuardError extends Error {
  readonly code = 400

  constructor (
    readonly reason: LeadGuardReason,
    message: string,
    readonly txClass?: string
  ) {
    super(message)
    this.name = 'LeadGuardError'
  }
}
