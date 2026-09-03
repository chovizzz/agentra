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

import { listProjects, openClient } from '@agentra-cli/client'
import { Command } from 'commander'

import { clearConfig, configPath, readConfig, resolveConfig, writeConfig } from '../config'
import { emit, type OutputOptions } from '../output'
import { globalOverrides } from './shared'

/**
 * Read a token without putting it in the shell history.
 *
 * `--token` exists because CI needs it, but the documented path is stdin: a token
 * passed as an argument is visible in `ps` and lands in `~/.zsh_history`.
 */
async function readTokenFromStdin (): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  const token = Buffer.concat(chunks).toString('utf8').trim()
  if (token === '') throw new Error('No token on stdin.')
  return token
}

export function authCommand (): Command {
  const auth = new Command('auth').description('Manage the stored Agentra credentials')

  auth
    .command('login')
    .description('Store the URL, workspace and token used by every other command')
    .requiredOption('--url <url>', 'Agentra front URL, e.g. https://agentra.example.com')
    .requiredOption('--workspace <slug>', 'Workspace slug (not a URL), e.g. agentra-main')
    .option('--token <token>', 'API token; prefer piping it on stdin so it stays out of shell history')
    .action(async (opts: { url: string, workspace: string, token?: string }) => {
      const token = opts.token ?? (await readTokenFromStdin())

      // Verify before storing. Writing an unusable token and failing on the next
      // command would point the blame at that command instead of at the login.
      const client = await openClient({ url: opts.url, workspace: opts.workspace }, token)
      try {
        await listProjects(client)
      } finally {
        await client.close()
      }

      const path = writeConfig({ url: opts.url, workspace: opts.workspace, token })
      process.stdout.write(`Signed in to ${opts.workspace} at ${opts.url}\nCredentials stored in ${path} (mode 600)\n`)
    })

  auth
    .command('status')
    .description('Show where credentials come from and whether they work')
    .option('--json', 'Machine-readable output')
    .action(async (opts: OutputOptions, cmd: Command) => {
      const stored = readConfig()
      const config = resolveConfig(globalOverrides(cmd))
      let reachable = false
      let projects = 0
      const client = await openClient({ url: config.url, workspace: config.workspace }, config.token)
      try {
        projects = (await listProjects(client)).length
        reachable = true
      } finally {
        await client.close()
      }
      emit(
        {
          url: config.url,
          workspace: config.workspace,
          // Never print the token itself — `auth status` is the command people
          // paste into bug reports.
          tokenSource: process.env.AGENTRA_TOKEN != null ? 'AGENTRA_TOKEN' : 'config file',
          configFile: configPath(),
          configFileHasToken: stored.token !== undefined,
          reachable,
          visibleProjects: projects
        },
        opts
      )
    })

  auth
    .command('logout')
    .description('Delete the stored credentials')
    .action(() => {
      const removed = clearConfig()
      process.stdout.write(removed ? `Removed ${configPath()}\n` : 'Nothing stored.\n')
    })

  return auth
}
