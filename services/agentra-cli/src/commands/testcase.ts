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
  createTestCase,
  getTestCase,
  listTestProjects,
  searchTestCases,
  TEST_CASE_PRIORITIES,
  TEST_CASE_STATUSES,
  TEST_CASE_TYPES,
  updateTestCase,
  type TestCasePriorityName,
  type TestCaseStatusName,
  type TestCaseTypeName
} from '@agentra-cli/client'
import { Command } from 'commander'

import { emit, type OutputOptions } from '../output'
import { withClient } from '../session'
import { globalOverrides, parseLimit, requireOneOf } from './shared'

export function testProjectCommand (): Command {
  return new Command('test-project').description('Test projects and their suites').addCommand(
    new Command('list')
      .description(
        'List test projects. ⚠️ Only projects you are a member of are visible, so an empty list can mean "not a member" rather than "none exist".'
      )
      .option('--json', 'Machine-readable output')
      .action(async (opts: OutputOptions, cmd: Command) => {
        const rows = await withClient(globalOverrides(cmd), listTestProjects)
        emit(opts.json === true ? rows : rows.map((r) => ({ name: r.name, suites: r.suites.length })), opts, [
          'name',
          'suites'
        ])
      })
  )
}

export function caseCommand (): Command {
  const testCase = new Command('case').description('Test cases')

  testCase
    .command('list')
    .description('Search test cases; all filters are optional and combine with AND')
    .option('-p, --project <name>', 'Test project name')
    .option('--suite <name>', 'Suite name')
    .option('-n, --name <text>', 'Case-insensitive substring match on the case name')
    .option('-k, --automation-key <key>', 'Exact match on the automation key')
    .option('-s, --status <name>', `One of: ${TEST_CASE_STATUSES.join(', ')}`)
    .option('--limit <n>', 'Maximum rows (1-200)', '50')
    .option('--json', 'Machine-readable output')
    .action(
      async (
        opts: {
          project?: string
          suite?: string
          name?: string
          automationKey?: string
          status?: TestCaseStatusName
          limit: string
        } & OutputOptions,
        cmd: Command
      ) => {
        // Parse before connecting: a bad --limit should fail on the flag, not after a
        // round trip that reports it as a connection error.
        const limit = parseLimit(opts.limit)
        const rows = await withClient(
          globalOverrides(cmd),
          async (client) =>
            await searchTestCases(client, {
              project: opts.project,
              suite: opts.suite,
              name: opts.name,
              automationKey: opts.automationKey,
              status: opts.status,
              limit
            })
        )
        emit(rows, opts, ['id', 'automationKey', 'status', 'priority', 'suite', 'name'])
      }
    )

  testCase
    .command('get <id>')
    .description('Read one test case in full, including its steps')
    .option('--json', 'Machine-readable output')
    .action(async (id: string, opts: OutputOptions, cmd: Command) => {
      const detail = await withClient(globalOverrides(cmd), async (client) => await getTestCase(client, id))
      emit(detail, opts)
    })

  testCase
    .command('create')
    .description('Create a test case inside an existing suite; prints the new id')
    .requiredOption('-p, --project <name>', 'Test project name')
    .requiredOption('--suite <name>', 'Suite name; must already exist')
    .requiredOption('-n, --name <text>', 'Case name')
    .option('-d, --description <markdown>')
    .option('--type <name>', `One of: ${TEST_CASE_TYPES.join(', ')}`)
    .option('--priority <name>', `One of: ${TEST_CASE_PRIORITIES.join(', ')}`)
    .option('-s, --status <name>', `One of: ${TEST_CASE_STATUSES.join(', ')}`)
    .option('-k, --automation-key <key>')
    .option('--json', 'Machine-readable output')
    .action(
      async (
        opts: {
          project: string
          suite: string
          name: string
          description?: string
          type?: TestCaseTypeName
          priority?: TestCasePriorityName
          status?: TestCaseStatusName
          automationKey?: string
        } & OutputOptions,
        cmd: Command
      ) => {
        const id = await withClient(globalOverrides(cmd), async (client) => await createTestCase(client, opts))
        emit({ id, name: opts.name }, opts, ['id', 'name'])
      }
    )

  testCase
    .command('update <id>')
    .description('Update a test case; omitted fields are left untouched')
    .option('-n, --name <text>')
    .option('-d, --description <markdown>', 'Replaces the whole description')
    .option('--type <name>', `One of: ${TEST_CASE_TYPES.join(', ')}`)
    .option('--priority <name>', `One of: ${TEST_CASE_PRIORITIES.join(', ')}`)
    .option('-s, --status <name>', `One of: ${TEST_CASE_STATUSES.join(', ')}`)
    .option('-k, --automation-key <key>')
    .option('--json', 'Machine-readable output')
    .action(
      async (
        id: string,
        opts: {
          name?: string
          description?: string
          type?: TestCaseTypeName
          priority?: TestCasePriorityName
          status?: TestCaseStatusName
          automationKey?: string
        } & OutputOptions,
        cmd: Command
      ) => {
        requireOneOf(opts, ['name', 'description', 'type', 'priority', 'status', 'automationKey'])
        const changed = await withClient(
          globalOverrides(cmd),
          async (client) => await updateTestCase(client, { id, ...opts })
        )
        emit({ id, changed }, opts)
      }
    )

  return testCase
}
