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

import core, { type Class, type Doc, type Timestamp } from '@hcengineering/core'
import { Model, type Builder } from '@hcengineering/model'
import agentraCore, { DOMAIN_AGENTRA_CORE } from '@hcengineering/model-agentra-core'
import { TDoc } from '@hcengineering/model-core'
import serverCore, { type ObjectDDParticipant } from '@hcengineering/server-core'
import serverAgentraCore, {
  type CommandExecution,
  type CommandExecutionStatus
} from '@hcengineering/server-agentra-core'

export { serverAgentraCoreId } from '@hcengineering/server-agentra-core'

/**
 * The idempotency ledger.
 *
 * Declared in the SERVER model package, next to the server descriptor that owns
 * the class id, because no client code may touch it. `models/server-core` does
 * the same for `serverCore.class.Trigger`.
 *
 * No `@Prop` decorators, also following `TTrigger`: this document has no UI and
 * needs no `IntlString` labels. Attributes are stored in the domain table's
 * `data` jsonb and remain fully queryable; the exclusion guarantee comes from
 * `PRIMARY KEY("workspaceId", _id)`, which every domain table already has, not
 * from any secondary index (`createIndex` in the Postgres adapter is a no-op,
 * so a plugin could not declare one anyway).
 */
@Model(serverAgentraCore.class.CommandExecution, core.class.Doc, DOMAIN_AGENTRA_CORE)
export class TCommandExecution extends TDoc implements CommandExecution {
  command!: string
  idempotencyKey!: string
  attemptId!: string
  status!: CommandExecutionStatus
  startedOn!: Timestamp
  finishedOn?: Timestamp
  result?: Record<string, any>
  error?: string
  epoch!: number
}

export function createModel (builder: Builder): void {
  builder.createModel(TCommandExecution)

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverAgentraCore.trigger.OnAgentraMarker,
    isAsync: true,
    txMatch: {
      _class: core.class.TxCreateDoc,
      objectClass: agentraCore.class.AgentraMarker
    }
  })

  builder.mixin<Class<Doc>, ObjectDDParticipant>(
    agentraCore.class.AgentraMarker,
    core.class.Class,
    serverCore.mixin.ObjectDDParticipant,
    {
      collectDocs: serverAgentraCore.function.AgentraMarkerRemove
    }
  )
}
