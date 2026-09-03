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

import agentraCore, { type AgentraMarker } from '@hcengineering/agentra-core'
import { type Client, type Doc, type Ref } from '@hcengineering/core'

/**
 * Minimal `function` resource. Exists to prove that `addLocation` resolved this
 * package and that `Resource<...>` ids declared in the plugin descriptor are
 * actually resolvable at runtime.
 *
 * @public
 */
export async function getAgentraMarkerTitle (client: Client, ref: Ref<Doc>, doc?: Doc): Promise<string> {
  const marker =
    (doc as AgentraMarker) ??
    (await client.findOne(agentraCore.class.AgentraMarker, { _id: ref as Ref<AgentraMarker> }))
  return marker?.key ?? ''
}
