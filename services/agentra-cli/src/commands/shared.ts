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

import type { Command } from 'commander'

import type { ConfigOverrides } from '../config'

/**
 * Pull `--url` / `--workspace` / `--token` off the root command.
 *
 * They are declared once on the program rather than on every subcommand, so the
 * leaf action has to walk up to find them.
 */
export function globalOverrides (cmd: Command): ConfigOverrides {
  const root = rootOf(cmd)
  const opts = root.opts<{ url?: string, workspace?: string, token?: string }>()
  return { url: opts.url, workspace: opts.workspace, token: opts.token }
}

function rootOf (cmd: Command): Command {
  let current = cmd
  while (current.parent != null) current = current.parent
  return current
}

export function parseLimit (raw: string): number {
  const limit = Number.parseInt(raw, 10)
  if (Number.isNaN(limit) || limit < 1 || limit > 200) {
    throw new Error(`--limit must be a number between 1 and 200, got '${raw}'`)
  }
  return limit
}

/**
 * Reject an update that would change nothing.
 *
 * Silently succeeding on an empty update makes a typo'd flag name look like a
 * successful edit — the command exits 0 and the field is untouched.
 */
export function requireOneOf<T extends object> (opts: T, fields: Array<keyof T & string>): void {
  const given = fields.filter((f) => opts[f] !== undefined)
  if (given.length === 0) {
    throw new Error(`Nothing to update — pass at least one of: ${fields.map((f) => '--' + f).join(', ')}`)
  }
}
