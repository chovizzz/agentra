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

export type Transport = 'stdio' | 'http'

export interface Config {
  /**
   * The **front** URL, not the transactor's. `connect()` fetches `/config.json`
   * from it to discover the accounts and collaborator endpoints.
   */
  url: string
  /** API token minted in Agentra's account settings. */
  token: string
  /** Workspace `url` slug (e.g. `agentra-main`), NOT an http URL. */
  workspace: string
  transport: Transport
  port: number
}

function env (name: string): string | undefined {
  const raw = process.env[name]
  // An unset variable and one set to whitespace mean the same thing to an
  // operator; treating '' as a value turns a blank line in a .env file into a
  // confusing downstream failure instead of a clear "missing config" error.
  if (raw === undefined || raw.trim() === '') return undefined
  return raw.trim()
}

function parseTransport (raw: string | undefined): Transport {
  if (raw === undefined) return 'http'
  if (raw === 'stdio' || raw === 'http') return raw
  throw new Error(`MCP_TRANSPORT must be 'stdio' or 'http', got '${raw}'`)
}

export function loadConfig (): Config {
  const missing: string[] = []
  const url = env('AGENTRA_URL')
  const token = env('AGENTRA_TOKEN')
  const workspace = env('AGENTRA_WORKSPACE')

  if (url === undefined) missing.push('AGENTRA_URL')
  if (token === undefined) missing.push('AGENTRA_TOKEN')
  if (workspace === undefined) missing.push('AGENTRA_WORKSPACE')

  // Fail loudly and name every missing key at once. Starting up "degraded" would
  // leave an MCP server that advertises tools it cannot serve, and the agent on
  // the other end would surface that as a confusing tool error much later.
  if (missing.length > 0) {
    throw new Error(`Missing env variables: ${missing.join(', ')}`)
  }

  const portRaw = env('MCP_PORT')
  const port = portRaw !== undefined ? Number.parseInt(portRaw, 10) : 3100
  if (Number.isNaN(port)) {
    throw new Error(`MCP_PORT must be a number, got '${portRaw ?? ''}'`)
  }

  return {
    url: url as string,
    token: token as string,
    workspace: workspace as string,
    transport: parseTransport(env('MCP_TRANSPORT')),
    port
  }
}
