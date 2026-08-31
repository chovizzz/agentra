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

import core, { type Doc, type Ref } from '@hcengineering/core'
import products, { ProductVersionState, type ProductVersion } from '@hcengineering/products'
import requirements, { type Requirement, type RequirementStatus } from '@hcengineering/requirements'
import testManagement, { TestRunStatus, testRunPassRate, type TestRun } from '@hcengineering/test-management'
import traceability, { type TraceLink } from '@hcengineering/traceability'
import tracker, { IssuePriority, type Issue } from '@hcengineering/tracker'

import { DONE_STATUS_CATEGORIES, TRACKER_ISSUE_STATUS_CLASS } from '../commands/completeCycle'
import {
  DEFAULT_RELEASE_PASS_RATE_THRESHOLD,
  RELEASE_GATE_NOT_EVALUATED,
  RELEASE_READY_REQUIREMENT_STATUSES,
  evaluateReleaseGate,
  type ReleaseGateReader
} from '../commands/releaseGate'
import { MemoryDb, makeHarness, seed, type Harness } from './harness'

const SPACE = 'product-1' as Ref<any>
const VERSION = 'pvpvpvpvpvpvpvpvpvpvpvp1' as Ref<ProductVersion>
const RUN = 'runrunrunrunrunrunrunrn1' as Ref<TestRun>
const RUN_TWO = 'runrunrunrunrunrunrunrn2' as Ref<TestRun>
const STATUS_TODO = 'status-todo' as Ref<any>
const STATUS_DONE = 'status-done' as Ref<any>

function seedVersion (db: MemoryDb, state: ProductVersionState = ProductVersionState.ReleaseCandidate): ProductVersion {
  return seed<ProductVersion>(db, {
    _id: VERSION,
    _class: products.class.ProductVersion,
    space: SPACE,
    state,
    parent: products.ids.NoParentVersion
  } as any)
}

function seedRequirement (db: MemoryDb, id: string, status: RequirementStatus): Requirement {
  return seed<Requirement>(db, {
    _id: id as Ref<any>,
    _class: requirements.masterTag.Requirement as Ref<any>,
    space: SPACE,
    status,
    targetVersion: VERSION
  } as any)
}

function seedResult (db: MemoryDb, id: string, run: Ref<TestRun>, status: TestRunStatus): void {
  seed(db, {
    _id: id as Ref<any>,
    _class: testManagement.class.TestResult,
    space: SPACE,
    attachedTo: run,
    status
  } as any)
}

function seedRun (db: MemoryDb, id: Ref<TestRun> = RUN): void {
  seed<TestRun>(db, { _id: id, _class: testManagement.class.TestRun, space: SPACE, productVersion: VERSION } as any)
}

function seedStatuses (db: MemoryDb): void {
  seed(db, { _id: STATUS_TODO, _class: TRACKER_ISSUE_STATUS_CLASS, category: 'task:statusCategory:Active' } as any)
  seed(db, { _id: STATUS_DONE, _class: TRACKER_ISSUE_STATUS_CLASS, category: DONE_STATUS_CATEGORIES[0] } as any)
}

function seedDeliveredIssue (db: MemoryDb, id: string, status: Ref<any>, priority: IssuePriority): Issue {
  const issue = seed<Issue>(db, {
    _id: id as Ref<any>,
    _class: tracker.class.Issue,
    space: SPACE,
    status,
    priority
  } as any)
  seed<TraceLink>(db, {
    _id: `edge-${id}` as Ref<any>,
    _class: traceability.class.TraceLink,
    space: core.space.Workspace,
    docA: issue._id,
    sourceClass: tracker.class.Issue,
    docB: VERSION as Ref<Doc>,
    targetClass: products.class.ProductVersion,
    kind: 'delivered-in',
    sourceBaseId: issue._id,
    targetBaseId: VERSION as Ref<Doc>,
    state: 'active'
  } as any)
  return issue
}

/**
 * A reader with NO space filter, standing in for the pipeline's system reader.
 *
 * The harness models the security filter as `MemoryDb.hidden`; lifting it for
 * the duration of one call is exactly what a privileged read does.
 */
function unfiltered (h: Harness): ReleaseGateReader {
  const lift = async <T>(op: () => Promise<T>): Promise<T> => {
    const saved = [...h.db.hidden]
    h.db.hidden.clear()
    try {
      return await op()
    } finally {
      for (const id of saved) h.db.hidden.add(id)
    }
  }
  // ⚠️ Parameters annotated explicitly. The `as unknown as` cast below is not a
  // contextual type, so an unannotated arrow lands on `noImplicitAny` — under
  // ts-jest it still runs, so the suite goes green while `_phase:validate`
  // fails.
  return {
    findAll: async (c: Ref<any>, q: any, o?: any) => await lift(async () => await h.client.findAll(c, q, o)),
    findOne: async (c: Ref<any>, q: any, o?: any) => await lift(async () => await h.client.findOne(c, q, o))
  } as unknown as ReleaseGateReader
}

/** The approval every "should pass" case needs, so it is not the thing failing. */
const APPROVAL = { approval: 'approval-1' as Ref<Doc> }

describe('release gate: the pass rate comes from testRunPassRate', () => {
  it('passes a version whose run is fully green', async () => {
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRun(h.db)
    seedResult(h.db, 'r1', RUN, TestRunStatus.Passed)
    seedResult(h.db, 'r2', RUN, TestRunStatus.Passed)

    const report = await evaluateReleaseGate(h.client, h.client, version, APPROVAL)

    expect(report.passed).toBe(true)
    expect(report.blockers).toEqual([])
    expect(report.passRate).toBe(100)
    expect(report.passRateThreshold).toBe(DEFAULT_RELEASE_PASS_RATE_THRESHOLD)
  })

  it('treats an EMPTY DENOMINATOR as "no data", never as 0% and never as 100%', async () => {
    // 🔴 THE SKIPPED TRAP, Technical Spec §4 row 6. A run whose results are all
    // `Skipped` has nothing to divide by. A `switch` over `TestRunStatus` would
    // drop `Skipped` into `default` and report 100% — shipping a version nobody
    // verified. Reporting 0% would be just as wrong in the other direction:
    // it blocks on evidence that does not exist and tells the reader the tests
    // FAILED. `testRunPassRate` returns `undefined`, and the gate turns that
    // into its own blocker that says what is actually wrong.
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRun(h.db)
    seedResult(h.db, 'r1', RUN, TestRunStatus.Skipped)
    seedResult(h.db, 'r2', RUN, TestRunStatus.Skipped)

    const report = await evaluateReleaseGate(h.client, h.client, version, APPROVAL)

    expect(report.passed).toBe(false)
    expect(report.blockers.map((it) => it.kind)).toEqual(['test-run-no-verdicts'])
    expect(report.passRate).toBeUndefined()
    // Neither of the two wrong readings is anywhere in the report.
    expect(JSON.stringify(report)).not.toContain('"passRate"')
  })

  it('delegates the Skipped policy rather than re-deriving it', async () => {
    // A run with one pass and one skip. With the default policy the skip leaves
    // the denominator (100%); with `excludeSkipped: false` it stays in (50%).
    // Both numbers must be exactly what `testRunPassRate` computes — the gate
    // forwards the flag and never interprets it.
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRun(h.db)
    seedResult(h.db, 'r1', RUN, TestRunStatus.Passed)
    seedResult(h.db, 'r2', RUN, TestRunStatus.Skipped)

    const stats = { done: 0, total: 2, untested: 0, blocked: 0, completed: 1, failed: 0, skipped: 1 }
    expect(testRunPassRate(stats, true)).toBe(100)
    expect(testRunPassRate(stats, false)).toBe(50)

    const lenient = await evaluateReleaseGate(h.client, h.client, version, APPROVAL)
    expect(lenient.passRate).toBe(testRunPassRate(stats, true))
    expect(lenient.passed).toBe(true)

    const strict = await evaluateReleaseGate(h.client, h.client, version, { ...APPROVAL, excludeSkipped: false })
    expect(strict.passRate).toBe(testRunPassRate(stats, false))
    expect(strict.passed).toBe(false)
    expect(strict.blockers.map((it) => it.kind)).toEqual(['test-run-below-threshold'])
  })

  it('counts every status, so an Untested result still blocks', async () => {
    // `collectTestRunStats` loops over `testRunStatuses`; the version it
    // replaced issued four literal queries and reported `total = 0` for a run
    // it did not recognise.
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRun(h.db)
    seedResult(h.db, 'r1', RUN, TestRunStatus.Passed)
    seedResult(h.db, 'r2', RUN, TestRunStatus.Untested)

    const report = await evaluateReleaseGate(h.client, h.client, version, APPROVAL)
    expect(report.passed).toBe(false)
    expect(report.passRate).toBe(50)
  })

  it('reports the LOWEST rate across runs and blocks on the failing one', async () => {
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRun(h.db)
    seedRun(h.db, RUN_TWO)
    seedResult(h.db, 'r1', RUN, TestRunStatus.Passed)
    seedResult(h.db, 'r2', RUN_TWO, TestRunStatus.Failed)

    const report = await evaluateReleaseGate(h.client, h.client, version, APPROVAL)
    expect(report.passRate).toBe(0)
    expect(report.blockers.map((it) => it.object)).toEqual([RUN_TWO])
  })

  it('blocks a version with no test run at all', async () => {
    const h = await makeHarness()
    const version = seedVersion(h.db)
    const report = await evaluateReleaseGate(h.client, h.client, version, APPROVAL)
    expect(report.blockers.map((it) => it.kind)).toEqual(['test-run-missing'])
  })
})

describe('release gate: scope', () => {
  it('blocks on a requirement that is not release ready and passes the ones that are', async () => {
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRun(h.db)
    seedResult(h.db, 'r1', RUN, TestRunStatus.Passed)
    seedRequirement(h.db, 'req-draft', 'Draft')
    for (const status of RELEASE_READY_REQUIREMENT_STATUSES) {
      seedRequirement(h.db, `req-${status}`, status)
    }

    const report = await evaluateReleaseGate(h.client, h.client, version, APPROVAL)
    expect(report.blockers).toEqual([expect.objectContaining({ kind: 'requirement-not-ready', object: 'req-draft' })])
  })

  it('separates an open P0/P1 defect from ordinary unfinished work, and lets done work through', async () => {
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRun(h.db)
    seedResult(h.db, 'r1', RUN, TestRunStatus.Passed)
    seedStatuses(h.db)
    seedDeliveredIssue(h.db, 'issue-open-p1', STATUS_TODO, IssuePriority.Urgent)
    seedDeliveredIssue(h.db, 'issue-open-p3', STATUS_TODO, IssuePriority.Medium)
    seedDeliveredIssue(h.db, 'issue-done', STATUS_DONE, IssuePriority.Urgent)

    const report = await evaluateReleaseGate(h.client, h.client, version, APPROVAL)
    expect(report.blockers).toEqual([
      expect.objectContaining({ kind: 'blocking-defect', object: 'issue-open-p1' }),
      expect.objectContaining({ kind: 'work-item-open', object: 'issue-open-p3' })
    ])
  })

  it('blocks when no approval accompanies the request (REL-003)', async () => {
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRun(h.db)
    seedResult(h.db, 'r1', RUN, TestRunStatus.Passed)

    const report = await evaluateReleaseGate(h.client, h.client, version, {})
    expect(report.blockers.map((it) => it.kind)).toEqual(['approval-missing'])
  })

  it('names the dimensions it cannot evaluate instead of silently passing them', async () => {
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRun(h.db)
    seedResult(h.db, 'r1', RUN, TestRunStatus.Passed)
    const report = await evaluateReleaseGate(h.client, h.client, version, APPROVAL)
    expect(report.notEvaluated).toEqual(RELEASE_GATE_NOT_EVALUATED)
    expect(report.notEvaluated).toContain('pull-request-merged')
  })
})

describe('release gate: waiver (REL-006)', () => {
  it('passes a failing gate but keeps every blocker in the record', async () => {
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRun(h.db)
    seedResult(h.db, 'r1', RUN, TestRunStatus.Failed)

    const report = await evaluateReleaseGate(h.client, h.client, version, {
      ...APPROVAL,
      waiverReason: 'hotfix, QA signed off out of band'
    })
    expect(report.passed).toBe(true)
    expect(report.waived).toBe(true)
    expect(report.blockers.length).toBe(1)
  })

  it('does not mark a clean gate as waived', async () => {
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRun(h.db)
    seedResult(h.db, 'r1', RUN, TestRunStatus.Passed)
    const report = await evaluateReleaseGate(h.client, h.client, version, { ...APPROVAL, waiverReason: 'unused' })
    expect(report.waived).toBe(false)
  })
})

describe('release gate: global verdict, filtered echo (PRD REL-003 / decision 20)', () => {
  it('FAILS on a blocker the caller cannot see, and says nothing about it', async () => {
    // 🔴 THE WHOLE POINT. The requirement lives in a space this caller cannot
    // read. Deciding from the caller's own view would report a clean gate and
    // ship a version another project is blocking.
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRun(h.db)
    seedResult(h.db, 'r1', RUN, TestRunStatus.Passed)
    seedRequirement(h.db, 'req-secret', 'Draft')
    h.db.hidden.add('req-secret' as Ref<any>)

    const report = await evaluateReleaseGate(unfiltered(h), h.client, version, APPROVAL)

    expect(report.passed).toBe(false)
    expect(report.restricted).toBe(true)
    // One contentless line, and nothing else.
    expect(report.blockers).toEqual([{ kind: 'restricted' }])
    const serialised = JSON.stringify(report)
    expect(serialised).not.toContain('req-secret')
    expect(serialised).not.toContain('Draft')
    // 🔴 NOT EVEN THE COUNT. Being able to count the blocking defects inside a
    // project you have no access to is itself a cross-space side channel.
    expect(report.blockerCount).toBeUndefined()
    expect(serialised).not.toContain('"passRate"')
  })

  it('collapses SEVERAL hidden blockers into one line, so the count does not leak', async () => {
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRun(h.db)
    seedResult(h.db, 'r1', RUN, TestRunStatus.Passed)
    for (const id of ['req-a', 'req-b', 'req-c']) {
      seedRequirement(h.db, id, 'Draft')
      h.db.hidden.add(id as Ref<any>)
    }

    const report = await evaluateReleaseGate(unfiltered(h), h.client, version, APPROVAL)
    expect(report.blockers).toEqual([{ kind: 'restricted' }])
  })

  it('bidirectional: WITHOUT the privileged reader the same gate passes — which is the bug', async () => {
    // Handing the caller's own client in as the auditor is what a naive
    // implementation does, and this asserts it produces the WRONG verdict. If
    // this test ever goes green alongside the one above, the two readers have
    // been collapsed back into one.
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRun(h.db)
    seedResult(h.db, 'r1', RUN, TestRunStatus.Passed)
    seedRequirement(h.db, 'req-secret', 'Draft')
    h.db.hidden.add('req-secret' as Ref<any>)

    const naive = await evaluateReleaseGate(h.client, h.client, version, APPROVAL)
    expect(naive.passed).toBe(true)
    expect(naive.restricted).toBe(false)
  })

  it('shows a blocker in full to a caller who CAN read it', async () => {
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRun(h.db)
    seedResult(h.db, 'r1', RUN, TestRunStatus.Passed)
    seedRequirement(h.db, 'req-visible', 'Draft')

    const report = await evaluateReleaseGate(unfiltered(h), h.client, version, APPROVAL)
    expect(report.restricted).toBe(false)
    expect(report.blockers).toEqual([
      expect.objectContaining({ kind: 'requirement-not-ready', object: 'req-visible', detail: "status 'Draft'" })
    ])
  })
})
