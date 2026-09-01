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
 * A platform connection per Agentra token, reused across requests.
 *
 * Keyed by token rather than shared, because under OAuth every agent acts as the
 * person who authorized it — one shared connection would silently give everyone
 * the first authorizer's permissions.
 *
 * The websocket client is used rather than `connectRest` because the tools need
 * `createDoc` / `addCollection` / `updateDoc`; the REST client exposes only the
 * raw `tx` surface.
 *
 * ⚠️ `NodeWebSocketFactory` is not optional — without it the client reaches for
 * the browser `WebSocket` global and fails at connect time in Node.
 */
export class ClientPool {
  private readonly clients = new Map<string, Promise<PlatformClient>>()

  constructor (private readonly config: Config) {}

  async get (token: string): Promise<PlatformClient> {
    let pending = this.clients.get(token)
    if (pending === undefined) {
      pending = connect(this.config.url, {
        token,
        workspace: this.config.workspace,
        socketFactory: NodeWebSocketFactory
      }).catch((err) => {
        // Drop the rejected promise so the next call retries instead of replaying
        // the same failure for the lifetime of the process.
        this.clients.delete(token)
        throw err
      })
      this.clients.set(token, pending)
    }
    return await pending
  }

  async close (): Promise<void> {
    const pending = [...this.clients.values()]
    this.clients.clear()
    for (const p of pending) {
      await p.then(async (c) => { await c.close() }).catch(() => {})
    }
  }
}
