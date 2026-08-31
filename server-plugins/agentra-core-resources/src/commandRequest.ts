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

import {
  TxOperations,
  systemAccount,
  systemAccountUuid,
  toFindResult,
  type Class,
  type Client,
  type Doc,
  type DocumentQuery,
  type DomainParams,
  type DomainResult,
  type FindOptions,
  type FindResult,
  type Hierarchy,
  type MeasureContext,
  type ModelDb,
  type OperationDomain,
  type Ref,
  type SearchOptions,
  type SearchQuery,
  type SearchResult,
  type SessionData,
  type Tx,
  type TxResult,
  type WithLookup
} from '@hcengineering/core'
import activity from '@hcengineering/activity'
import { CommandInProgressError, CommandPreemptedError } from '@hcengineering/server-agentra-core'
import {
  BaseMiddleware,
  type Middleware,
  type MiddlewareCreator,
  type PipelineContext
} from '@hcengineering/server-core'

import { ArchiveObjectError, archiveObject, type ArchiveObjectInput } from './commands/archive'
import { ArchivableGuardError } from './deleteGuard'
import { TraceLinkGuardError } from './traceLinkGuard'
import { CompleteCycleError, completeCycle, type CompleteCycleInput } from './commands/completeCycle'
import {
  ConvertLeadError,
  convertLeadToRequirement,
  getCommandRunner,
  type ConvertLeadToRequirementInput
} from './commands/convertLeadToRequirement'
import { CreateDefectError, createDefect, type CreateDefectInput, type DefectBodyWriter } from './commands/createDefect'
import { CreateWorkItemsError, createWorkItems, type CreateWorkItemsInput } from './commands/createWorkItems'
import { PARTIAL_WRITE_UNCLASSIFIED, type PartialWriteRisk } from './partialWrite'
import { LinkImplementsError, linkImplements, type LinkImplementsInput } from './commands/linkImplements'
import { UnlinkImplementsError, unlinkImplements, type UnlinkImplementsInput } from './commands/unlinkImplements'
import { LinkVerifiesError, linkVerifies, type LinkVerifiesInput } from './commands/linkVerifies'
import {
  PreviewReleaseGateError,
  previewReleaseGate,
  type PreviewReleaseGateInput,
  type PreviewReleaseGateResult
} from './commands/previewReleaseGate'
import type { ReleaseGateReader } from './commands/releaseGate'
import {
  ReleaseProductVersionError,
  carriesReleaseGate,
  releaseProductVersion,
  sanitizeAuditRecord,
  type ReleaseProductVersionInput
} from './commands/releaseProductVersion'

/**
 * The operation domain Agentra commands are invoked on.
 *
 * 🔴 WHY A DOMAIN REQUEST. A command body needs three things at once: the
 * `MeasureContext<SessionData>` of the CALLER (for attribution and security), a
 * `TxOperations` that writes as that caller, and the `CommandRunner` the
 * `CommandMiddleware` publishes on `PipelineContext.contextVars`. A trigger
 * cannot supply them — `TriggerControl.findAll` stamps
 * `contextData.isTriggerCtx = true` and runs as the system account, and
 * `TriggersMiddleware.processDerived` swallows trigger exceptions, so a 409 could
 * never reach the client. `Client.domainRequest` is the only generic
 * client→server call the platform offers, it carries the caller's session ctx
 * untouched, and it already routes this way for the communication stack. Same
 * `{ <op>: { params } }` shape as `TRACEABILITY_DOMAIN`.
 *
 * @public
 */
export const AGENTRA_COMMAND_DOMAIN = 'agentra-command' as OperationDomain

/**
 * The `SessionData.contextCache` key that opens the command ledger to a read.
 *
 * 🔴 THE ONLY WAY A NON-SYSTEM READER GETS THE LEDGER. `releaseProductVersion`
 * re-enters the pipeline through {@link SessionPipelineClient} as the CALLER,
 * not as the system account, so `account.uuid === systemAccountUuid` alone
 * would refuse the command its own re-entrancy anchor read — and refusing that
 * read is not a read failure, it is a WRITE failure: `ensureAuditRecord` would
 * see `found === undefined` on the replay and try to create the same derived
 * `_id` again, which ends in a duplicate key.
 *
 * ⚠️ WHY IT CANNOT BE FORGED, which is the whole question. `contextCache` lives
 * on `SessionData`, and `ClientSession.includeSessionContext`
 * (`foundations/server/packages/server/src/client.ts`) builds a FRESH
 * `SessionDataImpl` at the top of every request — `findAllRaw`, `tx`,
 * `domainRequestRaw` each call it. Nothing on the wire is copied into it: the
 * map starts empty (`SessionDataImpl.contextCache` is a lazy getter over
 * `_contextCache`, and the transactor passes `undefined`). So the key exists
 * only inside the request that set it, and only this file sets it.
 */
const LEDGER_ACCESS_KEY = 'agentra:ledger-access'

/**
 * The document path that says "this is a command ledger row".
 *
 * 🔴 A QUERY KEY, NOT A RESULT PREDICATE, and that distinction is the fix.
 * Filtering the RESULT means reading a field off the returned document, and any
 * caller can make that field vanish with `options.projection` — at which point
 * "did not match" is read as "let it through". Pushing the constraint into the
 * QUERY makes the row absent from the answer AND from `total`, whatever the
 * projection says, because the projection is applied after the `WHERE`.
 *
 * `$exists` is understood by both backends: `PostgresAdapterBase` translates it
 * to `IS NULL` on the JSON path (`storage.ts`, the `$exists` case), and the
 * in-memory matcher implements it as `(value !== undefined) === o`
 * (`foundations/core/packages/core/src/predicate.ts`). `getObjectValue` walks
 * the dotted path in both.
 */
const LEDGER_MARKER_PATH = 'props.gate'

/**
 * @public
 */
export const AGENTRA_OP_CONVERT_LEAD = 'convertLeadToRequirement'

/**
 * @public
 */
export const AGENTRA_OP_COMPLETE_CYCLE = 'completeCycle'

/**
 * The ONE operation behind all three `verifies` entry points — the test case
 * page, the requirement page and the bulk dialog.
 *
 * 🔴 Adding a second operation "for the bulk case" is the mistake this constant
 * exists to prevent: the pair claim and the derived edge `_id` are what make
 * repeated linking idempotent, and a parallel code path would have to reproduce
 * both to stay correct.
 *
 * @public
 */
export const AGENTRA_OP_LINK_VERIFIES = 'linkVerifies'

/**
 * The ONE operation behind BOTH `implements` entry points — "link a work item
 * to this requirement" and "link a requirement to this issue".
 *
 * 🔴 There is no second, reversed operation. The two directions differ only in
 * which end the user was looking at; the assertion, the pair claim, the derived
 * edge id and the two activity records are identical, and a mirrored code path
 * would have to reproduce all four to stay correct.
 *
 * @public
 */
export const AGENTRA_OP_LINK_IMPLEMENTS = 'linkImplements'

/**
 * The withdrawal of one `implements` assertion.
 *
 * 🔴 A SEPARATE OPERATION, NOT A FLAG ON `linkImplements`. A `revoke: true`
 * parameter would route both intents through one ledger namespace, so the first
 * link of a pair would occupy the row the later unlink needs and the unlink
 * would REPLAY the link's stored result — i.e. answer "linked" to "unlink".
 * Two names make that structurally impossible.
 *
 * @public
 */
export const AGENTRA_OP_UNLINK_IMPLEMENTS = 'unlinkImplements'

/**
 * Split a requirement into work items (PM-006 / Task 12).
 *
 * ⚠️ A SEPARATE OPERATION FROM `linkImplements`, not a flag on it: this one
 * WRITES issues, and its claim is keyed on the caller's batch intent rather
 * than on a pair, because two batches against one requirement are two
 * legitimate intents.
 *
 * @public
 */
export const AGENTRA_OP_CREATE_WORK_ITEMS = 'createWorkItems'

/**
 * @public
 */
export const AGENTRA_OP_CREATE_DEFECT = 'createDefect'

/**
 * SYS-005 archive / restore. ONE operation for both directions: the intent is a
 * field of the input, not a second entry point, because the claim, the derived
 * audit id and the generation arithmetic are identical for both and a parallel
 * code path would have to reproduce all three to stay correct.
 *
 * @public
 */
export const AGENTRA_OP_ARCHIVE_OBJECT = 'archiveObject'

/**
 * @public
 */
export const AGENTRA_OP_RELEASE_PRODUCT_VERSION = 'releaseProductVersion'

/**
 * The READ-ONLY preview of the gate (PRD §7.5).
 *
 * 🔴 A SEPARATE OPERATION, NOT A FLAG ON `releaseProductVersion`. A
 * `dryRun: true` parameter would route a query through the command path — the
 * idempotency-key validation, the ledger claim, the runner — and one forgotten
 * branch anywhere in that chain would turn a preview into a release. Two names
 * make the read path structurally incapable of writing.
 *
 * @public
 */
export const AGENTRA_OP_PREVIEW_RELEASE_GATE = 'previewReleaseGate'

/**
 * Reply envelope.
 *
 * 🔴 FAILURES ARE RETURNED, NOT THROWN. CRM-T006 requires the 409 to be VISIBLE
 * to the caller. An exception out of `domainRequest` crosses the wire as a
 * generic platform error whose class, `code` and `reason` do not survive
 * serialisation, so the client could not tell "already running" (retry later)
 * from "illegal transition" (never retry). Only the two expected failure
 * families are enveloped; anything else still throws, so a genuine bug is never
 * disguised as a 400.
 *
 * @public
 */
export type AgentraCommandResult<T = Record<string, any>> =
  | { ok: true, executionId: string, replayed: boolean, preempted: boolean, result: T }
  | AgentraFailure

/**
 * Reply envelope for a READ-ONLY operation.
 *
 * 🔴 NO `executionId`, NO `replayed`, NO `preempted` — DELIBERATELY. Those three
 * fields are the ledger's vocabulary, and a query has no ledger row. Reusing
 * {@link AgentraCommandResult} would force a fabricated execution id onto the
 * wire and let a client render "replayed: false" as if something had run; a
 * distinct type makes "this call wrote nothing" visible in the shape itself.
 *
 * The failure half is identical on purpose, so one `ok === false` branch on the
 * client handles refusals from either kind of operation.
 *
 * @public
 */
export type AgentraQueryResult<T = Record<string, any>> = { ok: true, result: T } | AgentraFailure

/**
 * A `Client` over the pipeline HEAD, bound to one caller's session context.
 *
 * 🔴 `head` is what makes this the CALLER's client. `BaseMiddleware.provideTx` /
 * `provideFindAll` delegate to `this.next`, i.e. DOWNWARDS, skipping every
 * middleware above — including `SpaceSecurityMiddleware` and
 * `SpacePermissionsMiddleware`. `PipelineImpl.create` assigns
 * `context.head = pipeline.head`, so going through it re-enters the whole chain
 * exactly where a real client request enters. Combined with `ctx` being the
 * caller's session context (`SpaceSecurityMiddleware` reads
 * `ctx.contextData.account` and nothing else), every read is filtered and every
 * write is authorised as the caller.
 *
 * It also means `TxApplyIf` from `client.apply()` reaches `ApplyTxMiddleware`
 * normally, which the command body depends on for its compare-and-swap steps.
 */
class SessionPipelineClient implements Client {
  constructor (
    private readonly context: PipelineContext,
    private readonly ctx: MeasureContext<SessionData>,
    private readonly head: Middleware
  ) {}

  getHierarchy (): Hierarchy {
    return this.context.hierarchy
  }

  getModel (): ModelDb {
    return this.context.modelDb
  }

  async findAll<T extends Doc>(
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Promise<FindResult<T>> {
    // 🔴 `PostgresAdapter.addSecurity` skips the SQL space ACL when
    // `sessionContext.isTriggerCtx === true`, and `TriggersMiddleware.processDerived`
    // sets that flag on the SHARED `contextData` the first time any trigger
    // reads — then never clears it. A command body interleaves writes and reads
    // in ONE request context, so without this line every read after the first
    // write would silently run unfiltered. A command body is not a trigger.
    if (this.ctx.contextData !== undefined) {
      this.ctx.contextData.isTriggerCtx = false
    }
    return await this.head.findAll(this.ctx, _class, query, options)
  }

  async findOne<T extends Doc>(
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Promise<WithLookup<T> | undefined> {
    return (await this.findAll(_class, query, { ...options, limit: 1 }))[0]
  }

  async tx (tx: Tx): Promise<TxResult> {
    const result = await this.head.tx(this.ctx, [tx])
    // `Middleware.tx` returns `TxMiddlewareResult`, a single result or an array
    // of them depending on how the lower middlewares grouped the batch.
    return (Array.isArray(result) ? result[0] : result) ?? {}
  }

  async searchFulltext (query: SearchQuery, options: SearchOptions): Promise<SearchResult> {
    return await this.head.searchFulltext(this.ctx, query, options)
  }

  async domainRequest<T>(domain: OperationDomain, params: DomainParams): Promise<DomainResult<T>> {
    return (await this.head.domainRequest(this.ctx, domain, params)) as DomainResult<T>
  }

  /** The session owns its lifetime; a per-request client must not close it. */
  async close (): Promise<void> {}
}

/**
 * Invocation entry point for Agentra commands.
 *
 * @public
 */
export class AgentraCommandRequestMiddleware extends BaseMiddleware implements Middleware {
  private constructor (context: PipelineContext, next?: Middleware) {
    super(context, next)
  }

  static create: MiddlewareCreator = async (_ctx, context, next): Promise<Middleware> => {
    return new AgentraCommandRequestMiddleware(context, next)
  }

  override async domainRequest (
    ctx: MeasureContext,
    domain: OperationDomain,
    params: DomainParams
  ): Promise<DomainResult> {
    if (domain !== AGENTRA_COMMAND_DOMAIN) {
      return await this.provideDomainRequest(ctx, domain, params)
    }
    return {
      domain,
      value: await this.handleCommand(ctx as MeasureContext<SessionData>, params)
    }
  }

  /**
   * Keep the command ledger off the session read path, and sanitise whatever a
   * server-side reader still gets.
   *
   * 🔴 THE LEDGER IS NOT READABLE BY A SESSION AT ALL any more. The release
   * audit record is an `ActivityInfoMessage` in the version's space, and space
   * membership was the only thing standing between it and a reader — so an
   * account that may open the product version could read who released what,
   * when, on whose approval and with which waiver, whatever it could see of the
   * work behind it. {@link hideLedgerRows} removes those rows from every read
   * that is not the server itself; {@link mayReadLedger} is the whole of the
   * "is this the server" question and says exactly what it trusts.
   *
   * What follows is the SECOND layer, kept because the first one hands ledger
   * rows to triggers, migrations and backup unchanged.
   *
   * ⚠️ SANITISING IS NO LONGER THE THING THAT KEEPS BLOCKERS OUT OF READERS'
   * HANDS — {@link ReleaseGateVerdict} is. `releaseProductVersion` stopped writing a
   * viewer-shaped report into `ActivityInfoMessage.props` at all, because a
   * per-result filter could never have covered the three paths that copy those
   * props somewhere it does not run:
   *
   * 1. THE CREATE TX IS BROADCAST VERBATIM. `addCollection` emits a plain
   *    `TxCreateDoc`, `SpaceSecurityMiddleware` targets the broadcast by
   *    `tx.objectSpace` — space members, plus collaborator guests — and
   *    `BroadcastMiddleware` does not rewrite tx fields. A client with a live
   *    query over activity messages folds `TxProcessor.createDoc2Doc(tx)` into
   *    its result, `attributes.props` and all;
   * 2. THE SAME TX SITS IN `DOMAIN_TX` FOREVER. `TxCUD.objectId` is indexed,
   *    `FindSecurityMiddleware` does not refuse tx queries and
   *    `SpaceSecurityMiddleware` gates `DOMAIN_TX` on `objectSpace` alone
   *    (`spaceSecurity.ts:613`) — so anyone who may read the version's space can
   *    query `core.class.TxCUD` by `objectId` and read the original attributes.
   *    Redacting the DOCUMENT does not touch the transaction that created it,
   *    which is why redaction was never a fix for this one;
   * 3. anything reading BELOW this middleware — triggers, backup's own pipeline
   *    (which has no FindSecurity/SpaceSecurity at all), `dev/tool` — sees the
   *    record unfiltered.
   *
   * All three are now harmless because the props carry no document identity.
   * What survives here is {@link sanitizeAuditRecord} as a BACKSTOP for records
   * this build did not write (a restored backup, a forged `props.gate`), and it
   * needs no caller identity: it drops the blocker list unconditionally instead
   * of deciding per reader which entries to keep.
   *
   * ℹ️ NOT a residual, checked: the fulltext indexer does not reach it.
   * `ActivityInfoMessage.props` carries no `@Prop`, the indexer collects only
   * indexed attributes, and the search result mapper returns no `props`.
   *
   * 🔴 WHAT HIDING THE DOCUMENT DOES NOT REACH, stated rather than implied.
   * Points 1 and 2 above are DOCUMENT-read-path-independent and survive this
   * change: a session with a live query open at the moment of the release
   * still receives the `TxCreateDoc` through the broadcast, and the same
   * transaction stays queryable in `DOMAIN_TX` by `objectId` forever. Both
   * leak the record's EXISTENCE, its `approval` ref and its `waiverReason` —
   * not the verdict's blockers, which is the reason the props were reduced to
   * a {@link ReleaseGateVerdict} in the first place. Closing them means
   * changing broadcast targeting and the `DOMAIN_TX` gate in
   * `SpaceSecurityMiddleware`, neither of which lives in this package.
   */
  override async findAll<T extends Doc>(
    ctx: MeasureContext<SessionData>,
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Promise<FindResult<T>> {
    // 🔴 CHEAP GATE FIRST. `findAll` is the hottest method in the pipeline and
    // this filter concerns exactly one document shape, so everything that
    // cannot possibly be an activity message leaves without a property read —
    // and, now, without a query rewrite.
    if (!this.mayCarryAuditRecord(_class)) {
      return await this.provideFindAll(ctx, _class, query, options)
    }
    if (this.mayReadLedger(ctx)) {
      return this.sanitizeLedgerRows(await this.provideFindAll(ctx, _class, query, options))
    }
    return this.sanitizeLedgerRows(await this.hideLedgerRows(ctx, _class, query, options))
  }

  /**
   * Answer a SESSION read with the ledger rows absent.
   *
   * Two layers, in this order:
   *
   * 1. the query rewrite — `props.gate` must not exist. The row never leaves
   *    the adapter, so it is missing from the page, from `total`, and from the
   *    answer to a probing query like `{ 'props.gate.passed': true }` that
   *    would otherwise leak the ledger's contents one boolean at a time;
   * 2. the result sweep — for any path where layer 1 did not bite (an adapter
   *    that ignores the operator, a middleware below that rewrites the query
   *    again, a cached answer). It cannot be defeated by a projection because
   *    the projection is WIDENED first and narrowed back afterwards.
   *
   * ⚠️ `limit` IS APPROXIMATE UNDER LAYER 2 AND ALWAYS WAS. A page that loses a
   * row to the sweep comes back short rather than topped up; only layer 1 keeps
   * pages full, and it is the layer that normally runs. `total` is decremented
   * by what the sweep removed rather than recomputed — the adapter's count is
   * over the whole query, not over this page.
   *
   * ⚠️ THE CONSTRAINT IS BY FIELD, NOT BY CLASS, so it over-excludes rather
   * than under-excludes: a `core.class.Doc` query reaches this branch (see
   * {@link mayCarryAuditRecord} for why the ancestor test has to be that way),
   * and any document of any class that happens to carry a `props.gate` would
   * be dropped from it too. Nothing else in the model has that shape today.
   * Over-exclusion is the direction to be wrong in here; the alternative,
   * narrowing on `_class`, would miss the ledger on exactly the ancestor query
   * the activity panel uses.
   *
   * ℹ️ `ProductVersionReleaseGuardMiddleware` IS UNAFFECTED, checked because it
   * is the one other reader of `auditRecordId` in the build and it fails
   * CLOSED on a missing record. It sits BELOW this middleware in
   * `server/server-pipeline/src/pipeline.ts` and reads with `provideFindAll`,
   * which descends further down — so its read never enters this override and
   * it keeps the unfiltered view its refusal depends on.
   *
   * ⚠️ TOP-LEVEL DOCUMENTS ONLY. An `options.lookup` that pulled a ledger row
   * in as a JOINED document would land in `lookupMap` / `$lookup`, which the
   * sweep does not walk. Nothing joins to an `ActivityInfoMessage` today —
   * activity is the child side of every relation it takes part in — so this is
   * a bound on the implementation, not a live hole; a lookup that ever points
   * this way has to be handled here.
   *
   * ⚠️ NOT `_class`-WIDE. `activity.class.ActivityInfoMessage` carries ordinary
   * UI activity too — `completeCycle`'s cycle snapshot and `archive`'s audit
   * line are both instances of it — and none of that is a command ledger. The
   * constraint names `props.gate`, which is written by `releaseProductVersion`
   * and by nothing else in this package, so every other activity message is
   * returned untouched.
   */
  private async hideLedgerRows<T extends Doc>(
    ctx: MeasureContext<SessionData>,
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Promise<FindResult<T>> {
    // ⚠️ SPREAD FIRST, CONSTRAINT SECOND, so a caller that names `props.gate`
    // itself — the shape a probe takes — is overridden rather than obeyed.
    const hidden = { ...query, [LEDGER_MARKER_PATH]: { $exists: false } } as unknown as DocumentQuery<T>
    const projection = options?.projection as Record<string, unknown> | undefined
    // Huly projections are INCLUSION lists (`PostgresAdapterBase.getProjection`
    // builds its `SELECT` from the keys and force-adds `_id` / `_class`), so a
    // caller drops `props` by leaving it out, not by setting it to `0`.
    const widen = projection !== undefined && projection.props !== 1 && projection.props !== true
    const effective = widen
      ? ({ ...options, projection: { ...projection, props: 1 } } as unknown as FindOptions<T>)
      : options
    const result = await this.provideFindAll(ctx, _class, hidden, effective)

    let dropped = 0
    const kept: T[] = []
    for (const doc of result) {
      if (carriesReleaseGate(doc)) {
        dropped++
        continue
      }
      if (widen) {
        // Give back exactly the shape that was asked for: `props` was ours, not
        // the caller's, and leaving it on would be a leak of its own.
        const { props, ...rest } = doc as unknown as Record<string, unknown>
        void props
        kept.push(rest as unknown as T)
        continue
      }
      kept.push(doc)
    }
    if (dropped === 0 && !widen) {
      return result
    }
    const total = result.total >= 0 ? Math.max(result.total - dropped, kept.length) : result.total
    return toFindResult(kept, total, result.lookupMap)
  }

  /**
   * The BACKSTOP, unchanged in substance and no longer the mechanism.
   *
   * It runs on the server-side path too, where a ledger row IS returned: for a
   * record this build wrote it is an identity transform, and for one it did not
   * (a restored backup, a forged `props.gate`) it is the difference between
   * handing a trigger a blocker list and not.
   */
  private sanitizeLedgerRows<T extends Doc>(result: FindResult<T>): FindResult<T> {
    if (!result.some((doc) => carriesReleaseGate(doc))) {
      return result
    }
    // No await, no reader, no re-entry: the projection is a pure function of
    // the document, so the recursion guard the viewer-based version needed is
    // gone with the viewer.
    const sanitized = result.map((doc) => (carriesReleaseGate(doc) ? sanitizeAuditRecord(doc) : doc))
    // `toFindResult` rather than a bare array: `total` is the SERVER's count
    // over the whole query and has nothing to do with `sanitized.length`, and
    // `lookupMap` belongs to the result rather than to any one document.
    return toFindResult(sanitized, result.total, result.lookupMap)
  }

  /**
   * May THIS reader see command ledger rows?
   *
   * 🔴 THE WHOLE FIX TURNS ON THIS PREDICATE, so both halves are stated with
   * where they are set and what it would take to forge them.
   *
   * 1. `account.uuid === systemAccountUuid` — the platform's own idiom for "not
   *    a user" (`foundations/server/packages/middleware/src/utils.ts`,
   *    `isSystem`). It covers every reader that comes in through
   *    `wrapPipeline`, whose `SessionDataImpl` is built with `systemAccount`:
   *    backup, the fulltext indexer, `dev/tool`, and the workspace-service
   *    migrations and upgrades. It also covers this middleware's own
   *    {@link auditorReader}. On a session the account comes from the JWT, so
   *    claiming it needs a token signed with `SERVER_SECRET`; a client cannot
   *    assert it;
   * 2. {@link LEDGER_ACCESS_KEY} on `contextCache` — the window a command body
   *    opens around itself, because a command runs AS THE CALLER. Set only by
   *    {@link withLedgerAccess}, on a `SessionData` the transactor rebuilds per
   *    request, and never populated from the request payload.
   *
   * ⚠️ `isTriggerCtx` IS DELIBERATELY NOT ONE OF THEM. `TriggersMiddleware`
   * sets it on the SHARED `contextData` and never clears it, which is exactly
   * why `SessionPipelineClient.findAll` has to force it back to `false`; a
   * permission that a stray write can switch on is not a permission.
   *
   * ⚠️ TRIGGERS DO NOT REACH THIS PREDICATE AT ALL, which is a different and
   * better answer than "triggers are admitted". `TriggersMiddleware` sits
   * BELOW this middleware in `server/server-pipeline/src/pipeline.ts`, and the
   * `findAll` it hands `TriggerControl` is its own — i.e. `provideFindAll`,
   * descending away from here. Worth stating because the account would not
   * have saved them: `processDerived` builds its async `SessionDataImpl` from
   * `sctx.account`, the CALLER's, not the system one. The fulltext indexer is
   * the same story from the other side — it reads through `rawFindAll` on the
   * adapter, below every middleware.
   */
  private mayReadLedger (ctx: MeasureContext<SessionData>): boolean {
    const data = ctx.contextData
    if (data === undefined) {
      // Fail closed: no session context is not a proof of being the server.
      return false
    }
    if (data.account?.uuid === systemAccountUuid) {
      return true
    }
    return data.contextCache?.get(LEDGER_ACCESS_KEY) === true
  }

  /**
   * Run `op` with the ledger readable by the caller's own client.
   *
   * ⚠️ AS NARROW AS IT CAN BE MADE: one command, and restored — not merely
   * deleted — afterwards, so a nested call cannot close a window it did not
   * open. `releaseProductVersion` is the only command that reads a ledger row;
   * `completeCycle`'s snapshot and `archive`'s audit line are activity messages
   * without a `props.gate`, so they are never hidden and need no window.
   */
  private async withLedgerAccess<T>(ctx: MeasureContext<SessionData>, op: () => Promise<T>): Promise<T> {
    const cache = ctx.contextData?.contextCache
    if (cache === undefined) {
      // ⚠️ NOT REACHABLE FROM A REAL SESSION, and it fails towards "no window"
      // rather than towards "always open". `SessionDataImpl.contextCache` is a
      // lazy getter that always yields a map, so the transactor never lands
      // here; only a hand-built context can, and one of those has no business
      // being handed the ledger just because it is incomplete.
      return await op()
    }
    const previous = cache.get(LEDGER_ACCESS_KEY)
    cache.set(LEDGER_ACCESS_KEY, true)
    try {
      return await op()
    } finally {
      if (previous === undefined) {
        cache.delete(LEDGER_ACCESS_KEY)
      } else {
        cache.set(LEDGER_ACCESS_KEY, previous)
      }
    }
  }

  /**
   * Could a query for `_class` return an `ActivityInfoMessage`?
   *
   * ⚠️ `isDerived(ActivityInfoMessage, _class)` and NOT the other way round.
   * The activity panel queries `activity.class.ActivityMessage`, and other code
   * queries `core.class.Doc`; asking whether the QUERY class derives from
   * `ActivityInfoMessage` would answer "no" for both and the filter would never
   * fire on the path that actually matters.
   */
  private mayCarryAuditRecord (_class: Ref<Class<Doc>>): boolean {
    const hierarchy = this.context.hierarchy
    if (hierarchy === undefined) {
      return false
    }
    try {
      return hierarchy.isDerived(activity.class.ActivityInfoMessage, _class)
    } catch (err: unknown) {
      // A class this hierarchy does not know is not an activity message.
      void err
      return false
    }
  }

  /** `null` for an unknown operation, mirroring the traceability handler. */
  async handleCommand (
    ctx: MeasureContext<SessionData>,
    args: DomainParams
  ): Promise<AgentraCommandResult | AgentraQueryResult | null> {
    if (args[AGENTRA_OP_CONVERT_LEAD] !== undefined) {
      const { params } = args[AGENTRA_OP_CONVERT_LEAD]
      return await this.convertLead(ctx, params as ConvertLeadToRequirementInput)
    }
    if (args[AGENTRA_OP_LINK_VERIFIES] !== undefined) {
      const { params } = args[AGENTRA_OP_LINK_VERIFIES]
      return await this.linkVerifies(ctx, params as LinkVerifiesInput)
    }
    if (args[AGENTRA_OP_LINK_IMPLEMENTS] !== undefined) {
      const { params } = args[AGENTRA_OP_LINK_IMPLEMENTS]
      return await this.linkImplements(ctx, params as LinkImplementsInput)
    }
    if (args[AGENTRA_OP_UNLINK_IMPLEMENTS] !== undefined) {
      const { params } = args[AGENTRA_OP_UNLINK_IMPLEMENTS]
      return await this.unlinkImplements(ctx, params as UnlinkImplementsInput)
    }
    if (args[AGENTRA_OP_CREATE_WORK_ITEMS] !== undefined) {
      const { params } = args[AGENTRA_OP_CREATE_WORK_ITEMS]
      return await this.createWorkItems(ctx, params as CreateWorkItemsInput)
    }
    if (args[AGENTRA_OP_CREATE_DEFECT] !== undefined) {
      const { params } = args[AGENTRA_OP_CREATE_DEFECT]
      return await this.createDefect(ctx, params as CreateDefectInput)
    }
    if (args[AGENTRA_OP_PREVIEW_RELEASE_GATE] !== undefined) {
      // ⚠️ `params`, the same inner key every other operation uses.
      const { params } = args[AGENTRA_OP_PREVIEW_RELEASE_GATE]
      return await this.previewReleaseGate(ctx, params as PreviewReleaseGateInput)
    }
    if (args[AGENTRA_OP_ARCHIVE_OBJECT] !== undefined) {
      const { params } = args[AGENTRA_OP_ARCHIVE_OBJECT]
      return await this.archiveObject(ctx, params as ArchiveObjectInput)
    }
    if (args[AGENTRA_OP_RELEASE_PRODUCT_VERSION] !== undefined) {
      const { params } = args[AGENTRA_OP_RELEASE_PRODUCT_VERSION]
      return await this.releaseProductVersion(ctx, params as ReleaseProductVersionInput)
    }
    if (args[AGENTRA_OP_COMPLETE_CYCLE] !== undefined) {
      // ⚠️ `params`, the same inner key the client writes. `DomainParams` is
      // `Record<string, any>`, so spelling it `query` on either side is not a
      // type error — it just reads `undefined` here.
      const { params } = args[AGENTRA_OP_COMPLETE_CYCLE]
      return await this.completeCycle(ctx, params as CompleteCycleInput)
    }
    return null
  }

  private async linkVerifies (
    ctx: MeasureContext<SessionData>,
    input: LinkVerifiesInput
  ): Promise<AgentraCommandResult> {
    if (input == null || typeof input !== 'object' || input.testCase === undefined || input.requirement === undefined) {
      return { ok: false, code: 400, reason: 'malformed-input', message: '`testCase` and `requirement` are required' }
    }
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey === '') {
      // Refused rather than defaulted: an auto-generated key would make every
      // retry a fresh execution and defeat the whole ledger.
      return { ok: false, code: 400, reason: 'malformed-input', message: '`idempotencyKey` is required' }
    }
    try {
      const outcome = await linkVerifies(
        { ctx, client: this.callerClient(ctx), runner: getCommandRunner(this.context) },
        input
      )
      return {
        ok: true,
        executionId: outcome.executionId,
        replayed: outcome.replayed,
        preempted: outcome.preempted,
        result: outcome.result
      }
    } catch (err: unknown) {
      return toCommandResult(err)
    }
  }

  private async linkImplements (
    ctx: MeasureContext<SessionData>,
    input: LinkImplementsInput
  ): Promise<AgentraCommandResult> {
    if (input == null || typeof input !== 'object' || input.workItem === undefined || input.requirement === undefined) {
      return { ok: false, code: 400, reason: 'malformed-input', message: '`workItem` and `requirement` are required' }
    }
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey === '') {
      // Refused rather than defaulted: an auto-generated key would make every
      // retry a fresh execution and defeat the whole ledger.
      return { ok: false, code: 400, reason: 'malformed-input', message: '`idempotencyKey` is required' }
    }
    try {
      const outcome = await linkImplements(
        { ctx, client: this.callerClient(ctx), runner: getCommandRunner(this.context) },
        input
      )
      return {
        ok: true,
        executionId: outcome.executionId,
        replayed: outcome.replayed,
        preempted: outcome.preempted,
        result: outcome.result
      }
    } catch (err: unknown) {
      return toCommandResult(err)
    }
  }

  private async unlinkImplements (
    ctx: MeasureContext<SessionData>,
    input: UnlinkImplementsInput
  ): Promise<AgentraCommandResult> {
    if (input == null || typeof input !== 'object' || input.workItem === undefined || input.requirement === undefined) {
      return { ok: false, code: 400, reason: 'malformed-input', message: '`workItem` and `requirement` are required' }
    }
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey === '') {
      // Refused rather than defaulted: an auto-generated key would make every
      // retry a fresh execution and defeat the whole ledger.
      return { ok: false, code: 400, reason: 'malformed-input', message: '`idempotencyKey` is required' }
    }
    try {
      const outcome = await unlinkImplements(
        { ctx, client: this.callerClient(ctx), runner: getCommandRunner(this.context) },
        input
      )
      return {
        ok: true,
        executionId: outcome.executionId,
        replayed: outcome.replayed,
        preempted: outcome.preempted,
        result: outcome.result
      }
    } catch (err: unknown) {
      return toCommandResult(err)
    }
  }

  private async createWorkItems (
    ctx: MeasureContext<SessionData>,
    input: CreateWorkItemsInput
  ): Promise<AgentraCommandResult> {
    if (
      input == null ||
      typeof input !== 'object' ||
      input.requirement === undefined ||
      input.project === undefined ||
      !Array.isArray(input.items) ||
      input.items.length === 0
    ) {
      // 🔴 CLASSIFIED HERE, NOT IN `createWorkItems.ts`. `malformed-input` is
      // the one refusal reason of this command that the command file never
      // throws — it is decided in this pre-validation, before the body is
      // entered — so its `partialWrite` has to be stated at this site or the
      // reason would reach the client unclassified and be read as "assume it
      // wrote", which for a request that never ran is needlessly alarming.
      return {
        ok: false,
        code: 400,
        reason: 'malformed-input',
        message: '`requirement`, `project` and a non-empty `items` array are required',
        partialWrite: 'none',
        itemsWritten: 0
      }
    }
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey === '') {
      return {
        ok: false,
        code: 400,
        reason: 'malformed-input',
        message: '`idempotencyKey` is required',
        partialWrite: 'none',
        itemsWritten: 0
      }
    }
    try {
      const outcome = await createWorkItems(
        { ctx, client: this.callerClient(ctx), runner: getCommandRunner(this.context) },
        input
      )
      return {
        ok: true,
        executionId: outcome.executionId,
        replayed: outcome.replayed,
        preempted: outcome.preempted,
        result: outcome.result
      }
    } catch (err: unknown) {
      return toCommandResult(err)
    }
  }

  private async archiveObject (
    ctx: MeasureContext<SessionData>,
    input: ArchiveObjectInput
  ): Promise<AgentraCommandResult> {
    if (
      input == null ||
      typeof input !== 'object' ||
      input.target === undefined ||
      input.targetClass === undefined ||
      (input.intent !== 'archive' && input.intent !== 'restore')
    ) {
      return {
        ok: false,
        code: 400,
        reason: 'malformed-input',
        message: "`target`, `targetClass` and `intent` ('archive' | 'restore') are required"
      }
    }
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey === '') {
      // Refused rather than defaulted: an auto-generated key would make every
      // retry a fresh execution and defeat the whole ledger.
      return { ok: false, code: 400, reason: 'malformed-input', message: '`idempotencyKey` is required' }
    }
    try {
      const outcome = await archiveObject(
        { ctx, client: this.callerClient(ctx), runner: getCommandRunner(this.context) },
        input
      )
      return {
        ok: true,
        executionId: outcome.executionId,
        replayed: outcome.replayed,
        preempted: outcome.preempted,
        result: outcome.result
      }
    } catch (err: unknown) {
      return toCommandResult(err)
    }
  }

  private async createDefect (
    ctx: MeasureContext<SessionData>,
    input: CreateDefectInput
  ): Promise<AgentraCommandResult> {
    if (
      input == null ||
      typeof input !== 'object' ||
      input.target === undefined ||
      input.targetClass === undefined ||
      input.project === undefined
    ) {
      return {
        ok: false,
        code: 400,
        reason: 'malformed-input',
        message: '`target`, `targetClass` and `project` are required'
      }
    }
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey === '') {
      return { ok: false, code: 400, reason: 'malformed-input', message: '`idempotencyKey` is required' }
    }
    try {
      const outcome = await createDefect(
        {
          ctx,
          client: this.callerClient(ctx),
          runner: getCommandRunner(this.context),
          writeBody: this.bodyWriter(ctx)
        },
        input
      )
      return {
        ok: true,
        executionId: outcome.executionId,
        replayed: outcome.replayed,
        preempted: outcome.preempted,
        result: outcome.result
      }
    } catch (err: unknown) {
      return toCommandResult(err)
    }
  }

  /**
   * The blob writer for a defect body, or `undefined` when this deployment has
   * no storage adapter on the pipeline.
   *
   * 🔴 Degrades to "no description" rather than throwing. A workspace without an
   * object store can still file the defect and still get the trace edge — which
   * is the part the audit trail needs — whereas failing the whole command would
   * turn a missing convenience into a hard block on the QA loop.
   */
  private bodyWriter (ctx: MeasureContext<SessionData>): DefectBodyWriter | undefined {
    const storage = this.context.storageAdapter
    if (storage === undefined) {
      return undefined
    }
    const workspace = this.context.workspace
    return async (blob, markup) => {
      // ⚠️ The STRING overload, and `size` deliberately omitted. This package
      // compiles against the platform-rig `default` profile, which carries no
      // `@types/node`, so `Buffer` does not exist here; and `markup.length`
      // would be UTF-16 code units, which understates the byte length of any
      // non-ASCII defect body. Letting the adapter measure its own input is the
      // only spelling that is right for both.
      await storage.put(ctx, workspace, blob, markup, 'application/json')
    }
  }

  /**
   * The read-only gate preview (PRD §7.5).
   *
   * 🔴 NO RUNNER, NO LEDGER, NO IDEMPOTENCY KEY — and therefore no
   * `idempotencyKey` validation either. All three exist to make a WRITE happen
   * once; this call writes nothing, so a ledger row would be a permanent record
   * of nothing having happened, and — the part that would actually be a bug —
   * a `succeeded` row REPLAYS, so the second preview would hand back the gate as
   * it stood the first time. The gate moves constantly; a preview must recompute.
   *
   * 🔴 THE SAME TWO READERS AS THE RELEASE. {@link callerClient} decides what is
   * echoed back and guards the read permission; {@link auditorReader} decides the
   * verdict. Handing the auditor to both, or the caller to both, would each be a
   * different bug — a leak and a false green respectively.
   */
  private async previewReleaseGate (
    ctx: MeasureContext<SessionData>,
    input: PreviewReleaseGateInput
  ): Promise<AgentraQueryResult<PreviewReleaseGateResult>> {
    if (input == null || typeof input !== 'object' || input.version === undefined) {
      return { ok: false, code: 400, reason: 'malformed-input', message: '`version` is required' }
    }
    const badThreshold = passRateThresholdError(input.passRateThreshold)
    if (badThreshold !== undefined) {
      return badThreshold
    }
    try {
      const result = await previewReleaseGate(
        { ctx, client: this.callerClient(ctx), auditor: this.auditorReader(ctx) },
        input
      )
      return { ok: true, result }
    } catch (err: unknown) {
      if (err instanceof PreviewReleaseGateError) {
        return { ok: false, code: err.code, reason: err.reason, message: err.message }
      }
      // 🔴 Anything else is RETHROWN, same rule as `toCommandResult`: telling the
      // caller "your request was wrong" about a server bug hides the bug.
      throw err
    }
  }

  private async releaseProductVersion (
    ctx: MeasureContext<SessionData>,
    input: ReleaseProductVersionInput
  ): Promise<AgentraCommandResult> {
    if (input == null || typeof input !== 'object' || input.version === undefined) {
      return { ok: false, code: 400, reason: 'malformed-input', message: '`version` is required' }
    }
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey === '') {
      // Refused rather than defaulted: an auto-generated key would make every
      // retry a fresh execution and defeat the whole ledger.
      return { ok: false, code: 400, reason: 'malformed-input', message: '`idempotencyKey` is required' }
    }
    // 🔴 Shared with the preview — see {@link passRateThresholdError}. The bar
    // is recorded in the audit trail as requested, so it may not be clamped.
    const badThreshold = passRateThresholdError(input.passRateThreshold)
    if (badThreshold !== undefined) {
      return badThreshold
    }
    try {
      // 🔴 THE LEDGER WINDOW. `runRelease` reads its own audit record back
      // through the CALLER's client as the re-entrancy anchor, and the read
      // filter hides that record from callers. Without this the second attempt
      // would find nothing, re-derive the same `_id` and die on a duplicate
      // key — the read gate would present as a write bug.
      const outcome = await this.withLedgerAccess(
        ctx,
        async () =>
          await releaseProductVersion(
            {
              ctx,
              client: this.callerClient(ctx),
              auditor: this.auditorReader(ctx),
              runner: getCommandRunner(this.context)
            },
            input
          )
      )
      return {
        ok: true,
        executionId: outcome.executionId,
        replayed: outcome.replayed,
        preempted: outcome.preempted,
        result: outcome.result
      }
    } catch (err: unknown) {
      return toCommandResult(err)
    }
  }

  /**
   * An UNFILTERED reader, for DECIDING the release gate and nothing else.
   *
   * 🔴 WHY THIS EXISTS. PRD REL-003 splits the gate in two: the verdict must be
   * computed over ALL blocking items, while the echo back is filtered by the
   * caller's permissions. A verdict computed through the caller's own filter
   * would let a release manager with no access to one project ship a version
   * that project is blocking — the gate would report green because it could not
   * see the red.
   *
   * 🔴 WHY IT IS SAFE. It is handed to `evaluateReleaseGate` as its `auditor`
   * argument, which is read-only by type ({@link ReleaseGateReader} has no
   * `tx`), and every blocker it finds is RE-READ through the caller's client
   * before being reported; the ones that come back empty are collapsed into a
   * single contentless entry. Nothing this reader returns reaches the caller
   * unfiltered. It is never used for a write — all writes go through
   * {@link callerClient}, so attribution and authorisation are unchanged.
   *
   * ⚠️ KNOWN RESIDUAL, stated rather than hidden: the derived context shares the
   * caller's `contextData` fields by reference (only `account` is replaced), so
   * `contextCache` is common to both. Today that cache holds one entry — the
   * `'processed'` transaction set `SpaceSecurityMiddleware` uses to de-duplicate
   * broadcasts — which is read-path neutral. If anything ever caches a
   * PER-ACCOUNT value there, this must become a fresh `SessionDataImpl` (or an
   * `ctx.newChild(...)` whose `contextData` is rebuilt) instead.
   *
   * ⚠️ `Object.create(ctx)` rather than a spread: `MeasureContext` is an object
   * with methods, and a shallow spread would drop the prototype and produce a
   * context whose `with` / `newChild` are undefined. The derived object shadows
   * `contextData` only, so `contextData.isTriggerCtx` toggling inside
   * `SessionPipelineClient` touches THIS copy and never the caller's shared one.
   */
  private auditorReader (ctx: MeasureContext<SessionData>): ReleaseGateReader | undefined {
    const head = this.context.head
    if (head === undefined || ctx.contextData === undefined) {
      // Degrades to "no privileged view": `releaseProductVersion` then decides
      // over the caller's own reads. Narrower than intended, never wider.
      return undefined
    }
    const systemCtx: MeasureContext<SessionData> = Object.create(ctx)
    Object.defineProperty(systemCtx, 'contextData', {
      value: { ...ctx.contextData, account: systemAccount },
      writable: true,
      enumerable: true,
      configurable: true
    })
    return new SessionPipelineClient(this.context, systemCtx, head)
  }

  private async completeCycle (
    ctx: MeasureContext<SessionData>,
    input: CompleteCycleInput
  ): Promise<AgentraCommandResult> {
    if (input == null || typeof input !== 'object' || input.cycle === undefined) {
      return { ok: false, code: 400, reason: 'malformed-input', message: '`cycle` is required' }
    }
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey === '') {
      // Refused rather than defaulted: an auto-generated key would make every
      // retry a fresh execution and defeat the whole ledger.
      return { ok: false, code: 400, reason: 'malformed-input', message: '`idempotencyKey` is required' }
    }
    if (!['keep', 'backlog', 'move'].includes(input.rolloverPolicy)) {
      // 🔴 NOT DEFAULTED TO `keep`. A caller whose policy this build does not
      // understand asked for something specific; silently keeping the issues
      // where they are would report success for a rollover that never happened.
      return {
        ok: false,
        code: 400,
        reason: 'malformed-input',
        message: '`rolloverPolicy` must be one of keep | backlog | move'
      }
    }
    try {
      const outcome = await completeCycle(
        {
          ctx,
          client: this.callerClient(ctx),
          runner: getCommandRunner(this.context)
        },
        input
      )
      return {
        ok: true,
        executionId: outcome.executionId,
        replayed: outcome.replayed,
        preempted: outcome.preempted,
        result: outcome.result
      }
    } catch (err: unknown) {
      return toCommandResult(err)
    }
  }

  private async convertLead (
    ctx: MeasureContext<SessionData>,
    input: ConvertLeadToRequirementInput
  ): Promise<AgentraCommandResult> {
    if (input == null || typeof input !== 'object' || input.lead === undefined) {
      return { ok: false, code: 400, reason: 'malformed-input', message: '`lead` is required' }
    }
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey === '') {
      // Refused rather than defaulted: an auto-generated key would make every
      // retry a fresh execution and defeat the whole ledger.
      return { ok: false, code: 400, reason: 'malformed-input', message: '`idempotencyKey` is required' }
    }
    try {
      const outcome = await convertLeadToRequirement(
        {
          ctx,
          client: this.callerClient(ctx),
          runner: getCommandRunner(this.context)
        },
        input
      )
      return {
        ok: true,
        executionId: outcome.executionId,
        replayed: outcome.replayed,
        preempted: outcome.preempted,
        result: outcome.result
      }
    } catch (err: unknown) {
      return toCommandResult(err)
    }
  }

  /**
   * A `TxOperations` that acts AS THE CALLER.
   *
   * Two independent halves, both required:
   *
   * 1. the transport — {@link SessionPipelineClient} over `context.head` with the
   *    caller's `ctx`, so security middlewares see `ctx.contextData.account`;
   * 2. the attribution — `TxFactory(user)` inside `TxOperations` stamps
   *    `modifiedBy`, so it MUST be the caller's `primarySocialId`, never
   *    `core.account.System`.
   *
   * `isDerived` stays `false`: these are first-class user writes, not derived
   * data, and marking them derived would misroute them in
   * `MarkDerivedEntryMiddleware`.
   */
  private callerClient (ctx: MeasureContext<SessionData>): TxOperations {
    const head = this.context.head
    if (head === undefined) {
      throw new Error('agentra: pipeline head is not available, refusing to run a command without the caller session')
    }
    const user = ctx.contextData?.account?.primarySocialId
    if (user === undefined) {
      // Fail closed. Substituting the system account here would run the whole
      // command with full authority and stamp the workspace's audit trail with
      // a write nobody made.
      throw new Error('agentra: no caller account on the session context, refusing to run a command')
    }
    return new TxOperations(new SessionPipelineClient(this.context, ctx, head), user, false)
  }
}

/**
 * The failure half both envelopes share.
 *
 * @public
 */
export interface AgentraFailure {
  ok: false
  code: number
  reason: string
  message: string
  /**
   * Whether this refusal may have left documents behind.
   *
   * 🔴 A SECOND AXIS, NOT A RESTATEMENT OF `code`. `code` says whether retrying
   * can help; this says whether anything was written before the refusal. A
   * client that reads `code === 400` as "nothing happened" is making a claim
   * the code never carried — which is precisely how a half-written batch got
   * reported to users as "nothing was created", sending them to close-and-retry
   * and duplicate the surviving half.
   *
   * ⚠️ ABSENT MEANS `'unclassified'`, WHICH MEANS "ASSUME IT WROTE". It must
   * never be defaulted to `'none'`: a reassuring answer nobody gave is the bug,
   * not the fix. `toCommandResult` therefore fills it on every branch, so the
   * field is only ever absent on a failure some other code path built by hand.
   */
  partialWrite?: PartialWriteRisk
  /**
   * For a batch command, how many elements of the batch are KNOWN to exist at
   * the moment of the refusal. Absent when the command is not a batch, or when
   * the count is not known.
   */
  itemsWritten?: number
}

/**
 * The `passRateThreshold` check, shared by the release and its preview.
 *
 * 🔴 SHARED RATHER THAN COPIED. A preview that accepted a threshold the release
 * refuses (or vice versa) would show the user a gate evaluated at a bar the
 * release will never use — the exact drift `previewReleaseGate` exists to
 * prevent, arriving through the input validation instead of through the
 * judgement.
 *
 * 🔴 NOT CLAMPED. A caller who asked for a threshold this build cannot honour
 * asked for something specific; quietly substituting 100 (or 0) would gate the
 * release on a bar nobody chose.
 *
 * @public
 */
export function passRateThresholdError (bar: unknown): AgentraFailure | undefined {
  if (bar === undefined) {
    return undefined
  }
  if (typeof bar !== 'number' || !Number.isFinite(bar) || bar < 0 || bar > 100) {
    return {
      ok: false,
      code: 400,
      reason: 'malformed-input',
      message: '`passRateThreshold` must be a number between 0 and 100'
    }
  }
  return undefined
}

/**
 * Map a command failure onto the wire envelope.
 *
 * 🔴 409 for both claim errors. `CommandInProgressError` is "someone else holds
 * a live claim"; `CommandPreemptedError` is "we lost the takeover race". Both
 * mean exactly "retry, the result does not exist yet", and both already carry
 * `code = 409` on the class — read from the instance rather than hard-coded so
 * the two cannot drift.
 *
 * 🔴 Anything not recognised is RETHROWN. Turning an unknown exception into a
 * 400 would tell the caller "your request was wrong" about a server bug, and
 * would let a half-completed conversion look like a clean refusal.
 *
 * @public
 */
export function toCommandResult (err: unknown): AgentraCommandResult {
  //
  // 🔴 BOTH CLAIM ERRORS ARE `'possible'`, AND NEITHER IS ABOUT THIS PROCESS.
  //
  // Neither reaches the body: `CommandInProgressError` is raised because a live
  // claim on this exact key is held by somebody else, and `CommandPreemptedError`
  // because the takeover of a stale-or-failed claim was lost. Read as "did MY
  // invocation write?" both would be `'none'` — and that reading is the wrong
  // one. The question the field answers is "may documents for THIS REQUEST
  // exist?", and in both cases another attempt on the very same idempotency key
  // is running now or ran and stopped partway, which is exactly the state where
  // a user must not be told the batch is empty.
  //
  if (err instanceof CommandInProgressError) {
    return {
      ok: false,
      code: err.code,
      reason: 'command-in-progress',
      message: err.message,
      partialWrite: 'possible'
    }
  }
  if (err instanceof CommandPreemptedError) {
    return {
      ok: false,
      code: err.code,
      reason: 'command-preempted',
      message: err.message,
      partialWrite: 'possible'
    }
  }
  if (err instanceof CreateWorkItemsError) {
    // The only command whose refusal paths have been audited one by one. See
    // `createWorkItemsPartialWrite`.
    return {
      ok: false,
      code: err.code,
      reason: err.reason,
      message: err.message,
      partialWrite: err.partialWrite,
      itemsWritten: err.itemsWritten
    }
  }
  //
  // 🔴 EVERY REMAINING COMMAND REPORTS `'unclassified'`, DELIBERATELY.
  //
  // Not `'none'`: none of these refusal paths has been walked to check whether
  // it can fire after a write, and answering "clean" on their behalf would
  // recreate the exact defect this field exists to close — a client told
  // "nothing happened" about something that half-happened. `'unclassified'`
  // makes the gap visible instead of papering over it, and an honest client
  // treats it as `'possible'`.
  //
  // The way to remove one of these from the fallback is to give its error class
  // its own `partialWrite`, backed by a `PartialWriteTable` over its reason
  // union the way `createWorkItems` does, and add a branch above.
  //
  if (
    err instanceof ConvertLeadError ||
    err instanceof CompleteCycleError ||
    err instanceof LinkVerifiesError ||
    err instanceof LinkImplementsError ||
    err instanceof UnlinkImplementsError ||
    err instanceof CreateDefectError ||
    err instanceof ReleaseProductVersionError ||
    err instanceof ArchiveObjectError ||
    // Same reasoning as `ArchivableGuardError`: the guard runs INSIDE the
    // caller's write path, so "a trace edge cannot be deleted, revoke it
    // instead" must reach the client as that sentence rather than as a 500.
    err instanceof TraceLinkGuardError ||
    // The guard runs INSIDE the caller's write path, so its refusals surface
    // here too — a delete blocked by CRM-T013 must reach the client as a
    // legible "archive it instead", not as an opaque 500.
    err instanceof ArchivableGuardError
  ) {
    return {
      ok: false,
      code: err.code,
      reason: err.reason,
      message: err.message,
      partialWrite: PARTIAL_WRITE_UNCLASSIFIED
    }
  }
  throw err
}
