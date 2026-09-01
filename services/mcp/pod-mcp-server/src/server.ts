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

import type { PlatformClient } from '@hcengineering/api-client'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { Config } from './config'
import { connectPlatform } from './platform'
import { errorResult } from './tools/result'
import { registerIssueTools } from './tools/issues'
import { registerTestCaseTools } from './tools/testcases'

/**
 * Lazily open one platform connection and reuse it.
 *
 * Connecting eagerly at startup would make the process refuse to boot whenever
 * Agentra is briefly unreachable; a lazy connection lets the server come up and
 * fail the individual tool call instead, which is what the agent can act on.
 */
function createClientProvider (config: Config): () => Promise<PlatformClient> {
  let pending: Promise<PlatformClient> | undefined
  return async () => {
    if (pending === undefined) {
      pending = connectPlatform(config).catch((err) => {
        // Drop the rejected promise so the next call retries rather than
        // replaying the same failure forever.
        pending = undefined
        throw err
      })
    }
    return await pending
  }
}

/**
 * Wrap every tool handler so a thrown error becomes an `isError` result.
 *
 * The SDK surfaces an escaped exception as a protocol error with no usable text;
 * the agent then has nothing to correct itself with. Keeping the message in the
 * result is what makes "unknown status name, here are the valid ones" useful.
 */
function withErrorHandling (server: McpServer): McpServer {
  const original = server.registerTool.bind(server)
  ;(server as any).registerTool = (name: string, config: unknown, cb: (...a: any[]) => Promise<any>) =>
    original(name as any, config as any, (async (...args: any[]) => {
      try {
        return await cb(...args)
      } catch (err) {
        return errorResult(err)
      }
    }) as any)
  return server
}

export function buildServer (config: Config): McpServer {
  const server = new McpServer({ name: 'agentra', version: '0.7.0' })
  const getClient = createClientProvider(config)

  withErrorHandling(server)
  registerIssueTools(server, getClient)
  registerTestCaseTools(server, getClient)

  return server
}
