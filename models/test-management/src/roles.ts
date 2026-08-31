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

import type { Permission, Ref, Role } from '@hcengineering/core'

import testManagement from './plugin'

/**
 * The `TestProject` space roles, one per column of Technical Spec §6.1 that can
 * hold a seat in a test project.
 *
 * 🔴 ONLY QA CARRIES THE WRITE GRANT, and the other four are deliberately
 * empty rather than omitted. §6.1's `Test assets/results` row reads
 * `Sales: Read summary | Product: Read | PM: Read | Developer: Read/Create
 * defect | QA: CRUD | Admin: CRUD` — four different labels that all mean "not
 * write" HERE, and differ only in columns other modules own. Naming them
 * anyway is what lets an operator seat a PM in a test project without that
 * silently meaning "no role, no permission, and no record of intent".
 *
 * ⚠️ `Admin` IS NOT IN THIS LIST. It is a workspace-level `AccountRole`
 * (`AccountRole.Maintainer` and up), not a space role, and it is honoured by
 * `SnapshotGuardMiddleware` through `hasAccountRole`, not through a `Role` doc.
 *
 * ⚠️ `Read summary` (Sales) is a READ-side narrowing this file cannot express:
 * `Permission` gates transactions, not projections. It is recorded in
 * Technical Spec §6.1 and stays a UI/query concern.
 *
 * @public
 */
export const roles: Array<{ _id: Ref<Role>, name: string, permissions: Array<Ref<Permission>> }> = [
  {
    _id: testManagement.role.QA,
    name: 'QA',
    permissions: [testManagement.permission.ManageTestAssets]
  },
  {
    _id: testManagement.role.Developer,
    name: 'Developer',
    permissions: []
  },
  {
    _id: testManagement.role.ProjectManager,
    name: 'Project Manager',
    permissions: []
  },
  {
    _id: testManagement.role.Product,
    name: 'Product',
    permissions: []
  },
  {
    _id: testManagement.role.Sales,
    name: 'Sales',
    permissions: []
  }
]
