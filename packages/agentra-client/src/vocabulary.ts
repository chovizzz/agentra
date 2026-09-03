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

/**
 * The user-facing names for the platform's numeric enums.
 *
 * These live here rather than in each caller because the array **index is the
 * stored value** — `ISSUE_PRIORITIES[2] === 'High'` is not a display detail, it
 * is the encoding. Two copies drifting by one position would silently write the
 * wrong priority rather than fail.
 */
export const ISSUE_PRIORITIES = ['NoPriority', 'Urgent', 'High', 'Medium', 'Low'] as const
export type IssuePriorityName = (typeof ISSUE_PRIORITIES)[number]

export const TEST_CASE_TYPES = ['Functional', 'Performance', 'Regression', 'Security', 'Smoke', 'Usability'] as const
export type TestCaseTypeName = (typeof TEST_CASE_TYPES)[number]

export const TEST_CASE_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'] as const
export type TestCasePriorityName = (typeof TEST_CASE_PRIORITIES)[number]

export const TEST_CASE_STATUSES = ['Draft', 'ReadyForReview', 'FixReviewComments', 'Approved', 'Rejected'] as const
export type TestCaseStatusName = (typeof TEST_CASE_STATUSES)[number]
