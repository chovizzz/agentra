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

import core, {
  systemAccountUuid,
  toFindResult,
  type Doc,
  type Hierarchy,
  type MeasureContext,
  type OperationDomain,
  type PersonId,
  type Ref,
  type SessionData,
  type Tx
} from '@hcengineering/core'
import agentraCore from '@hcengineering/server-agentra-core'
import products, { ProductVersionState, type ProductVersion } from '@hcengineering/products'
import requirements, { type Requirement, type RequirementStatus } from '@hcengineering/requirements'
import testManagement, { TestRunStatus, type TestRun } from '@hcengineering/test-management'
import type { Middleware, PipelineContext, TxMiddlewareResult } from '@hcengineering/server-core'

import { CommandMiddleware } from '../commandMiddleware'
import {
  AGENTRA_COMMAND_DOMAIN,
  AGENTRA_OP_PREVIEW_RELEASE_GATE,
  AgentraCommandRequestMiddleware
} from '../commandRequest'
import { PreviewReleaseGateError, previewReleaseGate } from '../commands/previewReleaseGate'
import { evaluateReleaseGate, releaseGateVerdict, type ReleaseGateReader } from '../commands/releaseGate'
import { releaseProductVersion } from '../commands/releaseProductVersion'
import { MemoryDb, makeHarness, seed, type Harness } from './harness'

const SPACE = 'product-1' as Ref<any>
const VERSION = 'pvpvpvpvpvpvpvpvpvpvpvp1' as Ref<ProductVersion>
const RUN = 'runrunrunrunrunrunrunrn1' as Ref<TestRun>
const APPROVAL = 'approval-1' as Ref<Doc>
/** The CALLER. Deliberately not `core.account.System`. */
const ALICE = 'alice-social-id' as PersonId

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

/**
 * A reader with NO space filter, standing in for the pipeline's system reader.
 * Same helper, same reason, as `releaseGate.test.ts`.
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
  return {
    findAll: async (c: Ref<any>, q: any, o?: any) => await lift(async () => await h.client.findAll(c, q, o)),
    findOne: async (c: Ref<any>, q: any, o?: any) => await lift(async () => await h.client.findOne(c, q, o))
  } as unknown as ReleaseGateReader
}

// ── the judgement is the release's own ──────────────────────────────────────

describe('previewReleaseGate: the SAME judgement as the release', () => {
  it('reports exactly what evaluateReleaseGate reports, blocker for blocker', async () => {
    // 🔴 THE POINT OF THE WHOLE TASK. A preview computed by a second
    // implementation would eventually say "ready" over a gate the release then
    // refuses. Both call one function; this pins that they agree.
    const h = await makeHarness()
    const version = seedVersion(h.db)
    seedRequirement(h.db, 'req-draft', 'Draft')
    seedGreenRun(h.db)

    const direct = await evaluateReleaseGate(unfiltered(h), h.client, version, { approval: APPROVAL })
    const preview = await previewReleaseGate(
      { ctx: h.ctx, client: h.client, auditor: unfiltered(h) },
      { version: VERSION, approval: APPROVAL }
    )

    expect(preview.gate).toEqual(direct)
    expect(preview.gate.passed).toBe(false)
    expect(preview.gate.blockers.map((it) => it.kind)).toEqual(['requirement-not-ready'])
  })

  it('matches the gate a REAL release reports for the same version and options', async () => {
    // End to end: the report the release stores and returns, and the report the
    // preview returns, for identical inputs. A waiver is supplied to BOTH so the
    // release actually completes and has a report to compare.
    const h = await makeHarness()
    seedVersion(h.db)
    seedRequirement(h.db, 'req-draft', 'Draft')
    seedGreenRun(h.db)
    const options = { approval: APPROVAL, waiverReason: 'hotfix for a customer outage' }

    const preview = await previewReleaseGate(
      { ctx: h.ctx, client: h.client, auditor: unfiltered(h) },
      {
        version: VERSION,
        ...options
      }
    )
    const released = await releaseProductVersion(
      { ctx: h.ctx, client: h.client, auditor: unfiltered(h), runner: h.runner },
      { version: VERSION, idempotencyKey: 'k1', ...options }
    )

    // 🔴 THE VERDICTS MATCH; THE DETAIL DOES NOT, BY DESIGN. `releaseGateVerdict`
    // is the projection the release path persists, and the preview is where the
    // blocker detail is allowed to live: it writes nothing, so it can be
    // recomputed per caller with that caller's own authority.
    expect(releaseGateVerdict(preview.gate)).toEqual(released.result.gate)
    expect(preview.gate.waived).toBe(true)
    expect(preview.gate.passed).toBe(true)
    expect(released.result.gate.blockers).toEqual([])
    expect(preview.gate.blockers).toHaveLength(1)
  })

  it('reports the version lifecycle facts the release page needs', async () => {
    const h = await makeHarness()
    seedVersion(h.db, ProductVersionState.Planning)

    const preview = await previewReleaseGate(
      { ctx: h.ctx, client: h.client, auditor: unfiltered(h) },
      {
        version: VERSION
      }
    )

    // `Planning` is not in `RELEASABLE_FROM`; the page hides the button rather
    // than letting the server answer `illegal-transition` after the click.
    expect(preview.releasable).toBe(false)
    expect(preview.alreadyReleased).toBe(false)
    expect(preview.version).toBe(VERSION)
  })
})

// ── zero writes ─────────────────────────────────────────────────────────────

describe('previewReleaseGate: it writes NOTHING', () => {
  it('produces no transaction, no ledger row and no audit record', async () => {
    const h = await makeHarness()
    seedVersion(h.db)
    seedRequirement(h.db, 'req-draft', 'Draft')
    seedGreenRun(h.db)
    const before = new Set(h.db.docs.keys())

    await previewReleaseGate(
      { ctx: h.ctx, client: h.client, auditor: unfiltered(h) },
      {
        version: VERSION,
        approval: APPROVAL
      }
    )

    // 🔴 NOT ONE TX REACHED THE CLIENT. `FakeClient.seen` records every
    // transaction, including the `TxApplyIf`s a command wraps its steps in.
    expect(h.fake.seen).toEqual([])
    // Nothing was created, and nothing existing was mutated.
    expect(new Set(h.db.docs.keys())).toEqual(before)
    // The ledger is the specific thing a `CommandRunner` would have written.
    expect(h.db.find(agentraCore.class.CommandExecution as Ref<any>, {})).toEqual([])
    // And no activity record — that is the release's audit trail, not a query's.
    // (`before` above already covers it; spelled out because the audit record is
    // the specific thing the release writes FIRST.)
    expect(h.db.find(core.class.Doc, { _class: 'activity:class:ActivityInfoMessage' as Ref<any> })).toEqual([])
  })

  it('writes nothing even when the gate PASSES, so a preview can never release', async () => {
    // The dangerous case: a green gate is exactly the state in which a
    // `dryRun`-style flag threaded through the release path would fall through
    // to the write steps.
    const h = await makeHarness()
    seedVersion(h.db)
    seedRequirement(h.db, 'req-ready', 'Validating')
    seedGreenRun(h.db)

    const preview = await previewReleaseGate(
      { ctx: h.ctx, client: h.client, auditor: unfiltered(h) },
      {
        version: VERSION,
        approval: APPROVAL
      }
    )

    expect(preview.gate.passed).toBe(true)
    expect(h.fake.seen).toEqual([])
    // The version is untouched: still a release candidate, still writable.
    expect((h.db.docs.get(VERSION) as ProductVersion).state).toBe(ProductVersionState.ReleaseCandidate)
    // And the requirement was NOT written back to `Released`.
    expect((h.db.docs.get('req-ready' as Ref<any>) as Requirement).status).toBe('Validating')
  })
})

// ── never stale ─────────────────────────────────────────────────────────────

describe('previewReleaseGate: recomputed on every call', () => {
  it('🔴 does not replay a cached report after the blockers change', async () => {
    // This is the reason the preview does not go through `CommandRunner`: a
    // `succeeded` ledger row REPLAYS its stored result without re-entering the
    // body, so the second call would report the first call's blockers.
    const h = await makeHarness()
    seedVersion(h.db)
    const draft = seedRequirement(h.db, 'req-draft', 'Draft')
    seedGreenRun(h.db)
    const context = { ctx: h.ctx, client: h.client, auditor: unfiltered(h) }

    const first = await previewReleaseGate(context, { version: VERSION, approval: APPROVAL })
    expect(first.gate.passed).toBe(false)
    expect(first.gate.blockers.map((it) => it.kind)).toEqual(['requirement-not-ready'])

    // Somebody closes the blocker while the popup is open.
    ;(h.db.docs.get(draft._id) as Requirement).status = 'Validating'

    const second = await previewReleaseGate(context, { version: VERSION, approval: APPROVAL })
    expect(second.gate.passed).toBe(true)
    expect(second.gate.blockers).toEqual([])
    // Still no ledger row that could have served a stale answer.
    expect(h.db.find(agentraCore.class.CommandExecution as Ref<any>, {})).toEqual([])
  })
})

// ── redaction parity ────────────────────────────────────────────────────────

describe('previewReleaseGate: redaction is IDENTICAL to the release path', () => {
  it('collapses restricted blockers, hides the count and suppresses the pass rate', async () => {
    const h = await makeHarness()
    seedVersion(h.db)
    // THREE blockers the caller cannot read. The number three must not be
    // recoverable from anything the preview returns.
    seedRequirement(h.db, 'req-hidden-1', 'Draft')
    seedRequirement(h.db, 'req-hidden-2', 'Draft')
    seedRequirement(h.db, 'req-hidden-3', 'Reviewing')
    h.db.hidden.add('req-hidden-1' as Ref<any>)
    h.db.hidden.add('req-hidden-2' as Ref<any>)
    h.db.hidden.add('req-hidden-3' as Ref<any>)
    seedGreenRun(h.db)
    const options = { approval: APPROVAL, waiverReason: 'accepted by the release board' }

    const preview = await previewReleaseGate(
      { ctx: h.ctx, client: h.client, auditor: unfiltered(h) },
      {
        version: VERSION,
        ...options
      }
    )
    const released = await releaseProductVersion(
      { ctx: h.ctx, client: h.client, auditor: unfiltered(h), runner: h.runner },
      { version: VERSION, idempotencyKey: 'k1', ...options }
    )

    // 🔴 THE SAME VERDICT. The preview may not be a wider door than the release
    // for the same caller ON THE FACTS; it IS the wider door on the DETAIL,
    // because only the preview's answer is never written down.
    expect(releaseGateVerdict(preview.gate)).toEqual(released.result.gate)
    expect(preview.gate.blockers).toEqual([{ kind: 'restricted' }])
    expect(preview.gate.restricted).toBe(true)
    // The verdict was still taken over the GLOBAL view: three hidden blockers,
    // so the gate only passes because of the waiver.
    expect(preview.gate.waived).toBe(true)
    // Neither the count nor the ids nor the pass rate are anywhere in the wire
    // payload — the count is itself a cross-space side channel.
    const wire = JSON.stringify(preview)
    expect(wire).not.toContain('req-hidden')
    expect(wire).not.toContain('"passRate"')
  })

  it('shows a caller the blockers they CAN read, unredacted', async () => {
    const h = await makeHarness()
    seedVersion(h.db)
    seedRequirement(h.db, 'req-visible', 'Draft')
    seedGreenRun(h.db)

    const preview = await previewReleaseGate(
      { ctx: h.ctx, client: h.client, auditor: unfiltered(h) },
      {
        version: VERSION,
        approval: APPROVAL
      }
    )

    expect(preview.gate.restricted).toBe(false)
    expect(preview.gate.blockers).toEqual([
      expect.objectContaining({ kind: 'requirement-not-ready', object: 'req-visible' })
    ])
  })
})

// ── the read guard ──────────────────────────────────────────────────────────

describe('previewReleaseGate: the READ-PERMISSION guard', () => {
  it('refuses a caller who cannot read the version, indistinguishably from "absent"', async () => {
    const h = await makeHarness()
    seedVersion(h.db)
    seedRequirement(h.db, 'req-draft', 'Draft')
    seedGreenRun(h.db)
    h.db.hidden.add(VERSION as Ref<any>)

    await expect(
      previewReleaseGate({ ctx: h.ctx, client: h.client, auditor: unfiltered(h) }, { version: VERSION })
    ).rejects.toMatchObject({ reason: 'version-not-found', code: 400 })

    // A version that genuinely does not exist gets the SAME answer, so the
    // refusal does not confirm existence.
    await expect(
      previewReleaseGate(
        { ctx: h.ctx, client: h.client, auditor: unfiltered(h) },
        {
          version: 'no-such-version' as Ref<ProductVersion>
        }
      )
    ).rejects.toBeInstanceOf(PreviewReleaseGateError)
  })

  it('🔴 BIDIRECTIONAL: without the guard, that same caller WOULD get the report', async () => {
    // The other half of the proof. If the version were simply unreachable, the
    // test above would pass with no guard at all. Here the auditor reads the
    // very same version and produces a real report — so the refusal above is
    // caused by the guard consulting the CALLER's filtered client, and deleting
    // the guard turns this leak back on.
    const h = await makeHarness()
    seedVersion(h.db)
    seedRequirement(h.db, 'req-draft', 'Draft')
    seedGreenRun(h.db)
    h.db.hidden.add(VERSION as Ref<any>)

    const auditor = unfiltered(h)
    const version = await auditor.findOne<ProductVersion>(products.class.ProductVersion, { _id: VERSION })
    expect(version).toBeDefined()
    const leaked = await evaluateReleaseGate(auditor, auditor, version as ProductVersion, { approval: APPROVAL })
    // Existence, the verdict AND the blocking items — exactly what the guard
    // withholds.
    expect(leaked.passed).toBe(false)
    expect(leaked.blockers.map((it) => it.kind)).toEqual(['requirement-not-ready'])
  })

  it('refuses a blank waiver reason, exactly as the release does', async () => {
    const h = await makeHarness()
    seedVersion(h.db)

    await expect(
      previewReleaseGate(
        { ctx: h.ctx, client: h.client, auditor: unfiltered(h) },
        {
          version: VERSION,
          waiverReason: '   '
        }
      )
    ).rejects.toMatchObject({ reason: 'waiver-without-reason' })
  })
})

// ── the middleware entry point ──────────────────────────────────────────────

class HeadDb extends MemoryDb {}

/**
 * The chain BELOW the head. It honours `MemoryDb.hidden` for everybody EXCEPT
 * the system account, which is what makes `auditorReader`'s privileged view
 * real in this harness rather than assumed.
 */
class HeadAdapter implements Middleware {
  readonly accounts: string[] = []
  readonly txes: Tx[] = []

  constructor (readonly db: HeadDb) {}

  async tx (ctx: MeasureContext<SessionData>, txes: Tx[]): Promise<TxMiddlewareResult> {
    for (const tx of txes) {
      this.txes.push(tx)
      this.db.apply(tx)
    }
    return []
  }

  async findAll (ctx: MeasureContext<SessionData>, _class: Ref<any>, query: any): Promise<any> {
    this.accounts.push(ctx.contextData.account.uuid)
    const privileged = ctx.contextData.account.uuid === systemAccountUuid
    // ⚠️ `toFindResult`, not a bare array: `countResults` asks for
    // `{ limit: 0, total: true }` and reads `.total`. A plain array reports
    // `undefined` there, which silently turns every run into "no verdicts".
    if (!privileged) {
      return toFindResult(this.db.find(_class, query))
    }
    const saved = [...this.db.hidden]
    this.db.hidden.clear()
    try {
      return toFindResult(this.db.find(_class, query))
    } finally {
      for (const id of saved) this.db.hidden.add(id)
    }
  }

  async findAllRaw (): Promise<any> {
    return []
  }

  async loadModel (): Promise<any> {
    return []
  }

  async groupBy (): Promise<any> {
    return new Map()
  }

  async searchFulltext (): Promise<any> {
    return { docs: [], total: 0 }
  }

  async handleBroadcast (): Promise<void> {}
  async close (): Promise<void> {}
  async domainRequest (): Promise<any> {
    return { domain: '', value: undefined }
  }

  async closeSession (): Promise<void> {}
}

interface MwHarness {
  ctx: MeasureContext<SessionData>
  db: HeadDb
  head: HeadAdapter
  middleware: AgentraCommandRequestMiddleware
}

async function makeMwHarness (): Promise<MwHarness> {
  const db = new HeadDb()
  const ctx: any = {
    contextData: { account: { uuid: 'alice', primarySocialId: ALICE } },
    info: () => {},
    warn: () => {},
    error: () => {},
    measure: () => {},
    with: async (_n: string, _p: any, op: any) => op(ctx),
    withSync: (_n: string, _p: any, op: any) => op(ctx),
    newChild: () => ctx,
    end: () => {}
  }
  const head = new HeadAdapter(db)
  const context = {
    contextVars: {},
    hierarchy: {
      isDerived: (_class: Ref<any>, from: Ref<any>) => from === core.class.Doc,
      findDomain: () => undefined
    } as unknown as Hierarchy,
    modelDb: {} as any
  } as unknown as PipelineContext
  await CommandMiddleware.create(ctx, context, head)
  const next = {
    domainRequest: async (_c: any, domain: OperationDomain) => ({ domain, value: 'forwarded' })
  } as unknown as Middleware
  const middleware = (await AgentraCommandRequestMiddleware.create(
    ctx,
    context,
    next
  )) as AgentraCommandRequestMiddleware
  ;(context as any).head = head
  return { ctx, db, head, middleware }
}

async function invokePreview (h: MwHarness, params: any): Promise<any> {
  // ⚠️ `params`, the inner key the client writes.
  const result = await h.middleware.domainRequest(h.ctx, AGENTRA_COMMAND_DOMAIN, {
    [AGENTRA_OP_PREVIEW_RELEASE_GATE]: { params }
  })
  return (result as any).value
}

describe('AgentraCommandRequestMiddleware: previewReleaseGate', () => {
  it('answers on the `params` inner key with a ledger-free envelope', async () => {
    const h = await makeMwHarness()
    seedVersion(h.db)
    seedRequirement(h.db, 'req-draft', 'Draft')

    const value = await invokePreview(h, { version: VERSION })

    expect(value.ok).toBe(true)
    expect(value.result.gate.passed).toBe(false)
    // 🔴 The ledger's vocabulary is ABSENT: nothing ran, so nothing has an id.
    expect(value.executionId).toBeUndefined()
    expect(value.replayed).toBeUndefined()
    expect(value.preempted).toBeUndefined()
    // And no transaction of any kind reached the pipeline.
    expect(h.head.txes).toEqual([])
  })

  it('reads the query with `params`, so a mis-spelled inner key is not silently accepted', async () => {
    const h = await makeMwHarness()
    seedVersion(h.db)

    const result = await h.middleware.domainRequest(h.ctx, AGENTRA_COMMAND_DOMAIN, {
      [AGENTRA_OP_PREVIEW_RELEASE_GATE]: { query: { version: VERSION } }
    })

    expect((result as any).value).toEqual({
      ok: false,
      code: 400,
      reason: 'malformed-input',
      message: '`version` is required'
    })
  })

  it('🔴 decides over the GLOBAL view while echoing only what the caller may read', async () => {
    const h = await makeMwHarness()
    seedVersion(h.db)
    seedRequirement(h.db, 'req-hidden', 'Draft')
    h.db.hidden.add('req-hidden' as Ref<any>)
    // Green, so the ONLY blocker is the one the caller cannot read.
    seedGreenRun(h.db)

    const value = await invokePreview(h, { version: VERSION, approval: APPROVAL })

    expect(value.ok).toBe(true)
    // The verdict saw the hidden blocker...
    expect(value.result.gate.passed).toBe(false)
    // ...and the echo did not.
    expect(value.result.gate.blockers).toEqual([{ kind: 'restricted' }])
    expect(value.result.gate.restricted).toBe(true)
    // The privileged read really happened as the system account, and the
    // caller's own reads really happened as the caller.
    expect(new Set(h.head.accounts)).toEqual(new Set(['alice', systemAccountUuid]))
  })

  it('refuses a version the caller cannot read', async () => {
    const h = await makeMwHarness()
    seedVersion(h.db)
    h.db.hidden.add(VERSION as Ref<any>)

    const value = await invokePreview(h, { version: VERSION })

    expect(value).toEqual({
      ok: false,
      code: 400,
      reason: 'version-not-found',
      message: `Product version '${VERSION}' does not exist`
    })
    expect(h.head.txes).toEqual([])
  })

  it('validates `passRateThreshold` with the SAME rule as the release', async () => {
    const h = await makeMwHarness()
    seedVersion(h.db)

    for (const bar of [-1, 101, Number.NaN, 'ninety' as any]) {
      const value = await invokePreview(h, { version: VERSION, passRateThreshold: bar })
      expect(value).toEqual({
        ok: false,
        code: 400,
        reason: 'malformed-input',
        message: '`passRateThreshold` must be a number between 0 and 100'
      })
    }
  })

  it('leaves an unknown operation to the rest of the chain', async () => {
    const h = await makeMwHarness()
    expect(await h.middleware.handleCommand(h.ctx, { somethingElse: { params: {} } })).toBeNull()
  })
})
