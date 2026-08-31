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
import core, {
  toFindResult,
  type Class,
  type Doc,
  type FindResult,
  type Hierarchy,
  type MeasureContext,
  type PersonId,
  type FindOptions,
  type Ref,
  type SessionData,
  systemAccountUuid
} from '@hcengineering/core'
import products, { type ProductVersion } from '@hcengineering/products'
import requirements from '@hcengineering/requirements'
import type { Middleware, PipelineContext } from '@hcengineering/server-core'

import { AgentraCommandRequestMiddleware } from '../commandRequest'
import { auditRecordId } from '../commands/releaseProductVersion'
import type { ReleaseGateReport } from '../commands/releaseGate'

const VERSION = 'aaaaaaaaaaaaaaaaaaaaaav1' as Ref<ProductVersion>
/** Readable by the reader under test. */
const VISIBLE = 'aaaaaaaaaaaaaaaaaaaaaar1' as Ref<Doc>
/** In a space the reader has no access to. */
const HIDDEN = 'aaaaaaaaaaaaaaaaaaaaaar2' as Ref<Doc>

const ALICE = 'alice-social-id' as PersonId

/**
 * A record THIS BUILD WOULD NEVER WRITE: a full viewer-shaped report, blockers
 * and all.
 *
 * 🔴 THAT IS THE POINT OF THE FIXTURE. `releaseProductVersion` now persists a
 * `ReleaseGateVerdict`, so a record produced by this build carries nothing to
 * strip and every test here would pass vacuously against it. The read path's
 * job is to be right about the records it did NOT write — a restored backup, a
 * `props.gate` somebody stamped through another write path — so the fixture is
 * exactly such a record.
 */
const forgedReport: ReleaseGateReport = {
  version: VERSION,
  passed: true,
  waived: true,
  blockers: [
    {
      kind: 'requirement-not-ready',
      object: VISIBLE,
      objectClass: requirements.masterTag.Requirement as unknown as Ref<Class<Doc>>,
      detail: "status 'Draft'"
    },
    {
      kind: 'requirement-not-ready',
      object: HIDDEN,
      objectClass: requirements.masterTag.Requirement as unknown as Ref<Class<Doc>>,
      detail: "status 'Reviewing' on the unlisted acquisition"
    }
  ],
  restricted: false,
  passRate: 91.5,
  passRateThreshold: 100,
  notEvaluated: []
}

function auditRecord (props: Record<string, any>): ActivityInfoMessage {
  return {
    _id: auditRecordId(VERSION),
    _class: activity.class.ActivityInfoMessage,
    space: 'space-1' as Ref<any>,
    attachedTo: VERSION,
    attachedToClass: products.class.ProductVersion,
    collection: 'activity',
    objectId: VERSION,
    objectClass: products.class.ProductVersion,
    modifiedBy: core.account.System,
    modifiedOn: 1,
    createdOn: 1,
    message: 'agentra:string:Released' as any,
    props
  } as unknown as ActivityInfoMessage
}

/**
 * The chain BELOW the middleware. It answers the query verbatim, which is what
 * makes it stand in for "the audit record as it is actually stored".
 */
class NextAdapter implements Middleware {
  calls = 0
  /**
   * What the middleware actually asked for.
   *
   * 🔴 THIS ADAPTER DELIBERATELY IGNORES THE QUERY. A real backend would drop
   * the ledger row on `props.gate: { $exists: false }` and layer 2 would never
   * be exercised; answering verbatim is what makes every "the row is gone"
   * assertion below an assertion about the RESULT SWEEP. Layer 1 is asserted
   * separately, off {@link queries}.
   */
  readonly queries: any[] = []
  readonly options: Array<FindOptions<any> | undefined> = []
  constructor (private readonly docs: Doc[]) {}

  async findAll (
    _ctx: MeasureContext<SessionData>,
    _class: Ref<any>,
    query: any,
    options?: FindOptions<any>
  ): Promise<FindResult<any>> {
    this.calls++
    this.queries.push(query)
    this.options.push(options)
    // A `total` that is NOT `docs.length`, so a filter that recomputed it from
    // the array it happens to hold would be caught.
    return toFindResult([...this.docs], 42, { extra: this.docs[0] })
  }

  async tx (): Promise<any> {
    return {}
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

/**
 * The top of the chain. Nothing may reach it from the read filter any more —
 * the sanitizer is a pure function — so every assertion about it is an
 * assertion that ZERO reads happened.
 */
class HeadAdapter extends NextAdapter {
  readonly reads: Array<{ _class: Ref<any>, query: any }> = []

  constructor () {
    super([])
  }

  override async findAll (_ctx: MeasureContext<SessionData>, _class: Ref<any>, query: any): Promise<FindResult<any>> {
    this.reads.push({ _class, query })
    return toFindResult([])
  }
}

/**
 * Who is doing the reading.
 *
 * - `system` — the server itself: triggers, migrations, backup, `dev/tool`,
 *   and this middleware's own privileged auditor. The ledger is visible, and
 *   the sanitiser is the only thing acting on it, which is why every test that
 *   predates the read gate runs as this reader;
 * - `session` — a logged-in account over the websocket. The ledger is not
 *   visible at all;
 * - `command` — a command body, which re-enters the pipeline as the CALLER but
 *   with the ledger window open on `contextCache`;
 * - `anonymous` — a session context with no account on it.
 */
type Reader = 'system' | 'session' | 'command' | 'anonymous'

function contextDataFor (reader: Reader): any {
  if (reader === 'anonymous') {
    // No account and no cache: the shape the fail-closed branch has to survive.
    return {}
  }
  const uuid = reader === 'system' ? systemAccountUuid : 'alice'
  const contextCache = new Map<string, any>()
  if (reader === 'command') {
    contextCache.set('agentra:ledger-access', true)
  }
  return {
    account: { uuid, primarySocialId: ALICE },
    // Left ON deliberately: the gate must not be reading this flag.
    isTriggerCtx: true,
    contextCache
  }
}

function makeCtx (reader: Reader = 'system'): MeasureContext<SessionData> {
  const ctx: any = {
    contextData: contextDataFor(reader),
    info: () => {},
    warn: () => {},
    error: () => {},
    measure: () => {},
    with: async (_n: string, _p: any, op: any) => op(ctx),
    withSync: (_n: string, _p: any, op: any) => op(ctx),
    newChild: () => ctx,
    end: () => {}
  }
  return ctx
}

interface Harness {
  ctx: MeasureContext<SessionData>
  head: HeadAdapter
  next: NextAdapter
  middleware: AgentraCommandRequestMiddleware
}

async function makeHarness (docs: Doc[], reader: Reader = 'system'): Promise<Harness> {
  const ctx = makeCtx(reader)
  const head = new HeadAdapter()
  const next = new NextAdapter(docs)
  const context = {
    contextVars: {},
    hierarchy: {
      // The real question the filter asks: "can a query for `_class` return an
      // ActivityInfoMessage?"
      isDerived: (_class: Ref<any>, from: Ref<any>) =>
        _class === from || (_class === activity.class.ActivityInfoMessage && from === core.class.Doc)
    } as unknown as Hierarchy,
    modelDb: {} as any
  } as unknown as PipelineContext
  const middleware = (await AgentraCommandRequestMiddleware.create(
    ctx,
    context,
    next
  )) as AgentraCommandRequestMiddleware
  ;(context as any).head = head
  return { ctx, head, next, middleware }
}

async function readAudit (h: Harness, _class: Ref<Class<Doc>> = activity.class.ActivityInfoMessage): Promise<any[]> {
  return [...(await h.middleware.findAll(h.ctx, _class, {}))]
}

describe('release audit record read filtering', () => {
  it('drops EVERY blocker, not only the ones this reader may not see', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport })])
    const [doc] = await readAudit(h)

    expect(doc.props.gate.blockers).toEqual([])
    // 🔴 Neither the hidden one NOR the visible one survives. Keeping the
    // visible one is what the viewer-based filter used to do, and it is exactly
    // what cannot be done for a payload that also sits in `DOMAIN_TX`.
    expect(JSON.stringify(doc.props.gate)).not.toContain(HIDDEN)
    expect(JSON.stringify(doc.props.gate)).not.toContain(VISIBLE)
    expect(JSON.stringify(doc.props.gate)).not.toContain('acquisition')
    expect(JSON.stringify(doc.props.gate)).not.toContain('Draft')
  })

  it('reports the blockers as restricted rather than as absent', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport })])
    const [doc] = await readAudit(h)

    // The stored report claimed `restricted: false`; the projection takes the
    // flag from `waived`, i.e. from "were there blockers at all".
    expect(doc.props.gate.restricted).toBe(true)
    // Suppressed with it, for the same side-channel reason.
    expect(doc.props.gate.passRate).toBeUndefined()
    // The count of blockers is never reported, in any spelling.
    expect(JSON.stringify(doc.props.gate)).not.toContain('restrictedCount')
  })

  it('keeps the verdict itself, which is what REL-003 and REL-006 audit', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport })])
    const [doc] = await readAudit(h)

    expect(doc.props.gate.passed).toBe(true)
    expect(doc.props.gate.waived).toBe(true)
    expect(doc.props.gate.passRateThreshold).toBe(100)
    expect(doc.props.gate.version).toBe(VERSION)
  })

  it('keeps passRate for a clean gate, where no blocker existed to project', async () => {
    const clean: ReleaseGateReport = { ...forgedReport, waived: false, blockers: [] }
    const h = await makeHarness([auditRecord({ gate: clean })])
    const [doc] = await readAudit(h)

    expect(doc.props.gate.restricted).toBe(false)
    expect(doc.props.gate.passRate).toBe(91.5)
    expect(doc.props.gate.blockers).toEqual([])
  })

  it('does not touch the rest of the record', async () => {
    const h = await makeHarness([
      auditRecord({ gate: forgedReport, approval: 'appr-1', waiverReason: 'exec sign-off' })
    ])
    const [doc] = await readAudit(h)

    expect(doc.props.approval).toBe('appr-1')
    expect(doc.props.waiverReason).toBe('exec sign-off')
    expect(doc.message).toBe('agentra:string:Released')
    expect(doc._id).toBe(auditRecordId(VERSION))
  })

  it('preserves total and lookupMap rather than recomputing them', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport })])
    const result = await h.middleware.findAll(h.ctx, activity.class.ActivityInfoMessage, {})

    expect(result.total).toBe(42)
    expect(result.lookupMap).toBeDefined()
    expect(result).toHaveLength(1)
  })

  it('fires on an ANCESTOR query class, which is how the activity panel reads', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport })])
    const [doc] = await readAudit(h, core.class.Doc)

    expect(doc.props.gate.blockers).toEqual([])
  })

  it('leaves activity messages that carry no gate exactly as they were', async () => {
    const plain = auditRecord({ someOtherProp: 1 })
    const h = await makeHarness([plain])
    const result = await h.middleware.findAll(h.ctx, activity.class.ActivityInfoMessage, {})

    expect(result[0]).toEqual(plain)
  })

  it('issues no read at all — the projection is a pure function', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport })])
    await readAudit(h)
    await h.middleware.findAll(h.ctx, products.class.ProductVersion, {})

    expect(h.head.reads).toHaveLength(0)
  })

  it('does not clear isTriggerCtx on the CALLER context', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport })])
    await readAudit(h)

    expect((h.ctx.contextData as any).isTriggerCtx).toBe(true)
  })

  it('needs no caller identity to sanitise, because the projection has none', async () => {
    // A command-window reader rather than the system account: the sanitiser is
    // the same pure function for both, and this is the reader that proves it
    // does not consult the account it was handed.
    const h = await makeHarness([auditRecord({ gate: forgedReport, waiverReason: 'exec sign-off' })], 'command')
    const [doc] = await readAudit(h)

    expect(doc.props.gate.passed).toBe(true)
    expect(doc.props.gate.waived).toBe(true)
    expect(doc.props.gate.blockers).toEqual([])
    expect(doc.props.waiverReason).toBe('exec sign-off')
  })
})

/** `FindOptions` carrying one projection, without an inline assertion. */
function projected (projection: Record<string, 1>): FindOptions<any> {
  const options: FindOptions<any> = { projection: projection as any }
  return options
}

describe('command ledger read gate', () => {
  it('hides the ledger row from a session read entirely', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport, waiverReason: 'exec sign-off' })], 'session')
    const rows = await readAudit(h)

    // Not "sanitised" — ABSENT. The record's existence is itself the signal:
    // which version was released, when, by whom, and that a waiver was used.
    expect(rows).toHaveLength(0)
  })

  it('pushes the exclusion into the QUERY, so the row is never counted either', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport })], 'session')
    await readAudit(h)

    // 🔴 The layer that a `projection` cannot reach, because `WHERE` runs
    // before `SELECT`. `total` and `limit` are decided against this query.
    expect(h.next.queries[0]).toEqual({ 'props.gate': { $exists: false } })
  })

  it('overrides a probing query that names the marker itself', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport })], 'session')
    await h.middleware.findAll(h.ctx, activity.class.ActivityInfoMessage, {
      'props.gate': { $exists: true }
    } as any)

    // The caller's constraint is spread FIRST and overwritten, not merged: a
    // probe for "records that have a gate" comes back with the opposite.
    expect(h.next.queries[0]).toEqual({ 'props.gate': { $exists: false } })
  })

  it('still hides the row when the caller projects the marker away', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport })], 'session')
    const rows = [
      ...(await h.middleware.findAll(h.ctx, activity.class.ActivityInfoMessage, {}, projected({ _id: 1, message: 1 })))
    ]

    // 🔴 THE BUG CLASS THIS TEST EXISTS FOR: a result filter that reads
    // `props.gate` off the returned document lets the row through the moment
    // the caller projects `props` away, because "no match" reads as "not a
    // ledger row". The projection is widened before the sweep instead.
    expect(h.next.options[0]?.projection).toEqual({ _id: 1, message: 1, props: 1 })
    expect(rows).toHaveLength(0)
  })

  it('gives back the projection that was asked for, not the widened one', async () => {
    const plain = auditRecord({ someOtherProp: 1 })
    const h = await makeHarness([plain], 'session')
    const rows = [...(await h.middleware.findAll(h.ctx, activity.class.ActivityInfoMessage, {}, projected({ _id: 1 })))]

    expect(rows).toHaveLength(1)
    // `props` was added by the gate, so it is taken back off again.
    expect(rows[0].props).toBeUndefined()
    expect(rows[0]._id).toBe(plain._id)
  })

  it('leaves the projection alone when the caller already asked for props', async () => {
    const h = await makeHarness([auditRecord({ someOtherProp: 1 })], 'session')
    await h.middleware.findAll(h.ctx, activity.class.ActivityInfoMessage, {}, projected({ _id: 1, props: 1 }))

    expect(h.next.options[0]?.projection).toEqual({ _id: 1, props: 1 })
  })

  it('does not touch ordinary activity messages', async () => {
    // `completeCycle`'s snapshot and `archive`'s audit line are exactly this
    // shape: an `ActivityInfoMessage` with `props` and no `gate`.
    const snapshot = auditRecord({ closedIssues: 3, rolloverPolicy: 'backlog' })
    const h = await makeHarness([snapshot], 'session')
    const rows = await readAudit(h)

    expect(rows).toEqual([snapshot])
  })

  it('decrements total by what it removed rather than recomputing it', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport }), auditRecord({ other: 1 })], 'session')
    const result = await h.middleware.findAll(h.ctx, activity.class.ActivityInfoMessage, {})

    // 42 was the adapter's count over the whole query; one row was swept.
    expect(result.total).toBe(41)
    expect(result).toHaveLength(1)
  })

  it('lets the server itself read the ledger', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport })], 'system')
    const rows = await readAudit(h)

    expect(rows).toHaveLength(1)
    // …and does not rewrite the query for it, so triggers and migrations see
    // the rows their own predicates asked for.
    expect(h.next.queries[0]).toEqual({})
  })

  it('lets a command body read its own re-entrancy anchor', async () => {
    // 🔴 NOT A CONVENIENCE. `releaseProductVersion` reads the record back
    // through the CALLER's client; hiding it there does not fail the read, it
    // fails the WRITE — `ensureAuditRecord` would re-derive the same `_id`.
    const h = await makeHarness([auditRecord({ gate: forgedReport })], 'command')
    const rows = await readAudit(h)

    expect(rows).toHaveLength(1)
    expect(h.next.queries[0]).toEqual({})
  })

  it('fails closed for a session context with no account and no cache', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport })], 'anonymous')

    expect(await readAudit(h)).toHaveLength(0)
  })

  it('does not read the window key off anything the caller controls', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport })], 'session')
    // A client can put whatever it likes in the query and the options; the key
    // is looked up on `SessionData.contextCache`, which the transactor rebuilds
    // empty for every request and this file is the only writer of.
    const rows = [
      ...(await h.middleware.findAll(
        h.ctx,
        activity.class.ActivityInfoMessage,
        { 'agentra:ledger-access': true } as any,
        { 'agentra:ledger-access': true } as any
      ))
    ]

    expect(rows).toHaveLength(0)
    expect((h.ctx.contextData as any).contextCache.get('agentra:ledger-access')).toBeUndefined()
  })

  it('skips the whole gate for a class that cannot be an activity message', async () => {
    const h = await makeHarness([auditRecord({ gate: forgedReport })], 'session')
    await h.middleware.findAll(h.ctx, products.class.ProductVersion, {})

    // Cheap gate first: no query rewrite, no projection widening, no sweep.
    expect(h.next.queries[0]).toEqual({})
    expect(h.next.options[0]).toBeUndefined()
  })
})
