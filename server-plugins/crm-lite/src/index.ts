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

export * from './guestScope'
export * from './intake'
export * from './leadGuard'

/**
 * @public
 */
export const serverCrmLiteId = 'server-crm-lite' as Plugin

/**
 * Server side descriptor for CRM Lite.
 *
 * ⚠️ It declares no ids and there is no `-resources` companion, because this
 * package contributes exactly one thing: a pipeline middleware, which
 * `server/server-pipeline` imports directly. The `addLocation` /
 * `models/server-*` scaffolding exists so that a MODEL can name a server
 * `Resource` (a trigger, an `ObjectDDParticipantFunc`) and have it resolved
 * lazily at runtime; with no such resource that scaffolding would be three
 * packages of indirection resolving to `{}`. `server-plugins/rating` is the
 * in-tree precedent for a middleware-only server plugin and is registered the
 * same way — one `rush.json` entry, one dependency in `server-pipeline`, one
 * line in `createServerPipeline`.
 *
 * @public
 */
export default plugin(serverCrmLiteId, {})
