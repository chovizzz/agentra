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

import type { WorkspaceUuid } from '@hcengineering/core'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'

import { loadConfig, type Config } from './config'
import { FeishuBackedProvider } from './auth/provider'
import { ClientPool } from './platform'
import { buildServer } from './server'

async function runStdio (config: Config): Promise<void> {
  const pool = new ClientPool(config)
  const token = config.token as string
  const server = buildServer(async () => await pool.get(token))
  // 🔴 Nothing may be written to stdout in stdio mode — stdout *is* the protocol
  // channel, and a stray console.log corrupts the JSON-RPC stream. Diagnostics go
  // to stderr.
  await server.connect(new StdioServerTransport())
  console.error('agentra mcp server ready on stdio')
}

async function runHttp (config: Config): Promise<void> {
  const oauth = config.oauth
  if (oauth === undefined) throw new Error('http transport requires OAuth configuration')

  const pool = new ClientPool(config)
  const provider = new FeishuBackedProvider(
    oauth.feishu,
    {
      accountsUrl: oauth.accountsUrl,
      serverSecret: oauth.serverSecret,
      workspaceUuid: oauth.workspaceUuid as WorkspaceUuid,
      tokenTtlSec: oauth.tokenTtlSec
    },
    oauth.serverSecret
  )

  const app = express()
  app.use(express.json())

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  // The Feishu redirect target. Registered before the OAuth router so it is not
  // shadowed, and it is the ONLY place a Feishu identity becomes an Agentra token.
  app.get('/auth/feishu/callback', (req, res) => {
    void provider.handleCallback(req, res)
  })

  // Advertises the metadata MCP clients discover, and serves /authorize, /token
  // and dynamic client registration. Must be mounted at the application root.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(oauth.publicUrl),
      resourceServerUrl: new URL(oauth.publicUrl),
      resourceName: 'Agentra'
    })
  )

  const requireAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: `${oauth.publicUrl}/.well-known/oauth-protected-resource`
  })

  app.post('/mcp', requireAuth, (req, res) => {
    // A fresh server and transport per request: stateless mode carries no session
    // across calls, so a shared transport would let concurrent requests interleave
    // on one stream — and, more importantly, would blur whose token is in use.
    const agentraToken = (req as any).auth?.extra?.agentraToken
    if (typeof agentraToken !== 'string') {
      res.status(401).json({ error: 'no Agentra token bound to this access token' })
      return
    }

    const server = buildServer(async () => await pool.get(agentraToken))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    server
      .connect(transport)
      .then(async () => {
        await transport.handleRequest(req, res, req.body)
      })
      .catch((err) => {
        console.error('mcp request failed', err)
        if (!res.headersSent) res.status(500).json({ error: 'internal error' })
      })
  })

  app.listen(config.port, () => {
    console.log(`agentra mcp server listening on :${config.port} (oauth via feishu)`)
  })
}

async function main (): Promise<void> {
  const config = loadConfig()
  if (config.transport === 'stdio') {
    await runStdio(config)
  } else {
    await runHttp(config)
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
