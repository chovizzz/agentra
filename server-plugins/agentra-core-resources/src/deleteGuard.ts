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

import activity from '@hcengineering/activity'
import agentraCore, { ARCHIVABLE_CLASSES, archivableKey } from '@hcengineering/agentra-core'
import core, {
  TxProcessor,
  type Class,
  type Doc,
  type Hierarchy,
  type MeasureContext,
  type Ref,
  type Tx,
  type TxApplyIf,
  type TxCreateDoc,
  type TxCUD,
  type TxMixin,
  type TxRemoveDoc,
  type TxUpdateDoc
} from '@hcengineering/core'
import serverAgentraCore, { commandExecutionId, commandObjectId } from '@hcengineering/server-agentra-core'
import traceability, { type TraceLink } from '@hcengineering/traceability'

/**
 * Refusal reasons. Machine readable because the two rules below fail for
 * completely different operator-visible causes and "not allowed" would tell a
 * sales lead nothing about which one they hit.
 *
 * @public
 */
export type ArchivableGuardReason = 'archive-requires-command' | 'delete-referenced' | 'opaque-operation'

/**
 * @public
 */
export class ArchivableGuardError extends Error {
  readonly code = 400

  constructor (
    readonly reason: ArchivableGuardReason,
    message: string,
    readonly txClass?: string
  ) {
    super(message)
    this.name = 'ArchivableGuardError'
  }
}

/**
 * How a transaction's payload touches one field.
 *
 * @public
 */
export type ArchivableFieldWrite =
  | { kind: 'untouched' }
  | { kind: 'plain', value: any }
  | { kind: 'unset' }
  | { kind: 'opaque', operator: string }

/**
 * Read the way `TxProcessor.applyUpdate` writes.
 *
 * 🔴 DISPATCH PER KEY, NOT PER PAYLOAD. `isOperator`
 * (`foundations/core/packages/core/src/operator.ts`) requires EVERY key to
 * start with `$`, but `TxProcessor.applyUpdate` dispatches KEY BY KEY. So a
 * MIXED payload — `{ title: 'x', $set: { 'agentra-core:mixin:Archivable.archived': true } }`
 * — makes `isOperator` false, and a guard that asked `isOperator` first and
 * then looked only for a literal key would report `untouched` while every
 * applier in the platform really did write the field. This is the same bug
 * `crm-lite`'s `readFieldWrite` was fixed for; the shape is copied rather than
 * imported because that function lives in `@hcengineering/server-products` /
 * `@hcengineering/server-crm-lite`, which this package does not depend on.
 *
 * ⚠️ A DOTTED FIELD IS THE POINT HERE. Mixin data is nested under
 * `doc[<mixinId>]`, so passing the MIXIN ID as `field` catches all four
 * spellings a writer can reach it by: `{ '<mixin>': {...} }`,
 * `{ '<mixin>.archived': v }`, `$set: { '<mixin>': {...} }` and
 * `$set: { '<mixin>.archived': v }`.
 *
 * @public
 */
export function readArchivableFieldWrite (operations: Record<string, any>, field: string): ArchivableFieldWrite {
  if (operations == null || typeof operations !== 'object') {
    return { kind: 'untouched' }
  }
  let plain: ArchivableFieldWrite | undefined
  const prefix = `${field}.`
  for (const [key, payload] of Object.entries(operations)) {
    if (!key.startsWith('$')) {
      if (key === field || key.startsWith(prefix)) {
        plain = { kind: 'plain', value: payload }
      }
      continue
    }
    const operator = key
    if (payload == null || typeof payload !== 'object') {
      continue
    }
    if (operator === '$unset') {
      if (Object.keys(payload).some((k) => k === field || k.startsWith(prefix))) return { kind: 'unset' }
      continue
    }
    if (operator === '$rename') {
      // Both halves matter: renaming the mixin key AWAY removes the flag, and
      // renaming something else ONTO it writes the flag. Neither is evaluable.
      const names = [...Object.keys(payload), ...Object.values(payload).map((v) => String(v))]
      if (names.some((k) => k === field || k.startsWith(prefix))) {
        return { kind: 'opaque', operator }
      }
      continue
    }
    if (Object.keys(payload).some((k) => k === field || k.startsWith(prefix))) {
      return { kind: 'opaque', operator }
    }
  }
  // Operators win when both are present: they are the stricter reading, and a
  // batch that names the field twice is not something to interpret leniently.
  return plain ?? { kind: 'untouched' }
}

/**
 * The transition claim. ONE lock for both directions, keyed on
 * `(target, the generation being written)`.
 *
 * 🔴 THE GENERATION IS WHAT MAKES THE ANCHOR REUSABLE. `products`' release
 * guard can key its evidence on the version id alone because `Released` is a
 * one-way door; archive is not. Keyed on the target alone, the ledger row left
 * behind by the first archive would authorise every later hand-written write of
 * the flag, in either direction, forever. Keyed on `(target, generation)` each
 * transition needs its own row, and rows are unforgeable: `CommandMiddleware.tx`
 * throws on ANY client CUD whose `objectClass` is `CommandExecution`, and it
 * writes the ledger through `provideTx` (i.e. BELOW itself), so no transaction
 * entering the pipeline can create one. `commandExecutionId` is a SHA-256
 * prefix, so the id cannot be guessed into existence either.
 *
 * @public
 */
export const ARCHIVE_TRANSITION_LOCK = 'AgentraArchivable:transition'

/**
 * The role string for the archive/restore audit record. Stable forever:
 * changing it re-points the existence lookup at an id that does not exist and
 * the next replay writes a duplicate record.
 *
 * @public
 */
export const ARCHIVE_AUDIT_ROLE = 'activity:archive-audit'

/**
 * @public
 */
export function archiveTransitionKey (target: Ref<Doc>, generation: number): string {
  return `${target}:${generation}`
}

/**
 * The `_id` of the audit record for one transition.
 *
 * @public
 */
export function archiveAuditId (target: Ref<Doc>, generation: number): Ref<Doc> {
  return commandObjectId(ARCHIVE_TRANSITION_LOCK, archiveTransitionKey(target, generation), ARCHIVE_AUDIT_ROLE)
}

/**
 * Read the generation a payload is stamping onto the mixin.
 *
 * `undefined` means "cannot tell", which the caller turns into a refusal — a
 * write of the archive flag that does not also declare its generation has no
 * addressable evidence and must not be guessed at.
 */
export function readArchiveGeneration (payload: Record<string, any>, mixinScoped: boolean): number | undefined {
  const attr = 'archiveGeneration'
  const key = mixinScoped ? attr : archivableKey(attr)
  const mixinKey = agentraCore.mixin.Archivable as string
  const candidates: any[] = []
  const collect = (obj: Record<string, any>): void => {
    for (const [k, v] of Object.entries(obj)) {
      if (k === key) {
        candidates.push(v)
      } else if (!mixinScoped && k === mixinKey && v != null && typeof v === 'object') {
        // The whole-mixin spelling: `{ '<mixin>': { archived, archiveGeneration } }`.
        candidates.push((v as Record<string, any>)[attr])
      }
    }
  }
  collect(payload)
  for (const [k, v] of Object.entries(payload)) {
    if (k.startsWith('$') && v != null && typeof v === 'object') {
      // ⚠️ `$unset` / `$rename` are NOT read for a generation on purpose: they
      // remove or relocate the field rather than stating a value, so there is
      // nothing to derive evidence from and the caller refuses.
      if (k === '$unset' || k === '$rename') continue
      collect(v as Record<string, any>)
    }
  }
  const found = candidates.find((c) => typeof c === 'number' && Number.isInteger(c) && c >= 0)
  return found
}

/**
 * The reads the guard needs. Narrower than `Middleware` so the rules are
 * testable without a pipeline.
 *
 * 🔴 THESE READS MUST BE UNFILTERED. A guard that could only see what the
 * CALLER may read would approve a write precisely when the caller cannot see
 * the evidence against it. Nothing read here is echoed to the client; only its
 * existence changes the verdict, so the wider read can only ever cost a false
 * REFUSAL, never a leak.
 *
 * @public
 */
export interface ArchivableGuardReader {
  hierarchy: Hierarchy
  findAll: <T extends Doc>(
    ctx: MeasureContext,
    _class: Ref<Class<T>>,
    query: Record<string, any>,
    options?: Record<string, any>
  ) => Promise<T[]>
}

/**
 * SYS-005, server side.
 *
 * Two rules, both of which the client half cannot enforce:
 *
 *  1. `Archivable.archived` moves ONLY by way of the archive/restore command
 *     (evidence: a ledger row plus an audit record for THIS transition);
 *  2. a physical `TxRemoveDoc` of an archivable object that still carries
 *     traceability edges is refused, with "archive it instead" (CRM-T013).
 *
 * 🔴 A MIDDLEWARE, NOT A TRIGGER — AND THIS IS THE WHOLE REASON THE CODE LIVES
 * HERE. `TriggersMiddleware.processDerived` runs AFTER `provideTx`, so the write
 * has already landed by the time a trigger sees it, and every trigger call is
 * wrapped in a `try/catch` that only calls `ctx.error`. A trigger cannot veto a
 * transaction; it can only comment on one that already happened, and "the Lead
 * is deleted and an error was logged" is not a delete guard.
 *
 * ⚠️ IT IS HOSTED BY {@link CommandMiddleware} RATHER THAN REGISTERED ON ITS
 * OWN. That middleware is already in `server/server-pipeline/src/pipeline.ts`
 * at exactly the slot these rules need — AFTER `ApplyTxMiddleware`, so a
 * `TxApplyIf` is already flattened, and BEFORE `TxMiddleware`, so a refused
 * write never reaches the transaction domain. Adding a second entry would have
 * meant editing `pipeline.ts` for no behavioural difference. (The walk below
 * still descends into `TxApplyIf.txes` — that is a property of the pipeline
 * LIST, not of this class, and the cost of being wrong is a silent bypass.)
 *
 * 🔴 WHAT THIS DOES NOT COVER, STATED SO NOBODY ASSUMES OTHERWISE.
 * `createBackupPipeline` builds a chain of `LowLevelMiddleware`,
 * `DomainFindMiddleware`, `ModelMiddleware` and `DBAdapterMiddleware` only, so
 * workspace restore and every `MigrationClient` write reach the domain table
 * directly. That is a property of every tx-pipeline guard in this tree
 * (`LeadGuardMiddleware`, `SnapshotGuardMiddleware` and
 * `ProductVersionReleaseGuardMiddleware` share it) and it is the intended trust
 * boundary: those callers are operators running server-side tooling, not
 * sessions. It is NOT a hole a client can reach.
 *
 * @public
 */
export class ArchivableGuard {
  constructor (private readonly reader: ArchivableGuardReader) {}

  async validate (ctx: MeasureContext, txes: Tx[], depth: number = 0): Promise<void> {
    if (depth > 8) {
      // Not constructible through the wire format, but a bounded walk is
      // cheaper than trusting that.
      throw new Error('agentra-core: refusing to validate a pathologically nested TxApplyIf')
    }
    for (const tx of txes) {
      // ⚠️ THE LITERAL COMPARISON COMES FIRST, DELIBERATELY. `isDerivedFrom`
      // asks `hasClass` before `isDerived`, and a hierarchy that has not loaded
      // the core model — every unit-test hierarchy, and any degraded startup —
      // answers `false` for `TxApplyIf` too. Descending would then be skipped
      // and every smuggled inner write would sail through unexamined, which is
      // the exact bypass this guard exists to close.
      if (tx._class === core.class.TxApplyIf || this.isDerivedFrom(tx._class, core.class.TxApplyIf)) {
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
    if (cud._class === core.class.TxRemoveDoc) {
      await this.validateRemove(ctx, cud as TxRemoveDoc<Doc>)
      return
    }
    if (cud._class === core.class.TxMixin) {
      const mixin = cud as TxMixin<Doc, Doc>
      // ⚠️ `isDerivedFrom`, not `===`. A mixin declared as extending
      // `Archivable` would carry the same attribute namespace and must not slip
      // past by naming itself.
      if (!this.isDerivedFrom(mixin.mixin as Ref<Class<Doc>>, agentraCore.mixin.Archivable as Ref<Class<Doc>>)) {
        return
      }
      const attrs = (mixin.attributes ?? {}) as Record<string, any>
      if (Object.keys(attrs).length === 0) return
      // 🔴 ANY write into this mixin is guarded, not just `archived`. Mixin
      // payloads live in the mixin's OWN namespace, so this transaction can
      // only be aimed at `archived` / `archivedOn` / `archivedBy` /
      // `archiveGeneration` — and forging the PROVENANCE pair is as much a
      // falsification of the SYS-005 record as forging the flag. Narrowing this
      // to `archived` would leave "who archived it, and when" writable by hand.
      const write = readArchivableFieldWrite(attrs, 'archived')
      await this.enforceTransitionEvidence(
        ctx,
        mixin.objectId,
        readArchiveGeneration(attrs, true),
        write.kind === 'untouched' ? { kind: 'plain', value: undefined } : write,
        mixin
      )
      return
    }
    if (cud._class === core.class.TxUpdateDoc) {
      const ops = (cud as TxUpdateDoc<Doc>).operations as Record<string, any>
      // 🔴 THE DOTTED SPELLING IS THE ONE THAT ACTUALLY STORES THE VALUE.
      // Guarding only `TxMixin` would be the same as not guarding at all: a
      // plain `TxUpdateDoc` on the base document writing
      // `'<mixinId>.archived'` reaches exactly the same bytes, and is what
      // `client.update` produces for a mixin attribute.
      const write = readArchivableFieldWrite(ops, agentraCore.mixin.Archivable as string)
      if (write.kind === 'untouched') return
      await this.enforceTransitionEvidence(ctx, cud.objectId, readArchiveGeneration(ops, false), write, cud)
      return
    }
    if (cud._class === core.class.TxCreateDoc) {
      // 🔴 A CREATE *CAN* CARRY MIXIN DATA, AND THIS IS THE HOLE THAT CLOSES.
      // `TxProcessor.createDoc2Doc` spreads `tx.attributes` onto the new
      // document verbatim (`foundations/core/packages/core/src/tx.ts`), so
      // `attributes['agentra-core:mixin:Archivable'] = { archived: true, ... }`
      // produces a document BORN ARCHIVED — `hierarchy.hasMixin` only asks
      // whether `doc[mixinId]` is defined. Nothing legitimate does this (the
      // command always writes the flag as a separate `TxMixin`), so the same
      // evidence rule applies here as everywhere else.
      const attrs = ((cud as TxCreateDoc<Doc>).attributes ?? {}) as Record<string, any>
      const write = readArchivableFieldWrite(attrs, agentraCore.mixin.Archivable as string)
      if (write.kind === 'untouched') return
      await this.enforceTransitionEvidence(ctx, cud.objectId, readArchiveGeneration(attrs, false), write, cud)
    }
  }

  /**
   * CRM-T013: an archivable object that anything still traces to may not be
   * physically deleted.
   *
   * 🔴 THE CHEAP PRE-GATE IS THE CLASS TEST. A removal of anything that is not
   * one of the four archivable classes returns WITHOUT READING THE DATABASE,
   * which is what keeps every cascade the platform runs — attachments, activity
   * messages, collection children — free of this guard's cost.
   *
   * ⚠️ `revoked` edges do NOT block. Task 12a's "unlink" sets `revoked` rather
   * than deleting the row precisely because traceability is an audit fact; a
   * revoked edge is history, not a live reference, and treating it as one would
   * make an unlinked object permanently undeletable.
   *
   * ⚠️ TWO QUERIES, NOT ONE. `DocumentQuery` has no cross-field `$or`, and an
   * edge may name the object at EITHER endpoint (`docA` / `docB`). Asking about
   * one end only would let a Lead that is the TARGET of an edge be deleted.
   */
  private async validateRemove (ctx: MeasureContext, tx: TxRemoveDoc<Doc>): Promise<void> {
    if (!this.isArchivableClass(tx.objectClass)) {
      return
    }
    const state = { $ne: 'revoked' }
    const [asSource, asTarget] = await Promise.all([
      this.reader.findAll<TraceLink>(ctx, traceability.class.TraceLink, { docA: tx.objectId, state }, { limit: 1 }),
      this.reader.findAll<TraceLink>(ctx, traceability.class.TraceLink, { docB: tx.objectId, state }, { limit: 1 })
    ])
    if (asSource.length === 0 && asTarget.length === 0) {
      return
    }
    throw new ArchivableGuardError(
      'delete-referenced',
      `'${tx.objectId}' is referenced by traceability links and cannot be deleted; archive it instead`,
      tx._class
    )
  }

  /**
   * The archive flag moved — prove the command moved it.
   *
   * Two facts must hold, and the FIRST is the one a client cannot manufacture.
   *
   * 1. a ledger row exists at
   *    `commandExecutionId(ARCHIVE_TRANSITION_LOCK, '<target>:<generation>')`.
   *    Unforgeable — see {@link ARCHIVE_TRANSITION_LOCK}.
   * 2. the audit record exists at {@link archiveAuditId}. Forgeable in
   *    isolation, which is exactly why it is not the anchor; what it adds is
   *    that the command got past its permission checks and wrote the record,
   *    closing the window in which an attempt that claimed the row and then
   *    failed would leave the anchor behind.
   *
   * ⚠️ ORDERING INSIDE THE COMMAND IS WHAT MAKES THE GENUINE PATH PASS: the
   * claim precedes the body (`CommandMiddleware.claim` precedes `execute`), the
   * audit record is written BEFORE the mixin write, and the command issues its
   * writes through `context.head`, i.e. re-enters the whole chain, so they do
   * arrive here and must pass on their merits.
   */
  private async enforceTransitionEvidence (
    ctx: MeasureContext,
    target: Ref<Doc>,
    generation: number | undefined,
    write: ArchivableFieldWrite,
    tx: Tx
  ): Promise<void> {
    if (write.kind === 'opaque' || write.kind === 'unset' || generation === undefined) {
      // An operator payload, an `$unset`, or a write that does not declare its
      // generation cannot be matched to any evidence. Nothing legitimate does
      // any of the three: the command always writes a plain, fully stamped
      // mixin payload.
      throw new ArchivableGuardError(
        'opaque-operation',
        `The archive flag on '${target}' may only be written as a plain, generation-stamped payload`,
        tx._class
      )
    }
    const ledgerId = commandExecutionId(ARCHIVE_TRANSITION_LOCK, archiveTransitionKey(target, generation))
    const ledger = await this.reader.findAll(
      ctx,
      serverAgentraCore.class.CommandExecution,
      { _id: ledgerId },
      { limit: 1 }
    )
    if (ledger.length === 0) {
      throw new ArchivableGuardError(
        'archive-requires-command',
        `'${target}' has no archive/restore execution for generation ${generation}; ` +
          'the archive flag is produced by the ArchiveObject / RestoreObject command only',
        tx._class
      )
    }
    const auditId = archiveAuditId(target, generation)
    const audit = await this.reader.findAll(ctx, activity.class.ActivityInfoMessage, { _id: auditId }, { limit: 1 })
    if (audit.length === 0) {
      throw new ArchivableGuardError(
        'archive-requires-command',
        `'${target}' carries no archive audit record at '${auditId}' for generation ${generation}`,
        tx._class
      )
    }
  }

  private isArchivableClass (_class: Ref<Class<Doc>>): boolean {
    return ARCHIVABLE_CLASSES.some((candidate) => this.isDerivedFrom(_class, candidate))
  }

  /**
   * ⚠️ `hasClass` FIRST. `Hierarchy.isDerived` walks an ancestor chain it looks
   * up in a `Map`, and an unknown classifier yields `undefined?.includes(...)
   * ?? false` — it returns `false` SILENTLY. Asking first turns a stale or
   * forged `objectClass` into a clean answer rather than a dependency on that
   * implementation detail, and it is what keeps this class usable against the
   * EMPTY hierarchy a unit test hands it.
   */
  private isDerivedFrom (_class: Ref<Class<Doc>>, ancestor: Ref<Class<Doc>>): boolean {
    const hierarchy = this.reader.hierarchy
    if (_class === undefined || hierarchy === undefined || !hierarchy.hasClass(_class)) {
      return false
    }
    return hierarchy.isDerived(_class, ancestor)
  }
}
