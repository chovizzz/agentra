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

import type { Class, Doc, Ref } from '@hcengineering/core'
import traceability, { traceLinkKinds, type TraceLink, type TraceLinkKind } from '@hcengineering/traceability'

import type { TraceEndpointView, TraceLinkView } from '../types'
import {
  countRestricted,
  farEndpoint,
  findIncomingTraceLinks,
  findOutgoingTraceLinks,
  groupTraceLinks,
  isEndpointRenderable,
  isRestrictedLink,
  nearEndpoint,
  parseTraceLinksResult,
  TRACE_OP_FIND_INCOMING,
  TRACE_OP_FIND_OUTGOING,
  TRACEABILITY_DOMAIN,
  traceLinkKindLabel
} from '../utils'

const REQ = 'requirements:class:Requirement' as Ref<Class<Doc>>
const CASE = 'testmgmt:class:TestCase' as Ref<Class<Doc>>

function doc (_id: string, _class: Ref<Class<Doc>>, baseId?: string): Doc {
  return { _id: _id as Ref<Doc>, _class, space: 'space' as any, modifiedBy: 'x' as any, modifiedOn: 0, baseId } as any
}

function visible (_id: string, _class: Ref<Class<Doc>>, baseId?: string): TraceEndpointView {
  return { _id: _id as Ref<Doc>, visible: true, _class, doc: doc(_id, _class, baseId) }
}

function hidden (_id: string): TraceEndpointView {
  return { _id: _id as Ref<Doc>, visible: false }
}

function link (id: string, kind: TraceLinkKind, source: TraceEndpointView, target: TraceEndpointView): TraceLinkView {
  return { _id: id as Ref<TraceLink>, kind, state: 'active', source, target }
}

describe('endpoint visibility', () => {
  it('renders only endpoints the server marked visible AND populated', () => {
    expect(isEndpointRenderable(visible('a', REQ))).toBe(true)
    expect(isEndpointRenderable(hidden('a'))).toBe(false)
    expect(isEndpointRenderable(undefined)).toBe(false)
  })

  it('fails closed on a malformed reply that claims visible with no payload', () => {
    expect(isEndpointRenderable({ _id: 'a' as Ref<Doc>, visible: true })).toBe(false)
    expect(isEndpointRenderable({ _id: 'a' as Ref<Doc>, visible: true, _class: REQ })).toBe(false)
    expect(isEndpointRenderable({ _id: 'a' as Ref<Doc>, visible: true, doc: doc('a', REQ) })).toBe(false)
  })

  it('a restricted endpoint carries nothing but its id', () => {
    const endpoint = hidden('secret')
    expect(Object.keys(endpoint).sort()).toEqual(['_id', 'visible'])
    expect(endpoint._class).toBeUndefined()
    expect(endpoint.doc).toBeUndefined()
  })

  it('marks an edge restricted when either end is unreadable', () => {
    expect(isRestrictedLink(link('1', 'verifies', visible('a', CASE), visible('b', REQ)))).toBe(false)
    expect(isRestrictedLink(link('2', 'verifies', visible('a', CASE), hidden('b')))).toBe(true)
    expect(isRestrictedLink(link('3', 'verifies', hidden('a'), visible('b', REQ)))).toBe(true)
  })
})

describe('direction', () => {
  const l = link('1', 'verifies', visible('case', CASE), visible('req', REQ))

  it('picks the far end relative to the page being rendered', () => {
    expect(farEndpoint(l, 'outgoing')._id).toBe('req')
    expect(farEndpoint(l, 'incoming')._id).toBe('case')
    expect(nearEndpoint(l, 'outgoing')._id).toBe('case')
    expect(nearEndpoint(l, 'incoming')._id).toBe('req')
  })
})

describe('kind labels', () => {
  it('maps every kind to a distinct string', () => {
    const labels = traceLinkKinds.map(traceLinkKindLabel)
    expect(new Set(labels).size).toBe(traceLinkKinds.length)
    expect(labels).not.toContain(traceability.string.TraceLink)
  })

  it('covers exactly the six kinds and no blocks', () => {
    expect([...traceLinkKinds].sort()).toEqual(
      ['converted-to', 'defect-of', 'delivered-in', 'fixed-by', 'implements', 'verifies'].sort()
    )
  })
})

describe('cross-version grouping', () => {
  it('collapses edges against several versions of one logical object', () => {
    const links = [
      link('e1', 'implements', visible('wi', CASE), visible('req-v2', REQ, 'req-base')),
      link('e2', 'implements', visible('wi', CASE), visible('req-v1', REQ, 'req-base'))
    ]
    const groups = groupTraceLinks(links, 'outgoing')
    expect(groups).toHaveLength(1)
    expect(groups[0].links).toHaveLength(2)
    // The version actually on the newest edge stays addressable.
    expect(groups[0].endpoint._id).toBe('req-v2')
  })

  it('keeps different kinds towards the same object apart', () => {
    const links = [
      link('e1', 'implements', visible('wi', CASE), visible('req', REQ, 'base')),
      link('e2', 'verifies', visible('wi', CASE), visible('req', REQ, 'base'))
    ]
    expect(groupTraceLinks(links, 'outgoing')).toHaveLength(2)
  })

  it('falls back to the concrete id for unversioned endpoints', () => {
    const links = [
      link('e1', 'fixed-by', visible('bug', CASE), visible('pr-1', REQ)),
      link('e2', 'fixed-by', visible('bug', CASE), visible('pr-2', REQ))
    ]
    expect(groupTraceLinks(links, 'outgoing')).toHaveLength(2)
  })

  it('never emits a row for a restricted edge', () => {
    const links = [
      link('e1', 'defect-of', visible('bug', CASE), hidden('secret-a')),
      link('e2', 'defect-of', visible('bug', CASE), hidden('secret-b')),
      link('e3', 'defect-of', visible('bug', CASE), visible('req', REQ))
    ]
    const groups = groupTraceLinks(links, 'outgoing')
    expect(groups).toHaveLength(1)
    expect(groups[0].endpoint._id).toBe('req')
    expect(countRestricted(links)).toBe(2)
    // Nothing about the hidden endpoints survives into the rendered rows.
    expect(JSON.stringify(groups)).not.toContain('secret')
  })

  it('groups by the incoming far end when asked from the target side', () => {
    const links = [
      link('e1', 'verifies', visible('case-v2', CASE, 'case-base'), visible('req', REQ)),
      link('e2', 'verifies', visible('case-v1', CASE, 'case-base'), visible('req', REQ))
    ]
    expect(groupTraceLinks(links, 'incoming')).toHaveLength(1)
  })
})

describe('transport', () => {
  it('reports an unrouted domain request as unavailable, not as empty', () => {
    expect(parseTraceLinksResult(null)).toEqual({
      available: false,
      links: [],
      coverage: { total: 0, visible: 0, restricted: 0, byKind: {} }
    })
    expect(parseTraceLinksResult(undefined).available).toBe(false)
    expect(parseTraceLinksResult({}).available).toBe(false)
  })

  it('fails closed on links without a coverage block rather than claiming zero', () => {
    const links = [link('e1', 'verifies', visible('a', CASE), visible('b', REQ))]
    const parsed = parseTraceLinksResult({ links })
    expect(parsed.available).toBe(false)
    expect(parsed.links).toEqual([])
  })

  it('distinguishes a real zero-link answer', () => {
    const parsed = parseTraceLinksResult({
      links: [],
      coverage: { total: 0, visible: 0, restricted: 0, byKind: {} }
    })
    expect(parsed.available).toBe(true)
  })

  it('renders the server coverage verbatim rather than recounting', () => {
    const links = [link('e1', 'verifies', visible('a', CASE), hidden('b'))]
    // The server withheld one endpoint, so its `visible` count is 0 even though
    // one link came back. The client must not "fix" that to 1.
    const parsed = parseTraceLinksResult({ links, coverage: { total: 1, visible: 0, restricted: 1, byKind: {} } })
    expect(parsed.coverage).toEqual({ total: 1, visible: 0, restricted: 1, byKind: {} })
  })

  it('calls the traceability domain with the documented op shape', async () => {
    const calls: Array<[string, any]> = []
    const client = {
      domainRequest: async (domain: any, params: any) => {
        calls.push([domain, params])
        return { domain, value: { links: [], coverage: { total: 0, visible: 0, restricted: 0, byKind: {} } } }
      }
    } as any

    await findOutgoingTraceLinks(client, { doc: 'x' as Ref<Doc> })
    await findIncomingTraceLinks(client, { doc: 'x' as Ref<Doc>, normalize: true })

    expect(calls[0][0]).toBe(TRACEABILITY_DOMAIN)
    // The inner key is `params`, matching `communication.ts#handleCommand`.
    expect(calls[0][1]).toEqual({ [TRACE_OP_FIND_OUTGOING]: { params: { doc: 'x' } } })
    expect(calls[1][1]).toEqual({ [TRACE_OP_FIND_INCOMING]: { params: { doc: 'x', normalize: true } } })
  })
})
