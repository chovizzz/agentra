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

import core from '@hcengineering/core'
import type { Builder } from '@hcengineering/model'

import testManagement from './plugin'

/**
 * The one capability the Agentra role matrix draws on test assets.
 *
 * Technical Spec §6.1 gives a single cell per role for `Test assets/results`:
 * `CRUD` for QA and Admin, read-only (plus "create defect", which lands in
 * tracker, not here) for Sales / Product / PM / Developer. One permission is
 * therefore the whole column — splitting it into "author cases" and "record
 * results" would be a role model the spec does not define.
 *
 * ⚠️ THIS PERMISSION IS A GRANT, NOT A `forbid`. `SpacePermissionsMiddleware`
 * only default-denies inside a space marked `restricted`; on an ordinary
 * `TestProject` a caller who holds NO permission is waved through by
 * `checkPermission`'s `!this.restrictedSpaces.has(space)` branch
 * (`foundations/server/packages/middleware/src/spacePermissions.ts:190`). So
 * the model declaring the permission is only half the mechanism — the write
 * gate that reads it is `SnapshotGuardMiddleware`, which default-denies.
 *
 * @public
 */
export function definePermissions (builder: Builder): void {
  builder.createDoc(
    core.class.Permission,
    core.space.Model,
    {
      label: testManagement.string.ManageTestAssetsPermission,
      description: testManagement.string.ManageTestAssetsDescription,
      scope: 'space'
    },
    testManagement.permission.ManageTestAssets
  )
}
