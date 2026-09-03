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

import activity, { type ActivityInfoMessage } from '@hcengineering/activity'
import core, { type Doc, type Ref } from '@hcengineering/core'
import products, { ProductVersionState, type ProductVersion } from '@hcengineering/products'
import requirements, { type Requirement, type RequirementStatus } from '@hcengineering/requirements'
import testManagement, { TestRunStatus, type TestRun } from '@hcengineering/test-management'
import traceability, {
  inheritableTraceEdges,
  traceLinkId,
  traceLinkInheritsOnRevision,
  traceLinkMatrix,
  type CoverageEdge,
  type TraceLink
} from '@hcengineering/traceability'
import type { CommandOutcome } from '@hcengineering/server-agentra-core'

import { agentraTraceEndpoints } from '../commands/traceEndpoints'
import { evaluateReleaseGate, type ReleaseGateReader } from '../commands/releaseGate'
import {
  RELEASABLE_FROM,
  RELEASE_PRODUCT_VERSION,
  RELEASE_PRODUCT_VERSION_LOCK,
  releaseCommandNamespace,
  ReleaseProductVersionError,
  auditRecordId,
  releaseProductVersion,
  releaseProductVersionIdempotencyKey,
  releaseProductVersionRoles,
  type ReleaseProductVersionInput,
  type ReleaseProductVersionResult
} from '../commands/releaseProductVersion'
import { MemoryDb, makeHarness, seed, type Harness } from './harness'

const SPACE = 'product-1' as Ref<any>
const VERSION = 'pvpvpvpvpvpvpvpvpvpvpvp1' as Ref<ProductVersion>
const PARENT = 'pvpvpvpvpvpvpvpvpvpvpvp0' as Ref<ProductVersion>
const RUN = 'runrunrunrunrunrunrunrn1' as Ref<TestRun>
const APPROVAL = 'approval-1' as Ref<Doc>
const KEY = releaseProductVersionIdempotencyKey(VERSION)

function seedVersion (
  db: MemoryDb,
  state: ProductVersionState = ProductVersionState.ReleaseCandidate,
  parent: Ref<ProductVersion> = products.ids.NoParentVersion
): ProductVersion {
  return seed<ProductVersion>(db, {
    _id: VERSION,
    _class: products.class.ProductVersion,
    space: SPACE,
    state,
    parent
  } as any)
}

function seedGreenRun (db: MemoryDb): void {
  seed<TestRun>(db, { _id: RUN, _class: testManagement.class.TestRun, space: SPACE, productVersion: VERSION } as any)
  seed(db, {
    _id: 'result-1' as Ref<any>,
    _class: testManagement.class.TestResult,
    space: SPACE,
    attachedTo: RUN,
    status: TestRunStatus.Passed
  } as any)
}

function seedRequirement (db: MemoryDb, id: string, status: RequirementStatus): void {
  seed<Requirement>(db, {
    _id: id as Ref<any>,
    _class: requirements.masterTag.Requirement as Ref<any>,
    space: SPACE,
    status,
    targetVersion: VERSION
  } as any)
}

function statusOf (db: MemoryDb, id: string): RequirementStatus {
  return (db.docs.get(id as Ref<any>) as Requirement).status
}

function stateOf (db: MemoryDb): ProductVersionState {
  return (db.docs.get(VERSION) as ProductVersion).state
}

async function run (
  h: Harness,
  input: Partial<ReleaseProductVersionInput> = {}
): Promise<CommandOutcome<ReleaseProductVersionResult>> {
  return await releaseProductVersion(
    { ctx: h.ctx, client: h.client, runner: h.runner },
    { version: VERSION, idempotencyKey: KEY, approval: APPROVAL, ...input }
  )
}

/** A reader with NO space filter, standing in for the pipeline's system reader. */
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

describe('releaseProductVersion: the happy path', () => {
  it('releases the version, writes the audit record and moves the scope forward', async () => {
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)
    seedRequirement(h.db, 'req-validating', 'Validating')
    seedRequirement(h.db, 'req-cancelled', 'Cancelled')

    const outcome = await run(h)

    expect(outcome.result.released).toBe(true)
    expect(outcome.result.gate.passed).toBe(true)
    expect(stateOf(h.db)).toBe(ProductVersionState.Released)
    expect((h.db.docs.get(VERSION) as any).readonly).toBe(true)
    // Write-back: `Validating -> Released` is the transition the release itself
    // performs; a `Cancelled` requirement is out of scope and untouched.
    expect(outcome.result.requirementsReleased).toBe(1)
    expect(statusOf(h.db, 'req-validating')).toBe('Released')
    expect(statusOf(h.db, 'req-cancelled')).toBe('Cancelled')

    const record = h.db.docs.get(auditRecordId(VERSION)) as ActivityInfoMessage
    expect(record).toBeDefined()
    expect(record.props?.approval).toBe(APPROVAL)
    expect(record.props?.gate.passed).toBe(true)
  })

  it('derives the audit record id from the version, not from a random id', () => {
    // Pinned so a rename of the command or the role is caught here rather than
    // by a replay that quietly writes a second record.
    expect(auditRecordId(VERSION)).toBe(auditRecordId(VERSION))
    expect(releaseProductVersionRoles.audit).toBe('activity:release-audit')
    expect(RELEASE_PRODUCT_VERSION).toBe('ReleaseProductVersion')
    expect(RELEASE_PRODUCT_VERSION_LOCK).toBe('ReleaseProductVersion:version')
  })

  it('derives the idempotency key as a pure function of the version', () => {
    // 🔴 NO TIMESTAMP, NO NONCE, NO CALLER IDENTITY. A retry after a dropped
    // connection must present the SAME key or the ledger cannot recognise it
    // and the release runs twice.
    expect(releaseProductVersionIdempotencyKey(VERSION)).toBe(releaseProductVersionIdempotencyKey(VERSION))
    expect(releaseProductVersionIdempotencyKey(VERSION)).toBe(`products:release-product-version:v1:${VERSION}`)
    expect(releaseProductVersionIdempotencyKey(PARENT)).not.toBe(releaseProductVersionIdempotencyKey(VERSION))
  })
})

describe('releaseProductVersion: the gate is not optional', () => {
  it('refuses a version whose scope is not ready and changes NOTHING', async () => {
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)
    seedRequirement(h.db, 'req-draft', 'Draft')

    await expect(run(h)).rejects.toBeInstanceOf(ReleaseProductVersionError)

    expect(stateOf(h.db)).toBe(ProductVersionState.ReleaseCandidate)
    expect(statusOf(h.db, 'req-draft')).toBe('Draft')
    // 🔴 No audit record: a FAILED gate must not be pinned, or the next attempt
    // — after the blockers are cleared — would replay the refusal instead of
    // re-evaluating.
    expect(h.db.docs.get(auditRecordId(VERSION))).toBeUndefined()
  })

  it('refuses a version whose only test run has no verdicts at all', async () => {
    const h = await makeHarness()
    seedVersion(h.db)
    seed<TestRun>(h.db, {
      _id: RUN,
      _class: testManagement.class.TestRun,
      space: SPACE,
      productVersion: VERSION
    } as any)
    seed(h.db, {
      _id: 'result-1' as Ref<any>,
      _class: testManagement.class.TestResult,
      space: SPACE,
      attachedTo: RUN,
      status: TestRunStatus.Skipped
    } as any)

    await expect(run(h)).rejects.toThrow(/gate/i)
    expect(stateOf(h.db)).toBe(ProductVersionState.ReleaseCandidate)
  })

  it('records the waiver and its reason when one overrides the gate (REL-006)', async () => {
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)
    seedRequirement(h.db, 'req-draft', 'Draft')

    const outcome = await run(h, { waiverReason: 'contractual deadline, risk accepted by CTO' })

    expect(outcome.result.gate.waived).toBe(true)
    expect(stateOf(h.db)).toBe(ProductVersionState.Released)
    const record = h.db.docs.get(auditRecordId(VERSION)) as ActivityInfoMessage
    expect(record.props?.waiverReason).toBe('contractual deadline, risk accepted by CTO')
    // 🔴 THE RECORD NAMES NO BLOCKER, AND THAT IS THE REL-006 TRADE-OFF MADE
    // EXPLICIT. `props` is copied verbatim into a `TxCreateDoc` that lives in
    // `DOMAIN_TX` forever and is broadcast to the version's space, and neither
    // copy can be filtered per reader — so what is auditable is the WAIVER and
    // its REASON (plus `createdBy` / `createdOn` and the approval), not the
    // identities of the documents it excused.
    expect(record.props?.gate.blockers).toEqual([])
    expect(record.props?.gate.waived).toBe(true)
    // The one line PRD §7.5 allows: blockers existed, none are written down.
    expect(record.props?.gate.restricted).toBe(true)
    expect(JSON.stringify(record.props)).not.toContain('req-draft')
  })

  it('refuses a blank waiver reason rather than treating it as no waiver', async () => {
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)
    await expect(run(h, { waiverReason: '   ' })).rejects.toThrow(/non-empty reason/)
  })

  it('refuses a release from a state that is not releasable', async () => {
    const h = await makeHarness()
    seedVersion(h.db, ProductVersionState.Archived)
    seedGreenRun(h.db)
    await expect(run(h)).rejects.toThrow(/cannot be released from state 'Archived'/)
    // ⚠️ The check is a LIST, not a numeric comparison: `Planning` is 2 and
    // `Released` is 1, so `state < Released` would be silently wrong.
    expect(RELEASABLE_FROM).toEqual([ProductVersionState.Active, ProductVersionState.ReleaseCandidate])
    expect(RELEASABLE_FROM).not.toContain(ProductVersionState.Planning)
  })
})

describe('releaseProductVersion: idempotency and re-entrancy', () => {
  it('replays the same result under the same key and writes nothing twice', async () => {
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)
    seedRequirement(h.db, 'req-validating', 'Validating')

    const first = await run(h)
    const again = await run(h)

    expect(again.replayed).toBe(true)
    expect(again.result.version).toBe(first.result.version)
    // ⚠️ `alreadyReleased` is still `false` here, and that is correct rather
    // than a bug: an OUTER replay hands back the stored payload VERBATIM
    // without re-entering the body, so it reports what the original attempt
    // observed. `CommandOutcome.replayed` is the flag for "you are seeing a
    // stored result"; `alreadyReleased` answers a different question — "was the
    // VERSION already released when a body last looked" — and only a pass that
    // actually runs can answer it. The next test covers that path.
    expect(again.result.alreadyReleased).toBe(false)
    expect(h.db.find(activity.class.ActivityInfoMessage, {})).toHaveLength(1)
  })

  it('recognises the version under a DIFFERENT key through the inner claim', async () => {
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)

    await run(h)
    const other = await run(h, { idempotencyKey: 'someone-elses-key' })

    expect(other.result.alreadyReleased).toBe(true)
    expect(h.db.find(activity.class.ActivityInfoMessage, {})).toHaveLength(1)
  })

  it('RE-ENTERS after a partial run and reports the gate the FIRST pass saw', async () => {
    // 🔴 The point of writing the audit record BEFORE the write-back. The first
    // pass releases the requirements and then dies on the version-state write;
    // by the time the second pass runs the scope is entirely `Released`, so a
    // body that recomputed the gate would record a clean sheet and the reason
    // this release was allowed would be gone.
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)
    seedRequirement(h.db, 'req-validating', 'Validating')
    seedRequirement(h.db, 'req-draft', 'Draft')

    h.fake.applyOutcome = (tx) => !String((tx as any).measureName ?? '').includes('version-state')
    await expect(run(h, { waiverReason: 'deadline' })).rejects.toThrow()

    // The write-back landed; the state did not.
    expect(statusOf(h.db, 'req-validating')).toBe('Released')
    expect(stateOf(h.db)).toBe(ProductVersionState.ReleaseCandidate)

    h.fake.applyOutcome = () => true
    const outcome = await run(h, { waiverReason: 'deadline' })

    expect(stateOf(h.db)).toBe(ProductVersionState.Released)
    // 🔴 The pinned VERDICT still says the release was waived, even though the
    // scope has since moved on and a fresh evaluation would find nothing. That
    // is the whole reason the record is written before the write-back.
    expect(outcome.result.gate.waived).toBe(true)
    expect(outcome.result.gate.restricted).toBe(true)
    expect(outcome.result.gate.blockers).toEqual([])
    // Exactly one audit record: the derived `_id` is what makes the second pass
    // find the first pass's record instead of writing a second.
    expect(h.db.find(activity.class.ActivityInfoMessage, {})).toHaveLength(1)
    // The requirement the first pass already moved is not moved again.
    expect(outcome.result.requirementsReleased).toBe(0)
    expect(statusOf(h.db, 'req-draft')).toBe('Draft')
  })

  it('finishes a release whose state landed but whose write-back did not', async () => {
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)
    seedRequirement(h.db, 'req-validating', 'Validating')

    h.fake.applyOutcome = (tx) => !String((tx as any).measureName ?? '').includes('requirement')
    await expect(run(h)).rejects.toThrow()
    expect(statusOf(h.db, 'req-validating')).toBe('Validating')

    h.fake.applyOutcome = () => true
    const outcome = await run(h)
    expect(statusOf(h.db, 'req-validating')).toBe('Released')
    expect(outcome.result.requirementsReleased).toBe(1)
  })
})

describe('releaseProductVersion: the ledger replay must not answer a caller who lost read access', () => {
  it('refuses a replay to a caller who may not read the version', async () => {
    // 🔴 THE REPLAY NEVER ENTERS THE BODY. `CommandMiddleware.resume` returns a
    // `succeeded` row's stored result verbatim, and BOTH claims are keyed on
    // caller-supplied data — the outer key is derived from the version, the
    // inner one IS the version. So without a check outside the runner, anyone
    // naming a released version would be handed the original caller's result:
    // the gate report, the blocker list, the scope size, and the fact that the
    // version exists at all.
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)

    const first = await run(h)
    expect(first.result.released).toBe(true)

    h.db.hidden.add(VERSION as Ref<any>)

    // Same key — the outer ledger row would replay …
    await expect(run(h)).rejects.toThrow(/does not exist/)
    // … and a DIFFERENT key, which would still replay the inner version claim.
    await expect(run(h, { idempotencyKey: 'attacker' })).rejects.toThrow(/does not exist/)
  })

  it('bidirectional: removing the guard would hand the result over', async () => {
    // The guard's whole value is that it sits OUTSIDE the runner. This
    // reproduces what happens without it — going straight to the runner with a
    // caller who cannot read the version — and asserts the stored result comes
    // back. If this ever stops replaying, the ledger's replay semantics changed
    // and the guard above may be resting on the wrong assumption.
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)
    const first = await run(h)

    h.db.hidden.add(VERSION as Ref<any>)

    const leaked = await h.runner.run<ReleaseProductVersionResult>(
      h.ctx,
      { command: releaseCommandNamespace(VERSION), idempotencyKey: KEY },
      async () => {
        throw new Error('the body must NOT be re-entered on a succeeded row')
      }
    )
    expect(leaked.replayed).toBe(true)
    expect(leaked.result.version).toBe(first.result.version)
    expect(leaked.result.gate).toBeDefined()
  })

  it('pins a verdict a SECOND caller may read, because it names nothing', async () => {
    // 🔴 THE LEAK THIS REPLACES. The record used to store the gate as the FIRST
    // caller saw it, and a re-entry (after a crash, or under a different key)
    // replayed it to caller B — who could then read the blockers caller A was
    // allowed to see. Re-redacting on the way out patched the RESULT and did
    // nothing about the `TxCreateDoc` in `DOMAIN_TX`, which keeps the original
    // attributes forever. The record now never holds them.
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)
    seedRequirement(h.db, 'req-draft', 'Draft')

    // Pass one: the caller CAN see the blocker, waives it, and dies on the
    // version-state write, so the record is pinned but the release is not done.
    h.fake.applyOutcome = (tx) => !String((tx as any).measureName ?? '').includes('version-state')
    await expect(run(h, { waiverReason: 'deadline' })).rejects.toThrow()
    const pinned = (h.db.docs.get(auditRecordId(VERSION)) as ActivityInfoMessage).props?.gate
    expect(pinned.blockers).toEqual([])
    expect(pinned.restricted).toBe(true)
    expect(pinned.passRate).toBeUndefined()

    // Pass two: a caller who may not read that requirement finishes the job.
    h.fake.applyOutcome = () => true
    h.db.hidden.add('req-draft' as Ref<any>)
    const outcome = await run(h, { idempotencyKey: 'second-caller', waiverReason: 'deadline' })

    expect(stateOf(h.db)).toBe(ProductVersionState.Released)
    expect(outcome.result.gate.blockers).toEqual([])
    expect(outcome.result.gate.restricted).toBe(true)
    expect(JSON.stringify(outcome.result.gate)).not.toContain('req-draft')
    // The stored record is byte-identical for both callers: there is no
    // per-viewer shape left for the two passes to disagree about.
    expect((h.db.docs.get(auditRecordId(VERSION)) as ActivityInfoMessage).props?.gate).toEqual(pinned)
  })

  it("a key that succeeded on one version cannot replay another version's result", async () => {
    // 🔴 THE OUTER LEDGER ROW IS KEYED ON `(command, idempotencyKey)` AND THE
    // KEY IS CALLER SUPPLIED. With a constant command name, presenting version
    // A's succeeded key while naming version B lands on A's row and
    // `CommandMiddleware.resume` hands back A's stored result — leaking A's
    // gate to someone who only proved they can read B, and telling them B was
    // released when nothing happened. The namespace carries the version, so the
    // two rows cannot collide.
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)
    const first = await run(h)
    expect(first.result.released).toBe(true)

    // Version B: same key, different version, and NOT releasable.
    seed<ProductVersion>(h.db, {
      _id: PARENT,
      _class: products.class.ProductVersion,
      space: SPACE,
      state: ProductVersionState.Archived,
      parent: products.ids.NoParentVersion
    } as any)

    await expect(
      releaseProductVersion(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { version: PARENT, idempotencyKey: KEY, approval: APPROVAL }
      )
    ).rejects.toThrow(/cannot be released from state 'Archived'/)

    expect((h.db.docs.get(PARENT) as ProductVersion).state).toBe(ProductVersionState.Archived)
    expect(releaseCommandNamespace(VERSION)).not.toBe(releaseCommandNamespace(PARENT))
  })

  it('stores nothing in the LEDGER that a narrower caller may not replay', async () => {
    // 🔴 THE LEDGER ROW IS WORLD READABLE. `CommandMiddleware.claim` writes it
    // into `core.space.Workspace`, which `SpaceSecurityMiddleware` grants to
    // every account unconditionally (`spaceSecurity.ts:82`, `:535`). A replay
    // never enters the body, so no post-runner redaction can rescue a payload
    // that is already on disk — the payload has to be harmless when it is
    // written.
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)
    seedRequirement(h.db, 'req-draft', 'Draft')

    const first = await run(h, { waiverReason: 'deadline' })
    expect(first.result.gate.blockers).toEqual([])
    expect(first.result.gate.waived).toBe(true)

    // The requirement becomes unreadable; the version stays readable, so the
    // pre-runner assert lets this caller through.
    h.db.hidden.add('req-draft' as Ref<any>)
    const replay = await run(h, { waiverReason: 'deadline' })

    expect(replay.replayed).toBe(true)
    expect(replay.result.gate).toEqual(first.result.gate)
    expect(JSON.stringify(replay.result.gate)).not.toContain('req-draft')
  })

  it('the RAW stored ledger payload carries no blocker either', async () => {
    // Read straight out of the ledger, bypassing every path that could filter
    // on the way out. This is the assertion that a future post-runner filter
    // cannot be mistaken for a fix: if a blocker ever appears here, it is
    // already readable by everyone in the workspace.
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)
    seedRequirement(h.db, 'req-draft', 'Draft')
    await run(h, { waiverReason: 'deadline' })

    const stored = await h.runner.run<ReleaseProductVersionResult>(
      h.ctx,
      { command: releaseCommandNamespace(VERSION), idempotencyKey: KEY },
      async () => {
        throw new Error('the body must NOT be re-entered on a succeeded row')
      }
    )
    expect(stored.result.gate.blockers).toEqual([])
    expect(JSON.stringify(stored.result)).not.toContain('req-draft')
  })

  it('flags a write-back that could not reach part of the scope', async () => {
    // 🔴 The gate decides globally but every write goes through the caller, so
    // a `Validating` requirement the caller cannot read is release-ready (not a
    // blocker) yet cannot be written back. The version still ships; the flag is
    // what records that the scope did not follow.
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)
    seedRequirement(h.db, 'req-hidden', 'Validating')
    h.db.hidden.add('req-hidden' as Ref<any>)

    const outcome = await releaseProductVersion(
      { ctx: h.ctx, client: h.client, auditor: unfiltered(h), runner: h.runner },
      { version: VERSION, idempotencyKey: KEY, approval: APPROVAL }
    )

    expect(outcome.result.released).toBe(true)
    expect(outcome.result.requirementsReleased).toBe(0)
    expect(outcome.result.writeBackIncomplete).toBe(true)
    // ⚠️ A BIT, NOT A COUNT: the number would be the same cross-space side
    // channel as a hidden-blocker count.
    expect(JSON.stringify(outcome.result)).not.toContain('req-hidden')
    expect(statusOf(h.db, 'req-hidden')).toBe('Validating')
  })

  it('reports a complete write-back when nothing is hidden', async () => {
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)
    seedRequirement(h.db, 'req-validating', 'Validating')
    const outcome = await run(h)
    expect(outcome.result.writeBackIncomplete).toBe(false)
  })

  it('still replays normally for a caller who CAN read the version', async () => {
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)

    const first = await run(h)
    const again = await run(h)

    expect(again.replayed).toBe(true)
    expect(again.result.version).toBe(first.result.version)
  })
})

describe('releaseProductVersion: edge inheritance is decided by inheritableTraceEdges', () => {
  it("does NOT carry a predecessor's delivered-in edges onto the new release", async () => {
    // 🔴 A release is a point-in-time snapshot. If v2 inherited v1's
    // `delivered-in` edges, every version would eventually claim everything
    // ever shipped and "what was in this release" would stop being answerable.
    const h = await makeHarness()
    seedVersion(h.db, ProductVersionState.ReleaseCandidate, PARENT)
    seed<ProductVersion>(h.db, {
      _id: PARENT,
      _class: products.class.ProductVersion,
      space: SPACE,
      state: ProductVersionState.Released,
      parent: products.ids.NoParentVersion
    } as any)
    seedGreenRun(h.db)
    seed<TraceLink>(h.db, {
      _id: traceLinkId('delivered-in', 'issue-old' as Ref<Doc>, PARENT as Ref<Doc>),
      _class: traceability.class.TraceLink,
      space: core.space.Workspace,
      docA: 'issue-old' as Ref<Doc>,
      sourceClass: 'tracker:class:Issue' as Ref<any>,
      docB: PARENT as Ref<Doc>,
      targetClass: products.class.ProductVersion,
      kind: 'delivered-in',
      sourceBaseId: 'issue-old' as Ref<Doc>,
      targetBaseId: PARENT as Ref<Doc>,
      state: 'active'
    } as any)

    await run(h)

    const carried = h.db.find(traceability.class.TraceLink, { docB: VERSION as Ref<Doc> })
    expect(carried).toHaveLength(0)
    expect(h.db.find(traceability.class.TraceLink, {})).toHaveLength(1)
  })

  it('the decision comes from the table, not from a hard-coded kind list', () => {
    // 🔴 BIDIRECTIONAL. The command filters through `inheritableTraceEdges`; the
    // reason it carries nothing today is that the TABLE says `delivered-in`
    // does not inherit — not because the command was written to skip it. Feed
    // the same function an inheriting kind and it returns the edge, which is
    // what the command would then carry.
    const base = { target: PARENT as Ref<Doc>, source: 'x' as Ref<Doc> }
    const edges: CoverageEdge[] = [
      { ...base, kind: 'delivered-in' },
      { ...base, kind: 'implements' },
      { ...base, kind: 'verifies' },
      { ...base, kind: 'defect-of' }
    ]
    const kept = inheritableTraceEdges(edges, PARENT as Ref<Doc>).map((it) => it.kind)
    expect(kept).toEqual(['implements', 'defect-of'])
    expect(traceLinkInheritsOnRevision['delivered-in']).toBe(false)
    // Edges pointing anywhere else are never in scope.
    expect(inheritableTraceEdges(edges, 'somewhere-else' as Ref<Doc>)).toEqual([])
  })

  it('registers ProductVersion as a trace endpoint, so delivery edges validate', () => {
    // Without this the `delivered-in` row of the matrix fails closed with
    // `unknown-target-class` and the gate can never see a work item.
    expect(agentraTraceEndpoints.get(products.class.ProductVersion)).toBe('ProductVersion')
    expect(traceLinkMatrix['delivered-in'].target).toContain('ProductVersion')
    // Pin the literal: the class ref is a `plugin()` string, and a rename on
    // the products side would otherwise register `undefined` silently.
    expect(products.class.ProductVersion).toBe('products:class:ProductVersion')
  })
})

describe('releaseProductVersion: global verdict, filtered echo', () => {
  it('refuses on a blocker the caller cannot see, without naming it', async () => {
    const h = await makeHarness()
    seedVersion(h.db)
    seedGreenRun(h.db)
    seedRequirement(h.db, 'req-secret', 'Draft')
    h.db.hidden.add('req-secret' as Ref<any>)

    await expect(
      releaseProductVersion(
        { ctx: h.ctx, client: h.client, auditor: unfiltered(h), runner: h.runner },
        { version: VERSION, idempotencyKey: KEY, approval: APPROVAL }
      )
    ).rejects.toThrow(/restricted items/)

    expect(stateOf(h.db)).toBe(ProductVersionState.ReleaseCandidate)
  })

  it('the gate helper and the command agree on what the caller may see', async () => {
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedGreenRun(h.db)
    seedRequirement(h.db, 'req-secret', 'Draft')
    h.db.hidden.add('req-secret' as Ref<any>)

    const report = await evaluateReleaseGate(unfiltered(h), h.client, version, { approval: APPROVAL })
    expect(report.passed).toBe(false)
    expect(report.blockers).toEqual([{ kind: 'restricted' }])
  })
})
