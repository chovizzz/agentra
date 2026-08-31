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

import type { Class, Ref } from '@hcengineering/core'
import type { Plugin, Resource } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'
import type { ObjectDDParticipantFunc, TriggerFunc } from '@hcengineering/server-core'

import type { CommandExecution } from './command'

export * from './command'

/**
 * @public
 */
export const serverAgentraCoreId = 'server-agentra-core' as Plugin

/**
 * Server side descriptor. It only declares ids; the implementations live in
 * `@hcengineering/server-agentra-core-resources` and are reached through
 * `addLocation(serverAgentraCoreId, ...)` in `registerServerPlugins()`.
 *
 * @public
 */
export default plugin(serverAgentraCoreId, {
  class: {
    /**
     * The idempotency ledger. Declared on the SERVER descriptor rather than the
     * client `agentra-core` plugin on purpose: nothing in the browser may read
     * or write it, and the `_id` derivation that guards it is server-only code.
     * `models/server-agentra-core` builds the `@Model` for this id, exactly the
     * way `models/server-core` builds `serverCore.class.Trigger`.
     */
    CommandExecution: '' as Ref<Class<CommandExecution>>
  },
  trigger: {
    OnAgentraMarker: '' as Resource<TriggerFunc>
  },
  function: {
    AgentraMarkerRemove: '' as Resource<ObjectDDParticipantFunc>
  }
})
