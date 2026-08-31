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

import { type Doc, type Tx } from '@hcengineering/core'
import { type TriggerControl } from '@hcengineering/server-core'

export * from './commandMiddleware'
export * from './commandRequest'
export * from './deleteGuard'
export * from './partialWrite'
export * from './traceLinkGuard'
export * from './traceLinkMetadata'
export * from './commands/archive'
export * from './commands/completeCycle'
export * from './commands/convertLeadToRequirement'
export * from './commands/createDefect'
export * from './commands/createWorkItems'
export * from './commands/defectContent'
export * from './commands/linkFixedBy'
export * from './commands/linkImplements'
export * from './commands/linkVerifies'
export * from './commands/previewReleaseGate'
export * from './commands/releaseGate'
export * from './commands/releaseProductVersion'
export * from './commands/traceCommandSupport'
export * from './commands/traceEndpoints'
export * from './commands/unlinkImplements'

/**
 * Minimal trigger. It produces no transactions of its own — its only job is to
 * prove that `addLocation(serverAgentraCoreId, ...)` resolved this package and
 * that `serverAgentraCore.trigger.OnAgentraMarker` is a live `Resource`.
 *
 * @public
 */
export async function onAgentraMarker (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  control.ctx.info('agentra-core marker transactions observed', { count: txes.length })
  return []
}

/**
 * Cascade-delete participant. The skeleton owns no children, so it returns an
 * empty list; it exists to show where a `builder.mixin`-wired server resource
 * goes, next to the `builder.createDoc`-wired trigger above.
 *
 * @public
 */
export async function agentraMarkerRemove (doc: Doc): Promise<Doc[]> {
  return []
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    OnAgentraMarker: onAgentraMarker
  },
  function: {
    AgentraMarkerRemove: agentraMarkerRemove
  }
})
