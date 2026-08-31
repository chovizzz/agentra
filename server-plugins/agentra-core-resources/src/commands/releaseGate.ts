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
  type Class,
  type Doc,
  type DocumentQuery,
  type FindOptions,
  type FindResult,
  type Ref,
  type Status
} from '@hcengineering/core'
import products, { type ProductVersion } from '@hcengineering/products'
import requirements, { type Requirement, type RequirementStatus } from '@hcengineering/requirements'
import testManagement, { collectTestRunStats, testRunPassRate, type TestRun } from '@hcengineering/test-management'
import traceability, { type TraceLink } from '@hcengineering/traceability'
import tracker, { IssuePriority, type Issue } from '@hcengineering/tracker'

import { DONE_STATUS_CATEGORIES, TRACKER_ISSUE_STATUS_CLASS } from './completeCycle'

/**
 * The read surface the gate needs.
 *
 * Structural rather than `Client` / `TxOperations` so a test can hand in a
 * five-line fake, and so the two readers below can be different objects with
 * different authority.
 *
 * @public
 */
export interface ReleaseGateReader {
  findAll: <T extends Doc>(
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ) => Promise<FindResult<T>>
  findOne: <T extends Doc>(
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ) => Promise<T | undefined>
}

/**
 * The default bar for "required tests passed" (PRD REL-003).
 *
 * 100 rather than some softer number: REL-003 says the gate checks that the
 * REQUIRED tests passed, and "required" is already the selection — a test that
 * may fail is not a required test. Deployments that want a softer bar pass
 * `passRateThreshold` explicitly, so the choice is always visible in the audit
 * record rather than buried in a default.
 *
 * @public
 */
export const DEFAULT_RELEASE_PASS_RATE_THRESHOLD = 100

/**
 * Requirement statuses that do not block a release.
 *
 * `Validating` IS release ready: the requirement lifecycle is
 * `Validating -> Released`, and it is the release itself that performs that
 * last transition (`ReleaseProductVersion`'s write-back step). `Rejected` and
 * `Cancelled` are out of scope rather than done — they are not shipping, so
 * they cannot hold a release either.
 *
 * Everything else — `Draft`, `Reviewing`, `Approved`, `InDelivery` — is work
 * still in flight and blocks.
 *
 * @public
 */
export const RELEASE_READY_REQUIREMENT_STATUSES: readonly RequirementStatus[] = [
  'Validating',
  'Released',
  'Cancelled',
  'Rejected'
]

/**
 * The priorities that make an open issue a BLOCKING defect (PRD REL-003's
 * "阻断缺陷", i.e. P0 / P1).
 *
 * @public
 */
export const BLOCKING_DEFECT_PRIORITIES: readonly IssuePriority[] = [IssuePriority.Urgent, IssuePriority.High]

/**
 * Dimensions this build does NOT evaluate yet, reported explicitly.
 *
 * 🔴 LISTED RATHER THAN OMITTED. REL-003 names four dimensions and this build
 * can only answer three of them; a gate that quietly skipped the fourth would
 * report "passed" for a version with unmerged pull requests and nothing in the
 * audit record would say the question was never asked. The PullRequest module
 * lands with Task 17a; until then the report carries the gap.
 *
 * @public
 */
export const RELEASE_GATE_NOT_EVALUATED: readonly string[] = ['pull-request-merged', 'ci-status']

/**
 * @public
 */
export type ReleaseBlockerKind =
  | 'requirement-not-ready'
  | 'work-item-open'
  | 'blocking-defect'
  | 'test-run-missing'
  | 'test-run-no-verdicts'
  | 'test-run-below-threshold'
  | 'approval-missing'
  | 'restricted'

/**
 * One reason the version may not ship.
 *
 * ⚠️ A blocker with `kind: 'restricted'` carries NOTHING else — no object, no
 * count, no title, no severity. See {@link ReleaseGateReport}.
 *
 * @public
 */
export interface ReleaseBlocker extends Record<string, any> {
  kind: ReleaseBlockerKind
  object?: Ref<Doc>
  objectClass?: Ref<Class<Doc>>
  detail?: string
}

/**
 * @public
 */
export interface ReleaseGateReport extends Record<string, any> {
  version: Ref<ProductVersion>
  /**
   * The DECISION, computed over the global view.
   *
   * 🔴 Never recomputed from `blockers`. Those are the caller's filtered view;
   * deriving the verdict from them would let a release manager with no access
   * to one project ship a version that project is blocking (PRD REL-003).
   */
  passed: boolean
  /** `true` when a waiver overrode a failing gate (REL-006). */
  waived: boolean
  /** The blockers THIS caller may see. */
  blockers: ReleaseBlocker[]
  /**
   * `true` when at least one blocker was withheld from `blockers`.
   *
   * 🔴 The withheld ones are collapsed into ONE `restricted` entry and the
   * count is not reported. The number of blockers in a space the caller cannot
   * read is itself a cross-space side channel: it lets someone count the open
   * P0 defects in a project they have no access to.
   */
  restricted: boolean
  /**
   * Lowest per-run pass rate across the version's runs.
   *
   * `undefined` means NO DATA, not 0% — see {@link evaluateReleaseGate}.
   * Suppressed entirely when `restricted`, for the same side-channel reason.
   */
  passRate?: number
  passRateThreshold: number
  notEvaluated: readonly string[]
}

/**
 * The PERSISTABLE projection of a gate report: the verdict, with every
 * document identity removed.
 *
 * 🔴 THIS IS THE ONLY GATE SHAPE THAT MAY BE WRITTEN DOWN, and the reason is
 * that redaction cannot reach a persisted report. A `ReleaseGateReport`'s
 * `blockers` name Requirements, Issues and TestRuns in whatever spaces the
 * version's scope spans, filtered for ONE viewer. Storing that in
 * `ActivityInfoMessage.props` puts it in three places a read-path filter does
 * not own:
 *
 * - the `TxCreateDoc` in `DOMAIN_TX`, which keeps the ORIGINAL attributes
 *   forever — redacting the document changes nothing about the transaction that
 *   created it, and `SpaceSecurityMiddleware` gates `DOMAIN_TX` on
 *   `objectSpace` alone (`spaceSecurity.ts:613`), i.e. on the VERSION's space;
 * - the broadcast of that same transaction, which `BroadcastMiddleware` sends
 *   verbatim to every session the space targets;
 * - `CommandExecution.result` in the idempotency ledger, which is written into
 *   `core.space.Workspace` — a space `SpaceSecurityMiddleware` grants to EVERY
 *   account unconditionally (`spaceSecurity.ts:82` and `:535`).
 *
 * None of those can be filtered per reader, so the fix is not to filter but to
 * never write the sensitive part. Everything here is a fact about the REQUEST
 * and the DECISION — booleans, a threshold, the version the caller already
 * named — computed over the GLOBAL view and therefore identical for every
 * caller and every replay.
 *
 * ⚠️ `blockers` is `never[]` so the compiler refuses a `ReleaseGateReport`
 * wherever a verdict is required. It is still PRESENT (always `[]`) because the
 * client parses this shape as a `ReleaseGateReport`
 * (`plugins/products-resources/src/release.ts:282` demands
 * `Array.isArray(blockers)`); dropping the field would make the release page
 * fail closed and show nothing at all.
 *
 * @public
 */
export interface ReleaseGateVerdict extends Record<string, any> {
  version: Ref<ProductVersion>
  passed: boolean
  waived: boolean
  /** ALWAYS EMPTY — see the note above. */
  blockers: never[]
  /**
   * `true` when the GLOBAL evaluation found any blocker at all.
   *
   * 🔴 GLOBAL, NOT PER VIEWER, and that is what makes it storable. The live
   * report's `restricted` means "something was withheld from YOU"; this one
   * means "blockers existed and none of them are written down here", which is
   * true for every reader of this record by construction. It is also PRD §7.5's
   * one permitted line — a boolean, never a count.
   */
  restricted: boolean
  /**
   * Lowest per-run pass rate, carried only when `restricted` is false.
   *
   * ⚠️ `restricted` is false here exactly when the global blocker list was
   * empty, so this number is never a projection of a document the release was
   * blocked on. `undefined` still means NO DATA, not 0%.
   */
  passRate?: number
  passRateThreshold: number
  notEvaluated: readonly string[]
}

/**
 * Project a live report onto the shape that may be persisted.
 *
 * 🔴 AN ALLOW-LIST, NOT A DELETE-LIST. Spelling out the fields that survive is
 * what makes a field ADDED to `ReleaseGateReport` later default to "not
 * persisted". A `const { blockers, ...rest } = report` would default it the
 * other way, and the next sensitive field would reach `DOMAIN_TX` silently.
 *
 * ⚠️ VIEWER INDEPENDENT ON THE PERSISTENCE PATH, which is what lets two racing
 * callers converge on one record. `report.waived` and `report.passed` are taken
 * over the unfiltered list; `report.passRate` is viewer dependent in general
 * (the live report suppresses it under restriction) but not here: a report that
 * is persisted has `passed === true`, so `waived === false` implies the global
 * blocker list was empty, which implies nothing was withheld from any viewer.
 *
 * @public
 */
export function releaseGateVerdict (report: ReleaseGateReport): ReleaseGateVerdict {
  // `passed && blockers.length > 0` IS `waived` (see `evaluateReleaseGate`), so
  // the waiver flag is the global "were there blockers" answer.
  const restricted = report.waived
  return {
    version: report.version,
    passed: report.passed,
    waived: report.waived,
    blockers: [],
    restricted,
    ...(restricted || report.passRate === undefined ? {} : { passRate: report.passRate }),
    passRateThreshold: report.passRateThreshold,
    notEvaluated: report.notEvaluated
  }
}

/**
 * @public
 */
export interface ReleaseGateOptions {
  passRateThreshold?: number
  /**
   * Whether `Skipped` results leave the pass-rate denominator.
   *
   * Forwarded verbatim to {@link testRunPassRate}, which owns the policy. The
   * gate does not reinterpret it.
   */
  excludeSkipped?: boolean
  /** An approval document; its absence is itself a blocker (REL-003). */
  approval?: Ref<Doc>
  /** REL-006: an administrator waiver, with a reason, overriding the gate. */
  waiverReason?: string
}

/**
 * Evaluate release readiness for one product version.
 *
 * 🔴 TWO READERS, AND THEY ARE NOT INTERCHANGEABLE (PRD REL-003, decision 20).
 *
 * - `auditor` is UNFILTERED and decides `passed`. A gate computed over only the
 *   spaces the caller can read would let a release manager with no access to
 *   one project ship a version that project is blocking — the gate would report
 *   green because it could not see the red.
 * - `viewer` carries the CALLER's authority and decides what is echoed back.
 *   Every blocker is re-read through it; the ones that come back empty are
 *   collapsed into a single contentless `restricted` entry.
 *
 * Passing the same object as both is legal and means "no privileged view
 * available"; the decision is then only as complete as the caller's access,
 * which is why the command wires a real system reader.
 *
 * 🔴 THE PASS RATE COMES FROM {@link testRunPassRate}, NEVER FROM A LOCAL
 * `switch`. That helper answers the Skipped question explicitly and returns
 * `undefined` for an empty denominator. Both properties matter here:
 *
 * - a `switch` over `TestRunStatus` lets `Skipped` fall into `default` and be
 *   counted as a pass — Technical Spec §4 lists exactly this as the release
 *   gate's known failure mode;
 * - `undefined` is NO DATA. A run whose results are all `Skipped` has an empty
 *   denominator, and the gate must neither read that as 100% (ship a version
 *   nobody tested) nor as 0% (block a version on evidence that does not exist).
 *   It becomes its own `test-run-no-verdicts` blocker, which says what is
 *   actually wrong.
 *
 * The counts likewise come from {@link collectTestRunStats}, which loops over
 * `testRunStatuses`; hard-coding four status queries is what used to make an
 * all-`Skipped` run report `total = 0`.
 *
 * @public
 */
export async function evaluateReleaseGate (
  auditor: ReleaseGateReader,
  viewer: ReleaseGateReader,
  version: ProductVersion,
  options: ReleaseGateOptions = {}
): Promise<ReleaseGateReport> {
  const passRateThreshold = options.passRateThreshold ?? DEFAULT_RELEASE_PASS_RATE_THRESHOLD

  const blockers: ReleaseBlocker[] = []
  let passRate: number | undefined

  // ── Approval (REL-003). ──────────────────────────────────────────────────
  if (options.approval === undefined) {
    blockers.push({ kind: 'approval-missing', detail: 'no approval was supplied with the release request' })
  }

  // ── Scope: requirements targeting this version. ──────────────────────────
  // The scope link is the `targetVersion` ATTRIBUTE, not a `delivered-in` edge:
  // `requirements/src/types.ts` records that the edge was dropped in favour of
  // the attribute so that `ViewOptionsModel.groupBy` can group by it.
  const scoped = await auditor.findAll<Requirement>(requirements.masterTag.Requirement as Ref<any>, {
    targetVersion: version._id
  })
  for (const requirement of scoped) {
    if (!RELEASE_READY_REQUIREMENT_STATUSES.includes(requirement.status)) {
      blockers.push({
        kind: 'requirement-not-ready',
        object: requirement._id,
        objectClass: requirement._class as Ref<Class<Doc>>,
        detail: `status '${requirement.status}'`
      })
    }
  }

  // ── Scope: issues delivered in this version. ─────────────────────────────
  const issues = await findDeliveredIssues(auditor, version._id)
  const doneIssues = await findDoneIssueStatuses(auditor, issues)
  for (const issue of issues) {
    if (doneIssues.has(issue.status)) continue
    // ⚠️ ONE CLASS, TWO ROLES. Technical Spec §3.4 forbids a parallel Issue
    // class, so a Bug and a Work Item are both `tracker.class.Issue` and differ
    // only by TaskType — which is data, not something to branch on here. The
    // PRIORITY is what REL-003 actually asks about ("阻断缺陷" = P0/P1), so an
    // open Urgent/High issue is reported as a blocking defect and everything
    // else as unfinished work. Both block; the labels differ so the release
    // page can say which is which.
    blockers.push({
      kind: BLOCKING_DEFECT_PRIORITIES.includes(issue.priority) ? 'blocking-defect' : 'work-item-open',
      object: issue._id,
      objectClass: issue._class as Ref<Class<Doc>>,
      detail: `priority ${IssuePriority[issue.priority] ?? issue.priority}`
    })
  }

  // ── Required tests. ──────────────────────────────────────────────────────
  const runs = await auditor.findAll<TestRun>(testManagement.class.TestRun, { productVersion: version._id })
  if (runs.length === 0) {
    blockers.push({ kind: 'test-run-missing', detail: 'no test run is associated with this version' })
  }
  for (const run of runs) {
    const stats = await collectTestRunStats(auditor, run._id)
    const rate = testRunPassRate(stats, options.excludeSkipped)
    if (rate === undefined) {
      // 🔴 NO DATA, NOT 0%. An empty denominator means every result was
      // `Skipped` (or there are none at all). Reporting it as 0% would block on
      // evidence nobody produced; reporting it as 100% would ship a version
      // nobody tested. It gets its own blocker instead.
      blockers.push({
        kind: 'test-run-no-verdicts',
        object: run._id,
        objectClass: run._class as Ref<Class<Doc>>,
        detail: `${stats.total} result(s), ${stats.skipped} skipped, no pass/fail verdict`
      })
      continue
    }
    passRate = passRate === undefined ? rate : Math.min(passRate, rate)
    if (rate < passRateThreshold) {
      blockers.push({
        kind: 'test-run-below-threshold',
        object: run._id,
        objectClass: run._class as Ref<Class<Doc>>,
        detail: `pass rate ${rate.toFixed(2)}% < ${passRateThreshold}%`
      })
    }
  }

  // 🔴 THE VERDICT IS TAKEN HERE, over the UNFILTERED list.
  const waived = blockers.length > 0 && (options.waiverReason ?? '') !== ''
  const passed = blockers.length === 0 || waived

  const view = await redactBlockers(viewer, blockers)

  return {
    version: version._id,
    passed,
    waived,
    blockers: view.blockers,
    restricted: view.restricted,
    // Suppressed under restriction: a numeric rate derived from runs the caller
    // cannot read is the same side channel as a count.
    ...(view.restricted || passRate === undefined ? {} : { passRate }),
    passRateThreshold,
    notEvaluated: RELEASE_GATE_NOT_EVALUATED
  }
}

/**
 * Re-read every blocker through the CALLER's reader and drop what it cannot see.
 *
 * 🔴 THE WITHHELD ONES COLLAPSE INTO ONE ENTRY AND CARRY NO COUNT. "There are
 * 3 blockers you may not see" tells the reader how many open P0 defects live in
 * a project they have no access to; PRD §7.5 allows exactly one line,
 * "未通过：存在受限范围内的阻断项".
 *
 * ⚠️ Blockers with no `object` (`approval-missing`, `test-run-missing`) are
 * always visible: they are properties of the REQUEST and of this version, which
 * the caller is already reading, not of some other space's document.
 */
async function redactBlockers (
  viewer: ReleaseGateReader,
  blockers: readonly ReleaseBlocker[]
): Promise<{ blockers: ReleaseBlocker[], restricted: boolean }> {
  const visible: ReleaseBlocker[] = []
  let restricted = false
  for (const blocker of blockers) {
    if (blocker.object === undefined || blocker.objectClass === undefined) {
      visible.push(blocker)
      continue
    }
    const readable = await viewer.findOne<Doc>(blocker.objectClass, { _id: blocker.object })
    if (readable !== undefined) {
      visible.push(blocker)
    } else {
      restricted = true
    }
  }
  if (restricted) {
    visible.push({ kind: 'restricted' })
  }
  return { blockers: visible, restricted }
}

/**
 * The issues delivered in this version, via `delivered-in` trace edges.
 *
 * The requirement side uses the `targetVersion` attribute instead (see above);
 * for issues the edge IS the record, and `traceLinkMatrix` allows
 * `WorkItem | Bug --delivered-in--> ProductVersion`.
 */
async function findDeliveredIssues (auditor: ReleaseGateReader, version: Ref<ProductVersion>): Promise<Issue[]> {
  const edges = await auditor.findAll<TraceLink>(traceability.class.TraceLink, {
    // `docB` is the persisted name of the TARGET endpoint — the only spelling
    // the Postgres relation schema promotes to an indexed column.
    docB: version as Ref<Doc>,
    kind: 'delivered-in',
    state: 'active'
  })
  const ids = [...new Set(edges.map((it) => it.docA as Ref<Issue>))]
  if (ids.length === 0) {
    return []
  }
  return [...(await auditor.findAll<Issue>(tracker.class.Issue, { _id: { $in: ids } }))]
}

/**
 * Which statuses among these issues' mean "finished".
 *
 * ⚠️ Answered from `Status.category`, never from the status name: a tracker
 * project type may rename statuses and add its own, and only the category
 * survives that. Same rule as `completeCycle`, and the category list is
 * imported from there rather than re-spelled.
 *
 * ⚠️ A status document that cannot be read counts as NOT done, so an
 * unreadable status blocks rather than silently waving a version through.
 */
async function findDoneIssueStatuses (auditor: ReleaseGateReader, issues: Issue[]): Promise<Set<Ref<Status>>> {
  const done = new Set<Ref<Status>>()
  if (issues.length === 0) {
    return done
  }
  const statusIds = [...new Set(issues.map((it) => it.status))]
  const statuses = await auditor.findAll<Status>(TRACKER_ISSUE_STATUS_CLASS, { _id: { $in: statusIds } })
  for (const status of statuses) {
    if (status.category !== undefined && DONE_STATUS_CATEGORIES.includes(status.category as Ref<Doc>)) {
      done.add(status._id)
    }
  }
  return done
}

/**
 * Nothing in this module writes. Exported so the command can name the class it
 * reads without importing `products` twice.
 *
 * @public
 */
export const PRODUCT_VERSION_CLASS = products.class.ProductVersion
