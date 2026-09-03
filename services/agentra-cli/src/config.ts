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

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

export interface StoredConfig {
  url?: string
  workspace?: string
  token?: string
}

export interface ResolvedConfig {
  url: string
  workspace: string
  token: string
}

/**
 * Where the CLI keeps its credentials.
 *
 * `XDG_CONFIG_HOME` is honoured so the file lands wherever the rest of the user's
 * tooling puts config; the default matches the XDG spec rather than `~/.agentra`
 * so it is covered by the same backup and sync rules as everything else there.
 */
export function configPath (): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'agentra', 'config.json')
}

export function readConfig (): StoredConfig {
  const path = configPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredConfig
  } catch (err) {
    throw new Error(`Config at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function writeConfig (config: StoredConfig): string {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  // `writeFileSync`'s mode applies only when it creates the file; an existing
  // file keeps whatever permissions it had, so a config written before this
  // rule existed would stay world-readable with a token in it.
  chmodSync(path, 0o600)
  return path
}

export function clearConfig (): boolean {
  const path = configPath()
  if (!existsSync(path)) return false
  rmSync(path)
  return true
}

export interface ConfigOverrides {
  url?: string
  workspace?: string
  token?: string
}

/**
 * Merge the three sources, most specific first: command-line flags, then the
 * environment, then the stored config.
 *
 * The environment beats the file so a CI job can point the same machine at a
 * different workspace without rewriting a file it does not own.
 */
export function resolveConfig (overrides: ConfigOverrides = {}): ResolvedConfig {
  const stored = readConfig()
  const url = overrides.url ?? envOrUndefined('AGENTRA_URL') ?? stored.url
  const workspace = overrides.workspace ?? envOrUndefined('AGENTRA_WORKSPACE') ?? stored.workspace
  const token = overrides.token ?? envOrUndefined('AGENTRA_TOKEN') ?? stored.token

  const missing: string[] = []
  if (url === undefined) missing.push('url (--url / AGENTRA_URL)')
  if (workspace === undefined) missing.push('workspace (--workspace / AGENTRA_WORKSPACE)')
  if (token === undefined) missing.push('token (AGENTRA_TOKEN)')
  if (missing.length > 0) {
    throw new Error(
      `Not configured — missing ${missing.join(', ')}.\n` +
        "Run 'agentra auth login' to store these, or set the environment variables."
    )
  }
  return { url: url as string, workspace: workspace as string, token: token as string }
}

function envOrUndefined (name: string): string | undefined {
  const raw = process.env[name]
  // An unset variable and one set to whitespace mean the same thing to an
  // operator; treating '' as a value turns a blank line in a .env file into a
  // confusing "connection refused" much later.
  if (raw === undefined || raw.trim() === '') return undefined
  return raw.trim()
}
