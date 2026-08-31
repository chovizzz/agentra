//
// Copyright © 2024 Hardcore Engineering Inc.
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

import { Analytics } from '@hcengineering/analytics'
import type { DocumentQuery, Ref } from '@hcengineering/core'
import requirements from '@hcengineering/requirements'
import traceability from '@hcengineering/traceability'
import { LinkVerifiesPopup } from '@hcengineering/traceability-resources'
import { showPopup, showPanel } from '@hcengineering/ui'
import testManagement, {
  type TestProject,
  type TestCase,
  type TestSuite,
  type TestResult,
  type TestPlan
} from '@hcengineering/test-management'

import CreateTestSuiteComponent from './components/test-suite/CreateTestSuite.svelte'
import EditTestSuiteComponent from './components/test-suite/EditTestSuite.svelte'
import CreateTestCase from './components/test-case/CreateTestCase.svelte'
import CreateProject from './components/project/CreateProject.svelte'
import SelectTestCases from './components/test-case/SelectTestCasesModal.svelte'
import { getTestRunIdFromLocation } from './navigation'
import { initializeIterator } from './components/test-result/store/testIteratorStore'
import { setSelected } from './components/test-run/store/testRunStore'

export async function showCreateTestSuitePopup (
  space: Ref<TestProject> | undefined,
  parentId: Ref<TestSuite>
): Promise<void> {
  showPopup(CreateTestSuiteComponent, { space, parentId }, 'top')
}

export async function showEditTestSuitePopup (suite: Ref<TestSuite>): Promise<void> {
  showPopup(EditTestSuiteComponent, { _id: suite }, 'top')
}

export async function showCreateTestCasePopup (space: Ref<TestProject>, testSuiteId: Ref<TestSuite>): Promise<void> {
  showPopup(CreateTestCase, { space, testSuiteId }, 'top')
}

export async function showCreateProjectPopup (): Promise<void> {
  showPopup(CreateProject, {}, 'top')
}

export async function showCreateTestRunPanel (options: {
  testCases?: TestCase[]
  testPlanId?: Ref<TestPlan>
}): Promise<void> {
  const { testCases, testPlanId } = options
  setSelected(testPlanId, testCases)
  showPanel(
    testManagement.component.NewTestRunPanel,
    testManagement.ids.NewTestRun,
    testManagement.class.TestRun,
    'content',
    undefined,
    false
  )
}

export async function showCreateTestPlanPanel (): Promise<void> {
  showPanel(
    testManagement.component.NewTestPlanPanel,
    testManagement.ids.NewTestPlan,
    testManagement.class.TestPlan,
    'content',
    undefined,
    false
  )
}

export async function showSelectTestCasesPopup (options: {
  testCases?: TestCase[]
  space?: Ref<TestProject>
  onSave: (testCases: TestCase[]) => void
}): Promise<void> {
  const { onSave, space, testCases } = options
  showPopup(SelectTestCases, { onSave, space, testCases }, 'top')
}

export async function showTestRunnerPanel (options: {
  query?: DocumentQuery<TestResult>
  space: Ref<TestProject>
  selectedDocs?: TestResult[]
}): Promise<void> {
  try {
    const { query, space, selectedDocs } = options
    await initializeIterator({
      query: { ...query, space },
      options: {
        lookup: {
          testCase: testManagement.class.TestCase
        }
      },
      docs: selectedDocs
    })
    const testRunId = getTestRunIdFromLocation()
    showPanel(testManagement.component.TestRunner, testRunId, testManagement.class.TestRun, 'content', undefined, false)
  } catch (err: any) {
    Analytics.handleError(err)
    console.error('Failed to initialize test runner', err)
  }
}

export async function CreateChildTestSuiteAction (doc: TestSuite): Promise<void> {
  await showCreateTestSuitePopup(doc.space, doc._id)
}

export async function EditTestSuiteAction (doc: TestSuite): Promise<void> {
  await showEditTestSuitePopup(doc._id)
}

export async function RunSelectedTestsAction (docs: TestCase[] | TestCase): Promise<void> {
  const testCases = Array.isArray(docs) ? docs : [docs]
  if (testCases?.length > 0) {
    await showCreateTestRunPanel({ testCases })
  } else {
    console.error('No test cases selected')
  }
}

/**
 * `verifies` ENTRY POINT 3 — bulk link from a test case selection.
 *
 * 🔴 SAME COMMAND, SAME KEYS. The popup ends in `linkVerifiesPairs`, which calls
 * the ONE `linkVerifies` command once per (case, requirement) pair on that
 * pair's own derived idempotency key. A dedicated "bulk" write path would have
 * to reproduce the server matrix check, the pair claim and the two activity
 * records, and would drift from them the first time any of the three changed.
 *
 * ⚠️ Because the keys are per pair rather than per batch, an interrupted bulk
 * run is simply repeated: the pairs that landed replay, the rest are created.
 *
 * @public
 */
export async function LinkVerifiesAction (docs: TestCase[] | TestCase): Promise<void> {
  const testCases = Array.isArray(docs) ? docs : [docs]
  if (testCases.length === 0) {
    console.error('No test cases selected')
    return
  }
  showPopup(LinkVerifiesPopup, {
    pick: 'requirement',
    pickClass: requirements.masterTag.Requirement,
    fixed: testCases.map((it) => it._id),
    // Requirements are Cards: their display field is `title`, not `name`.
    searchField: 'title',
    placeholder: traceability.string.LinkVerifiesToRequirement
  })
}

export async function EditProjectAction (project: TestProject | undefined): Promise<void> {
  if (project !== undefined) {
    showPopup(CreateProject, { project })
  }
}
