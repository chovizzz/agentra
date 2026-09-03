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

// Re-exported so callers need only depend on this package, not on api-client too.
export type { PlatformClient }

export interface ConnectOptions {
  /**
   * The **front** URL, not the transactor's. `connect()` fetches `/config.json`
   * from it to discover the accounts and collaborator endpoints.
   */
  url: string
  /** Workspace `url` slug (e.g. `agentra-main`), NOT an http URL. */
  workspace: string
}

/**
 * Open one platform connection.
 *
 * The websocket client is used rather than `connectRest` because the domain
 * functions need `createDoc` / `addCollection` / `updateDoc`; the REST client
 * exposes only the raw `tx` surface.
 *
 * ⚠️ `NodeWebSocketFactory` is not optional — without it the client reaches for
 * the browser `WebSocket` global and fails at connect time in Node.
 */
export async function openClient (options: ConnectOptions, token: string): Promise<PlatformClient> {
  return await connect(options.url, {
    token,
    workspace: options.workspace,
    socketFactory: NodeWebSocketFactory
  })
}

/**
 * A platform connection per Agentra token, reused across requests.
 *
 * Keyed by token rather than shared, because under OAuth every agent acts as the
 * person who authorized it — one shared connection would silently give everyone
 * the first authorizer's permissions.
 *
 * The CLI holds exactly one token and so keeps exactly one entry; the pool still
 * earns its place there by giving both callers the same reconnect-on-failure
 * behaviour.
 */
export class ClientPool {
  private readonly clients = new Map<string, Promise<PlatformClient>>()

  constructor (private readonly options: ConnectOptions) {}

  async get (token: string): Promise<PlatformClient> {
    let pending = this.clients.get(token)
    if (pending === undefined) {
      pending = openClient(this.options, token).catch((err) => {
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
      await p
        .then(async (c) => {
          await c.close()
        })
        .catch(() => {})
    }
  }
}
