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

import { errorResult } from './tools/result'
import { registerIssueTools } from './tools/issues'
import { registerTestCaseTools } from './tools/testcases'

/**
 * Wrap every tool handler so a thrown error becomes an `isError` result.
 *
 * The SDK surfaces an escaped exception as a protocol error with no usable text;
 * the agent then has nothing to correct itself with. Keeping the message in the
 * result is what makes "unknown status name, here are the valid ones" useful.
 */
// The parameter is deliberately not called `cb`: `n/no-callback-literal` keys off
// that name and reads this as a Node-style errback, which it is not — the return
// value IS the tool result.
function wrap (handler: (...a: any[]) => Promise<any>): (...a: any[]) => Promise<any> {
  return async (...args: any[]): Promise<any> => {
    try {
      return await handler(...args)
    } catch (err) {
      return errorResult(err)
    }
  }
}

function withErrorHandling (server: McpServer): McpServer {
  const original = server.registerTool.bind(server)
  ;(server as any).registerTool = (name: string, config: unknown, handler: (...a: any[]) => Promise<any>) =>
    original(name as any, config as any, wrap(handler) as any)
  return server
}

/**
 * One MCP server bound to one caller's platform client.
 *
 * `getClient` is passed in rather than derived from config: under OAuth it
 * resolves to the client of whoever authorized *this* request.
 */
export function buildServer (getClient: () => Promise<PlatformClient>): McpServer {
  const server = new McpServer({ name: 'agentra', version: '0.7.0' })

  withErrorHandling(server)
  registerIssueTools(server, getClient)
  registerTestCaseTools(server, getClient)

  return server
}
