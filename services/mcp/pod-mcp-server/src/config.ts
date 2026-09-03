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

export interface FeishuAuthConfig {
  clientId: string
  clientSecret: string
  redirectUrl: string
  allowedTenantKeys: string[]
  authBaseUrl: string
  apiBaseUrl: string
  scope: string
}

export interface Config {
  /**
   * The **front** URL, not the transactor's. `connect()` fetches `/config.json`
   * from it to discover the accounts and collaborator endpoints.
   */
  url: string
  /** Workspace `url` slug (e.g. `agentra-main`), NOT an http URL. */
  workspace: string
  transport: Transport
  port: number

  /**
   * Set for the http transport: each agent authorizes with Feishu and acts as
   * itself, so there is no shared static token.
   *
   * ⚠️ stdio has no browser to redirect, so that transport still takes a token
   * from `AGENTRA_TOKEN` — it runs on the operator's own machine under their own
   * identity, which is the same trust boundary an OAuth login would establish.
   */
  oauth?: OAuthConfig
  /** stdio only. */
  token?: string
}

export interface OAuthConfig {
  /** Public base URL of this server; the OAuth issuer and redirect base. */
  publicUrl: string
  accountsUrl: string
  serverSecret: string
  workspaceUuid: string
  tokenTtlSec: number
  feishu: FeishuAuthConfig
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

function loadOAuth (): OAuthConfig {
  const missing: string[] = []
  const publicUrl = env('MCP_PUBLIC_URL')
  const accountsUrl = env('ACCOUNTS_URL')
  const serverSecret = env('SERVER_SECRET')
  const workspaceUuid = env('AGENTRA_WORKSPACE_UUID')
  const clientId = env('FEISHU_CLIENT_ID')
  const clientSecret = env('FEISHU_CLIENT_SECRET')
  const tenants = parseList(env('FEISHU_ALLOWED_TENANT_KEYS'))

  if (publicUrl === undefined) missing.push('MCP_PUBLIC_URL')
  if (accountsUrl === undefined) missing.push('ACCOUNTS_URL')
  if (serverSecret === undefined) missing.push('SERVER_SECRET')
  if (workspaceUuid === undefined) missing.push('AGENTRA_WORKSPACE_UUID')
  if (clientId === undefined) missing.push('FEISHU_CLIENT_ID')
  if (clientSecret === undefined) missing.push('FEISHU_CLIENT_SECRET')
  // 🔴 An empty allow-list would let ANY Feishu tenant authorize. Refusing to start
  // is the only safe reading of "not configured" for a gate whose whole job is to
  // keep strangers out.
  if (tenants.length === 0) missing.push('FEISHU_ALLOWED_TENANT_KEYS')

  if (missing.length > 0) {
    throw new Error(`Missing env variables for OAuth: ${missing.join(', ')}`)
  }

  return {
    publicUrl: (publicUrl as string).replace(/\/$/, ''),
    accountsUrl: accountsUrl as string,
    serverSecret: serverSecret as string,
    workspaceUuid: workspaceUuid as string,
    tokenTtlSec: Number.parseInt(env('MCP_TOKEN_TTL_SEC') ?? '28800', 10),
    feishu: {
      clientId: clientId as string,
      clientSecret: clientSecret as string,
      redirectUrl: `${(publicUrl as string).replace(/\/$/, '')}/auth/feishu/callback`,
      allowedTenantKeys: tenants,
      authBaseUrl: env('FEISHU_AUTH_BASE_URL') ?? 'https://open.feishu.cn',
      apiBaseUrl: env('FEISHU_API_BASE_URL') ?? 'https://open.feishu.cn',
      scope: env('FEISHU_SCOPE') ?? ''
    }
  }
}

function parseList (raw: string | undefined): string[] {
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '')
}

export function loadConfig (): Config {
  const missing: string[] = []
  const url = env('AGENTRA_URL')
  const workspace = env('AGENTRA_WORKSPACE')

  if (url === undefined) missing.push('AGENTRA_URL')
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

  const transport = parseTransport(env('MCP_TRANSPORT'))

  if (transport === 'stdio') {
    const token = env('AGENTRA_TOKEN')
    if (token === undefined) {
      throw new Error('Missing env variables: AGENTRA_TOKEN (required for the stdio transport)')
    }
    return { url: url as string, workspace: workspace as string, transport, port, token }
  }

  return { url: url as string, workspace: workspace as string, transport, port, oauth: loadOAuth() }
}
