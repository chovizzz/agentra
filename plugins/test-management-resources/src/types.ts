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
import { type Asset, type IntlString } from '@hcengineering/platform'

import testManagement, { TestCaseStatus, TestRunStatus, testRunStatuses } from '@hcengineering/test-management'

/** @public */
export const defaultTestCaseStatuses = [
  TestCaseStatus.Draft,
  TestCaseStatus.ReadyForReview,
  TestCaseStatus.FixReviewComments,
  TestCaseStatus.Approved,
  TestCaseStatus.Rejected
]

/** @public */
export const testCaseStatusAssets: Record<TestCaseStatus, { icon: Asset, label: IntlString }> = {
  [TestCaseStatus.Draft]: { icon: testManagement.icon.StatusDraft, label: testManagement.string.StatusDraft },
  [TestCaseStatus.ReadyForReview]: {
    icon: testManagement.icon.StatusReview,
    label: testManagement.string.StatusReview
  },
  [TestCaseStatus.FixReviewComments]: {
    icon: testManagement.icon.StatusReviewComments,
    label: testManagement.string.StatusReviewComments
  },
  [TestCaseStatus.Approved]: { icon: testManagement.icon.StatusApproved, label: testManagement.string.StatusApproved },
  [TestCaseStatus.Rejected]: { icon: testManagement.icon.StatusRejected, label: testManagement.string.StatusRejected }
}

/**
 * ⚠️ This list is what the status selector renders. Adding an enum member
 * WITHOUT adding it here compiles cleanly and silently makes the new status
 * unreachable from the UI — which is exactly what would have happened to
 * `Skipped`. It is now derived from the enum's own ordered list so the next
 * append cannot be forgotten here.
 *
 * @public
 */
export const defaultTestRunStatuses = [...testRunStatuses]

/** @public */
export const testRunStatusAssets: Record<TestRunStatus, { icon: Asset, label: IntlString }> = {
  [TestRunStatus.Untested]: {
    icon: testManagement.icon.StatusNonTested,
    label: testManagement.string.StatusNonTested
  },
  [TestRunStatus.Blocked]: {
    icon: testManagement.icon.StatusBlocked,
    label: testManagement.string.StatusBlocked
  },
  [TestRunStatus.Passed]: {
    icon: testManagement.icon.StatusPassed,
    label: testManagement.string.StatusPassed
  },
  [TestRunStatus.Failed]: {
    icon: testManagement.icon.StatusFailed,
    label: testManagement.string.StatusFailed
  },
  // `Record<TestRunStatus, ...>` makes this map the ONE consumer the compiler
  // forces you to update when a member is appended. Keep it that way.
  [TestRunStatus.Skipped]: {
    icon: testManagement.icon.StatusSkipped,
    label: testManagement.string.StatusSkipped
  }
}
