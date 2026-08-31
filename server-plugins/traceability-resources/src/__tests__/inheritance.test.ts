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

import core, { toFindResult, TxFactory } from '@hcengineering/core'
import type {
  Class,
  Doc,
  MeasureContext,
  PersonId,
  Ref,
  SessionData,
  Space,
  Tx,
  TxCreateDoc
} from '@hcengineering/core'
import type { Middleware, PipelineContext } from '@hcengineering/server-core'
import traceability, {
  summariseRequirementCoverage,
  traceLinkId,
  traceLinkInheritsOnRevision,
  traceLinkKinds,
  type CoverageEdge,
  type TraceLink,
  type TraceLinkKind,
  type TraceLinkState
} from '@hcengineering/traceability'

import { inheritedEdgeIds, planInheritedEdges, readRevisionCreate, type RevisionCreate } from '../inheritance'
import { TraceabilityMiddleware } from '../middleware'

const REQ_CLASS = 'requirement:class:Requirement' as Ref<Class<Doc>>
const CASE_CLASS = 'test:class:TestCase' as Ref<Class<Doc>>
const PLAIN_CLASS = 'tracker:class:Issue' as Ref<Class<Doc>>

const BASE = 'requirement-base' as Ref<Doc>
const V1 = BASE
const V2 = 'requirement-v2' as Ref<Doc>
const V3 = 'requirement-v3' as Ref<Doc>
const FAR = 'far-endpoint' as Ref<Doc>
const FAR_BASE = 'far-base' as Ref<Doc>

const WORKSPACE = 'core:space:Workspace' as Ref<Space>
const SYSTEM = 'core:account:System' as PersonId

const REVISION: RevisionCreate = {
  objectId: V2,
  objectClass: REQ_CLASS,
  objectSpace: WORKSPACE,
  baseId: BASE,
  version: 2
}

/** An edge with the predecessor as TARGET (`X --kind--> requirement`). */
function incoming (kind: TraceLinkKind, over: Partial<TraceLink> = {}): TraceLink {
  return {
    _id: traceLinkId(kind, FAR, V1),
    _class: traceability.class.TraceLink,
    space: WORKSPACE,
    modifiedBy: SYSTEM,
    modifiedOn: 1,
    docA: FAR,
    sourceClass: CASE_CLASS,
    docB: V1,
    targetClass: REQ_CLASS,
    kind,
    sourceBaseId: FAR_BASE,
    targetBaseId: BASE,
    state: 'active',
    ...over
  }
}

/** An edge with the predecessor as SOURCE (`requirement --kind--> X`). */
function outgoing (kind: TraceLinkKind, over: Partial<TraceLink> = {}): TraceLink {
  return {
    ...incoming(kind),
    _id: traceLinkId(kind, V1, FAR),
    docA: V1,
    sourceClass: REQ_CLASS,
    docB: FAR,
    targetClass: CASE_CLASS,
    sourceBaseId: BASE,
    targetBaseId: FAR_BASE,
    ...over
  }
}

const NOTHING = new Set<Ref<TraceLink>>()

// ── the planner ───────────────────────────────────────────────────────────────

describe('readRevisionCreate', () => {
  function create (objectId: Ref<Doc>, attributes: Record<string, unknown>): Tx {
    return {
      _class: core.class.TxCreateDoc,
      _id: 'tx' as Ref<Tx>,
      space: core.space.Tx,
      modifiedBy: SYSTEM,
      modifiedOn: 1,
      objectId,
      objectClass: REQ_CLASS,
      objectSpace: WORKSPACE,
      attributes
    } as unknown as TxCreateDoc<Doc>
  }

  it('recognises a revision by baseId !== objectId', () => {
    expect(readRevisionCreate(create(V2, { baseId: BASE, version: 2 }))).toEqual(REVISION)
  })

  it('carries the stamped version through, and tolerates its absence', () => {
    expect(readRevisionCreate(create(V2, { baseId: BASE }))?.version).toBeUndefined()
    expect(readRevisionCreate(create(V2, { baseId: BASE, version: 'two' }))?.version).toBeUndefined()
  })

  it('🔴 treats the FIRST revision (baseId === objectId) as a plain create', () => {
    // `VersioningMiddleware.setVersionData` sets `baseId = objectId` on a brand
    // new document. Inheriting there would make a document inherit its own edges.
    expect(readRevisionCreate(create(V1, { baseId: V1 }))).toBeUndefined()
  })

  it('ignores an unversioned create and every non-create tx', () => {
    expect(readRevisionCreate(create(V2, {}))).toBeUndefined()
    expect(readRevisionCreate({ _class: core.class.TxUpdateDoc } as unknown as Tx)).toBeUndefined()
  })
})

describe('planInheritedEdges', () => {
  it('🔴 executes the §3.2.1 table on the TARGET side, kind by kind', () => {
    for (const kind of traceLinkKinds) {
      const plan = planInheritedEdges([incoming(kind)], V1, REVISION, NOTHING)
      expect(plan).toHaveLength(traceLinkInheritsOnRevision[kind] ? 1 : 0)
    }
  })

  it('🔴 executes the same table on the SOURCE side (delivered-in lives there)', () => {
    for (const kind of traceLinkKinds) {
      const plan = planInheritedEdges([outgoing(kind)], V1, REVISION, NOTHING)
      expect(plan).toHaveLength(traceLinkInheritsOnRevision[kind] ? 1 : 0)
    }
  })

  it('carries exactly the four inheriting kinds and neither of the two that do not', () => {
    const plan = planInheritedEdges(
      traceLinkKinds.map((kind) => incoming(kind)),
      V1,
      REVISION,
      NOTHING
    )
    expect(plan.map((edge) => edge.attributes.kind)).toEqual(['converted-to', 'implements', 'defect-of', 'fixed-by'])
  })

  it('re-points the target end and leaves the source end alone', () => {
    const [edge] = planInheritedEdges([incoming('implements')], V1, REVISION, NOTHING)
    expect(edge._id).toBe(traceLinkId('implements', FAR, V2))
    expect(edge.attributes.docA).toBe(FAR)
    expect(edge.attributes.docB).toBe(V2)
    expect(edge.attributes.targetClass).toBe(REQ_CLASS)
    expect(edge.attributes.sourceBaseId).toBe(FAR_BASE)
    expect(edge.attributes.targetBaseId).toBe(BASE)
    expect(edge.attributes.state).toBe('active')
    expect(edge.attributes.metadata?.inheritedFrom).toBe(traceLinkId('implements', FAR, V1))
  })

  it('re-points the source end for an outgoing edge', () => {
    const [edge] = planInheritedEdges([outgoing('converted-to')], V1, REVISION, NOTHING)
    expect(edge._id).toBe(traceLinkId('converted-to', V2, FAR))
    expect(edge.attributes.docA).toBe(V2)
    expect(edge.attributes.docB).toBe(FAR)
    expect(edge.attributes.sourceBaseId).toBe(BASE)
    expect(edge.attributes.targetBaseId).toBe(FAR_BASE)
  })

  it('never carries a revoked or an orphaned edge forward', () => {
    for (const state of ['revoked', 'orphaned'] as TraceLinkState[]) {
      expect(planInheritedEdges([incoming('implements', { state })], V1, REVISION, NOTHING)).toHaveLength(0)
    }
  })

  it('ignores edges that touch neither end of the predecessor', () => {
    const elsewhere = incoming('implements', { _id: 'x' as Ref<TraceLink>, docB: V3 })
    expect(planInheritedEdges([elsewhere], V1, REVISION, NOTHING)).toHaveLength(0)
  })

  // ── idempotence / re-entrancy ──────────────────────────────────────────────
  it('🔴 is idempotent: a replay whose ids already exist produces nothing', () => {
    const edges = traceLinkKinds.map((kind) => incoming(kind))
    const first = planInheritedEdges(edges, V1, REVISION, NOTHING)
    expect(first).toHaveLength(4)
    const landed = new Set(first.map((edge) => edge._id))
    expect(planInheritedEdges(edges, V1, REVISION, landed)).toHaveLength(0)
  })

  it('🔴 is re-entrant: after a partial failure only the missing edges are planned', () => {
    const edges = traceLinkKinds.map((kind) => incoming(kind))
    const all = planInheritedEdges(edges, V1, REVISION, NOTHING)
    // Two of four landed before the process died.
    const partial = new Set(all.slice(0, 2).map((edge) => edge._id))
    const rest = planInheritedEdges(edges, V1, REVISION, partial)
    expect(rest.map((edge) => edge._id)).toEqual(all.slice(2).map((edge) => edge._id))
  })

  it('derives the same id twice for the same triple, so two writers collide', () => {
    const once = planInheritedEdges([incoming('defect-of')], V1, REVISION, NOTHING)
    const twice = planInheritedEdges([incoming('defect-of')], V1, REVISION, NOTHING)
    expect(once[0]._id).toBe(twice[0]._id)
    expect(inheritedEdgeIds([incoming('defect-of')], V1, REVISION)).toEqual([once[0]._id])
  })

  it('refuses a degenerate self-link rather than splitting it into two edges', () => {
    const selfish = incoming('implements', { docA: V1, sourceClass: REQ_CLASS })
    expect(planInheritedEdges([selfish], V1, REVISION, NOTHING)).toHaveLength(0)
  })

  it('collapses two predecessor edges that derive the same id into one create', () => {
    const twin = incoming('implements', { _id: 'duplicate-row' as Ref<TraceLink> })
    expect(planInheritedEdges([incoming('implements'), twin], V1, REVISION, NOTHING)).toHaveLength(1)
  })
})

// ── the coverage contract this must not break ────────────────────────────────

describe('🔴 revising a requirement still zeroes its coverage', () => {
  it('does not carry the verifies edge, so covered === 0 and stale === 1', () => {
    const before = [incoming('verifies'), incoming('implements')]
    const carried = planInheritedEdges(before, V1, REVISION, NOTHING)
    expect(carried.map((edge) => edge.attributes.kind)).toEqual(['implements'])

    // What the coverage arithmetic sees on the NEW revision: the old verifies
    // edge (still pointing at V1) plus whatever inheritance produced.
    const seen: CoverageEdge[] = [
      ...before.map((link) => ({
        kind: link.kind,
        source: link.docA,
        target: link.docB,
        targetBaseId: link.targetBaseId
      })),
      ...carried.map((edge) => ({
        kind: edge.attributes.kind,
        source: edge.attributes.docA,
        target: edge.attributes.docB,
        targetBaseId: edge.attributes.targetBaseId
      }))
    ]
    const coverage = summariseRequirementCoverage(seen, V2, BASE, new Map())
    expect(coverage.covered).toBe(0)
    expect(coverage.stale).toBe(1)
    expect(coverage.supersededCoverage).toBe(true)
  })
})

// ── the middleware wiring ────────────────────────────────────────────────────

interface Harness {
  middleware: TraceabilityMiddleware
  /** Batches handed DOWN the chain, in order. */
  batches: Tx[][]
  /** Was every read issued before the first write? */
  readsBeforeFirstWrite: boolean
}

function harness (options: {
  links?: TraceLink[]
  chain?: Doc[]
  versionable?: boolean
  existing?: Array<Ref<TraceLink>>
}): Harness {
  const links = options.links ?? []
  const chain = options.chain ?? []
  const existing = new Set(options.existing ?? [])
  const state: Harness = { middleware: undefined as any, batches: [], readsBeforeFirstWrite: true }

  const match = (doc: any, query: any): boolean =>
    Object.entries(query).every(([k, v]: [string, any]) => {
      if (v !== null && typeof v === 'object' && '$in' in v) return (v.$in as any[]).includes(doc[k])
      return doc[k] === v
    })

  const next = {
    findAll: async (_ctx: any, _class: Ref<Class<Doc>>, query: any) => {
      if (state.batches.length > 0) state.readsBeforeFirstWrite = false
      if (_class === traceability.class.TraceLink) {
        const found = links.filter((l) => match(l, query))
        // `_id: { $in: [...] }` is the re-entrancy probe: answer it from the
        // set of ids the caller says already landed.
        if (query._id?.$in !== undefined) {
          return toFindResult(
            (query._id.$in as Array<Ref<TraceLink>>)
              .filter((id) => existing.has(id))
              .map((id) => ({ ...incoming('implements'), _id: id }))
          )
        }
        return toFindResult(found)
      }
      return toFindResult(chain.filter((d) => match(d, query)))
    },
    tx: async (_ctx: any, txes: Tx[]) => {
      state.batches.push(txes)
      return {}
    }
  } as unknown as Middleware

  const context: PipelineContext = {
    hierarchy: {
      hasClass: (c: string) => c === REQ_CLASS || c === PLAIN_CLASS,
      classHierarchyMixin: (c: string, mixin: string) =>
        c === REQ_CLASS && mixin === core.mixin.VersionableClass ? {} : undefined
    },
    contextVars: {}
  } as any

  state.middleware = new (TraceabilityMiddleware as any)(context, next)
  return state
}

function ctx (): MeasureContext<SessionData> {
  return { contextData: {}, info: () => {}, warn: () => {}, error: () => {} } as any
}

/**
 * A revision create shaped the way one actually arrives here: an ORDINARY user
 * tx (not a `DerivedTx`) that `VersioningMiddleware` has already stamped.
 */
function revisionTx (objectId: Ref<Doc>, baseId: Ref<Doc>, version = 2, objectClass = REQ_CLASS): Tx {
  return new TxFactory(SYSTEM).createTxCreateDoc<Doc>(
    objectClass,
    WORKSPACE,
    { baseId, version, isLatest: true } as any,
    objectId as any
  )
}

function predecessor (over: Partial<Doc> = {}): Doc {
  return {
    _id: V1,
    _class: REQ_CLASS,
    space: WORKSPACE,
    modifiedBy: SYSTEM,
    modifiedOn: 1,
    baseId: BASE,
    isLatest: true,
    version: 1,
    ...over
  } as any
}

describe('TraceabilityMiddleware inheritance', () => {
  it('writes the inherited edges in a SECOND batch, after the revision', async () => {
    const h = harness({ links: [incoming('implements'), incoming('verifies')], chain: [predecessor()] })
    await h.middleware.tx(ctx(), [revisionTx(V2, BASE)])

    expect(h.batches).toHaveLength(2)
    expect(h.batches[0]).toHaveLength(1)
    const derived = h.batches[1] as Array<TxCreateDoc<TraceLink>>
    expect(derived).toHaveLength(1)
    expect(derived[0].objectId).toBe(traceLinkId('implements', FAR, V2))
    expect(derived[0].attributes.kind).toBe('implements')
    expect(derived[0].objectClass).toBe(traceability.class.TraceLink)
    // 🔴 The reads must all precede the write, or the predecessor lookup would
    // find the successor itself.
    expect(h.readsBeforeFirstWrite).toBe(true)
  })

  it('does nothing at all for a first revision', async () => {
    const h = harness({ links: [incoming('implements')], chain: [predecessor()] })
    await h.middleware.tx(ctx(), [revisionTx(V1, V1, 1)])
    expect(h.batches).toHaveLength(1)
  })

  it('🔴 ignores a forged baseId on an unversioned class', async () => {
    // `VersioningMiddleware` stamps nothing for such a class, so `baseId` there
    // is client-supplied and must not be trusted to mean "revision".
    const h = harness({ links: [incoming('implements')], chain: [predecessor({ _class: PLAIN_CLASS } as any)] })
    await h.middleware.tx(ctx(), [revisionTx(V2, BASE, 2, PLAIN_CLASS)])
    expect(h.batches).toHaveLength(1)
  })

  it('emits no second batch when the predecessor has no inheritable edges', async () => {
    const h = harness({ links: [incoming('verifies')], chain: [predecessor()] })
    await h.middleware.tx(ctx(), [revisionTx(V2, BASE)])
    expect(h.batches).toHaveLength(1)
  })

  it('🔴 never picks the successor as its own predecessor', async () => {
    // V2 is already stored and still flagged `isLatest`.
    const h = harness({
      links: [incoming('implements')],
      chain: [predecessor({ isLatest: false } as any), { ...predecessor(), _id: V2, version: 2 } as any]
    })
    await h.middleware.tx(ctx(), [revisionTx(V2, BASE)])
    const derived = h.batches[1] as Array<TxCreateDoc<TraceLink>>
    expect(derived[0].objectId).toBe(traceLinkId('implements', FAR, V2))
  })

  it('🔴 never picks a LATER revision as the predecessor of an earlier one', async () => {
    // The chain has moved on to V3. Inheriting V2's edges must still read V1 —
    // `isLatest` names the head of the chain, not the parent of this member.
    const h = harness({
      links: [incoming('implements'), { ...incoming('implements'), _id: 'v3-edge' as any, docB: V3 }],
      chain: [predecessor({ isLatest: false } as any), { ...predecessor(), _id: V3, version: 3, isLatest: true } as any]
    })
    await h.middleware.tx(ctx(), [revisionTx(V2, BASE, 2)])
    const derived = h.batches[1] as Array<TxCreateDoc<TraceLink>>
    // Read V1's edge, not V3's — both would produce the SAME derived id here, so
    // the proof is that exactly one edge was planned off the V1 row.
    expect(derived).toHaveLength(1)
    expect(derived[0].attributes.metadata?.inheritedOnRevisionOf).toBe(V1)
  })

  it('falls back to the highest version when no member carries isLatest', async () => {
    const h = harness({
      links: [incoming('implements')],
      chain: [
        predecessor({ isLatest: undefined } as any),
        { ...predecessor(), _id: 'requirement-v0' as Ref<Doc>, version: 0, isLatest: undefined } as any
      ]
    })
    await h.middleware.tx(ctx(), [revisionTx(V2, BASE, 2)])
    const derived = h.batches[1] as Array<TxCreateDoc<TraceLink>>
    expect(derived[0].attributes.metadata?.inheritedOnRevisionOf).toBe(V1)
  })

  it('🔴 is idempotent through the pipeline: a replay writes no second edge', async () => {
    const already = traceLinkId('implements', FAR, V2)
    const h = harness({
      links: [incoming('implements')],
      chain: [predecessor()],
      existing: [already]
    })
    await h.middleware.tx(ctx(), [revisionTx(V2, BASE)])
    expect(h.batches).toHaveLength(1)
  })

  it('leaves an ordinary batch untouched', async () => {
    const h = harness({})
    const plain = new TxFactory(SYSTEM).createTxUpdateDoc(REQ_CLASS, WORKSPACE, V1 as any, {})
    await h.middleware.tx(ctx(), [plain])
    expect(h.batches).toEqual([[plain]])
  })
})
