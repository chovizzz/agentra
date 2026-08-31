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

import type { Class, Doc, OperationDomain, Ref } from '@hcengineering/core'
import type { Plugin, Resource } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'
import type { ObjectDDParticipantFunc, TriggerFunc } from '@hcengineering/server-core'
import type { TraceLink, TraceLinkKind, TraceLinkState } from '@hcengineering/traceability'

/**
 * @public
 */
export const serverTraceabilityId = 'server-traceability' as Plugin

/**
 * What a caller is allowed to learn about ONE endpoint of a trace edge.
 *
 * 🔴 When `visible` is false the caller gets nothing beyond "a link exists".
 * No title, no identifier, no assignee, no status, no class label. That
 * degradation is the whole point: the edge itself lives in
 * `core.space.Workspace` and is readable by any member, so the protection has to
 * be applied to the ENDPOINTS, on the server, at read time.
 *
 * @public
 */
export interface TraceEndpointView {
  _id: Ref<Doc>
  visible: boolean
  /** Only populated when `visible`. */
  _class?: Ref<Class<Doc>>
  /** Only populated when `visible`. Never carries endpoint content otherwise. */
  doc?: Doc
}

/**
 * A trace edge as returned to a caller, after per-endpoint filtering.
 *
 * @public
 */
export interface TraceLinkView {
  _id: Ref<TraceLink>
  kind: TraceLinkKind
  state: TraceLinkState
  source: TraceEndpointView
  target: TraceEndpointView
}

/**
 * @public
 */
export interface TraceLinkQuery {
  /** The concrete document the caller is looking from. */
  doc: Ref<Doc>
  /** Optional normalisation to the logical object (`baseId ?? _id`). */
  baseId?: Ref<Doc>
  kinds?: TraceLinkKind[]
  /** Defaults to `['active']`. Pass explicitly to include audit history. */
  states?: TraceLinkState[]
  /** Normalise across versions by matching on the base id instead of the concrete id. */
  normalize?: boolean
}

/**
 * The security-filtered read used to resolve endpoints.
 *
 * 🔴 This MUST be a find that carries the CALLING account's session, not the
 * system account. `TriggerControl.findAll` runs as system and would resolve
 * every endpoint regardless of permission, silently turning the filter into a
 * no-op. The implementation therefore takes the accessor as a parameter instead
 * of reaching for a global one.
 *
 * @public
 */
export type TraceEndpointResolver = (_class: Ref<Class<Doc>>, ids: Array<Ref<Doc>>) => Promise<Doc[]>

/**
 * @public
 */
export interface TraceCoverage {
  total: number
  /** Edges whose endpoints the caller may see. Aggregate counts EXCLUDE the rest. */
  visible: number
  /** Edges present but with at least one endpoint the caller cannot read. */
  restricted: number
  byKind: Partial<Record<TraceLinkKind, number>>
}

/**
 * Server side descriptor. It declares ids only; implementations live in
 * `@hcengineering/server-traceability-resources` and are reached through
 * `addLocation(serverTraceabilityId, ...)` in `registerServerPlugins()`.
 *
 * @public
 */
export default plugin(serverTraceabilityId, {
  trigger: {
    /** Flips `state` to `orphaned` when either endpoint is removed. Never deletes the edge. */
    OnTraceEndpointRemoved: '' as Resource<TriggerFunc>
  },
  function: {
    TraceLinkRemove: '' as Resource<ObjectDDParticipantFunc>
  }
})

/**
 * The operation domain the traceability read handler answers on.
 *
 * 🔴 THIS BLOCK REPLACES the former `FindOutgoingLinks` / `FindIncomingLinks`
 * `Resource<unknown>` placeholders on the descriptor above. They were deleted
 * rather than implemented, because a `Resource` id can never be the transport
 * here: `getResource()` resolves ids INSIDE one process, and
 * `addLocation(serverTraceabilityId, ...)` only ever runs in the transactor, so
 * a browser has no way to invoke one. Leaving them declared invited exactly the
 * wrong implementation.
 *
 * The real call mechanism is `Client.domainRequest(domain, params)` — the
 * platform's only generic client→server call, already load bearing for the
 * communication stack. The constants below are the SERVER half of that
 * contract; the client half is `TRACEABILITY_DOMAIN` /
 * `TRACE_OP_FIND_OUTGOING` / `TRACE_OP_FIND_INCOMING` in
 * `@hcengineering/traceability-resources`, and the two halves must be changed
 * together.
 *
 * Wire shape, mirroring `CommunicationMiddleware.handleCommand`:
 *
 * ```
 * request:  { [op]: { params: TraceLinkQuery } }
 * response: TraceLinksResult
 * ```
 *
 * ⚠️ The inner key is `params`, NOT `query`.
 *
 * @public
 */
export const TRACEABILITY_DOMAIN = 'traceability' as OperationDomain

/**
 * @public
 */
export const TRACE_OP_FIND_OUTGOING = 'findOutgoingLinks'

/**
 * @public
 */
export const TRACE_OP_FIND_INCOMING = 'findIncomingLinks'

/**
 * The reply body of both operations.
 *
 * 🔴 `coverage` is always stated by the SERVER and rendered as received. A reply
 * carrying `links` but no `coverage` is malformed and the client treats the
 * whole handler as unavailable rather than recomputing the numbers.
 *
 * @public
 */
export interface TraceLinksResult {
  links: TraceLinkView[]
  coverage: TraceCoverage
}
