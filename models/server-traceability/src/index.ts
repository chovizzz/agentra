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

import core, { type Class, type Doc } from '@hcengineering/core'
import { type Builder } from '@hcengineering/model'
import traceability from '@hcengineering/model-traceability'
import serverCore, { type ObjectDDParticipant } from '@hcengineering/server-core'
import serverTraceability from '@hcengineering/server-traceability'

export { serverTraceabilityId } from '@hcengineering/server-traceability'

export function createModel (builder: Builder): void {
  // Endpoint removal must NOT delete the edge — it flips `state` to `orphaned`
  // so the audit fact survives. The txMatch stays broad here and is narrowed
  // once the endpoint modules exist to match against.
  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverTraceability.trigger.OnTraceEndpointRemoved,
    isAsync: true,
    txMatch: {
      _class: core.class.TxRemoveDoc
    }
  })

  // A trace edge owns no children and must never cascade into its endpoints.
  builder.mixin<Class<Doc>, ObjectDDParticipant>(
    traceability.class.TraceLink,
    core.class.Class,
    serverCore.mixin.ObjectDDParticipant,
    {
      collectDocs: serverTraceability.function.TraceLinkRemove
    }
  )
}
