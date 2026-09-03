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

import attachment, { type Attachment } from '@hcengineering/attachment'
import {
  SortingOrder,
  generateId,
  type Class,
  type Doc,
  type DocumentQuery,
  type FindOptions,
  type FindResult,
  type Rank,
  type Ref,
  type TxOperations
} from '@hcengineering/core'
import { makeRank } from '@hcengineering/rank'

import testManagement from './plugin'
import {
  INITIAL_TEST_CASE_VERSION,
  TestCaseStatus,
  testRunStatuses,
  TestRunStatus,
  type Build,
  type TestCase,
  type TestCaseSnapshot,
  type TestProject,
  type TestRun,
  type TestSnapshotAttachment,
  type TestStep,
  type TestStepData
} from './types'

/**
 * The read surface these helpers need.
 *
 * Structural rather than `Client`, so a test can hand in a five-line fake and
 * so callers may pass either a `TxOperations` or a raw platform client.
 *
 * @public
 */
export interface TestManagementReader {
  findAll: <T extends Doc>(
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ) => Promise<FindResult<T>>
}

/**
 * The rank of the LAST step of one test case, or `undefined` when it has none.
 *
 * 🔴 WHY THIS EXISTS AT ALL — i.e. why `RANK_AUTO` is not usable here.
 * `RankMiddleware.setRank` (`foundations/server/packages/middleware/src/rank.ts`)
 * resolves `RANK_AUTO` by finding the last document of that CLASS **in the
 * space**, with no `attachedTo` term. Every `TestStep` in a `TestProject` shares
 * one space, so the server would hand step 1 of case B a rank derived from the
 * last step of case A. Ordering inside a case would be arbitrary and, worse,
 * unstable. `plugins/document-resources/src/utils.ts` computes ranks client
 * side for exactly this reason.
 *
 * @public
 */
export async function getLastStepRank (
  client: TestManagementReader,
  testCase: Ref<TestCase>
): Promise<Rank | undefined> {
  const [last] = await client.findAll<TestStep>(
    testManagement.class.TestStep,
    { attachedTo: testCase },
    { sort: { rank: SortingOrder.Descending }, limit: 1, projection: { rank: 1 } }
  )
  return last?.rank
}

/**
 * Append one step to a test case, computing its rank client side.
 *
 * @public
 */
export async function addTestStep (
  client: TxOperations,
  testCase: TestCase,
  data: TestStepData
): Promise<Ref<TestStep>> {
  const lastRank = await getLastStepRank(client, testCase._id)
  const rank = makeRank(lastRank, undefined)
  return await client.addCollection(
    testManagement.class.TestStep,
    testCase.space,
    testCase._id,
    testManagement.class.TestCase,
    'steps',
    { rank, ...data }
  )
}

/**
 * The rank that places a step between `before` and `after`.
 *
 * Either side may be `undefined`, meaning "the end of the list on that side".
 *
 * @public
 */
export function rankBetween (before: Rank | undefined, after: Rank | undefined): Rank {
  return makeRank(before, after)
}

/**
 * Bump a test case revision.
 *
 * Callers do this whenever STRUCTURED content changes (steps, preconditions).
 * Snapshots are keyed on the resulting number, so a bump is what makes the next
 * pin freeze something new.
 *
 * @public
 */
export function nextTestCaseVersion (testCase: Pick<TestCase, 'version'>): number {
  return (testCase.version ?? INITIAL_TEST_CASE_VERSION) + 1
}

/** @public */
export function currentTestCaseVersion (testCase: Pick<TestCase, 'version'>): number {
  return testCase.version ?? INITIAL_TEST_CASE_VERSION
}

/**
 * Freeze a test case revision, or return the snapshot that already froze it.
 *
 * LAZY: nothing calls this on edit. It runs the first time a Test Plan Item or
 * a Test Result needs to pin `(case, version)`, and every later pin of the same
 * pair reuses the one document. That is what keeps the snapshot table at
 * O(cases x revisions) instead of O(cases x plans x runs).
 *
 * CONCURRENCY: the create is wrapped in `apply().notMatch(...)`, so two clients
 * racing on the same pair produce ONE snapshot — the loser's `TxApplyIf` fails
 * its precondition server side and it re-reads the winner's document. A plain
 * "find, then create" would have both find nothing and both insert.
 *
 * @public
 */
export async function ensureTestCaseSnapshot (
  client: TxOperations,
  testCase: TestCase,
  steps?: TestStep[]
): Promise<Ref<TestCaseSnapshot>> {
  const version = currentTestCaseVersion(testCase)

  const existing = await findTestCaseSnapshot(client, testCase._id, version)
  if (existing !== undefined) {
    return existing._id
  }

  const orderedSteps =
    steps ??
    (await client.findAll<TestStep>(
      testManagement.class.TestStep,
      { attachedTo: testCase._id },
      { sort: { rank: SortingOrder.Ascending } }
    ))

  const attachments = await client.findAll<Attachment>(attachment.class.Attachment, { attachedTo: testCase._id })

  const _id = generateId<TestCaseSnapshot>()
  const ops = client.apply(`test-management-snapshot-${testCase._id}-${version}`)
  ops.notMatch(testManagement.class.TestCaseSnapshot, { attachedTo: testCase._id, version })
  await ops.addCollection(
    testManagement.class.TestCaseSnapshot,
    testCase.space,
    testCase._id,
    testManagement.class.TestCase,
    'snapshots',
    {
      version,
      name: testCase.name,
      // The blob ref is carried over verbatim: the snapshot SHARES the bytes,
      // it does not copy them.
      description: testCase.description,
      preconditions: testCase.preconditions,
      type: testCase.type,
      priority: testCase.priority,
      steps: orderedSteps.map(toStepData),
      attachmentsMeta: attachments.map(toAttachmentMeta)
    },
    _id
  )
  const { result } = await ops.commit()
  if (result) {
    return _id
  }

  // Lost the race. The winner's document is the answer; there is exactly one.
  const winner = await findTestCaseSnapshot(client, testCase._id, version)
  if (winner === undefined) {
    throw new Error(`test-management: snapshot for '${testCase._id}' v${version} could neither be created nor found`)
  }
  return winner._id
}

/** @public */
export async function findTestCaseSnapshot (
  client: TestManagementReader,
  testCase: Ref<TestCase>,
  version: number
): Promise<TestCaseSnapshot | undefined> {
  const [found] = await client.findAll<TestCaseSnapshot>(
    testManagement.class.TestCaseSnapshot,
    { attachedTo: testCase, version },
    { limit: 1 }
  )
  return found
}

/** @public */
export function toStepData (step: TestStep | TestStepData): TestStepData {
  return {
    action: step.action,
    testData: step.testData,
    expectedResult: step.expectedResult
  }
}

/** @public */
export function toAttachmentMeta (value: Attachment): TestSnapshotAttachment {
  return {
    name: value.name,
    file: value.file,
    type: value.type,
    size: value.size,
    lastModified: value.lastModified
  }
}

/**
 * The `TestCase` fields an `Approved` case freezes.
 *
 * 🔴 THIS LIST IS THE CONTRACT BETWEEN THE CLIENT AND THE SERVER, and it lives
 * here — in the plugin both of them already depend on — so there is exactly one
 * of it. A field the panel greys out but the pipeline accepts is a lie; a field
 * the pipeline refuses but the panel offers is a dead control. QA-T019 says an
 * attempt to change an approved case is REFUSED, so both sides have to agree on
 * what "change" means.
 *
 * ⚠️ WHAT IS DELIBERATELY ABSENT, and why:
 *
 *  - `status` — it is the ESCAPE HATCH. Freezing it would make `Approved` a
 *    terminal state with no way back into review, i.e. a trap rather than a
 *    gate. Moving the case to `FixReviewComments` is exactly how an editor is
 *    supposed to reopen it, and that move is audited like any other.
 *  - `version` — {@link registerTestCaseEdit} bumps it, and `VersioningMiddleware`
 *    writes `readonly` / `isLatest` on its own. Platform bookkeeping is not a
 *    user edit.
 *  - `assignee` — reassigning a reviewer does not change what the case
 *    ASSERTS, and freezing it would break the one client rule this list exists
 *    to keep: `models/test-management`'s list and table viewlets render
 *    `assignee` (and `status`) as INLINE editors, and neither viewlet can be
 *    made read-only from the test case panel. Freezing it would produce a
 *    control the user can click and a server that refuses the save.
 *  - `attachments` / `comments` / `steps` / `snapshots` — collection counters,
 *    maintained by the server whenever a comment, an attachment or a snapshot
 *    is added. An approved case must keep receiving those.
 *  - the `TestStep` documents themselves — they are separate docs on their own
 *    path, which {@link registerTestCaseEdit} already handles by sending the
 *    case back to `FixReviewComments`. Freezing them here would refuse the step
 *    write BEFORE that downgrade lands and break a shipped behaviour.
 *
 * @public
 */
export const APPROVED_TEST_CASE_FROZEN_FIELDS: readonly string[] = [
  'name',
  'description',
  'preconditions',
  'type',
  'priority',
  'automationKey'
]

/**
 * Whether this case's content may be edited in place.
 *
 * @public
 */
export function isTestCaseContentFrozen (testCase: Pick<TestCase, 'status'>): boolean {
  return testCase.status === TestCaseStatus.Approved
}

/**
 * Whether `field` is one of {@link APPROVED_TEST_CASE_FROZEN_FIELDS}.
 *
 * @public
 */
export function isFrozenTestCaseField (field: string): boolean {
  return APPROVED_TEST_CASE_FROZEN_FIELDS.includes(field)
}

/**
 * Record that a test case's STRUCTURED content changed.
 *
 * Two effects, and they belong together:
 *
 *  1. the revision counter advances, so the NEXT pin freezes something new
 *     while every snapshot already taken keeps describing the case as it was;
 *  2. an `Approved` case falls back to `FixReviewComments`.
 *
 * (2) is PRD §5.4's rule and the only new state transition this work adds — the
 * `TestCaseStatus` enum upstream already spells out the whole review ladder, so
 * nothing is redefined here.
 *
 * ⚠️ SCOPE: this is the STEP path. The case's OWN content fields are frozen
 * while it is `Approved` — see {@link APPROVED_TEST_CASE_FROZEN_FIELDS} and
 * `SnapshotGuardMiddleware` — so the two paths differ on purpose: a step edit
 * reopens the case, an attribute edit is refused until someone reopens it.
 *
 * @public
 */
export async function registerTestCaseEdit (client: TxOperations, testCase: TestCase): Promise<void> {
  const update: { version: number, status?: TestCaseStatus } = { version: nextTestCaseVersion(testCase) }
  if (testCase.status === TestCaseStatus.Approved) {
    update.status = TestCaseStatus.FixReviewComments
  }
  await client.update(testCase, update)
}

/**
 * The idempotent match key for a CI build.
 *
 * 🔴 NOT `commitSha`. One commit is built many times (retries, matrix legs,
 * nightly rebuilds); keying on it would fold all of those into one `Build` and
 * make "which build did this run execute against" unanswerable.
 *
 * @public
 */
export function buildExternalKey (provider: string, pipelineId: string): string {
  return `${provider}:${pipelineId}`
}

/**
 * Find-or-create a `Build` by its logical key `(space, externalKey)`.
 *
 * @public
 */
export async function ensureBuild (
  client: TxOperations,
  space: Ref<TestProject>,
  externalKey: string,
  data: Omit<Build, keyof Doc | 'space' | 'externalKey'>
): Promise<Ref<Build>> {
  const existing = await findBuild(client, space, externalKey)
  if (existing !== undefined) {
    return existing._id
  }

  const _id = generateId<Build>()
  const ops = client.apply(`test-management-build-${space}-${externalKey}`)
  ops.notMatch(testManagement.class.Build, { space, externalKey })
  await ops.createDoc(testManagement.class.Build, space, { externalKey, ...data }, _id)
  const { result } = await ops.commit()
  if (result) {
    return _id
  }

  const winner = await findBuild(client, space, externalKey)
  if (winner === undefined) {
    throw new Error(`test-management: build '${externalKey}' could neither be created nor found`)
  }
  return winner._id
}

/** @public */
export async function findBuild (
  client: TestManagementReader,
  space: Ref<TestProject>,
  externalKey: string
): Promise<Build | undefined> {
  const [found] = await client.findAll<Build>(testManagement.class.Build, { space, externalKey }, { limit: 1 })
  return found
}

/**
 * Per-status counts for one test run.
 *
 * `completed` is the Passed bucket — the name predates this file and is kept so
 * the existing progress bar keeps compiling.
 *
 * @public
 */
export interface TestRunStats {
  readonly done: number
  readonly total: number
  readonly untested: number
  readonly blocked: number
  readonly completed: number
  readonly failed: number
  readonly skipped: number
}

/**
 * Count the results of one run, by status.
 *
 * 🔴 THIS LOOPS OVER {@link testRunStatuses}; it does not hard-code a list.
 * The version it replaced issued four literal queries and summed those four
 * into `total`, which meant a run whose results were ALL `Skipped` reported
 * `total = 0`, `done = 0%` and raised nothing — a silent wrong number on the
 * screen. Driving both the buckets and the total off the enum's own list makes
 * the next appended status a compile-and-go change instead of a repeat of that
 * bug.
 *
 * @public
 */
export async function collectTestRunStats (client: TestManagementReader, run: Ref<TestRun>): Promise<TestRunStats> {
  const counts = new Map<TestRunStatus, number>()
  for (const status of testRunStatuses) {
    counts.set(status, await countResults(client, run, status))
  }
  return summariseTestRunStats(counts)
}

/**
 * The pure half of {@link collectTestRunStats}, so the arithmetic is testable
 * without a client.
 *
 * @public
 */
export function summariseTestRunStats (counts: Map<TestRunStatus, number> | Record<number, number>): TestRunStats {
  const get = (status: TestRunStatus): number => (counts instanceof Map ? counts.get(status) : counts[status]) ?? 0

  const untested = get(TestRunStatus.Untested)
  const blocked = get(TestRunStatus.Blocked)
  const completed = get(TestRunStatus.Passed)
  const failed = get(TestRunStatus.Failed)
  const skipped = get(TestRunStatus.Skipped)

  // Skipped counts towards the total: it is a DECIDED outcome ("we chose not to
  // run this"), so leaving it out would keep the progress bar short of 100% for
  // a run that is finished, and — when everything is skipped — divide by zero.
  const total = testRunStatuses.reduce((sum, status) => sum + get(status), 0)

  // "Done" is everything that is no longer awaiting a verdict.
  const done = total > 0 ? ((total - untested) * 100) / total : 0

  return { done, total, untested, blocked, completed, failed, skipped }
}

/**
 * Pass rate, with the Skipped question answered EXPLICITLY.
 *
 * 🔴 A release gate must not compute this ad hoc. "Skipped" is neither a pass
 * nor a failure, so whether it belongs in the denominator is a POLICY choice —
 * and the failure mode of leaving it implicit is a `switch` whose `default`
 * branch quietly treats a skipped test as a passing one. `excludeSkipped`
 * defaults to `true`: a test nobody ran is not evidence of quality, so it is
 * left out of the denominator rather than counted against (or for) the build.
 *
 * Returns `undefined` when the denominator is empty — "no data" is not "0%",
 * and a gate that cannot tell the two apart will block or pass the wrong build.
 *
 * @public
 */
export function testRunPassRate (stats: TestRunStats, excludeSkipped: boolean = true): number | undefined {
  const denominator = excludeSkipped ? stats.total - stats.skipped : stats.total
  if (denominator <= 0) {
    return undefined
  }
  return (stats.completed * 100) / denominator
}

async function countResults (client: TestManagementReader, run: Ref<TestRun>, status: TestRunStatus): Promise<number> {
  const results = await client.findAll(
    testManagement.class.TestResult,
    { attachedTo: run, status },
    { limit: 0, total: true }
  )
  return results.total > 0 ? results.total : 0
}
