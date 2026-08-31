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

import { Attachment } from '@hcengineering/attachment'
import { Employee } from '@hcengineering/contact'
import {
  Doc,
  type Blob,
  type CollectionSize,
  type Rank,
  type Ref,
  type Markup,
  TypedSpace,
  MarkupBlobRef,
  AttachedDoc,
  Timestamp
} from '@hcengineering/core'
import { type ProductVersion } from '@hcengineering/products'
import { IconProps } from '@hcengineering/view'

/** @public */
export enum TestCaseType {
  Functional,
  Performance,
  Regression,
  Security,
  Smoke,
  Usability
}

/** @public */
export const testCaseTypes = [
  TestCaseType.Functional,
  TestCaseType.Performance,
  TestCaseType.Regression,
  TestCaseType.Security,
  TestCaseType.Smoke,
  TestCaseType.Usability
]

/** @public */
export enum TestCasePriority {
  Low,
  Medium,
  High,
  Urgent
}

/** @public */
export const testCasePriorities = [
  TestCasePriority.Low,
  TestCasePriority.Medium,
  TestCasePriority.High,
  TestCasePriority.Urgent
]

/** @public */
export enum TestCaseStatus {
  Draft,
  ReadyForReview,
  FixReviewComments,
  Approved,
  Rejected
}

/** @public */
export interface TestProject extends TypedSpace, IconProps {
  fullDescription?: Markup
}

/** @public */
export interface TestSuite extends Doc {
  space: Ref<TestProject>
  name: string
  description?: string
  parent: Ref<TestSuite>
  testCases?: CollectionSize<TestCase>
}

/** @public */
export interface TestCase extends AttachedDoc<TestSuite, 'testCases', TestProject> {
  name: string
  description: MarkupBlobRef | null
  type: TestCaseType
  priority: TestCasePriority
  status: TestCaseStatus
  assignee: Ref<Employee>
  attachments?: CollectionSize<Attachment>
  comments?: number

  /**
   * Structured content added by Agentra. All three are OPTIONAL so that every
   * test case written before this migration stays a valid `TestCase`.
   */
  preconditions?: Markup
  automationKey?: string
  /**
   * Monotonic revision counter, bumped whenever structured content changes.
   * `undefined` means "never versioned"; readers must treat it as {@link INITIAL_TEST_CASE_VERSION}.
   */
  version?: number
  steps?: CollectionSize<TestStep>
  snapshots?: CollectionSize<TestCaseSnapshot>
}

/**
 * One reproducible action inside a test case.
 *
 * 🔴 `action` / `testData` / `expectedResult` are INLINE {@link Markup}, not
 * `MarkupBlobRef`. A blob ref means one object-storage object per field, and
 * `collaborator` mints a NEW timestamped JSON blob on every collaborative save
 * while `server-plugins/collaboration-resources`' `OnDelete` only removes the
 * ydoc — the JSON blobs are never reclaimed. At the PRD capacity assumption
 * (10k cases x ~8 steps x 3 fields) that is 240k permanently live blobs before
 * a single edit. `Training.description` and `TestSuite.description` are the
 * in-tree precedent for inline markup on a small rich-text field.
 *
 * @public
 */
export interface TestStep extends AttachedDoc<TestCase, 'steps', TestProject> {
  rank: Rank
  action: Markup
  testData?: Markup
  expectedResult: Markup
}

/**
 * A step as frozen into a {@link TestCaseSnapshot}.
 *
 * Deliberately a plain inline array element and NOT an `AttachedDoc`: a
 * snapshot is immutable, so its steps never need their own identity, their own
 * rank arithmetic or their own collection counters — and a 10k x 10 snapshot
 * matrix would otherwise multiply into 800k documents.
 *
 * @public
 */
export interface TestStepData {
  action: Markup
  testData?: Markup
  expectedResult: Markup
}

/**
 * Attachment metadata copied into a snapshot.
 *
 * 🔴 The BLOB IS NOT COPIED — `file` names the very same object the live
 * `Attachment` points at. That is why deleting an attachment referenced by a
 * snapshot has to be refused server side: unlike `card`, which shares blobs the
 * same way but ships no reference counting in `OnAttachmentDelete`, a snapshot
 * that loses its bytes is a silently corrupted audit record.
 *
 * @public
 */
export interface TestSnapshotAttachment {
  name: string
  file: Ref<Blob>
  type: string
  size: number
  lastModified?: Timestamp
}

/**
 * An immutable frozen revision of a {@link TestCase}.
 *
 * Deduplicated on `(attachedTo, version)`: ONE snapshot per case revision,
 * shared by every Test Plan Item and Test Result that pins it. Created lazily —
 * only when something first needs to pin that revision.
 *
 * 🔴 NOT `core.mixin.VersionableClass`. `VersioningMiddleware.findAll` checks
 * only that the mixin EXISTS (never `enabled`) and then forces `isLatest: true`
 * onto every query, so declaring it on `TestCase` would make every pre-existing
 * case vanish from every list; on top of that `cloneCard` zeroes all Collection
 * attributes, so steps would not be cloned at all.
 *
 * @public
 */
export interface TestCaseSnapshot extends AttachedDoc<TestCase, 'snapshots', TestProject> {
  version: number
  name: string
  /** The blob ref the case carried at snapshot time. Bytes are shared, not copied. */
  description: MarkupBlobRef | null
  preconditions?: Markup
  type: TestCaseType
  priority: TestCasePriority
  steps: TestStepData[]
  attachmentsMeta?: TestSnapshotAttachment[]
}

/** @public */
export const INITIAL_TEST_CASE_VERSION = 1

/**
 * A named non-sensitive key/value pair on a {@link TestEnvironment}.
 *
 * @public
 */
export interface TestEnvironmentVariable {
  key: string
  value: string
}

/**
 * Where a test run executed.
 *
 * Archived rather than deleted: historical `TestRun.environment` refs must not
 * dangle.
 *
 * @public
 */
export interface TestEnvironment extends Doc {
  space: Ref<TestProject>
  name: string
  description?: string
  variables?: TestEnvironmentVariable[]
  archived: boolean
}

/**
 * A CI build a test run executed against.
 *
 * 🔴 `externalKey` is the idempotent match key, shaped `${provider}:${pipelineId}`
 * — NOT `commitSha`, because one commit produces many CI runs and keying on it
 * would collapse them into a single Build. Logical uniqueness is
 * `(space, externalKey)`.
 *
 * @public
 */
export interface Build extends Doc {
  space: Ref<TestProject>
  name: string
  externalKey: string
  productVersion?: Ref<ProductVersion>
  commitSha?: string
  ciUrl?: string
  createdOnCi?: Timestamp
}

/**
 * @public
 */
export interface TestRun extends Doc {
  name: string
  description: MarkupBlobRef | null
  dueDate?: Timestamp
  results?: CollectionSize<TestResult>

  /**
   * ⚠️ Execution context is FLAT, not a nested `TestRunContext` object.
   * Huly's filters (`ClassFilters`), `orderBy`, `@Index` and attribute
   * presenters all address TOP-LEVEL attribute names only; nesting these would
   * silently kill "filter runs by build" and "sort runs by environment".
   */
  testPlan?: Ref<TestPlan>
  productVersion?: Ref<ProductVersion>
  build?: Ref<Build>
  environment?: Ref<TestEnvironment>
  /**
   * The delivery cycle this run belongs to.
   *
   * Typed `Ref<Doc>` on purpose: the cycle module is owned elsewhere and a hard
   * dependency here would couple two independently evolving packages. Narrow it
   * to `Ref<Cycle>` when the modules are wired together.
   */
  cycle?: Ref<Doc>
  executedBy?: Ref<Employee>
  startedOn?: Timestamp
  finishedOn?: Timestamp
  externalRunId?: string
}

/** @public */
export enum TestRunStatus {
  Untested,
  Blocked,
  Passed,
  Failed,
  /**
   * 🔴 APPENDED, never inserted. `TestRunStatus` is a NUMERIC enum whose values
   * are persisted verbatim in `TestResult.status`; renumbering the members
   * would silently rewrite history (every stored `Passed` would read back as
   * something else). Appending at 4 needs no data migration at all.
   */
  Skipped
}

/**
 * Every status, in display order.
 *
 * Exported from the descriptor package so that server-side consumers (release
 * gates) and the UI share ONE list instead of each hard-coding four values.
 *
 * @public
 */
export const testRunStatuses: TestRunStatus[] = [
  TestRunStatus.Untested,
  TestRunStatus.Blocked,
  TestRunStatus.Passed,
  TestRunStatus.Failed,
  TestRunStatus.Skipped
]

// TODO: Refactor to associations
/** @public */
export interface TestResult extends AttachedDoc<TestRun, 'results', TestProject> {
  name: string
  testCase: Ref<TestCase>
  /** The frozen case revision this result was produced against. */
  snapshot?: Ref<TestCaseSnapshot>
  testSuite?: Ref<TestSuite>
  status?: TestRunStatus
  /**
   * Why this result is {@link TestRunStatus.Blocked}.
   *
   * 🔴 MANDATORY WHENEVER `status === Blocked`, enforced server side by
   * `server-plugins/test-management`. A blocked result is a claim that
   * SOMETHING ELSE prevented the verdict; without the reason it is
   * indistinguishable from "nobody got round to it", and a release gate reading
   * the run cannot tell an environment outage from an untested feature.
   *
   * Optional in the TYPE so that every result written before this field existed
   * stays a valid `TestResult`; the guard only fires on writes that reach
   * `Blocked`.
   */
  blockedReason?: string
  description: MarkupBlobRef | null
  assignee?: Ref<Employee>
  attachments?: CollectionSize<Attachment>
  comments?: number
}

/** @public */
export interface TestPlan extends Doc {
  name: string
  description: MarkupBlobRef | null
  items?: CollectionSize<TestPlanItem>
}

/** @public */
export interface TestPlanItem extends AttachedDoc<TestPlan, 'items', TestProject> {
  testCase: Ref<TestCase>
  /**
   * The pinned case revision. A REFERENCE, not "a version number plus rebuild
   * logic": rebuilding from a number would re-read whatever the case says today.
   */
  snapshot?: Ref<TestCaseSnapshot>
  testSuite?: Ref<TestSuite>
  assignee?: Ref<Employee>
}
