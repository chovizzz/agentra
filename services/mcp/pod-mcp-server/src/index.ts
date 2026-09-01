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

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'

import { loadConfig, type Config } from './config'
import { buildServer } from './server'

async function runStdio (config: Config): Promise<void> {
  const server = buildServer(config)
  // 🔴 Nothing may be written to stdout in stdio mode — stdout *is* the protocol
  // channel, and a stray console.log corrupts the JSON-RPC stream. Diagnostics
  // go to stderr.
  await server.connect(new StdioServerTransport())
  console.error('agentra mcp server ready on stdio')
}

async function runHttp (config: Config): Promise<void> {
  const app = express()
  app.use(express.json())

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.post('/mcp', (req, res) => {
    // A fresh server and transport per request: the stateless mode carries no
    // session across calls, so sharing one transport would let concurrent
    // requests interleave on the same stream.
    const server = buildServer(config)
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
    console.log(`agentra mcp server listening on :${config.port}`)
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
