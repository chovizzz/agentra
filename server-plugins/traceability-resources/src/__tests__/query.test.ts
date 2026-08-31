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

import { isId, type Class, type Doc, type PersonId, type Ref, type Space } from '@hcengineering/core'
import traceability, { traceLinkId, type TraceLink } from '@hcengineering/traceability'

import { buildTraceLink, findIncomingLinks, findOutgoingLinks, summarize, type TraceLinkFinder } from '../query'

const REQ = 'requirement:class:Requirement' as Ref<Class<Doc>>
const CASE = 'test:class:TestCase' as Ref<Class<Doc>>

const REQ_ID = '111111111111111111111111' as Ref<Doc>
const CASE_ID = '222222222222222222222222' as Ref<Doc>
const SECRET_CASE_ID = '333333333333333333333333' as Ref<Doc>

function link (over: Partial<TraceLink> = {}): TraceLink {
  const base: TraceLink = {
    _id: traceLinkId('verifies', CASE_ID, REQ_ID),
    _class: traceability.class.TraceLink,
    space: 'core:space:Workspace' as Ref<Space>,
    modifiedBy: 'core:account:System' as PersonId,
    modifiedOn: 1,
    docA: CASE_ID,
    sourceClass: CASE,
    docB: REQ_ID,
    targetClass: REQ,
    kind: 'verifies',
    sourceBaseId: CASE_ID,
    targetBaseId: REQ_ID,
    state: 'active'
  }
  return { ...base, ...over }
}

/** Stands in for the raw domain read; records the queries it was handed. */
function finder (links: TraceLink[]): { find: TraceLinkFinder, queries: Array<Record<string, any>> } {
  const queries: Array<Record<string, any>> = []
  const find: TraceLinkFinder = async (query) => {
    queries.push(query)
    return links.filter((l) =>
      Object.entries(query).every(([k, v]) => {
        if (typeof v === 'object' && v !== null && '$in' in v) return (v.$in as any[]).includes((l as any)[k])
        return (l as any)[k] === v
      })
    )
  }
  return { find, queries }
}

/** Stands in for a security-filtered read: only `allowed` ids come back. */
function resolver (allowed: Array<Ref<Doc>>): (_class: Ref<Class<Doc>>, ids: Array<Ref<Doc>>) => Promise<Doc[]> {
  return async (_class, ids) =>
    ids
      .filter((id) => allowed.includes(id))
      .map(
        (id) =>
          ({
            _id: id,
            _class,
            space: 'space' as any,
            modifiedBy: 'sys' as any,
            modifiedOn: 1,
            // Sensitive-looking payload: the assertions below prove it never
            // escapes for an endpoint the caller cannot read.
            title: `secret title of ${id}`
          }) as any
      )
}

describe('edge query shape', () => {
  it('always pins _class so upstream core.class.Relation rows cannot be returned', async () => {
    const { find, queries } = finder([link()])
    await findOutgoingLinks(find, resolver([CASE_ID, REQ_ID]), { doc: CASE_ID })
    expect(queries[0]._class).toBe(traceability.class.TraceLink)
  })

  it('uses the indexed docA column for outgoing and docB for incoming', async () => {
    const out = finder([link()])
    await findOutgoingLinks(out.find, resolver([CASE_ID, REQ_ID]), { doc: CASE_ID })
    expect(out.queries[0].docA).toBe(CASE_ID)
    expect(out.queries[0].docB).toBeUndefined()

    const inc = finder([link()])
    await findIncomingLinks(inc.find, resolver([CASE_ID, REQ_ID]), { doc: REQ_ID })
    expect(inc.queries[0].docB).toBe(REQ_ID)
    expect(inc.queries[0].docA).toBeUndefined()
  })

  it('defaults to active edges only, and includes history only when asked', async () => {
    const a = finder([link()])
    await findOutgoingLinks(a.find, resolver([CASE_ID, REQ_ID]), { doc: CASE_ID })
    expect(a.queries[0].state).toEqual({ $in: ['active'] })

    const b = finder([link()])
    await findOutgoingLinks(b.find, resolver([CASE_ID, REQ_ID]), {
      doc: CASE_ID,
      states: ['active', 'orphaned', 'revoked']
    })
    expect(b.queries[0].state).toEqual({ $in: ['active', 'orphaned', 'revoked'] })
  })

  it('switches to the base id fields when normalising across versions', async () => {
    const { find, queries } = finder([link()])
    await findOutgoingLinks(find, resolver([CASE_ID, REQ_ID]), {
      doc: CASE_ID,
      baseId: 'base' as Ref<Doc>,
      normalize: true
    })
    expect(queries[0].sourceBaseId).toBe('base')
    expect(queries[0].docA).toBeUndefined()
  })
})

describe('per-endpoint permission filtering', () => {
  it('returns both endpoints when the caller may read both', async () => {
    const { find } = finder([link()])
    const res = await findOutgoingLinks(find, resolver([CASE_ID, REQ_ID]), { doc: CASE_ID })

    expect(res).toHaveLength(1)
    expect(res[0].source.visible).toBe(true)
    expect(res[0].target.visible).toBe(true)
  })

  it('leaks nothing about a far endpoint the caller may not read', async () => {
    const { find } = finder([link()])
    // Caller can see the test case (near) but not the requirement (far).
    const res = await findOutgoingLinks(find, resolver([CASE_ID]), { doc: CASE_ID })

    expect(res).toHaveLength(1)
    const target = res[0].target
    expect(target.visible).toBe(false)
    expect(target.doc).toBeUndefined()
    expect(target._class).toBeUndefined()
    // The strongest assertion: nothing anywhere in the serialised payload
    // mentions the RESTRICTED endpoint's content. Titles, identifiers, people
    // and statuses must never survive the filter. (The near endpoint's own
    // title is legitimately present — the caller may read that object.)
    expect(JSON.stringify(res)).not.toContain(`secret title of ${REQ_ID}`)
    expect(JSON.stringify(res.map((r) => r.target))).not.toContain('secret title')
    // The link still surfaces its kind/state so the UI can render a placeholder.
    expect(res[0].kind).toBe('verifies')
  })

  it('returns nothing at all when the near endpoint is unreadable', async () => {
    const { find } = finder([link()])
    // Not being able to read the object means not being able to enumerate its
    // edges either — edge counts are themselves information.
    const res = await findOutgoingLinks(find, resolver([REQ_ID]), { doc: CASE_ID })
    expect(res).toEqual([])
  })

  it('does not let a hit under one class satisfy an endpoint of another', async () => {
    // Same id, different class. Granting the caller the TestCase must NOT make
    // a Requirement carrying the same ref look visible.
    const collide = link({ docB: CASE_ID, targetClass: REQ })
    const { find } = finder([collide])
    // Resolver only ever grants the TestCase class, never the Requirement class.
    const res = await findOutgoingLinks(
      find,
      async (_class, ids) =>
        _class === CASE
          ? ids.map((id) => ({ _id: id, _class, space: 'space', modifiedBy: 's', modifiedOn: 1 }) as any)
          : [],
      { doc: CASE_ID }
    )

    expect(res).toHaveLength(1)
    expect(res[0].source.visible).toBe(true)
    expect(res[0].target.visible).toBe(false)
  })

  it('ignores documents the resolver returns that were never asked for', async () => {
    const { find } = finder([link()])
    const res = await findOutgoingLinks(
      find,
      async (_class, ids) => {
        if (_class === CASE) {
          return ids.map((id) => ({ _id: id, _class, space: 'space', modifiedBy: 's', modifiedOn: 1 })) as any
        }
        // For the Requirement side, grant nothing that was asked for and instead
        // return an unsolicited document. It must not make the target visible.
        return [{ _id: SECRET_CASE_ID, _class, space: 'space', modifiedBy: 's', modifiedOn: 1 }] as any
      },
      { doc: CASE_ID }
    )
    expect(res[0].source.visible).toBe(true)
    expect(res[0].target.visible).toBe(false)
  })

  it('fails closed when the resolver returns nothing', async () => {
    const { find } = finder([link()])
    const res = await findOutgoingLinks(find, async () => [], { doc: CASE_ID })
    expect(res).toEqual([])
  })

  it('filters the incoming direction the same way', async () => {
    const links = [link(), link({ _id: traceLinkId('verifies', SECRET_CASE_ID, REQ_ID), docA: SECRET_CASE_ID })]
    const { find } = finder(links)
    // Caller sees the requirement and one of the two test cases.
    const res = await findIncomingLinks(find, resolver([REQ_ID, CASE_ID]), { doc: REQ_ID })

    expect(res).toHaveLength(2)
    expect(res.filter((r) => r.source.visible)).toHaveLength(1)
    expect(JSON.stringify(res)).not.toContain(`secret title of ${SECRET_CASE_ID}`)
  })
})

describe('coverage aggregation', () => {
  it('excludes restricted edges from the visible count and the per-kind counts', async () => {
    const links = [link(), link({ _id: traceLinkId('verifies', SECRET_CASE_ID, REQ_ID), docA: SECRET_CASE_ID })]
    const { find } = finder(links)
    const res = await findIncomingLinks(find, resolver([REQ_ID, CASE_ID]), { doc: REQ_ID })
    const cov = summarize(res)

    expect(cov.total).toBe(2)
    expect(cov.visible).toBe(1)
    expect(cov.restricted).toBe(1)
    // The per-kind breakdown must not count the restricted edge either — that
    // would leak the volume of objects the caller cannot see.
    expect(cov.byKind.verifies).toBe(1)
  })
})

describe('buildTraceLink', () => {
  it('produces a deterministic 24 hex char _id that passes isId', () => {
    const built = buildTraceLink({
      source: CASE_ID,
      sourceClass: CASE,
      target: REQ_ID,
      targetClass: REQ,
      kind: 'verifies'
    })
    expect(built._id).toHaveLength(24)
    expect(built._id).toMatch(/^[0-9a-f]{24}$/)
    expect(isId(built._id)).toBe(true)
    expect(built._id).toBe(traceLinkId('verifies', CASE_ID, REQ_ID))
  })

  it('is stable across calls, so a duplicate create collides on the primary key', () => {
    const args = { source: CASE_ID, sourceClass: CASE, target: REQ_ID, targetClass: REQ, kind: 'verifies' } as const
    expect(buildTraceLink({ ...args })._id).toBe(buildTraceLink({ ...args })._id)
  })

  it('keys on the concrete version, not the base id', () => {
    // Two versions of the same requirement must yield two distinct edges;
    // keying on baseId would collapse them and destroy the audit history.
    const v1 = buildTraceLink({
      source: CASE_ID,
      sourceClass: CASE,
      target: REQ_ID,
      targetClass: REQ,
      targetBaseId: 'base' as Ref<Doc>,
      kind: 'verifies'
    })
    const v2 = buildTraceLink({
      source: CASE_ID,
      sourceClass: CASE,
      target: SECRET_CASE_ID,
      targetClass: REQ,
      targetBaseId: 'base' as Ref<Doc>,
      kind: 'verifies'
    })
    expect(v1._id).not.toBe(v2._id)
    expect(v1.targetBaseId).toBe(v2.targetBaseId)
  })

  it('defaults base ids to the concrete ids and state to active', () => {
    const built = buildTraceLink({
      source: CASE_ID,
      sourceClass: CASE,
      target: REQ_ID,
      targetClass: REQ,
      kind: 'implements'
    })
    expect(built.sourceBaseId).toBe(CASE_ID)
    expect(built.targetBaseId).toBe(REQ_ID)
    expect(built.state).toBe('active')
    expect(built._class).toBe(traceability.class.TraceLink)
  })

  it('writes the endpoints under the indexed docA/docB names', () => {
    const built: any = buildTraceLink({
      source: CASE_ID,
      sourceClass: CASE,
      target: REQ_ID,
      targetClass: REQ,
      kind: 'implements'
    })
    expect(built.docA).toBe(CASE_ID)
    expect(built.docB).toBe(REQ_ID)
    expect(built.source).toBeUndefined()
    expect(built.target).toBeUndefined()
  })
})
