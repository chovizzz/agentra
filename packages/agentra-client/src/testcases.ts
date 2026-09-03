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

import {
  TEST_CASE_PRIORITIES,
  TEST_CASE_STATUSES,
  TEST_CASE_TYPES,
  type TestCasePriorityName,
  type TestCaseStatusName,
  type TestCaseTypeName
} from './vocabulary'

export interface TestProjectSummary {
  name: string
  suites: string[]
}

export interface TestCaseSummary {
  id: string
  name: string
  suite: string
  type: TestCaseTypeName
  priority: TestCasePriorityName
  status: TestCaseStatusName
  automationKey?: string
  version?: number
  modifiedOn: string
}

export interface TestCaseStep {
  action: unknown
  expectedResult: unknown
}

export interface TestCaseDetail extends TestCaseSummary {
  description: string
  preconditions: unknown
  steps: TestCaseStep[]
}

export interface SearchTestCasesParams {
  project?: string
  suite?: string
  name?: string
  automationKey?: string
  status?: TestCaseStatusName
  limit?: number
}

export interface CreateTestCaseParams {
  project: string
  suite: string
  name: string
  description?: string
  type?: TestCaseTypeName
  priority?: TestCasePriorityName
  status?: TestCaseStatusName
  automationKey?: string
}

export interface UpdateTestCaseParams {
  id: string
  name?: string
  description?: string
  type?: TestCaseTypeName
  priority?: TestCasePriorityName
  status?: TestCaseStatusName
  automationKey?: string
}

async function findTestProject (client: PlatformClient, name: string): Promise<TestProject> {
  const projects = await client.findAll(testManagement.class.TestProject, {})
  const match = projects.find((p) => p.name.toLowerCase() === name.toLowerCase())
  if (match === undefined) {
    const names = projects.map((p) => p.name).join(', ')
    // An empty list here usually means "you are not a member of any test project"
    // rather than "there are none" — Huly filters spaces by membership.
    const available = names === '' ? '(none visible)' : names
    throw new Error(`Test project '${name}' not found. Available: ${available}`)
  }
  return match
}

function describeCase (tc: TestCase, suiteName?: string): TestCaseSummary {
  return {
    id: tc._id,
    name: tc.name,
    suite: suiteName ?? tc.attachedTo,
    type: TEST_CASE_TYPES[tc.type],
    priority: TEST_CASE_PRIORITIES[tc.priority],
    status: TEST_CASE_STATUSES[tc.status],
    automationKey: tc.automationKey,
    version: tc.version,
    modifiedOn: new Date(tc.modifiedOn).toISOString()
  }
}

/**
 * ⚠️ Only projects the caller is a member of are visible — Huly filters spaces by
 * membership, so an empty list means "not a member" just as often as it means
 * "none exist". Callers should say so rather than reporting an empty workspace.
 */
export async function listTestProjects (client: PlatformClient): Promise<TestProjectSummary[]> {
  const projects = await client.findAll(testManagement.class.TestProject, {})
  const suites = await client.findAll(testManagement.class.TestSuite, {})
  return projects.map((p) => ({
    name: p.name,
    suites: suites.filter((s) => s.space === p._id).map((s) => s.name)
  }))
}

export async function searchTestCases (
  client: PlatformClient,
  params: SearchTestCasesParams
): Promise<TestCaseSummary[]> {
  const query: Record<string, unknown> = {}
  let projectId: Ref<TestProject> | undefined
  if (params.project !== undefined) {
    projectId = (await findTestProject(client, params.project))._id
    query.space = projectId
  }
  if (params.suite !== undefined) {
    // Scope the name lookup to the project when one was given. Suite names are only
    // unique within a project — `section1-前台` exists in more than one — so a global
    // lookup silently answers with another project's suite and returns its cases.
    const suites = await client.findAll(
      testManagement.class.TestSuite,
      projectId !== undefined ? { space: projectId } : {}
    )
    const match = suites.find((s) => s.name.toLowerCase() === params.suite?.toLowerCase())
    if (match === undefined) {
      const where = params.project !== undefined ? ` in ${params.project}` : ''
      throw new Error(`Suite '${params.suite}' not found${where}.`)
    }
    query.attachedTo = match._id
  }
  if (params.name !== undefined) query.name = { $like: `%${params.name}%` }
  if (params.automationKey !== undefined) query.automationKey = params.automationKey
  if (params.status !== undefined) query.status = TestCaseStatus[params.status]

  const cases = await client.findAll(testManagement.class.TestCase, query, {
    limit: params.limit ?? 50,
    sort: { modifiedOn: SortingOrder.Descending }
  })
  const suites = await client.findAll(testManagement.class.TestSuite, {})
  const byId = new Map(suites.map((s) => [s._id, s.name]))
  return cases.map((c) => describeCase(c, byId.get(c.attachedTo)))
}

export async function getTestCase (client: PlatformClient, id: string): Promise<TestCaseDetail> {
  const tc = await client.findOne(testManagement.class.TestCase, { _id: id as Ref<TestCase> })
  if (tc === undefined) throw new Error(`Test case '${id}' not found.`)
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
  return {
    ...describeCase(tc, suite?.name),
    description,
    preconditions: tc.preconditions,
    steps: steps.map((s) => ({ action: (s as any).action, expectedResult: (s as any).expectedResult }))
  }
}

/** Returns the id of the created case. */
export async function createTestCase (client: PlatformClient, params: CreateTestCaseParams): Promise<string> {
  const project = await findTestProject(client, params.project)
  const suites = await client.findAll(testManagement.class.TestSuite, { space: project._id })
  const suite = suites.find((s) => s.name.toLowerCase() === params.suite.toLowerCase())
  if (suite === undefined) {
    throw new Error(
      `Suite '${params.suite}' not found in ${project.name}. Available: ${suites.map((s) => s.name).join(', ')}`
    )
  }

  const caseId = generateId<TestCase>()
  const description =
    params.description !== undefined
      ? await client.uploadMarkup(testManagement.class.TestCase, caseId, 'description', params.description, 'markdown')
      : null

  await client.addCollection(
    testManagement.class.TestCase,
    project._id,
    suite._id as Ref<TestSuite>,
    testManagement.class.TestSuite,
    'testCases',
    {
      name: params.name,
      description,
      // `TestCase.assignee` is typed non-optional but the UI creates cases with
      // null; inventing an assignee here would lie about who owns the case.
      assignee: null,
      type: TestCaseType[params.type ?? 'Functional'],
      priority: TestCasePriority[params.priority ?? 'Medium'],
      status: TestCaseStatus[params.status ?? 'Draft'],
      automationKey: params.automationKey,
      attachments: 0,
      comments: 0,
      steps: 0,
      snapshots: 0
    } as any,
    caseId as Ref<any>
  )
  return caseId
}

/** Returns the names of the fields that were actually changed. */
export async function updateTestCase (client: PlatformClient, params: UpdateTestCaseParams): Promise<string[]> {
  const tc = await client.findOne(testManagement.class.TestCase, { _id: params.id as Ref<TestCase> })
  if (tc === undefined) throw new Error(`Test case '${params.id}' not found.`)

  const update: Record<string, unknown> = {}
  if (params.name !== undefined) update.name = params.name
  if (params.type !== undefined) update.type = TestCaseType[params.type]
  if (params.priority !== undefined) update.priority = TestCasePriority[params.priority]
  if (params.status !== undefined) update.status = TestCaseStatus[params.status]
  if (params.automationKey !== undefined) update.automationKey = params.automationKey
  if (params.description !== undefined) {
    update.description = await client.uploadMarkup(
      testManagement.class.TestCase,
      tc._id,
      'description',
      params.description,
      'markdown'
    )
  }
  if (Object.keys(update).length === 0) {
    throw new Error('Nothing to update — pass at least one field.')
  }
  await client.updateDoc(testManagement.class.TestCase, tc.space, tc._id, update)
  return Object.keys(update)
}
