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

import {
  createIssue,
  getIssue,
  ISSUE_PRIORITIES,
  listProjects,
  searchIssues,
  updateIssue,
  type IssuePriorityName
} from '@agentra-cli/client'
import { Command } from 'commander'

import { emit, type OutputOptions } from '../output'
import { withClient } from '../session'
import { globalOverrides, parseLimit, requireOneOf } from './shared'

export function projectCommand (): Command {
  return new Command('project').description('Tracker projects').addCommand(
    new Command('list')
      .description('List projects with the identifier used as the issue prefix')
      .option('--json', 'Machine-readable output')
      .action(async (opts: OutputOptions, cmd: Command) => {
        const rows = await withClient(globalOverrides(cmd), listProjects)
        emit(rows, opts, ['identifier', 'name', 'description'])
      })
  )
}

export function issueCommand (): Command {
  const issue = new Command('issue').description('Issues')

  issue
    .command('list')
    .description('Search issues; all filters are optional and combine with AND')
    .option('-p, --project <identifier>', 'Project identifier, e.g. PLAUD')
    .option('-s, --status <name>', 'Status name; requires --project, since statuses are scoped to a project type')
    .option('-t, --title <text>', 'Case-insensitive substring match on the title')
    .option('-n, --limit <n>', 'Maximum rows (1-200)', '50')
    .option('--json', 'Machine-readable output')
    .action(
      async (
        opts: { project?: string, status?: string, title?: string, limit: string } & OutputOptions,
        cmd: Command
      ) => {
        // Parse before connecting: a bad --limit should fail on the flag, not after a
        // round trip that reports it as a connection error.
        const limit = parseLimit(opts.limit)
        const rows = await withClient(
          globalOverrides(cmd),
          async (client) =>
            await searchIssues(client, { project: opts.project, status: opts.status, title: opts.title, limit })
        )
        emit(rows, opts, ['identifier', 'status', 'priority', 'title', 'modifiedOn'])
      }
    )

  issue
    .command('get <identifier>')
    .description('Read one issue in full, description rendered as markdown')
    .option('--json', 'Machine-readable output')
    .action(async (identifier: string, opts: OutputOptions, cmd: Command) => {
      const detail = await withClient(globalOverrides(cmd), async (client) => await getIssue(client, identifier))
      emit(detail, opts)
    })

  issue
    .command('create')
    .description('Create an issue; prints the new identifier')
    .requiredOption('-p, --project <identifier>', 'Project identifier, e.g. PLAUD')
    .requiredOption('-t, --title <text>', 'Issue title')
    .option('-d, --description <markdown>', 'Description, as markdown')
    .option('-s, --status <name>', "Status name; defaults to the task type's first status")
    .option('--priority <name>', `One of: ${ISSUE_PRIORITIES.join(', ')}`)
    .option('--task-type <name>', 'Required when the project type has several task types')
    .option('--json', 'Machine-readable output')
    .action(
      async (
        opts: {
          project: string
          title: string
          description?: string
          status?: string
          priority?: IssuePriorityName
          taskType?: string
        } & OutputOptions,
        cmd: Command
      ) => {
        const identifier = await withClient(globalOverrides(cmd), async (client) => await createIssue(client, opts))
        emit({ identifier }, opts, ['identifier'])
      }
    )

  issue
    .command('update <identifier>')
    .description('Update an issue; omitted fields are left untouched')
    .option('-t, --title <text>')
    .option('-d, --description <markdown>', 'Replaces the whole description')
    .option('-s, --status <name>')
    .option('--priority <name>', `One of: ${ISSUE_PRIORITIES.join(', ')}`)
    .option('--json', 'Machine-readable output')
    .action(
      async (
        identifier: string,
        opts: { title?: string, description?: string, status?: string, priority?: IssuePriorityName } & OutputOptions,
        cmd: Command
      ) => {
        requireOneOf(opts, ['title', 'description', 'status', 'priority'])
        const changed = await withClient(
          globalOverrides(cmd),
          async (client) => await updateIssue(client, { identifier, ...opts })
        )
        emit({ identifier, changed }, opts)
      }
    )

  return issue
}
