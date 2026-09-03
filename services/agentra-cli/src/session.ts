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

import { openClient, type PlatformClient } from '@agentra-cli/client'

import { resolveConfig, type ConfigOverrides } from './config'

/**
 * Open a connection, run one command against it, and always close it.
 *
 * Without the `finally` the websocket keeps the event loop alive and the process
 * hangs after printing its output — which reads as "the command is slow" rather
 * than as "it finished".
 */
export async function withClient<T> (
  overrides: ConfigOverrides,
  fn: (client: PlatformClient) => Promise<T>
): Promise<T> {
  const config = resolveConfig(overrides)
  const client = await openClient({ url: config.url, workspace: config.workspace }, config.token)
  try {
    return await fn(client)
  } finally {
    await client.close()
  }
}
