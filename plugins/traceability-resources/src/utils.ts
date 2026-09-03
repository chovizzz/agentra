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

import type { Client, Doc, DomainParams, DomainResult, OperationDomain, Ref } from '@hcengineering/core'
import type { IntlString } from '@hcengineering/platform'
import traceability, { normId, type MaybeVersioned, type TraceLinkKind } from '@hcengineering/traceability'

import type {
  TraceCoverage,
  TraceDirection,
  TraceEndpointView,
  TraceLinkQuery,
  TraceLinksResult,
  TraceLinkView,
  TraceLinksState
} from './types'

/**
 * The operation domain the traceability read handler answers on.
 *
 * 🔴 THIS IS THE CALL MECHANISM, and it is a domain request rather than a
 * "server function resource".
 *
 * `Resource<T>` ids are resolved by `getResource()` **inside one process**.
 * There is no platform RPC that lets a browser invoke a `Resource` that lives in
 * a `server-*` bundle — `addLocation(serverTraceabilityId, ...)` is called by
 * `registerServerPlugins()` in the transactor, never in the client. So the
 * `FindOutgoingLinks` / `FindIncomingLinks` placeholders in
 * `@hcengineering/server-traceability` cannot themselves be the transport.
 *
 * `Client.domainRequest(domain, params)` is the platform's only generic
 * client→server call, and it is already load bearing in this repo: the
 * communication stack routes `'communication' as OperationDomain` through
 * `CommunicationMiddleware.domainRequest` in `server/server-pipeline`, which
 * dispatches on a `{ <opName>: { params } }` params object
 * (`communication.ts#handleCommand`). This module mirrors that shape exactly.
 *
 * The middleware half is deliberately NOT in this delivery (it lives under
 * `server-plugins/` + the pipeline registration, both outside this file
 * boundary) — see the wiring notes. Until it lands, `domainRequest` falls
 * through `BaseMiddleware.provideDomainRequest` to `{ domain, value: null }`,
 * which this module reports as `available: false` rather than as "no links".
 *
 * @public
 */
export const TRACEABILITY_DOMAIN = 'traceability' as OperationDomain

/**
 * Operation names on {@link TRACEABILITY_DOMAIN}.
 *
 * @public
 */
export const TRACE_OP_FIND_OUTGOING = 'findOutgoingLinks'

/**
 * @public
 */
export const TRACE_OP_FIND_INCOMING = 'findIncomingLinks'

const EMPTY_COVERAGE: TraceCoverage = { total: 0, visible: 0, restricted: 0, byKind: {} }

/**
 * The unavailable / empty state.
 *
 * 🔴 Note there is no client-side fallback path here, and there must never be
 * one. The obvious "fallback" — `findAll(traceability.class.TraceLink, ...)`
 * plus a client-side endpoint resolve — would bypass the server's near-endpoint
 * check, and `options.associations` would bypass the per-endpoint filter
 * altogether (`spaceSecurity.ts` filters `$lookup`, not associations). A
 * missing handler renders as "unavailable", never as degraded data.
 *
 * @public
 */
export function emptyTraceLinksState (available: boolean): TraceLinksState {
  return { available, links: [], coverage: EMPTY_COVERAGE }
}

/**
 * Narrows an untrusted `DomainResult.value` into a {@link TraceLinksState}.
 *
 * Kept pure and exported so the "handler absent" vs "handler answered with zero
 * links" distinction is directly testable without a transactor.
 *
 * @public
 */
export function parseTraceLinksResult (value: unknown): TraceLinksState {
  if (value == null || typeof value !== 'object') {
    // `{ domain, value: null }` is what an unrouted domain request returns;
    // a pipeline with no head returns `value: undefined`. Both mean "no handler".
    return emptyTraceLinksState(false)
  }
  const result = value as Partial<TraceLinksResult>
  if (!Array.isArray(result.links)) {
    return emptyTraceLinksState(false)
  }
  // 🔴 Fail closed on a missing coverage block rather than substituting zeroes.
  // A reply carrying links but no coverage would otherwise render as
  // "0 links, 0 restricted" — a confident, wrong claim about coverage that the
  // server never made. Only the server may state these numbers.
  if (result.coverage == null || typeof result.coverage.visible !== 'number') {
    return emptyTraceLinksState(false)
  }
  return {
    available: true,
    links: result.links,
    // 🔴 Rendered as received. Never recomputed from `links` — see TraceCoverage.
    coverage: result.coverage
  }
}

async function request (client: Client, op: string, query: TraceLinkQuery): Promise<TraceLinksState> {
  // 🔴 The inner key is `params`, matching the one existing domain-request
  // convention in this repo: the communication client sends
  // `{ findMessagesMeta: { params } }` (`packages/presentation/src/communication.ts`)
  // and the middleware unpacks `args.findMessagesMeta.params`
  // (`server/server-pipeline/src/communication.ts#handleCommand`). Naming it
  // anything else would make a handler written by copying that one silently
  // read `undefined`.
  const params: DomainParams = { [op]: { params: query } }
  const result: DomainResult<unknown> = await client.domainRequest(TRACEABILITY_DOMAIN, params)
  return parseTraceLinksResult(result?.value)
}

/**
 * Edges where `query.doc` is the SOURCE, per-endpoint filtered on the server.
 *
 * @public
 */
export async function findOutgoingTraceLinks (client: Client, query: TraceLinkQuery): Promise<TraceLinksState> {
  return await request(client, TRACE_OP_FIND_OUTGOING, query)
}

/**
 * Edges where `query.doc` is the TARGET, per-endpoint filtered on the server.
 *
 * @public
 */
export async function findIncomingTraceLinks (client: Client, query: TraceLinkQuery): Promise<TraceLinksState> {
  return await request(client, TRACE_OP_FIND_INCOMING, query)
}

/**
 * The endpoint at the FAR side of the edge, relative to the object whose page
 * is being rendered.
 *
 * @public
 */
export function farEndpoint (link: TraceLinkView, direction: TraceDirection): TraceEndpointView {
  return direction === 'outgoing' ? link.target : link.source
}

/**
 * @public
 */
export function nearEndpoint (link: TraceLinkView, direction: TraceDirection): TraceEndpointView {
  return direction === 'outgoing' ? link.source : link.target
}

/**
 * Whether an endpoint may be rendered with its real content.
 *
 * 🔴 Fail closed on shape as well as on the flag: an endpoint is only rendered
 * when the server said `visible` AND actually shipped a `doc` and a `_class`.
 * A `visible: true` with no payload is a malformed reply, and rendering
 * "something" from it is exactly the accident this guard prevents.
 *
 * @public
 */
export function isEndpointRenderable (
  endpoint: TraceEndpointView | undefined
): endpoint is TraceEndpointView & { _class: Ref<any>, doc: Doc } {
  return endpoint !== undefined && endpoint.visible && endpoint.doc !== undefined && endpoint._class !== undefined
}

/**
 * An edge is restricted when EITHER endpoint is unreadable. The near endpoint
 * is already server-checked (an unreadable near endpoint means the edge is not
 * returned at all), so in practice this reports the far side — but it is
 * written over both so a future server change cannot silently open a hole.
 *
 * @public
 */
export function isRestrictedLink (link: TraceLinkView): boolean {
  return !isEndpointRenderable(link.source) || !isEndpointRenderable(link.target)
}

/**
 * The label of a trace kind. Every kind is mapped explicitly so a new kind is a
 * compile error rather than a blank chip.
 *
 * @public
 */
export function traceLinkKindLabel (kind: TraceLinkKind): IntlString {
  const labels: Record<TraceLinkKind, IntlString> = {
    'converted-to': traceability.string.KindConvertedTo,
    implements: traceability.string.KindImplements,
    verifies: traceability.string.KindVerifies,
    'defect-of': traceability.string.KindDefectOf,
    'fixed-by': traceability.string.KindFixedBy,
    'delivered-in': traceability.string.KindDeliveredIn
  }
  return labels[kind] ?? traceability.string.TraceLink
}

/**
 * One logical relationship, possibly asserted against several concrete versions
 * of the same far object.
 *
 * @public
 */
export interface TraceLinkGroup {
  /** `kind ‖ logical far id`. Stable, and safe as a keyed-each key. */
  key: string
  kind: TraceLinkKind
  /** The far endpoint of the most recent edge in the group. */
  endpoint: TraceEndpointView
  /**
   * Every edge in the group, newest first as returned. `length > 1` means the
   * same logical relationship was asserted against more than one version — that
   * IS meaningful audit history and is surfaced, not erased.
   */
  links: TraceLinkView[]
}

/**
 * The logical identity of a far endpoint: `normId(doc) = doc.baseId ?? doc._id`.
 *
 * 🔴 Only readable endpoints can be normalised, because `baseId` lives on the
 * endpoint document and the server ships no document for a restricted endpoint.
 * That is intentional: normalising restricted endpoints would require the
 * server to hand out their base ids, which would let a caller learn that two
 * edges they may not read point at the same hidden object. Restricted edges are
 * therefore never grouped — see {@link groupTraceLinks}.
 */
function logicalFarId (endpoint: TraceEndpointView): Ref<Doc> {
  return isEndpointRenderable(endpoint) ? normId(endpoint.doc as MaybeVersioned) : endpoint._id
}

/**
 * Collapses the per-version edges of one logical relationship into a single row.
 *
 * A trace edge is an audit fact about a CONCRETE version, so a requirement that
 * has been revised legitimately produces several `implements` edges towards the
 * same logical object. Coverage-style rendering must count that once; the
 * per-version detail stays available on the group.
 *
 * Restricted edges are excluded entirely — they are reported only as an opaque
 * count, never as rows.
 *
 * @public
 */
export function groupTraceLinks (links: TraceLinkView[], direction: TraceDirection): TraceLinkGroup[] {
  const groups: TraceLinkGroup[] = []
  const byKey = new Map<string, TraceLinkGroup>()
  for (const link of links) {
    if (isRestrictedLink(link)) {
      continue
    }
    const endpoint = farEndpoint(link, direction)
    const key = `${link.kind} ${logicalFarId(endpoint)}`
    const existing = byKey.get(key)
    if (existing !== undefined) {
      existing.links.push(link)
      continue
    }
    const group: TraceLinkGroup = { key, kind: link.kind, endpoint, links: [link] }
    byKey.set(key, group)
    groups.push(group)
  }
  return groups
}

/**
 * How many returned edges are restricted.
 *
 * 🔴 This is NOT a coverage number and must not be presented as one — the
 * rendered figure is always the server's `TraceCoverage.restricted`, and
 * `TraceLinksSection` uses nothing else. This helper exists for callers that
 * hold a link array with no coverage block (tests, and any future consumer that
 * slices the array), and it must never be substituted for the server figure in
 * a coverage display.
 *
 * @public
 */
export function countRestricted (links: TraceLinkView[]): number {
  return links.filter(isRestrictedLink).length
}
