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

import core, { systemAccountUuid, toFindResult } from '@hcengineering/core'
import type { Class, Doc, FindOptions, MeasureContext, PersonId, Ref, SessionData, Space } from '@hcengineering/core'
import type { Middleware, PipelineContext } from '@hcengineering/server-core'
import { TRACEABILITY_DOMAIN, TRACE_OP_FIND_OUTGOING, type TraceLinksResult } from '@hcengineering/server-traceability'
import traceability, { traceLinkId, type TraceLink } from '@hcengineering/traceability'

import { TraceabilityMiddleware } from '../middleware'

const DOC = 'core:class:Doc' as Ref<Class<Doc>>
const REQ = 'requirement:class:Requirement' as Ref<Class<Doc>>
const CASE = 'test:class:TestCase' as Ref<Class<Doc>>

const REQ_ID = '111111111111111111111111' as Ref<Doc>
const CASE_ID = '222222222222222222222222' as Ref<Doc>
const OTHER_ID = '333333333333333333333333' as Ref<Doc>

const WORKSPACE = 'core:space:Workspace' as Ref<Space>
const SYSTEM = 'core:account:System' as PersonId

/** `alice` sees both endpoints; `mallory` only the near one; `nobody` neither. */
const VISIBILITY: Record<string, Set<Ref<Doc>>> = {
  alice: new Set([REQ_ID, CASE_ID]),
  mallory: new Set([REQ_ID]),
  nobody: new Set()
}

/** Only the edges are interesting; `_class` is what the class gate reads. */
const PARENTS: Record<string, string[]> = {
  [traceability.class.TraceLink]: [DOC, 'core:class:Relation'],
  [REQ]: [DOC],
  [CASE]: [DOC],
  [core.class.Tx]: [DOC],
  [core.class.TxCUD]: [core.class.Tx, DOC],
  [core.class.TxCreateDoc]: [core.class.TxCUD, core.class.Tx, DOC],
  [core.class.TxUpdateDoc]: [core.class.TxCUD, core.class.Tx, DOC]
}

function createTx (over: Partial<TraceLink> = {}): any {
  return {
    _id: 'tx1' as any,
    _class: core.class.TxCreateDoc,
    space: WORKSPACE,
    modifiedBy: SYSTEM,
    modifiedOn: 1,
    objectId: 'edge1',
    objectClass: traceability.class.TraceLink,
    objectSpace: WORKSPACE,
    attributes: { ...link(), ...over }
  }
}

function isDerived (a: string, b: string): boolean {
  return a === b || (PARENTS[a] ?? []).includes(b)
}

function link (over: Partial<TraceLink> = {}): TraceLink {
  return {
    _id: traceLinkId('verifies', CASE_ID, REQ_ID),
    _class: traceability.class.TraceLink,
    space: WORKSPACE,
    modifiedBy: SYSTEM,
    modifiedOn: 1,
    docA: REQ_ID,
    sourceClass: REQ,
    docB: CASE_ID,
    targetClass: CASE,
    kind: 'verifies',
    sourceBaseId: REQ_ID,
    targetBaseId: CASE_ID,
    state: 'active',
    ...over
  }
}

const ENDPOINTS: Doc[] = [
  { _id: REQ_ID, _class: REQ, space: WORKSPACE, modifiedBy: SYSTEM, modifiedOn: 1 } as any,
  { _id: CASE_ID, _class: CASE, space: WORKSPACE, modifiedBy: SYSTEM, modifiedOn: 1 } as any
]

function sessionCtx (account: string, extra: Record<string, unknown> = {}): MeasureContext<SessionData> {
  return {
    contextData: { account: { uuid: account, primarySocialId: `${account}-social` }, ...extra },
    newChild: () => sessionCtx(account, extra),
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any
}

interface Harness {
  middleware: TraceabilityMiddleware
  /** Every class the middleware resolved endpoints for, in order. */
  headReads: Array<{ account: string, _class: Ref<Class<Doc>> }>
  /** What the fake adapter was handed, so the projection rewrite is observable. */
  adapterOptions: Array<FindOptions<Doc> | undefined>
}

/**
 * `next` is the adapter side: it honours `projection`, which is the whole point
 * — a filter that only reads the rows it is handed can be blinded by one.
 * `head` is the security side: what comes back depends on the account, exactly
 * as `SpaceSecurityMiddleware` makes it.
 */
function harness (rows: Doc[], opt: { total?: number, headIntoFindAll?: boolean } = {}): Harness {
  const state: Harness = { middleware: undefined as any, headReads: [], adapterOptions: [] }

  const next = {
    findAll: async (_ctx: any, _class: Ref<Class<Doc>>, _query: any, options?: FindOptions<Doc>) => {
      state.adapterOptions.push(options)
      const projection = options?.projection as Record<string, 0 | 1> | undefined
      const docs = rows.map((doc) => {
        if (projection === undefined) return doc
        const out: any = {}
        for (const [field, mode] of Object.entries(projection)) {
          if (mode === 1 && (doc as any)[field] !== undefined) out[field] = (doc as any)[field]
        }
        return out as Doc
      })
      return toFindResult(docs, opt.total ?? docs.length)
    }
  } as unknown as Middleware

  const head = {
    findAll: async (ctx: MeasureContext<SessionData>, _class: Ref<Class<Doc>>, query: any) => {
      const account = (ctx.contextData as any).account.uuid as string
      state.headReads.push({ account, _class })
      if (isDerived(traceability.class.TraceLink, _class)) {
        // Model the real pipeline: the head re-enters this very middleware.
        if (opt.headIntoFindAll === true) {
          return await state.middleware.findAll(ctx, _class as any, query)
        }
        return toFindResult(rows.filter((d) => isDerived(d._class, traceability.class.TraceLink)))
      }
      const wanted: Array<Ref<Doc>> = query._id?.$in ?? []
      const allowed = VISIBILITY[account] ?? new Set<Ref<Doc>>()
      return toFindResult(ENDPOINTS.filter((d) => wanted.includes(d._id) && allowed.has(d._id)))
    }
  } as unknown as Middleware

  const context: PipelineContext = { head, hierarchy: { isDerived }, contextVars: {} } as any
  state.middleware = new (TraceabilityMiddleware as any)(context, next)
  return state
}

async function find (
  h: Harness,
  account: string,
  options?: FindOptions<Doc>,
  extra?: Record<string, unknown>
): Promise<Doc[]> {
  return [
    ...(await h.middleware.findAll(
      sessionCtx(account, extra ?? {}),
      traceability.class.TraceLink as any,
      {},
      options as any
    ))
  ]
}

describe('TraceabilityMiddleware.findAll', () => {
  // ── the hole this closes ──────────────────────────────────────────────────
  it('returns the edge when the caller can see BOTH endpoints', async () => {
    const h = harness([link()])
    expect(await find(h, 'alice')).toHaveLength(1)
  })

  it('🔴 drops the edge when ONE endpoint is unreadable', async () => {
    const h = harness([link()])
    expect(await find(h, 'mallory')).toEqual([])
  })

  it('🔴 drops the edge when NEITHER endpoint is readable', async () => {
    const h = harness([link()])
    expect(await find(h, 'nobody')).toEqual([])
  })

  it('🔴 the SAME query answers differently per caller', async () => {
    const h = harness([link()])
    expect(await find(h, 'alice')).toHaveLength(1)
    expect(await find(h, 'mallory')).toHaveLength(0)
    expect(new Set(h.headReads.map((r) => r.account))).toEqual(new Set(['alice', 'mallory']))
  })

  it('resolves endpoints through the head, never through the next hop', async () => {
    const h = harness([link()])
    await find(h, 'alice')
    expect(h.headReads.map((r) => r._class).sort()).toEqual([CASE, REQ].sort())
  })

  // ── projection: the blinding attack ───────────────────────────────────────
  it('🔴 a projection that erases docA/docB does NOT disable the filter', async () => {
    const h = harness([link()])
    const docs = await find(h, 'mallory', { projection: { _id: 1 } } as any)
    expect(docs).toEqual([])
    // The rewrite is visible on the wire to the adapter.
    const sent = h.adapterOptions[0]?.projection as Record<string, 0 | 1>
    expect(sent).toMatchObject({ _id: 1, docA: 1, docB: 1, sourceClass: 1, targetClass: 1 })
  })

  it('🔴 a projection pinning docA to 0 does not disable it either', async () => {
    const h = harness([link()])
    expect(await find(h, 'mallory', { projection: { _id: 1, docA: 0 } } as any)).toEqual([])
  })

  it('gives the widened fields back to nobody: the caller sees exactly its projection', async () => {
    const h = harness([link()])
    const docs = await find(h, 'alice', { projection: { _id: 1 } } as any)
    expect(docs).toHaveLength(1)
    expect(Object.keys(docs[0]).sort()).toEqual(['_class', '_id'])
    expect((docs[0] as any).docA).toBeUndefined()
    expect((docs[0] as any).targetClass).toBeUndefined()
  })

  it('leaves a request with no projection completely alone', async () => {
    const h = harness([link()])
    const docs = await find(h, 'alice')
    expect(h.adapterOptions[0]).toBeUndefined()
    expect((docs[0] as any).docA).toBe(REQ_ID)
  })

  it('🔴 an edge missing an endpoint field is dropped, not passed', async () => {
    const h = harness([link({ docB: undefined as any })])
    expect(await find(h, 'alice')).toEqual([])
  })

  // ── system reads must not be collateral damage ────────────────────────────
  it('🔴 the system account is not filtered', async () => {
    const h = harness([link()])
    expect(await find(h, systemAccountUuid as unknown as string)).toHaveLength(1)
    expect(h.headReads).toEqual([])
  })

  it('🔴 a trigger context is not filtered', async () => {
    const h = harness([link()])
    const docs = await find(h, 'nobody', undefined, { isTriggerCtx: true })
    expect(docs).toHaveLength(1)
    expect(h.headReads).toEqual([])
  })

  it('🔴 a context with no session data at all is not filtered', async () => {
    const h = harness([link()])
    const bare = { info: () => {}, warn: () => {}, error: () => {} } as any
    expect(await h.middleware.findAll(bare, traceability.class.TraceLink as any, {})).toHaveLength(1)
  })

  it("🔴 the middleware's OWN endpoint reads are not filtered again, so `restricted` survives", async () => {
    // `head` re-enters `findAll`, exactly as the real pipeline does. Without the
    // internal-read marker the edge would be filtered out before `query.ts` saw
    // it and `coverage.restricted` would be permanently 0.
    const h = harness([link()], { headIntoFindAll: true })
    const value = (
      (await h.middleware.domainRequest(sessionCtx('mallory'), TRACEABILITY_DOMAIN, {
        [TRACE_OP_FIND_OUTGOING]: { params: { doc: REQ_ID } }
      })) as any
    ).value as TraceLinksResult
    expect(value.links).toHaveLength(1)
    expect(value.links[0].target.visible).toBe(false)
    expect(value.coverage).toEqual({ total: 1, visible: 0, restricted: 1, byKind: {} })
  })

  // ── the cheap gate ────────────────────────────────────────────────────────
  it('does not touch a query that cannot return an edge', async () => {
    const h = harness([{ _id: OTHER_ID, _class: REQ } as any])
    const docs = [...(await h.middleware.findAll(sessionCtx('nobody'), REQ as any, {}))]
    expect(docs).toHaveLength(1)
    expect(h.headReads).toEqual([])
    expect(h.adapterOptions[0]).toBeUndefined()
  })

  it('🔴 fires on a core.class.Doc query and filters ONLY the edges in it', async () => {
    const other = { _id: OTHER_ID, _class: REQ, space: WORKSPACE } as any
    const h = harness([link(), other])
    const docs = [...(await h.middleware.findAll(sessionCtx('mallory'), DOC as any, {}))]
    expect(docs).toEqual([other])
  })

  // ── $lookup: the second door ──────────────────────────────────────────────
  it('🔴 filters edges arriving through a reverse $lookup', async () => {
    const parent = { _id: OTHER_ID, _class: REQ, space: WORKSPACE, $lookup: { edges: [link()] } } as any
    const h = harness([parent])
    const docs = [
      ...(await h.middleware.findAll(sessionCtx('mallory'), REQ as any, {}, {
        lookup: { _id: { edges: [traceability.class.TraceLink, 'docA'] } }
      } as any))
    ]
    expect(docs).toHaveLength(1)
    expect((docs[0] as any).$lookup.edges).toEqual([])
    // The parent row itself is untouched.
    expect(docs[0]._id).toBe(OTHER_ID)
    // And the original object was not mutated.
    expect(parent.$lookup.edges).toHaveLength(1)
  })

  it('keeps a $lookup edge whose endpoints are both readable', async () => {
    const parent = { _id: OTHER_ID, _class: REQ, space: WORKSPACE, $lookup: { edges: [link()] } } as any
    const h = harness([parent])
    const docs = [
      ...(await h.middleware.findAll(sessionCtx('alice'), REQ as any, {}, {
        lookup: { _id: { edges: [traceability.class.TraceLink, 'docA'] } }
      } as any))
    ]
    expect((docs[0] as any).$lookup.edges).toHaveLength(1)
  })

  // ── total ─────────────────────────────────────────────────────────────────
  it('🔴 never republishes a server-side total that counted restricted edges', async () => {
    const h = harness([link()], { total: 42 })
    const result = await h.middleware.findAll(sessionCtx('mallory'), traceability.class.TraceLink as any, {}, {
      total: true
    } as any)
    expect(result).toHaveLength(0)
    expect(result.total).toBe(-1)
  })

  it('reports the filtered length when the adapter only echoed the page length', async () => {
    const other = { _id: OTHER_ID, _class: REQ, space: WORKSPACE } as any
    const h = harness([link(), other])
    const result = await h.middleware.findAll(sessionCtx('mallory'), DOC as any, {})
    expect(result.total).toBe(1)
  })

  it('leaves total untouched when nothing was dropped', async () => {
    const h = harness([link()], { total: 42 })
    const result = await h.middleware.findAll(sessionCtx('alice'), traceability.class.TraceLink as any, {}, {
      total: true
    } as any)
    expect(result.total).toBe(42)
  })

  // ── DOMAIN_TX: the second copy of every edge ──────────────────────────────
  it('🔴 filters TxCreateDoc<TraceLink> out of a transaction query', async () => {
    const h = harness([createTx()])
    const docs = [...(await h.middleware.findAll(sessionCtx('mallory'), core.class.Tx as any, {}))]
    expect(docs).toEqual([])
  })

  it('keeps the creating transaction when both endpoints are readable', async () => {
    const h = harness([createTx()])
    const docs = [...(await h.middleware.findAll(sessionCtx('alice'), core.class.Tx as any, {}))]
    expect(docs).toHaveLength(1)
  })

  it('🔴 drops a non-create transaction on an edge outright: it carries no endpoint to judge', async () => {
    const update = { ...createTx(), _class: core.class.TxUpdateDoc, attributes: undefined }
    const h = harness([update])
    expect([...(await h.middleware.findAll(sessionCtx('alice'), core.class.Tx as any, {}))]).toEqual([])
  })

  it('🔴 fires on a query for the CONCRETE tx class, not just for a base class', async () => {
    // `isDerived(TxCUD, TxCreateDoc)` is false — TxCUD is the parent — so a gate
    // that only looked "downwards" would let this exact query through, and it is
    // the one that returns the edge's whole `attributes`.
    const h = harness([createTx()])
    expect([...(await h.middleware.findAll(sessionCtx('mallory'), core.class.TxCreateDoc as any, {}))]).toEqual([])
  })

  it('🔴 fires on a query for a concrete edge class too', async () => {
    const h = harness([link()])
    expect([...(await h.middleware.findAll(sessionCtx('mallory'), traceability.class.TraceLink as any, {}))]).toEqual(
      []
    )
  })

  it('leaves transactions about anything else alone', async () => {
    const other = { ...createTx(), objectClass: REQ, attributes: { title: 'x' } }
    const h = harness([other])
    const docs = [...(await h.middleware.findAll(sessionCtx('nobody'), core.class.Tx as any, {}))]
    expect(docs).toHaveLength(1)
    expect(h.headReads).toEqual([])
  })

  it('🔴 a projection cannot blind the transaction filter either', async () => {
    const h = harness([createTx()])
    const docs = [
      ...(await h.middleware.findAll(sessionCtx('mallory'), core.class.Tx as any, {}, {
        projection: { _id: 1 }
      } as any))
    ]
    expect(docs).toEqual([])
    expect(h.adapterOptions[0]?.projection).toMatchObject({ objectClass: 1, attributes: 1 })
  })

  // ── the combined gate Codex found open ────────────────────────────────────
  it('🔴 filters $lookup edges even when the query class ALSO carries edges', async () => {
    const parent = { _id: OTHER_ID, _class: REQ, space: WORKSPACE, $lookup: { edges: [link()] } } as any
    const h = harness([link(), parent])
    const docs = [
      ...(await h.middleware.findAll(sessionCtx('mallory'), DOC as any, {}, {
        lookup: { _id: { edges: [traceability.class.TraceLink, 'docA'] } }
      } as any))
    ]
    // The top-level edge is gone AND the one hiding in the lookup payload is too.
    expect(docs).toHaveLength(1)
    expect(docs[0]._id).toBe(OTHER_ID)
    expect((docs[0] as any).$lookup.edges).toEqual([])
  })

  it('🔴 an edge that itself carries a $lookup payload is still dropped', async () => {
    // The identity trap: `filterLookup` copies, and a copy is no longer the key
    // the verdict was recorded against.
    // Its `$lookup` must actually CHANGE, or no copy is made and the trap
    // never springs: the nested edge is invisible to mallory, so it is dropped.
    const edge = { ...link(), $lookup: { edges: [link()] } } as any
    const h = harness([edge])
    const docs = [
      ...(await h.middleware.findAll(sessionCtx('mallory'), DOC as any, {}, {
        lookup: { _id: { edges: [traceability.class.TraceLink, 'docA'] } }
      } as any))
    ]
    expect(docs).toEqual([])
  })

  // ── exclusion projections keep their meaning ──────────────────────────────
  it('🔴 an exclusion projection is not silently turned into an inclusion one', async () => {
    const h = harness([link()])
    await find(h, 'alice', { projection: { state: 0 } } as any)
    // Nothing needed lifting, so the options object is passed through untouched.
    expect(h.adapterOptions[0]?.projection).toEqual({ state: 0 })
  })

  it('🔴 lifts an exclusion of docA rather than adding an inclusion beside it', async () => {
    const h = harness([link()])
    const docs = await find(h, 'alice', { projection: { docA: 0 } } as any)
    const sent = h.adapterOptions[0]?.projection as Record<string, 0 | 1>
    expect(sent).toEqual({})
    expect(Object.values(sent)).not.toContain(1)
    // And the caller still does not get the field it excluded.
    expect((docs[0] as any).docA).toBeUndefined()
  })

  // ── malformed rows fail closed without throwing ───────────────────────────
  it('🔴 an edge with a null endpoint class is dropped, and never asked about', async () => {
    const h = harness([link({ sourceClass: null as any })])
    expect(await find(h, 'alice')).toEqual([])
    // Not one read: an unjudgeable row is dropped, never turned into a query on
    // a `null` classifier that would throw and take the whole page with it.
    expect(h.headReads).toEqual([])
  })

  it('🔴 an endpoint class the hierarchy does not know is never queried, and fails closed', async () => {
    const h = harness([link()])
    ;(h.middleware as any).context.hierarchy.hasClass = (cls: string) => cls !== CASE
    expect(await find(h, 'alice')).toEqual([])
    // REQ was still resolved; CASE was skipped rather than handed to the head,
    // where an unknown classifier throws and takes the whole page with it.
    expect(h.headReads.map((r) => r._class)).toEqual([REQ])
  })

  it('🔴 an edge with an empty endpoint id is dropped', async () => {
    const h = harness([link({ docB: '' as any })])
    expect(await find(h, 'alice')).toEqual([])
  })
})
