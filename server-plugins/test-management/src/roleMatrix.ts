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

import { type AccountUuid, type Permission, type Ref, type Role, type RolesAssignment } from '@hcengineering/core'

/**
 * @public
 */
export type TestAssetGuardReason = 'test-assets-readonly'

/**
 * QA-T019's ROLE half.
 *
 * ⚠️ `code` IS 403, NOT THE 400 `SnapshotGuardError` USES. The two refusals are
 * different answers: `SnapshotGuardError` means "this document is in a state
 * that forbids the edit, for everyone", this one means "this edit is fine, you
 * are not the one who may make it". Collapsing them would tell a Developer to
 * "send the case back to review" for an edit no review would ever let them
 * make.
 *
 * @public
 */
export class TestAssetPermissionError extends Error {
  readonly code = 403
  readonly reason: TestAssetGuardReason = 'test-assets-readonly'

  constructor (
    message: string,
    readonly txClass?: string
  ) {
    super(message)
    this.name = 'TestAssetPermissionError'
  }
}

/**
 * Fields on a test asset that the PLATFORM writes on behalf of any caller, and
 * which therefore must survive the role gate.
 *
 * 🔴 WHY A FIELD LIST RATHER THAN "REFUSE EVERY WRITE". `SnapshotGuardMiddleware`
 * sits BELOW `VersioningMiddleware` and BELOW `MarkDerivedEntryMiddleware`
 * (`server/server-pipeline/src/pipeline.ts`), so writes that no user authored
 * pass through it:
 *
 *  - `readonly` / `isLatest` — `VersioningMiddleware` demotes the previous
 *    version of a versioned doc (`foundations/server/packages/middleware/src/versioning.ts:137`);
 *  - `attachments` / `comments` — the collection counters an `Attachment` or a
 *    chunter `ChatMessage` bumps on its parent. The child document is NOT a
 *    test-management class, so this guard never sees its create; refusing only
 *    the counter would leave the parent's count permanently wrong, which is a
 *    corrupted document rather than an enforced rule.
 *
 * ⚠️ THAT MAKES "COMMENT ON A TEST CASE" AND "ATTACH A FILE TO ONE" REACHABLE
 * FOR A READ-ONLY ROLE, and it is deliberate: Technical Spec §6.1 grades those
 * columns by object, and commenting is the affordance §6.1 hands even `Sales`
 * on `Requirement`. Whether an attachment counts as content is governed where
 * the attachment itself is created, not here.
 *
 * ⚠️ NOT IN THE LIST, ON PURPOSE: `version` and `status`. Both move only
 * through `registerTestCaseEdit`, i.e. a human editing the case.
 *
 * @public
 */
export const TEST_ASSET_PLATFORM_MANAGED_FIELDS: readonly string[] = ['readonly', 'isLatest', 'attachments', 'comments']

/**
 * Every field name a `TxUpdateDoc.operations` object writes, plain and through
 * operators alike.
 *
 * 🔴 `$rename` CONTRIBUTES BOTH SIDES. Its shape is `{ $rename: { from: to } }`
 * — the source is emptied and the target is overwritten — so a walk that
 * collected only keys would report `{ $rename: { readonly: name } }` as
 * touching nothing but `readonly` and wave a rename INTO `name` through the
 * allowlist. `readTestCaseFieldWrite` in `approvedCase.ts` checks the same two
 * directions for the same reason.
 *
 * ⚠️ Only `$rename`'s values are treated as field names. Every other
 * operator's values are payloads, and comparing them against field names would
 * make `{ $set: { name: 'readonly' } }` look like a write to `readonly`.
 *
 * @public
 */
export function collectWrittenFields (ops: Record<string, any>): string[] {
  const fields = new Set<string>()
  for (const [key, value] of Object.entries(ops)) {
    if (!key.startsWith('$')) {
      fields.add(key)
      continue
    }
    if (value == null || typeof value !== 'object') {
      // An operator with a non-object payload writes nothing this walk can
      // name. Report it under its own key so it can never be mistaken for an
      // empty (and therefore allowed) update.
      fields.add(key)
      continue
    }
    for (const field of Object.keys(value as Record<string, unknown>)) {
      fields.add(field)
    }
    if (key === '$rename') {
      for (const target of Object.values(value as Record<string, unknown>)) {
        if (typeof target === 'string') {
          fields.add(target)
        }
      }
    }
  }
  return Array.from(fields)
}

/**
 * Whether this update writes NOTHING but {@link TEST_ASSET_PLATFORM_MANAGED_FIELDS}.
 *
 * ⚠️ A MIXED UPDATE IS NOT PLATFORM MANAGED. `{ name: 'x', readonly: true }`
 * fails here, so smuggling a content edit alongside a versioning field buys
 * nothing.
 *
 * @public
 */
export function isPlatformManagedTestAssetUpdate (ops: Record<string, any>): boolean {
  const fields = collectWrittenFields(ops)
  if (fields.length === 0) {
    // Writes no field at all. Refusing a no-op would only turn a harmless
    // client retry into an error.
    return true
  }
  return fields.every((field) => TEST_ASSET_PLATFORM_MANAGED_FIELDS.includes(field))
}

/**
 * Whether `account` holds `permission` in a space, given that space's role
 * assignment.
 *
 * 🔴 THIS IS `SpacePermissionsMiddleware.setPermissions` READ BACKWARDS, and it
 * has to be: that middleware computes the same map but keeps it private and
 * — decisively — only DENIES inside a `restricted` space
 * (`spacePermissions.ts:190`). A `TestProject` is not restricted, so its answer
 * for a caller with no permission is "allowed". The role matrix needs the
 * opposite default, so the lookup is redone here and the decision is made by
 * the caller.
 *
 * @public
 */
export function holdsSpacePermission (
  roles: Role[],
  assignment: RolesAssignment,
  permission: Ref<Permission>,
  account: AccountUuid
): boolean {
  for (const role of roles) {
    if (!(role.permissions ?? []).includes(permission)) continue
    const members = (assignment[role._id] ?? []) as AccountUuid[]
    if (members.includes(account)) {
      return true
    }
  }
  return false
}
