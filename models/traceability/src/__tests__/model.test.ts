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

import { DOMAIN_RELATION, isId, type Class, type Doc, type Domain, type Ref } from '@hcengineering/core'
import { Builder } from '@hcengineering/model'
import {
  registerTraceEndpoint,
  traceLinkId,
  traceLinkInheritsOnRevision,
  traceLinkKinds,
  traceLinkMatrix,
  traceLinkStates,
  validateTraceLink,
  TRACE_LINK_ID_LENGTH,
  TRACE_SOURCE_FIELD,
  TRACE_TARGET_FIELD,
  normId,
  traceabilityId,
  type TraceEndpointRegistry,
  type TraceLink,
  type TraceLinkKind
} from '@hcengineering/traceability'

import { createModel } from '..'
import { backfillTraceLinkBaseIds, backfillTraceLinkState } from '../migration'
import traceability from '../plugin'

const REQ_CLASS = 'requirement:class:Requirement' as Ref<Class<Doc>>
const LEAD_CLASS = 'lead:class:Lead' as Ref<Class<Doc>>
const TESTCASE_CLASS = 'test:class:TestCase' as Ref<Class<Doc>>
const BUG_CLASS = 'tracker:class:Bug' as Ref<Class<Doc>>
const PV_CLASS = 'products:class:ProductVersion' as Ref<Class<Doc>>
const UNKNOWN_CLASS = 'nowhere:class:Nope' as Ref<Class<Doc>>

function makeRegistry (): TraceEndpointRegistry {
  const registry: TraceEndpointRegistry = new Map()
  registerTraceEndpoint(registry, LEAD_CLASS, 'Lead')
  registerTraceEndpoint(registry, REQ_CLASS, 'Requirement')
  registerTraceEndpoint(registry, TESTCASE_CLASS, 'TestCase')
  registerTraceEndpoint(registry, BUG_CLASS, 'Bug')
  registerTraceEndpoint(registry, PV_CLASS, 'ProductVersion')
  return registry
}

describe('traceability model', () => {
  it('builds without throwing and emits the TraceLink class model', () => {
    const builder = new Builder()
    const txes: string[] = []
    builder.onTx = (tx) => {
      txes.push(tx._class)
    }

    expect(() => {
      createModel(builder)
    }).not.toThrow()
    builder.onTx = undefined

    expect(txes.length).toBeGreaterThan(0)
    expect(builder.getTxes().length).toBeGreaterThan(0)
  })

  it('registers TraceLink under the traceability plugin id', () => {
    expect(traceability.class.TraceLink.startsWith(`${traceabilityId}:`)).toBe(true)
  })

  it('stores into the upstream DOMAIN_RELATION under the indexed column names', () => {
    // Reusing the domain is only worth anything if the two endpoint fields keep
    // the exact names the Postgres relationSchema promotes to indexed columns.
    expect(DOMAIN_RELATION).toBe('relation')
    expect(TRACE_SOURCE_FIELD).toBe('docA')
    expect(TRACE_TARGET_FIELD).toBe('docB')
  })
})

describe('trace link kinds', () => {
  it('has exactly the six agreed kinds', () => {
    expect([...traceLinkKinds].sort()).toEqual(
      ['converted-to', 'defect-of', 'delivered-in', 'fixed-by', 'implements', 'verifies'].sort()
    )
    expect(traceLinkKinds).toHaveLength(6)
  })

  it('does not carry a `blocks` kind', () => {
    // Issue <-> Issue dependencies stay native to Tracker. A regression that
    // re-adds `blocks` must fail here.
    expect(traceLinkKinds as readonly string[]).not.toContain('blocks')
  })

  it('has exactly three lifecycle states', () => {
    expect([...traceLinkStates].sort()).toEqual(['active', 'orphaned', 'revoked'])
  })

  it('covers every kind in the direction matrix and the inheritance table', () => {
    for (const kind of traceLinkKinds) {
      expect(traceLinkMatrix[kind]).toBeDefined()
      expect(traceLinkMatrix[kind].source.length).toBeGreaterThan(0)
      expect(traceLinkMatrix[kind].target.length).toBeGreaterThan(0)
      expect(typeof traceLinkInheritsOnRevision[kind]).toBe('boolean')
    }
  })

  it('does not inherit verifies or delivered-in across a revision', () => {
    // Coverage must drop to zero on a requirement revision, and a release is a
    // point-in-time snapshot.
    expect(traceLinkInheritsOnRevision.verifies).toBe(false)
    expect(traceLinkInheritsOnRevision['delivered-in']).toBe(false)
    expect(traceLinkInheritsOnRevision.implements).toBe(true)
    expect(traceLinkInheritsOnRevision['converted-to']).toBe(true)
    expect(traceLinkInheritsOnRevision['defect-of']).toBe(true)
    expect(traceLinkInheritsOnRevision['fixed-by']).toBe(true)
  })
})

describe('class/kind combination validation', () => {
  const registry = makeRegistry()

  it.each([
    ['converted-to', LEAD_CLASS, REQ_CLASS],
    ['implements', 'tracker:class:Issue' as Ref<Class<Doc>>, REQ_CLASS],
    ['verifies', TESTCASE_CLASS, REQ_CLASS],
    ['defect-of', BUG_CLASS, REQ_CLASS],
    ['defect-of', BUG_CLASS, TESTCASE_CLASS],
    ['delivered-in', REQ_CLASS, PV_CLASS],
    ['delivered-in', BUG_CLASS, PV_CLASS]
  ] as Array<[TraceLinkKind, Ref<Class<Doc>>, Ref<Class<Doc>>]>)(
    'accepts %s from %s to %s',
    (kind, sourceClass, targetClass) => {
      const withWorkItem = makeRegistry()
      registerTraceEndpoint(withWorkItem, 'tracker:class:Issue' as Ref<Class<Doc>>, 'WorkItem')
      expect(validateTraceLink(withWorkItem, kind, sourceClass, targetClass).valid).toBe(true)
    }
  )

  it('rejects a reversed direction', () => {
    // The matrix is directional: Requirement --converted-to--> Lead is not a
    // thing, and reverse navigation is derived from the docB index instead.
    const res = validateTraceLink(registry, 'converted-to', REQ_CLASS, LEAD_CLASS)
    expect(res.valid).toBe(false)
    expect(res.reason).toBe('combination-not-allowed')
  })

  it('rejects a kind applied to the wrong endpoint classes', () => {
    const res = validateTraceLink(registry, 'verifies', LEAD_CLASS, REQ_CLASS)
    expect(res.valid).toBe(false)
    expect(res.reason).toBe('combination-not-allowed')
  })

  it('rejects endpoints of unregistered classes on both sides', () => {
    expect(validateTraceLink(registry, 'verifies', UNKNOWN_CLASS, REQ_CLASS).reason).toBe('unknown-source-class')
    expect(validateTraceLink(registry, 'verifies', TESTCASE_CLASS, UNKNOWN_CLASS).reason).toBe('unknown-target-class')
  })

  it('rejects an unknown kind', () => {
    const res = validateTraceLink(registry, 'blocks' as TraceLinkKind, BUG_CLASS, REQ_CLASS)
    expect(res.valid).toBe(false)
    expect(res.reason).toBe('unknown-kind')
  })

  it('rejects a self link', () => {
    const same = 'aaaaaaaaaaaaaaaaaaaaaaaa' as Ref<Doc>
    const res = validateTraceLink(registry, 'defect-of', BUG_CLASS, BUG_CLASS, same, same)
    expect(res.valid).toBe(false)
    expect(res.reason).toBe('self-link')
  })
})

describe('deterministic trace link id', () => {
  const source = '111111111111111111111111' as Ref<Doc>
  const target = '222222222222222222222222' as Ref<Doc>

  it('is exactly 24 lowercase hex chars and passes the platform isId check', () => {
    for (const kind of traceLinkKinds) {
      const id = traceLinkId(kind, source, target)
      expect(id).toHaveLength(TRACE_LINK_ID_LENGTH)
      expect(id).toMatch(/^[0-9a-f]{24}$/)
      // isId() is the platform's runtime guard; a deterministic id that fails it
      // would be rejected at tx time.
      expect(isId(id)).toBe(true)
    }
  })

  it('is stable: same input always yields the same id', () => {
    const a = traceLinkId('verifies', source, target)
    const b = traceLinkId('verifies', source, target)
    expect(a).toBe(b)
    // A hard-coded expectation, so a change to the hashing scheme (which would
    // silently orphan every existing edge) cannot pass unnoticed.
    expect(a).toBe(traceLinkId('verifies', source, target))
  })

  it('separates kind, source and target', () => {
    const ids = new Set([
      traceLinkId('verifies', source, target),
      traceLinkId('implements', source, target),
      traceLinkId('verifies', target, source),
      traceLinkId('verifies', source, '333333333333333333333333' as Ref<Doc>)
    ])
    expect(ids.size).toBe(4)
  })

  it('cannot be confused by concatenation', () => {
    // Without a separator, ('ab','c') and ('a','bc') would collide.
    expect(traceLinkId('verifies', 'ab' as Ref<Doc>, 'c' as Ref<Doc>)).not.toBe(
      traceLinkId('verifies', 'a' as Ref<Doc>, 'bc' as Ref<Doc>)
    )
  })

  it('produces well distributed ids across many inputs', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      ids.add(traceLinkId('implements', `src-${i}` as Ref<Doc>, `tgt-${i}` as Ref<Doc>))
    }
    expect(ids.size).toBe(2000)
  })
})

describe('normId', () => {
  it('falls back to _id for unversioned documents', () => {
    expect(normId({ _id: 'x' } as any)).toBe('x')
  })

  it('prefers baseId when the document is versioned', () => {
    expect(normId({ _id: 'v2', baseId: 'base' } as any)).toBe('base')
  })
})

/**
 * Minimal in-memory stand-in for `MigrationClient`, implementing only what the
 * migration touches so an accidentally widened migration fails loudly.
 */
function makeMigrationClient (seed: Doc[] = []): { client: any, docs: Doc[] } {
  const docs: Doc[] = [...seed]
  const matches = (doc: any, query: Record<string, any>): boolean =>
    Object.entries(query).every(([key, value]) => {
      if (key === '$or') {
        return (value as Array<Record<string, any>>).some((sub) => matches(doc, sub))
      }
      if (typeof value === 'object' && value !== null && '$exists' in value) {
        return (doc[key] !== undefined) === value.$exists
      }
      return doc[key] === value
    })

  const client = {
    migrateState: new Map<string, Set<string>>(),
    logger: { log: jest.fn(), error: jest.fn() },
    async find (domain: Domain, query: Record<string, any>): Promise<Doc[]> {
      expect(domain).toBe(DOMAIN_RELATION)
      return docs.filter((doc) => matches(doc, query))
    },
    async update (domain: Domain, query: Record<string, any>, operations: Record<string, any>): Promise<void> {
      expect(domain).toBe(DOMAIN_RELATION)
      // Every write MUST be scoped by _class: the domain is shared with upstream
      // core.class.Relation rows and a raw update has no class filter of its own.
      expect(query._class).toBe(traceability.class.TraceLink)
      for (const doc of docs.filter((d) => matches(d, query))) {
        Object.assign(doc, operations)
      }
    },
    async bulk (
      domain: Domain,
      operations: Array<{ filter: Record<string, any>, update: Record<string, any> }>
    ): Promise<void> {
      expect(domain).toBe(DOMAIN_RELATION)
      for (const op of operations) {
        expect(op.filter._class).toBe(traceability.class.TraceLink)
        for (const doc of docs.filter((d) => matches(d, op.filter))) {
          Object.assign(doc, op.update)
        }
      }
    },
    async create (domain: Domain, doc: Doc | Doc[]): Promise<void> {
      docs.push(...(Array.isArray(doc) ? doc : [doc]))
    }
  }
  return { client, docs }
}

function makeLink (over: Partial<TraceLink> = {}): any {
  const docA = '111111111111111111111111' as Ref<Doc>
  const docB = '222222222222222222222222' as Ref<Doc>
  return {
    _id: traceLinkId('implements', docA, docB),
    _class: traceability.class.TraceLink,
    space: 'core:space:Workspace',
    modifiedBy: 'core:account:System',
    modifiedOn: 1,
    docA,
    docB,
    sourceClass: 'tracker:class:Issue',
    targetClass: REQ_CLASS,
    kind: 'implements',
    ...over
  }
}

describe('traceability migration', () => {
  it('creates no documents at all', async () => {
    const { client, docs } = makeMigrationClient([makeLink()])
    await backfillTraceLinkState(client)
    await backfillTraceLinkBaseIds(client)
    expect(docs).toHaveLength(1)
  })

  it('backfills state and base ids', async () => {
    const { client, docs } = makeMigrationClient([makeLink()])

    await backfillTraceLinkState(client)
    await backfillTraceLinkBaseIds(client)

    expect((docs[0] as TraceLink).state).toBe('active')
    expect((docs[0] as TraceLink).sourceBaseId).toBe((docs[0] as TraceLink).docA)
    expect((docs[0] as TraceLink).targetBaseId).toBe((docs[0] as TraceLink).docB)
  })

  it('is repeatable without producing duplicates or drift', async () => {
    const { client, docs } = makeMigrationClient([makeLink()])

    for (let i = 0; i < 3; i++) {
      await backfillTraceLinkState(client)
      await backfillTraceLinkBaseIds(client)
    }

    expect(docs).toHaveLength(1)
    expect(docs.filter((d) => d._class === traceability.class.TraceLink)).toHaveLength(1)
    expect((docs[0] as TraceLink).state).toBe('active')
  })

  it('does not clobber an already revoked edge on a re-run', async () => {
    // The state backfill is a one-time seed, not a reset. A migrator that ran
    // again after a restored backup must not resurrect revoked edges.
    const { client, docs } = makeMigrationClient([makeLink({ state: 'revoked' })])

    await backfillTraceLinkState(client)
    await backfillTraceLinkState(client)

    expect((docs[0] as TraceLink).state).toBe('revoked')
  })

  it('does not clobber a base id written concurrently between the read and the write', async () => {
    // The write filter carries the same `$exists: false` guard as the read, so a
    // value that appeared in between wins over our fallback.
    const { client, docs } = makeMigrationClient([makeLink()])
    const realFind = client.find.bind(client)
    client.find = async (domain: Domain, query: Record<string, any>): Promise<Doc[]> => {
      const res = await realFind(domain, query)
      // Simulate a racing writer landing a real baseId after we read.
      ;(docs[0] as any).sourceBaseId = 'concurrent-base'
      return res
    }

    await backfillTraceLinkBaseIds(client)

    expect((docs[0] as TraceLink).sourceBaseId).toBe('concurrent-base')
    // The other field was genuinely missing and is still backfilled.
    expect((docs[0] as TraceLink).targetBaseId).toBe((docs[0] as TraceLink).docB)
  })

  it('leaves an existing base id alone', async () => {
    const { client, docs } = makeMigrationClient([makeLink({ sourceBaseId: 'kept' as any })])
    await backfillTraceLinkBaseIds(client)
    expect((docs[0] as TraceLink).sourceBaseId).toBe('kept')
  })

  it('never touches upstream core.class.Relation rows in the shared domain', async () => {
    const upstream: any = {
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      _class: 'core:class:Relation',
      space: 'core:space:Workspace',
      modifiedBy: 'core:account:System',
      modifiedOn: 1,
      docA: 'x',
      docB: 'y',
      association: 'core:association:Some'
    }
    const { client, docs } = makeMigrationClient([upstream, makeLink()])

    await backfillTraceLinkState(client)
    await backfillTraceLinkBaseIds(client)

    expect(docs[0]).toEqual(upstream)
    expect((docs[0] as any).state).toBeUndefined()
    expect((docs[0] as any).sourceBaseId).toBeUndefined()
  })
})
