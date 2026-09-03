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

import type { Plugin } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'

export * from './approvedCase'
export * from './blockedGuard'
export * from './roleMatrix'
export * from './snapshotGuard'

/**
 * @public
 */
export const serverTestManagementId = 'server-test-management' as Plugin

/**
 * Server side descriptor for Test Management.
 *
 * ⚠️ It declares no ids and has no `-resources` companion, because this package
 * contributes exactly one thing: a pipeline middleware, imported directly by
 * `server/server-pipeline`. The `addLocation` / `models/server-*` scaffolding
 * exists so a MODEL can name a server `Resource` and have it resolved lazily;
 * with no such resource it would be three packages of indirection resolving to
 * `{}`. `server-plugins/rating` and `server-plugins/crm-lite` are the in-tree
 * precedents and are registered the same way — one `rush.json` entry, one
 * dependency in `server-pipeline`, one line in `createServerPipeline`.
 *
 * @public
 */
export default plugin(serverTestManagementId, {})
