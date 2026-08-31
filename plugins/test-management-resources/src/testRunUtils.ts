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
import { type Ref } from '@hcengineering/core'
import { getClient } from '@hcengineering/presentation'
import testManagement, {
  collectTestRunStats,
  type TestRun,
  type TestCase,
  type TestRunStats
} from '@hcengineering/test-management'

export type { TestRunStats }

export async function getTestCases (objectId: Ref<TestRun>): Promise<TestCase[]> {
  if (objectId === undefined) {
    return []
  }
  const client = getClient()
  const testResults = await client.findAll(testManagement.class.TestResult, { attachedTo: objectId })
  const testCaseIds = testResults.map((testResult) => testResult.testCase)
  return await client.findAll(testManagement.class.TestCase, { _id: { $in: testCaseIds } })
}

/**
 * Per-status counts for a test run.
 *
 * 🔴 THE ARITHMETIC MOVED OUT OF THIS FILE ON PURPOSE. What used to live here
 * was four literal queries (Untested / Blocked / Passed / Failed) whose sum was
 * the total — so a run whose results were all `Skipped` reported `total = 0`,
 * `done = 0%`, and raised nothing at all. `collectTestRunStats` in
 * `@hcengineering/test-management` drives both the buckets and the total off
 * `testRunStatuses`, and is unit tested against exactly that all-skipped case.
 * This wrapper exists only to supply the ambient UI client.
 */
export async function getTestRunStats (objectId: Ref<TestRun>): Promise<TestRunStats> {
  return await collectTestRunStats(getClient(), objectId)
}
