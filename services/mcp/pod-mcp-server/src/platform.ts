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

import { connect, NodeWebSocketFactory, type PlatformClient } from '@hcengineering/api-client'
import type { Config } from './config'

/**
 * One platform connection shared by every tool call.
 *
 * The websocket client is used rather than `connectRest` because the tools need
 * `createDoc` / `addCollection` / `updateDoc`, which the REST client does not
 * expose — it only offers the raw `tx` surface.
 *
 * ⚠️ `NodeWebSocketFactory` is not optional here. Without it the client reaches
 * for the browser `WebSocket` global and fails at connect time in Node.
 */
export async function connectPlatform (config: Config): Promise<PlatformClient> {
  return await connect(config.url, {
    token: config.token,
    workspace: config.workspace,
    socketFactory: NodeWebSocketFactory
  })
}
