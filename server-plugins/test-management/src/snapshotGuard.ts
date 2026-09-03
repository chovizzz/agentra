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

import attachment, { type Attachment } from '@hcengineering/attachment'
import core, {
  AccountRole,
  TxProcessor,
  hasAccountRole,
  systemAccountUuid,
  type Class,
  type Doc,
  type MeasureContext,
  type Ref,
  type Role,
  type RolesAssignment,
  type SessionData,
  type Space,
  type SpaceType,
  type Tx,
  type TxApplyIf,
  type TxCreateDoc,
  type TxCUD,
  type TxMixin,
  type TxRemoveDoc,
  type TxUpdateDoc,
  type TypedSpace
} from '@hcengineering/core'
import {
  BaseMiddleware,
  type Middleware,
  type MiddlewareCreator,
  type PipelineContext,
  type TxMiddlewareResult
} from '@hcengineering/server-core'
import testManagement, { type TestCase, type TestCaseSnapshot, type TestProject } from '@hcengineering/test-management'

import { checkApprovedTestCaseUpdate, touchesFrozenTestCaseField } from './approvedCase'
import { TestAssetPermissionError, holdsSpacePermission, isPlatformManagedTestAssetUpdate } from './roleMatrix'

/**
 * The classes Technical Spec §6.1 calls `Test assets/results`.
 *
 * ⚠️ `TestProject` IS ABSENT ON PURPOSE. It is the SPACE, not an asset in it:
 * creating, renaming and archiving one is already governed by
 * `core.permission.UpdateSpace` / `ArchiveSpace` through
 * `SpacePermissionsMiddleware`, and duplicating that here would refuse the
 * membership edits an operator needs in order to grant the QA role in the
 * first place.
 *
 * Subclasses are covered: every membership test goes through `isDerived`.
 *
 * @public
 */
export const TEST_ASSET_CLASSES: readonly Ref<Class<Doc>>[] = [
  testManagement.class.TestSuite as Ref<Class<Doc>>,
  testManagement.class.TestCase as Ref<Class<Doc>>,
  testManagement.class.TestStep as Ref<Class<Doc>>,
  testManagement.class.TestCaseSnapshot as Ref<Class<Doc>>,
  testManagement.class.TestEnvironment as Ref<Class<Doc>>,
  testManagement.class.Build as Ref<Class<Doc>>,
  testManagement.class.TestRun as Ref<Class<Doc>>,
  testManagement.class.TestResult as Ref<Class<Doc>>,
  testManagement.class.TestPlan as Ref<Class<Doc>>,
  testManagement.class.TestPlanItem as Ref<Class<Doc>>
]

/**
 * Why refusals carry a machine readable reason: the two things this guard
 * protects fail for very different operator-visible causes, and "not allowed"
 * would tell a QA lead nothing about which one they hit.
 *
 * @public
 */
export type SnapshotGuardReason =
  | 'snapshot-immutable'
  | 'attachment-referenced'
  | 'snapshot-duplicate'
  | 'approved-case-readonly'

/**
 * @public
 */
export class SnapshotGuardError extends Error {
  readonly code = 400

  constructor (
    readonly reason: SnapshotGuardReason,
    message: string,
    readonly txClass?: string
  ) {
    super(message)
    this.name = 'SnapshotGuardError'
  }
}

/**
 * Server-side enforcement of `TestCaseSnapshot` immutability, plus the
 * reference check that keeps a snapshot's attachment bytes alive.
 *
 * 🔴 WHY A MIDDLEWARE AND NOT A TRIGGER. `TriggersMiddleware.processDerived`
 * runs AFTER the write has already landed and wraps every trigger in a
 * `try/catch` that only logs — a trigger can comment on a transaction, never
 * refuse one. `RatingMiddleware` and `LeadGuardMiddleware` are the in-tree
 * precedents for "check, then `throw`".
 *
 * 🔴 WHY SERVER SIDE AT ALL. The model ships no editor and no panel for a
 * snapshot, but that is a property of ONE client. `client.update`, a script, a
 * future viewlet or any API caller reaches the same document with no UI
 * involved. The pipeline is the only choke point all of them share, and a
 * snapshot that can drift is not a snapshot — every historical Test Run that
 * pinned it would silently start reporting today's expectations.
 *
 * ⚠️ REGISTRATION ORDER, in both directions:
 *   - AFTER `ApplyTxMiddleware`, so a `TxApplyIf` has already been unwrapped
 *     and its inner writes arrive as plain CUDs. (The walk below descends into
 *     `TxApplyIf.txes` anyway — that is a property of the pipeline list, not of
 *     this class, and the cost of being wrong is a silent bypass.)
 *   - BEFORE `TxMiddleware`, so a refused write never reaches the transaction
 *     domain and cannot be replayed out of it.
 *
 * 🔴 CASCADE DELETION MUST STILL WORK. `MarkDerivedEntryMiddleware` sets
 * `context.derived` to the chain immediately below itself, and this middleware
 * sits below that mark — so the collection-removal transactions that
 * `TriggersMiddleware` emits when a `TestCase` is deleted DO re-enter here. A
 * blanket "never remove a snapshot" would therefore make test cases
 * undeletable. {@link SnapshotGuardMiddleware.validateRemove} allows a removal
 * exactly when the owning test case is going away too — see its doc comment.
 *
 * @public
 */
export class SnapshotGuardMiddleware extends BaseMiddleware implements Middleware {
  private constructor (context: PipelineContext, next?: Middleware) {
    super(context, next)
  }

  static create: MiddlewareCreator = async (_ctx, context, next): Promise<Middleware> => {
    return new SnapshotGuardMiddleware(context, next)
  }

  async tx (ctx: MeasureContext, txes: Tx[]): Promise<TxMiddlewareResult> {
    await this.validate(ctx, txes)
    return await this.provideTx(ctx, txes)
  }

  private async validate (ctx: MeasureContext, txes: Tx[], depth: number = 0): Promise<void> {
    if (depth > 8) {
      throw new Error('test-management: refusing to validate a pathologically nested TxApplyIf')
    }
    // Collected ONCE per batch, before anything is judged: a cascade arrives as
    // "remove the case" plus "remove its snapshots" in the same array, and the
    // order within that array is not guaranteed.
    const removedCases = collectRemovedCases(this.context.hierarchy, txes)
    for (const tx of txes) {
      if (this.context.hierarchy.isDerived(tx._class, core.class.TxApplyIf)) {
        await this.validate(ctx, (tx as TxApplyIf).txes, depth + 1)
        continue
      }
      if (!TxProcessor.isExtendsCUD(tx._class)) {
        continue
      }
      await this.validateCUD(ctx, tx as TxCUD<Doc>, removedCases)
    }
  }

  private async validateCUD (ctx: MeasureContext, cud: TxCUD<Doc>, removedCases: Set<Ref<Doc>>): Promise<void> {
    // 🔴 IDENTITY BEFORE STATE. The role gate runs FIRST so that a Developer
    // aiming at an approved case is told they may not edit test assets, rather
    // than being told to "send it back to review" — advice that would be a
    // dead end, because reopening it would not make the edit legal either.
    // The two gates are an AND: passing this one still leaves every state
    // check below in force.
    await this.validateRoleMatrix(ctx, cud)
    await this.validateRolesAssignment(ctx, cud)

    if (this.isSnapshotClass(cud.objectClass)) {
      // A create is how a snapshot comes into existence; everything else is a
      // rewrite of history.
      if (cud._class === core.class.TxCreateDoc) {
        await this.validateCreate(ctx, cud as TxCreateDoc<TestCaseSnapshot>)
        return
      }
      if (cud._class === core.class.TxUpdateDoc || cud._class === core.class.TxMixin) {
        throw new SnapshotGuardError(
          'snapshot-immutable',
          `Test case snapshot '${cud.objectId}' is immutable and cannot be modified`,
          cud._class
        )
      }
      if (cud._class === core.class.TxRemoveDoc) {
        await this.validateRemove(ctx, cud as TxRemoveDoc<TestCaseSnapshot>, removedCases)
      }
      return
    }

    if (cud._class === core.class.TxUpdateDoc && this.isTestCaseClass(cud.objectClass)) {
      await this.validateTestCaseUpdate(ctx, cud as TxUpdateDoc<TestCase>)
      return
    }

    if (cud._class === core.class.TxRemoveDoc && this.isAttachmentClass(cud.objectClass)) {
      await this.validateAttachmentRemove(ctx, cud as TxRemoveDoc<Attachment>, removedCases)
    }
  }

  /**
   * QA-T019's ROLE half: only a caller who holds
   * `testManagement.permission.ManageTestAssets` in the target space may write
   * a test asset. Technical Spec §6.1 (`Test assets/results`): `CRUD` for QA
   * and Admin, read-only for Sales / Product / PM / Developer.
   *
   * 🔴 WHY THIS IS NOT `SpacePermissionsMiddleware`'S JOB. That middleware
   * knows the permission and computes the very same role map, but its default
   * is ALLOW: `checkPermission` falls through to `return true` for any space
   * not marked `restricted`
   * (`foundations/server/packages/middleware/src/spacePermissions.ts:190`), and
   * a `TestProject` is an ordinary space. Declaring the permission in the model
   * would therefore have changed nothing at all. The matrix needs DEFAULT DENY,
   * so the same lookup is redone here and inverted.
   *
   * 🔴 WHY NOT THE CLIENT. `EditTestCase.svelte` can grey out a field; the
   * import tool, a REST caller, a script and `client.update` reach the same
   * document with no panel in the way. This middleware is the choke point all
   * of them share — the same argument
   * {@link SnapshotGuardMiddleware.validateTestCaseUpdate} already makes.
   *
   * FOUR THINGS PASS WITHOUT A ROLE, and each is load bearing:
   *
   *  1. the system account — the migration/tool path, and the same escape
   *     `SpacePermissionsMiddleware.checkPermission` opens on its first line;
   *  2. an admin-mode session (`contextData.admin`);
   *  3. `AccountRole.Maintainer` and up — §6.1's `Admin: CRUD` column. It is a
   *     WORKSPACE role, not a space role, so it can never be expressed as a
   *     `Role` doc;
   *  4. an update writing only platform-managed fields — see
   *     {@link TEST_ASSET_PLATFORM_MANAGED_FIELDS}.
   *
   * ⚠️ `isTriggerCtx` IS DELIBERATELY NOT AN ESCAPE, even though derived
   * cascades re-enter this middleware. Two reasons. It is not reset once set
   * (`TriggersMiddleware.processDerived` flips it inside its `findAll` wrapper
   * and never clears it), so trusting it would widen with every trigger a
   * request happens to fire. And it is not needed: a cascade is authored by the
   * account whose parent write was already accepted, so it passes on that
   * account's own permission, while the collection counters a read-only member
   * legitimately moves are covered by the field allowlist instead.
   *
   * ⚠️ THE ONE PLACE THIS FAILS OPEN is `contextData === undefined`, i.e. no
   * session at all. Every pipeline entry point builds a `SessionData`; a
   * context without one is not a caller, and failing closed there would refuse
   * the in-process tool path that has no account to check.
   */
  /**
   * Who may change WHO HOLDS A ROLE on a test project.
   *
   * 🔴 WITHOUT THIS THE WHOLE ROLE MATRIX IS SELF-SERVICE.
   * `SpacePermissionsMiddleware` returns `true` unconditionally for a write
   * whose target IS a space
   * (`foundations/server/packages/middleware/src/spacePermissions.ts:201` —
   * `if (isSpace || !this.restrictedSpaces.has(space)) return true`), and a
   * `TestProject` is not a restricted space. So any member could write the
   * space type's `RolesAssignment` mixin, put their own account in the QA
   * role, and then pass {@link validateRoleMatrix} legitimately. Enforcing
   * read-only test assets while leaving the role list writable protects
   * nothing.
   *
   * ⚠️ `TestProject` is deliberately absent from {@link TEST_ASSET_CLASSES} —
   * guarding it there would refuse the very write that GRANTS the QA role, so
   * a project could never be staffed. This is the narrower rule that belongs
   * alongside it: not "who may edit the project", only "who may edit its
   * roles".
   *
   * ⚠️ Creating a project is NOT affected. `CreateProject.svelte` defaults
   * `owners` to `[getCurrentAccount().uuid]` (`:68-69`) and issues
   * `createDoc` before `createMixin`, so by the time the mixin arrives the
   * caller already owns the space this checks against.
   */
  private async validateRolesAssignment (ctx: MeasureContext, cud: TxCUD<Doc>): Promise<void> {
    if (!this.writesRolesAssignment(cud)) {
      return
    }
    const session = (ctx as MeasureContext<SessionData>).contextData
    if (session === undefined) {
      return
    }
    if (session.admin === true) {
      return
    }
    const account = session.account
    if (account === undefined) {
      throw new TestAssetPermissionError(
        `Role assignment on '${cud.objectId}' cannot be changed by an unidentified caller`,
        cud._class
      )
    }
    if (account.primarySocialId === core.account.System || account.uuid === systemAccountUuid) {
      return
    }
    if (hasAccountRole(account, AccountRole.Maintainer)) {
      return
    }
    const [space] = await this.provideFindAll<Space>(
      ctx,
      core.class.Space,
      { _id: cud.objectId as Ref<Space> },
      {
        limit: 1
      }
    )
    // ⚠️ A mixin aimed at a space that does not exist writes nothing: the
    // adapter's UPDATE matches no row. Refusing here would only break a client
    // that creates the project and stamps its roles in one batch, so the
    // absence is allowed rather than treated as suspicious.
    if (space === undefined) {
      return
    }
    if (space.owners?.includes(account.uuid) === true) {
      return
    }
    throw new TestAssetPermissionError(
      `Role assignment on test project '${cud.objectId}' may only be changed by an owner of that project`,
      cud._class
    )
  }

  /**
   * Whether this transaction reaches the space type's `RolesAssignment` mixin.
   *
   * Covers both shapes: a `TxMixin` naming the target class directly, and a
   * `TxUpdateDoc` writing the dotted `<mixinId>.<role>` keys that a mixin
   * attribute is actually stored under.
   */
  private writesRolesAssignment (cud: TxCUD<Doc>): boolean {
    if (!this.isDerivedFrom(cud.objectClass, testManagement.class.TestProject as Ref<Class<Doc>>)) {
      return false
    }
    const target = testManagement.mixin.DefaultProjectTypeData as unknown as Ref<Class<Doc>>
    if (cud._class === core.class.TxMixin) {
      return String((cud as TxMixin<Doc, Doc>).mixin) === String(target)
    }
    if (cud._class !== core.class.TxUpdateDoc) {
      return false
    }
    const ops = (cud as TxUpdateDoc<Doc>).operations as Record<string, any>
    if (ops == null || typeof ops !== 'object') {
      return false
    }
    const prefix = `${target}.`
    const names = (payload: unknown): string[] =>
      payload != null && typeof payload === 'object' ? Object.keys(payload as Record<string, unknown>) : []
    for (const [key, payload] of Object.entries(ops)) {
      const keys = key.startsWith('$') ? names(payload) : [key]
      if (keys.some((k) => k === target || k.startsWith(prefix))) {
        return true
      }
    }
    return false
  }

  private async validateRoleMatrix (ctx: MeasureContext, cud: TxCUD<Doc>): Promise<void> {
    if (!this.isTestAssetClass(cud.objectClass)) {
      return
    }
    const session = (ctx as MeasureContext<SessionData>).contextData
    if (session === undefined) {
      return
    }
    if (session.admin === true) {
      return
    }
    const account = session.account
    if (account === undefined) {
      // A session that carries no account cannot be shown to hold anything.
      throw new TestAssetPermissionError(
        `Test asset '${cud.objectId}' cannot be modified by an unidentified caller`,
        cud._class
      )
    }
    if (account.primarySocialId === core.account.System || account.uuid === systemAccountUuid) {
      return
    }
    if (hasAccountRole(account, AccountRole.Maintainer)) {
      return
    }
    // ⚠️ `TxMixin` IS CHECKED AGAINST THE SAME ALLOWLIST, not waved through and
    // not blanket-refused. `TriggersMiddleware.updateCollection` emits a
    // `TxMixin` instead of a `TxUpdateDoc` whenever the attached document's
    // `_class` is a mixin (`foundations/server/packages/middleware/src/triggers.ts:283`),
    // so a future mixin subclass of a test asset would have its collection
    // counter refused by a rule that only knew about `TxUpdateDoc`. The
    // allowlist is the same one, so this widens nothing a plain update could
    // not already do.
    if (this.isPlatformManagedWrite(cud)) {
      return
    }
    if (await this.hasManagePermission(ctx, session, cud.objectSpace)) {
      return
    }
    throw new TestAssetPermissionError(
      `Test asset '${cud.objectId}' is read-only for this role; 'Manage test assets' is required in space '${cud.objectSpace}'`,
      cud._class
    )
  }

  private isPlatformManagedWrite (cud: TxCUD<Doc>): boolean {
    if (cud._class === core.class.TxUpdateDoc) {
      return isPlatformManagedTestAssetUpdate((cud as TxUpdateDoc<Doc>).operations as Record<string, any>)
    }
    if (cud._class === core.class.TxMixin) {
      return isPlatformManagedTestAssetUpdate((cud as TxMixin<Doc, Doc>).attributes as Record<string, any>)
    }
    return false
  }

  /**
   * Whether the session's account holds `ManageTestAssets` in `spaceId`.
   *
   * ⚠️ THE SPACE IS READ THROUGH `provideFindAll`, i.e. AS THE CALLER. The
   * chain below this middleware still reaches the adapter's `addSecurity`,
   * which appends the space ACL for an ordinary session
   * (`foundations/server/packages/postgres/src/storage.ts:626`) — so a caller
   * who cannot see the space gets `undefined` here and is refused. That is the
   * correct answer for a WRITE gate, and it is the opposite of the branch
   * {@link SnapshotGuardMiddleware.validateRemove} takes, where "not visible"
   * must not turn a retry into an error.
   *
   * ⚠️ ROLES AND ASSIGNMENTS COME FROM `modelDb`, NOT FROM THE DATABASE.
   * `Role` and `SpaceType` live in `DOMAIN_MODEL`; the per-space assignment is
   * a mixin ON the space document, which is why the space itself is the only
   * thing that has to be fetched.
   *
   * The result is memoised in `contextData.contextCache`, which lives for one
   * request: a batch that writes twenty results reads the space once, and a
   * role revoked between requests is never served from a stale map.
   */
  private async hasManagePermission (ctx: MeasureContext, session: SessionData, spaceId: Ref<Space>): Promise<boolean> {
    const cacheKey = `test-management:manage-test-assets:${spaceId}:${session.account.uuid}`
    const cached = session.contextCache?.get(cacheKey)
    if (typeof cached === 'boolean') {
      return cached
    }
    const allowed = await this.resolveManagePermission(ctx, session, spaceId)
    session.contextCache?.set(cacheKey, allowed)
    return allowed
  }

  private async resolveManagePermission (
    ctx: MeasureContext,
    session: SessionData,
    spaceId: Ref<Space>
  ): Promise<boolean> {
    const [space] = await this.provideFindAll<Space>(ctx, core.class.Space, { _id: spaceId }, { limit: 1 })
    if (space === undefined) {
      return false
    }
    // 🔴 A SPACE OWNER MANAGES ITS ASSETS, role assignment or not. Without this
    // an owner who never gave themself the QA role can delete the project but
    // not its contents — and `TriggersMiddleware` runs the cascade AFTER the
    // space removal has already landed, so the failure mode is a deleted
    // project with its test cases still in the database. Owning the container
    // and being unable to empty it is not a permission model, it is a way to
    // strand data.
    if (space.owners?.includes(session.account.uuid) === true) {
      return true
    }
    const typeId = (space as TypedSpace).type
    if (typeId === undefined) {
      return false
    }
    const [spaceType] = this.context.modelDb.findAllSync(core.class.SpaceType, { _id: typeId })
    if (spaceType === undefined) {
      return false
    }
    const assignment = this.context.hierarchy.as(
      space,
      (spaceType as SpaceType).targetClass
    ) as unknown as RolesAssignment
    const roles = this.context.modelDb.findAllSync(core.class.Role, { attachedTo: spaceType._id }) as Role[]
    return holdsSpacePermission(roles, assignment, testManagement.permission.ManageTestAssets, session.account.uuid)
  }

  /**
   * QA-T019: an `Approved` test case is read-only.
   *
   * 🔴 WHY THE SERVER OWNS THIS. `EditTestCase.svelte` disables the controls,
   * and that is a property of ONE caller. The import tool, a REST client, a
   * migration script and any future viewlet reach the same document with no
   * panel in the way — and an approved case that can be rewritten silently is
   * exactly what the review ladder exists to prevent, because every Test Plan
   * and Test Run that pinned it was approved against different text.
   *
   * 🔴 WHY IT LIVES IN THIS MIDDLEWARE rather than a third one. Both
   * `test-management` guards are already registered in
   * `server/server-pipeline`; this one already owns the `TestCase` class checks
   * and already runs at the right two boundaries (after `ApplyTxMiddleware`, so
   * a `TxApplyIf` arrives unwrapped; before `TxMiddleware`, so a refusal never
   * reaches the transaction domain). A fourth registration would buy nothing
   * and change the pipeline file.
   *
   * ⚠️ `TxMixin` IS NOT CHECKED, and that is not a hole.
   * `TxProcessor.updateMixin4Doc` writes into `doc[tx.mixin]`, never into the
   * base document — so a mixin cannot reach `TestCase.name`. Refusing a mixin
   * attribute that merely SHARES a name with a frozen field would break
   * unrelated mixins for no gain.
   *
   * ⚠️ `TxRemoveDoc` is not checked either: deleting an approved case is a
   * different decision from editing one, its evidence is protected by
   * {@link SnapshotGuardMiddleware.validateRemove}, and QA-T019 is about
   * changing a case, not about retiring it.
   *
   * ⚠️ THREE RESIDUALS, recorded here rather than left to be rediscovered:
   *
   *  1. `description` is a `MarkupBlobRef`, and the prose behind it is edited
   *     through `collaborator`. That service DOES reach this guard — contrary
   *     to what this note used to claim: `saveDocumentToPlatform` ends in
   *     `client.diffUpdate(current, { [objectAttr]: blobId })`
   *     (`server/collaborator/src/storage/platform.ts:260`), which is a
   *     `TxUpdateDoc` naming `description`, so the ref is refused here like
   *     any other frozen field.
   *
   *     🔴 AND THE IDENTITY IS WHY THIS CHECK HAS NO SYSTEM ESCAPE.
   *     `simpleClientFactory` (`server/collaborator/src/platform.ts:71-76`)
   *     opens the platform connection with `generateToken(systemAccountUuid,
   *     ...)` while `getTxOperations` (`:43-53`) stamps `modifiedBy` from the
   *     ORIGINAL user's token. So a person's edit arrives with
   *     `SessionData.account.uuid === systemAccountUuid`, and the system
   *     escapes that {@link validateRoleMatrix} and
   *     {@link validateRolesAssignment} legitimately need would wave it
   *     straight through. Do not add one here "for symmetry".
   *
   *     ⚠️ THE COLLABORATIVE COPY IS RECONCILED ELSEWHERE, not here.
   *     `saveDocument` persists the ydoc to collaborator's OWN storage before
   *     it attempts the platform write, and `loadDocument` prefers that ydoc
   *     over the blob ref, so a refusal used to leave only the DOCUMENT frozen
   *     — `description` keeps pointing at the old blob, and every Test Plan and
   *     Test Run that pinned it still resolves the approved text — while the
   *     collaborative editor kept serving the rejected edit to whoever had the
   *     panel open. `server/collaborator` now closes that itself: the refusal
   *     below comes back over the transactor socket as a `PlatformError`,
   *     `isPlatformRejection` (`server/collaborator/src/storage/errors.ts`)
   *     classifies it, and `StorageExtension.revertDocument`
   *     (`server/collaborator/src/extensions/storage.ts`) puts the ydoc and the
   *     live editors back to the last content the platform accepted. That
   *     mechanism keys off the refusal, not off this class — nothing there
   *     knows what a `TestCase` is, and nothing needs to be registered here.
   *  2. a batch that CREATES an approved case and then updates it slips through
   *     the `current === undefined` branch. Not an escalation — the creator
   *     could have written the final content into the create — and closing it
   *     would break the legitimate create-then-update batch that branch exists
   *     for.
   *  3. `undefined` from `provideFindAll` can in principle mean "invisible to
   *     this caller" rather than "absent". `SpaceSecurityMiddleware` sits ABOVE
   *     this guard, so a caller who cannot read the space cannot land a write
   *     in it this far — the same argument
   *     {@link SnapshotGuardMiddleware.validateRemove} already relies on.
   */
  private async validateTestCaseUpdate (ctx: MeasureContext, tx: TxUpdateDoc<TestCase>): Promise<void> {
    const ops = tx.operations as Record<string, any>
    // The cheap gate: a transaction naming none of the frozen fields never
    // loads the document. That is the path `VersioningMiddleware`'s
    // `readonly` / `isLatest` writes, the `version` bump and every collection
    // counter take.
    if (!touchesFrozenTestCaseField(ops)) {
      return
    }
    const [current] = await this.provideFindAll<TestCase>(ctx, tx.objectClass, { _id: tx.objectId }, { limit: 1 })
    if (current === undefined) {
      // Nothing to protect: an update addressed at an absent `_id` writes no
      // row, and refusing would be a false negative for the legitimate
      // create-then-update batch whose create has not landed yet.
      return
    }
    const violation = checkApprovedTestCaseUpdate(current, ops)
    if (violation === undefined) {
      return
    }
    const how = violation.operator !== undefined ? ` via '${violation.operator}'` : ''
    throw new SnapshotGuardError(
      'approved-case-readonly',
      `'${violation.field}' cannot be changed${how} on approved test case '${tx.objectId}'; send it back to review first`,
      tx._class
    )
  }

  /**
   * Refuse a SECOND snapshot for a `(test case, version)` pair.
   *
   * 🔴 WITHOUT THIS, "immutable" is only half true. Nothing can edit an
   * existing snapshot, but a plain `createDoc` at the same pair adds a rival
   * document — and readers resolve the pair with `findAll(..., { limit: 1 })`,
   * so which one they get is adapter order, not intent. The audit trail would
   * drift without a single byte of an existing snapshot ever changing.
   *
   * ⚠️ This never fires on the legitimate path. `ensureTestCaseSnapshot` wraps
   * its create in `apply().notMatch(TestCaseSnapshot, { attachedTo, version })`,
   * and `ApplyTxMiddleware` evaluates that precondition ABOVE this middleware —
   * a losing race is reported as `success: false` and its inner create is never
   * forwarded here at all.
   */
  private async validateCreate (ctx: MeasureContext, tx: TxCreateDoc<TestCaseSnapshot>): Promise<void> {
    const attributes = tx.attributes as Partial<TestCaseSnapshot>
    const attachedTo = attributes?.attachedTo ?? (tx.attachedTo as Ref<TestCase> | undefined)
    const version = attributes?.version
    if (attachedTo === undefined || version === undefined) {
      return
    }
    const existing = await this.provideFindAll<TestCaseSnapshot>(
      ctx,
      testManagement.class.TestCaseSnapshot,
      { attachedTo, version },
      { limit: 1 }
    )
    if (existing.length === 0) {
      return
    }
    throw new SnapshotGuardError(
      'snapshot-duplicate',
      `Test case '${attachedTo}' already has a snapshot for version ${version}`,
      tx._class
    )
  }

  /**
   * A snapshot may only disappear together with the test case that owns it.
   *
   * The two accepted shapes are the two ways that legitimately happens:
   *
   *  1. the owning `TestCase` is removed in the SAME batch — the client-side
   *     cascade;
   *  2. the owning `TestCase` is already gone — the derived cascade
   *     `TriggersMiddleware` emits after the parent removal has landed.
   *
   * Anything else is someone deleting evidence out from under a historical
   * Test Run, and is refused.
   */
  private async validateRemove (
    ctx: MeasureContext,
    tx: TxRemoveDoc<TestCaseSnapshot>,
    removedCases: Set<Ref<Doc>>
  ): Promise<void> {
    const [snapshot] = await this.provideFindAll<TestCaseSnapshot>(
      ctx,
      tx.objectClass,
      { _id: tx.objectId },
      { limit: 1 }
    )
    if (snapshot === undefined) {
      // Nothing to protect: the row is not there. Refusing would turn a
      // harmless retry into an error.
      return
    }
    if (removedCases.has(snapshot.attachedTo)) {
      return
    }
    // ⚠️ `provideFindAll` descends BELOW this middleware, i.e. below
    // SpaceSecurity / Private / FindSecurity — but NOT below the adapter's own
    // `addSecurity`, which still appends the space ACL for an ordinary session.
    // So "owner not found" can in principle mean "invisible to this caller"
    // rather than "gone", and that branch ALLOWS the removal. It is not a hole:
    // SpaceSecurityMiddleware sits ABOVE this guard, so a caller who cannot
    // read the space cannot get a write into it this far in the first place.
    const [owner] = await this.provideFindAll<TestCase>(
      ctx,
      testManagement.class.TestCase,
      { _id: snapshot.attachedTo },
      { limit: 1 }
    )
    if (owner === undefined) {
      return
    }
    throw new SnapshotGuardError(
      'snapshot-immutable',
      `Test case snapshot '${tx.objectId}' (v${snapshot.version}) is immutable and cannot be deleted while test case '${snapshot.attachedTo}' exists`,
      tx._class
    )
  }

  /**
   * Refuse to delete an attachment whose bytes a snapshot still points at.
   *
   * 🔴 WHY THIS IS NOT OPTIONAL. A snapshot stores attachment METADATA plus the
   * blob id; it never copies the bytes. `card` shares blobs the same way and
   * its `OnAttachmentDelete` carries NO reference counting, so the sharing is
   * already known to be breakable in-tree. Here the consequence is worse than a
   * broken thumbnail: the snapshot is the evidence a historical Test Run was
   * judged against.
   *
   * The lookup is scoped rather than global — an `Attachment` on a test case is
   * `attachedTo` that case, so only that case's snapshots can possibly cite it.
   */
  private async validateAttachmentRemove (
    ctx: MeasureContext,
    tx: TxRemoveDoc<Attachment>,
    removedCases: Set<Ref<Doc>>
  ): Promise<void> {
    const [doc] = await this.provideFindAll<Attachment>(ctx, tx.objectClass, { _id: tx.objectId }, { limit: 1 })
    if (doc === undefined) {
      return
    }
    if (!this.isTestCaseClass(doc.attachedToClass)) {
      return
    }

    // 🔴 SCOPED TO THE SPACE, NOT TO THE OWNING TEST CASE. Snapshots store a
    // blob id, and the same blob CAN be cited by a snapshot of a different
    // case — nothing forces one attachment per blob. A lookup narrowed to
    // `attachedTo: doc.attachedTo` would miss exactly that, and
    // `server-plugins/attachment-resources`' `OnAttachmentDelete` then removes
    // the blob unconditionally, leaving the other case's snapshot pointing at
    // bytes that no longer exist.
    //
    // ⚠️ Residual: a snapshot in ANOTHER project space is still not seen. That
    // is deliberate — a repo-wide scan on every attachment delete is not worth
    // paying for a case that requires hand-crafted cross-project blob reuse —
    // and it is recorded here rather than left to be rediscovered.
    const snapshots = await this.provideFindAll<TestCaseSnapshot>(
      ctx,
      testManagement.class.TestCaseSnapshot,
      { space: doc.space as Ref<TestProject> },
      { projection: { _id: 1, attachedTo: 1, attachmentsMeta: 1 } }
    )
    const citing = snapshots.filter((snapshot) =>
      (snapshot.attachmentsMeta ?? []).some((meta) => meta.file === doc.file)
    )
    if (citing.length === 0) {
      return
    }

    // Two kinds of citation do not count, and BOTH are needed for cascade
    // deletion to keep working:
    //
    //  1. the citing snapshot's test case is going away in this same batch;
    //  2. the citing snapshot's test case is ALREADY gone — the derived
    //     cascade removes the case first and then works through its children,
    //     and nothing guarantees the snapshots are reached before the
    //     attachments. Without this, deleting a test case would deadlock on
    //     its own evidence.
    const owners = Array.from(new Set(citing.map((snapshot) => snapshot.attachedTo)))
    const alive = await this.provideFindAll<TestCase>(
      ctx,
      testManagement.class.TestCase,
      { _id: { $in: owners } },
      { projection: { _id: 1 } }
    )
    const aliveIds = new Set<Ref<Doc>>(alive.map((owner) => owner._id))
    const survivors = citing.filter(
      (snapshot) => !removedCases.has(snapshot.attachedTo) && aliveIds.has(snapshot.attachedTo)
    )
    if (survivors.length === 0) {
      return
    }
    throw new SnapshotGuardError(
      'attachment-referenced',
      `Attachment '${doc.name}' is referenced by ${survivors.length} test case snapshot(s) and cannot be deleted`,
      tx._class
    )
  }

  private isSnapshotClass (_class: Ref<Class<Doc>>): boolean {
    return this.isDerivedFrom(_class, testManagement.class.TestCaseSnapshot as Ref<Class<Doc>>)
  }

  private isTestCaseClass (_class: Ref<Class<Doc>>): boolean {
    return this.isDerivedFrom(_class, testManagement.class.TestCase as Ref<Class<Doc>>)
  }

  private isAttachmentClass (_class: Ref<Class<Doc>>): boolean {
    return this.isDerivedFrom(_class, attachment.class.Attachment as Ref<Class<Doc>>)
  }

  private isTestAssetClass (_class: Ref<Class<Doc>>): boolean {
    return TEST_ASSET_CLASSES.some((asset) => this.isDerivedFrom(_class, asset))
  }

  /**
   * An unknown classifier makes `isDerived` walk an empty ancestor chain; ask
   * `hasClass` first so a stale or forged `objectClass` is a clean `false`
   * rather than a dependency on that implementation detail.
   */
  private isDerivedFrom (_class: Ref<Class<Doc>>, ancestor: Ref<Class<Doc>>): boolean {
    const hierarchy = this.context.hierarchy
    if (_class === undefined || !hierarchy.hasClass(_class)) {
      return false
    }
    return hierarchy.isDerived(_class, ancestor)
  }
}

/**
 * Every `TestCase` this batch removes, including the ones nested inside a
 * `TxApplyIf`.
 *
 * @public
 */
export function collectRemovedCases (
  hierarchy: { hasClass: (_class: Ref<Class<Doc>>) => boolean, isDerived: (a: any, b: any) => boolean },
  txes: Tx[],
  acc = new Set<Ref<Doc>>(),
  depth: number = 0
): Set<Ref<Doc>> {
  if (depth > 8) {
    return acc
  }
  for (const tx of txes) {
    if (hierarchy.isDerived(tx._class, core.class.TxApplyIf)) {
      collectRemovedCases(hierarchy, (tx as TxApplyIf).txes, acc, depth + 1)
      continue
    }
    if (tx._class !== core.class.TxRemoveDoc) {
      continue
    }
    const cud = tx as TxCUD<Doc>
    if (!hierarchy.hasClass(cud.objectClass)) {
      continue
    }
    if (hierarchy.isDerived(cud.objectClass, testManagement.class.TestCase as Ref<Class<Doc>>)) {
      acc.add(cud.objectId)
    }
  }
  return acc
}
