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
import { generateId, SortingOrder, type Ref } from '@hcengineering/core'
import testManagement, {
  TestCasePriority,
  TestCaseStatus,
  TestCaseType,
  type TestCase,
  type TestProject,
  type TestSuite
} from '@hcengineering/test-management'
import { z } from 'zod'

import { jsonResult, textResult, type ToolResult } from './result'

const TYPES = ['Functional', 'Performance', 'Regression', 'Security', 'Smoke', 'Usability'] as const
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'] as const
const STATUSES = ['Draft', 'ReadyForReview', 'FixReviewComments', 'Approved', 'Rejected'] as const

async function findTestProject (client: PlatformClient, name: string): Promise<TestProject> {
  const projects = await client.findAll(testManagement.class.TestProject, {})
  const match = projects.find((p) => p.name.toLowerCase() === name.toLowerCase())
  if (match === undefined) {
    throw new Error(
      `Test project '${name}' not found. Available: ${projects.map((p) => p.name).join(', ') || '(none visible)'}`
    )
  }
  return match
}

function describeCase (tc: TestCase, suiteName?: string): Record<string, unknown> {
  return {
    id: tc._id,
    name: tc.name,
    suite: suiteName ?? tc.attachedTo,
    type: TYPES[tc.type],
    priority: PRIORITIES[tc.priority],
    status: STATUSES[tc.status],
    automationKey: tc.automationKey,
    version: tc.version,
    modifiedOn: new Date(tc.modifiedOn).toISOString()
  }
}

export function registerTestCaseTools (server: any, getClient: () => Promise<PlatformClient>): void {
  server.registerTool(
    'agentra_list_test_projects',
    {
      title: '列出测试專案',
      description:
        'List test projects and their suites. ⚠️ Only projects the token owner is a member of are visible — ' +
        'Huly filters spaces by membership, so an empty list can mean "not a member" rather than "none exist".',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async (): Promise<ToolResult> => {
      const client = await getClient()
      const projects = await client.findAll(testManagement.class.TestProject, {})
      const suites = await client.findAll(testManagement.class.TestSuite, {})
      return jsonResult(
        projects.map((p) => ({
          name: p.name,
          suites: suites.filter((s) => s.space === p._id).map((s) => s.name)
        }))
      )
    }
  )

  server.registerTool(
    'agentra_search_test_cases',
    {
      title: '搜索测试用例',
      description: 'Search test cases. Filters are optional and combine with AND.',
      inputSchema: {
        project: z.string().optional().describe('Test project name'),
        suite: z.string().optional().describe('Suite name'),
        name: z.string().optional().describe('Case-insensitive substring match on the case name'),
        automationKey: z.string().optional().describe('Exact match on the automation key'),
        status: z.enum(STATUSES).optional(),
        limit: z.number().int().min(1).max(200).default(50)
      },
      annotations: { readOnlyHint: true }
    },
    async (args: {
      project?: string
      suite?: string
      name?: string
      automationKey?: string
      status?: (typeof STATUSES)[number]
      limit: number
    }): Promise<ToolResult> => {
      const client = await getClient()
      const query: Record<string, unknown> = {}
      if (args.project !== undefined) {
        query.space = (await findTestProject(client, args.project))._id
      }
      if (args.suite !== undefined) {
        const suites = await client.findAll(testManagement.class.TestSuite, {})
        const match = suites.find((s) => s.name.toLowerCase() === args.suite?.toLowerCase())
        if (match === undefined) throw new Error(`Suite '${args.suite}' not found.`)
        query.attachedTo = match._id
      }
      if (args.name !== undefined) query.name = { $like: `%${args.name}%` }
      if (args.automationKey !== undefined) query.automationKey = args.automationKey
      if (args.status !== undefined) query.status = TestCaseStatus[args.status]

      const cases = await client.findAll(testManagement.class.TestCase, query, {
        limit: args.limit,
        sort: { modifiedOn: SortingOrder.Descending }
      })
      const suites = await client.findAll(testManagement.class.TestSuite, {})
      const byId = new Map(suites.map((s) => [s._id, s.name]))
      return jsonResult(cases.map((c) => describeCase(c, byId.get(c.attachedTo))))
    }
  )

  server.registerTool(
    'agentra_get_test_case',
    {
      title: '读取测试用例',
      description: 'Read one test case in full, including its steps and description.',
      inputSchema: { id: z.string().describe('Test case id, as returned by agentra_search_test_cases') },
      annotations: { readOnlyHint: true }
    },
    async (args: { id: string }): Promise<ToolResult> => {
      const client = await getClient()
      const tc = await client.findOne(testManagement.class.TestCase, { _id: args.id as Ref<TestCase> })
      if (tc === undefined) throw new Error(`Test case '${args.id}' not found.`)
      const suite = await client.findOne(testManagement.class.TestSuite, { _id: tc.attachedTo })
      const steps = await client.findAll(
        testManagement.class.TestStep,
        { attachedTo: tc._id },
        { sort: { rank: SortingOrder.Ascending } }
      )
      let description = ''
      if (tc.description != null) {
        description = await client.fetchMarkup(
          testManagement.class.TestCase,
          tc._id,
          'description',
          tc.description,
          'markdown'
        )
      }
      return jsonResult({
        ...describeCase(tc, suite?.name),
        description,
        preconditions: tc.preconditions,
        steps: steps.map((s) => ({ action: (s as any).action, expectedResult: (s as any).expectedResult }))
      })
    }
  )

  server.registerTool(
    'agentra_create_test_case',
    {
      title: '创建测试用例',
      description: 'Create a test case inside a suite.',
      inputSchema: {
        project: z.string().describe('Test project name'),
        suite: z.string().describe('Suite name; must already exist'),
        name: z.string().min(1),
        description: z.string().optional().describe('Markdown'),
        type: z.enum(TYPES).default('Functional'),
        priority: z.enum(PRIORITIES).default('Medium'),
        status: z.enum(STATUSES).default('Draft'),
        automationKey: z.string().optional()
      }
    },
    async (args: {
      project: string
      suite: string
      name: string
      description?: string
      type: (typeof TYPES)[number]
      priority: (typeof PRIORITIES)[number]
      status: (typeof STATUSES)[number]
      automationKey?: string
    }): Promise<ToolResult> => {
      const client = await getClient()
      const project = await findTestProject(client, args.project)
      const suites = await client.findAll(testManagement.class.TestSuite, { space: project._id })
      const suite = suites.find((s) => s.name.toLowerCase() === args.suite.toLowerCase())
      if (suite === undefined) {
        throw new Error(`Suite '${args.suite}' not found in ${project.name}. Available: ${suites.map((s) => s.name).join(', ')}`)
      }

      const caseId = generateId<TestCase>()
      const description =
        args.description !== undefined
          ? await client.uploadMarkup(
            testManagement.class.TestCase,
            caseId,
            'description',
            args.description,
            'markdown'
          )
          : null

      await client.addCollection(
        testManagement.class.TestCase,
        project._id,
        suite._id as Ref<TestSuite>,
        testManagement.class.TestSuite,
        'testCases',
        {
          name: args.name,
          description,
          // `TestCase.assignee` is typed non-optional but the UI creates cases with
          // null; inventing an assignee here would lie about who owns the case.
          assignee: null,
          type: TestCaseType[args.type],
          priority: TestCasePriority[args.priority],
          status: TestCaseStatus[args.status],
          automationKey: args.automationKey,
          attachments: 0,
          comments: 0,
          steps: 0,
          snapshots: 0
        } as any,
        caseId as Ref<any>
      )
      return textResult(`Created test case ${caseId} (${args.name})`)
    }
  )

  server.registerTool(
    'agentra_update_test_case',
    {
      title: '修改测试用例',
      description: 'Update fields of an existing test case. Omitted fields are left untouched.',
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().optional().describe('Markdown; replaces the whole description'),
        type: z.enum(TYPES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        status: z.enum(STATUSES).optional(),
        automationKey: z.string().optional()
      }
    },
    async (args: {
      id: string
      name?: string
      description?: string
      type?: (typeof TYPES)[number]
      priority?: (typeof PRIORITIES)[number]
      status?: (typeof STATUSES)[number]
      automationKey?: string
    }): Promise<ToolResult> => {
      const client = await getClient()
      const tc = await client.findOne(testManagement.class.TestCase, { _id: args.id as Ref<TestCase> })
      if (tc === undefined) throw new Error(`Test case '${args.id}' not found.`)

      const update: Record<string, unknown> = {}
      if (args.name !== undefined) update.name = args.name
      if (args.type !== undefined) update.type = TestCaseType[args.type]
      if (args.priority !== undefined) update.priority = TestCasePriority[args.priority]
      if (args.status !== undefined) update.status = TestCaseStatus[args.status]
      if (args.automationKey !== undefined) update.automationKey = args.automationKey
      if (args.description !== undefined) {
        update.description = await client.uploadMarkup(
          testManagement.class.TestCase,
          tc._id,
          'description',
          args.description,
          'markdown'
        )
      }
      if (Object.keys(update).length === 0) {
        throw new Error('Nothing to update — pass at least one field.')
      }
      await client.updateDoc(testManagement.class.TestCase, tc.space, tc._id, update)
      return textResult(`Updated test case ${args.id}: ${Object.keys(update).join(', ')}`)
    }
  )
}
