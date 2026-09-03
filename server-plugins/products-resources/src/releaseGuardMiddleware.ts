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
import core, {
  TxProcessor,
  type Class,
  type Doc,
  type MeasureContext,
  type Ref,
  type Tx,
  type TxApplyIf,
  type TxCreateDoc,
  type TxCUD,
  type TxMixin,
  type TxUpdateDoc
} from '@hcengineering/core'
import products, { type ProductVersion } from '@hcengineering/products'
import serverAgentraCore, { commandExecutionId } from '@hcengineering/server-agentra-core'
import { auditRecordId, RELEASE_PRODUCT_VERSION_LOCK } from '@hcengineering/server-agentra-core-resources'
import {
  BaseMiddleware,
  type Middleware,
  type MiddlewareCreator,
  type PipelineContext,
  type TxMiddlewareResult
} from '@hcengineering/server-core'
import {
  checkProductVersionCreate,
  ProductReleaseGuardError,
  readFieldWrite,
  readProductVersionStateIntent,
  refuseRelease,
  type ProductReleaseGuardVerdict,
  type ProductVersionStateIntent
} from '@hcengineering/server-products'

/**
 * Server-side enforcement of "a product version becomes `Released` only by
 * running `ReleaseProductVersion`" (PRD REL-003, Technical Spec §3.6).
 *
 * 🔴 WHY A MIDDLEWARE AND NOT A TRIGGER. `TriggersMiddleware.processDerived`
 * runs AFTER `provideTx` — the write has already landed by then — and it wraps
 * every trigger call in a `try/catch` that only calls `ctx.error`. A trigger
 * therefore cannot refuse a transaction; it can only comment on one that
 * already happened, and "the version is released and an error was logged" is
 * not a gate. `RatingMiddleware`, `CommandMiddleware`, `LeadGuardMiddleware`
 * and `SnapshotGuardMiddleware` are the in-tree precedents for "check, then
 * `throw`".
 *
 * 🔴 WHY SERVER SIDE AT ALL — the client-side half is already in place and is
 * still not a boundary. `CreateProductVersion.svelte` now freezes a forked
 * parent with `parentStateOnChildVersion` (`Archived`) instead of `Released`,
 * `userSelectableProductVersionStates` keeps `Released` out of
 * `ProductVersionStateEditor`'s dropdown, and `models/products` marks the
 * attribute `@ReadOnly()`. All three are properties of ONE client:
 * `@ReadOnly()` is consumed by the attribute editors, so a hand-written
 * `TxUpdateDoc` from a script, the REST surface, the import tool or any future
 * viewlet reaches `state` with none of them involved. The pipeline is the only
 * choke point every writer shares.
 *
 * ⚠️ REGISTRATION ORDER MATTERS, in both directions:
 *   - AFTER `ApplyTxMiddleware`, which unwraps `TxApplyIf` and forwards
 *     `applyIf.txes` through `provideTx`, so the release command's own
 *     compare-and-swap write arrives here as a plain `TxUpdateDoc`. (The walk
 *     below descends into `TxApplyIf.txes` anyway — that is a property of the
 *     pipeline LIST, not of this class, and the cost of being wrong is a bypass
 *     that looks like nothing at all.)
 *   - BEFORE `TxMiddleware`, so a refused write never reaches the transaction
 *     domain and cannot be replayed out of it.
 *
 * ℹ️ The release command writes through `context.head`, i.e. re-enters the
 * whole chain from the top, so its own writes DO pass through here and must be
 * accepted on their merits — see {@link ProductVersionReleaseGuardMiddleware.enforceReleaseEvidence}.
 *
 * 🔴 WHAT THIS DOES NOT COVER, STATED SO NOBODY ASSUMES OTHERWISE.
 * `createBackupPipeline` builds a chain of `LowLevelMiddleware`,
 * `DomainFindMiddleware`, `ModelMiddleware` and `DBAdapterMiddleware` ONLY —
 * this guard is not in it. So workspace restore (`BackupClientOps.upload`) and
 * every `MigrationClient` write (`update` -> `rawUpdate`, `create` -> `upload`)
 * reach the domain table directly and could set `state` to anything, ledger
 * rows and audit records included. That is a property of every tx-pipeline
 * guard in this tree (`LeadGuardMiddleware` and `SnapshotGuardMiddleware`
 * share it), and it is the intended trust boundary: those callers are operators
 * running server-side tooling, not sessions. It is NOT a hole a client can
 * reach. `models/products`'s only migration writes `patch` and never `state`.
 *
 * ⚠️ `TxRemoveDoc` is deliberately not guarded here. Deleting a released
 * version is a retention question, not a release-gate one — and the bypass it
 * would otherwise enable (delete, then re-create at the same `_id` on the dead
 * version's surviving evidence) is closed at the CREATE end instead, by
 * {@link checkProductVersionCreate}, which never accepts `Released` at all.
 *
 * @public
 */
export class ProductVersionReleaseGuardMiddleware extends BaseMiddleware implements Middleware {
  private constructor (context: PipelineContext, next?: Middleware) {
    super(context, next)
  }

  static create: MiddlewareCreator = async (_ctx, context, next): Promise<Middleware> => {
    return new ProductVersionReleaseGuardMiddleware(context, next)
  }

  async tx (ctx: MeasureContext, txes: Tx[]): Promise<TxMiddlewareResult> {
    await this.validate(ctx, txes)
    return await this.provideTx(ctx, txes)
  }

  private async validate (ctx: MeasureContext, txes: Tx[], depth: number = 0): Promise<void> {
    if (depth > 8) {
      // A cycle is not constructible through the wire format, but a bounded
      // walk is cheaper than trusting that.
      throw new Error('products: refusing to validate a pathologically nested TxApplyIf')
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
    if (cud._class === core.class.TxCreateDoc) {
      if (!this.isProductVersionClass(cud.objectClass)) return
      await this.validateCreate(ctx, cud as TxCreateDoc<ProductVersion>)
      return
    }
    if (cud._class === core.class.TxUpdateDoc) {
      if (!this.isProductVersionClass(cud.objectClass)) return
      await this.validateUpdate(ctx, cud as TxUpdateDoc<ProductVersion>)
      return
    }
    if (cud._class === core.class.TxMixin) {
      // A mixin may redeclare `state` in its OWN attribute namespace, and it
      // only becomes `ProductVersion.state` when the MIXIN itself descends from
      // ProductVersion. A mixin hung on an unrelated class writes elsewhere.
      const mixin = cud as TxMixin<Doc, Doc>
      if (!this.isProductVersionClass(mixin.mixin as Ref<Class<Doc>>)) return
      await this.validateMixin(ctx, mixin)
    }
  }

  /**
   * A create into `Released` is refused OUTRIGHT — it never even looks for
   * evidence. See {@link checkProductVersionCreate} for why: the evidence is
   * keyed on the version id and OUTLIVES the version, so "delete a released
   * version, re-create a document at the same `_id` as `Released`" would
   * otherwise pass on a previous release's paperwork.
   */
  private async validateCreate (ctx: MeasureContext, tx: TxCreateDoc<ProductVersion>): Promise<void> {
    const attributes = (tx.attributes ?? {}) as Record<string, any>
    await this.applyIntent(checkProductVersionCreate(attributes), tx, async () => {
      // Unreachable: `checkProductVersionCreate` turns `needs-command` into a
      // refusal. Kept so the shape cannot silently become a no-op if it changes.
      await this.enforceReleaseEvidence(ctx, tx.objectId, tx)
    })
  }

  private async validateUpdate (ctx: MeasureContext, tx: TxUpdateDoc<ProductVersion>): Promise<void> {
    const ops = tx.operations as Record<string, any>
    // 🔴 THE CHEAP PRE-GATE. A tx that does not mention `state` returns here
    // WITHOUT READING THE DOCUMENT, which is what keeps the platform's own
    // high-frequency writers free: `VersioningMiddleware`'s `readonly` /
    // `isLatest` stamps, `migratePatchVersion`'s `patch` backfill, and every
    // ordinary edit of `name` / `description` / `codename`.
    if (readFieldWrite(ops, 'state').kind === 'untouched') return

    await this.applyIntent(readProductVersionStateIntent(ops), tx, async () => {
      await this.enforceReleaseEvidence(ctx, tx.objectId, tx)
    })
  }

  /**
   * ⚠️ `attrs` IS PASSED WHOLE, not narrowed to `attrs.state`.
   * `TxProcessor.updateMixin4Doc` applies mixin attributes with the SAME
   * per-key rule as `applyUpdate` — a `$`-prefixed key is an operator, anything
   * else is a plain set — so a mixin payload can carry `$inc: { state: 1 }`
   * exactly like an update can, and `readFieldWrite` has to see it.
   */
  private async validateMixin (ctx: MeasureContext, tx: TxMixin<Doc, Doc>): Promise<void> {
    const attrs = tx.attributes as Record<string, any>
    if (attrs == null || readFieldWrite(attrs, 'state').kind === 'untouched') return
    await this.applyIntent(readProductVersionStateIntent(attrs), tx, async () => {
      await this.enforceReleaseEvidence(ctx, tx.objectId as Ref<ProductVersion>, tx)
    })
  }

  private async applyIntent (
    intent: ProductVersionStateIntent,
    tx: Tx,
    onNeedsCommand: () => Promise<void>
  ): Promise<void> {
    switch (intent.kind) {
      case 'untouched':
      case 'allowed':
        // 🔴 THE ESCAPE HATCH, and it is the whole reason this is a value check
        // rather than a freeze. Every non-`Released` state passes untouched, so
        // `Released -> Archived` (a version superseded by its successor),
        // `Planning -> Active`, `Active -> ReleaseCandidate` and a rollback out
        // of `ReleaseCandidate` all keep working. This guard owns ONE
        // transition; `RELEASABLE_FROM`, inside the command, owns the rest.
        return
      case 'refused':
        this.enforce(intent.verdict, tx)
        return
      case 'needs-command':
        await onNeedsCommand()
    }
  }

  /**
   * The `Released` gate. Two facts must hold, and the FIRST is the one a client
   * cannot manufacture.
   *
   * 1. an idempotency-ledger row exists at
   *    `commandExecutionId(RELEASE_PRODUCT_VERSION_LOCK, versionId)`.
   *
   *    🔴 THIS IS THE UNFORGEABLE ANCHOR, AND THE INNER CLAIM IS THE ONLY ONE
   *    THAT CAN BE. `releaseProductVersion` takes two claims. The OUTER one is
   *    keyed `(releaseCommandNamespace(version), idempotencyKey)` and
   *    `idempotencyKey` is CALLER SUPPLIED — the guard holds a transaction, not
   *    a request, and cannot recompute a key it never saw, so that row is not
   *    addressable from here at all. The INNER claim is
   *    `(RELEASE_PRODUCT_VERSION_LOCK, versionId)`: both halves are constants
   *    of this codebase plus the id already named by the transaction, so the
   *    guard derives the same `_id` the command did.
   *
   *    Unforgeable because `CommandMiddleware.tx` throws on ANY CUD whose
   *    `objectClass` is `CommandExecution`, and it writes the ledger through
   *    `provideTx` — i.e. BELOW itself — so no transaction entering the
   *    pipeline can create that row. `commandExecutionId` is a SHA-256 prefix,
   *    so the id cannot be guessed into existence either. A row there proves
   *    `ReleaseProductVersion` really ran FOR THIS VERSION.
   *
   * 2. the release audit record exists at `auditRecordId(versionId)` — the
   *    `ActivityInfoMessage` carrying the gate report, the approval and any
   *    REL-006 waiver.
   *
   *    Forgeable in isolation: nothing vetoes writing an `ActivityInfoMessage`
   *    at a chosen `_id`, which is exactly why it is not the anchor. What it
   *    adds is that the command did not merely CLAIM the version but got past
   *    its gate evaluation and wrote the record — closing the window in which
   *    an attempt that claimed the ledger row and then failed (or was refused
   *    by the gate) would leave the anchor behind. Note the gate is evaluated
   *    BEFORE the record is written and a failed gate throws, so the record's
   *    existence is itself a statement that the gate passed.
   *
   * ⚠️ ORDERING INSIDE `runRelease` IS WHAT MAKES THE GENUINE PATH PASS: the
   * inner ledger row is claimed before the body runs (`CommandMiddleware.claim`
   * precedes `execute`), the audit record is Step 2, and the `state` write is
   * Step 5. Both facts hold by the time this guard sees that write.
   *
   * 🔴 `provideFindAll` descends BELOW this middleware and therefore below
   * `SpaceSecurityMiddleware` / `PrivateMiddleware` / `FindSecurityMiddleware`
   * — the same property `CommandMiddleware.findExecution` relies on. A guard
   * that could only see what the CALLER may read would approve a write
   * precisely when the caller cannot see the evidence against it. Nothing read
   * here is echoed to the client; only its existence changes the verdict, and
   * failing closed means the narrower read can only ever cost a false REFUSAL.
   */
  private async enforceReleaseEvidence (ctx: MeasureContext, version: Ref<ProductVersion>, tx: Tx): Promise<void> {
    const ledgerId = commandExecutionId(RELEASE_PRODUCT_VERSION_LOCK, version)
    const ledger = await this.provideFindAll(
      ctx,
      serverAgentraCore.class.CommandExecution,
      { _id: ledgerId },
      { limit: 1 }
    )
    if (ledger.length === 0) {
      this.enforce(
        refuseRelease(
          'release-requires-command',
          `Product version '${version}' has no ReleaseProductVersion execution; ` +
            "'Released' is produced by the release command only"
        ),
        tx
      )
    }

    const auditId = auditRecordId(version)
    const audit = await this.provideFindAll(ctx, activity.class.ActivityInfoMessage, { _id: auditId }, { limit: 1 })
    if (audit.length === 0) {
      this.enforce(
        refuseRelease(
          'release-requires-command',
          `Product version '${version}' carries no release audit record at '${auditId}'`
        ),
        tx
      )
    }
  }

  private isProductVersionClass (_class: Ref<Class<Doc>>): boolean {
    const hierarchy = this.context.hierarchy
    // An unknown classifier makes `isDerived` walk an empty ancestor chain and
    // return `false` SILENTLY; ask first, so a stale or forged `objectClass` is
    // a clean answer rather than a dependency on that implementation detail.
    if (!hierarchy.hasClass(_class)) {
      return false
    }
    return hierarchy.isDerived(_class, products.class.ProductVersion as Ref<Class<Doc>>)
  }

  /**
   * 🔴 THROW, do not return. `Middleware.tx` has no "rejected" channel: the
   * only way to stop `provideTx` from being reached is an exception, which
   * `ClientSession` turns into an error reply for the calling client. Anything
   * softer — logging, dropping the tx from the batch — would report success for
   * a write that did not happen.
   */
  private enforce (verdict: ProductReleaseGuardVerdict, tx: Tx): void {
    if (verdict.ok) return
    throw new ProductReleaseGuardError(verdict.reason, verdict.message, tx._class)
  }
}
