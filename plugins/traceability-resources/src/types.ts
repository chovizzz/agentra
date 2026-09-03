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
import type { TraceLink, TraceLinkKind, TraceLinkState } from '@hcengineering/traceability'

//
// 🔴 These are the WIRE types of the traceability domain request. They are a
// deliberate structural copy of `TraceEndpointView` / `TraceLinkView` /
// `TraceLinkQuery` / `TraceCoverage` in `@hcengineering/server-traceability`.
//
// They are copied rather than imported because a browser bundle must never
// depend on a `server-*` package — `@hcengineering/server-traceability` pulls
// `@hcengineering/server-core`, which drags the transactor into the client
// bundle. The long-term fix is to hoist these four types down into the leaf
// descriptor package `@hcengineering/traceability`, which both sides already
// depend on; that package is outside this delivery's file boundary, so the copy
// is what ships and the hoist is left as a wiring note.
//

/**
 * What a caller is allowed to learn about ONE endpoint of a trace edge.
 *
 * 🔴 When `visible` is false, EVERYTHING except `_id` is absent — no `_class`,
 * no `doc`. The UI must never render anything for such an endpoint beyond the
 * "a restricted link exists" placeholder. The server produces exactly this
 * shape (`query.ts#view`); the client never widens it.
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
  /** Defaults to `['active']` on the server. Pass explicitly to include audit history. */
  states?: TraceLinkState[]
  /** Normalise across versions by matching on the base id instead of the concrete id. */
  normalize?: boolean
}

/**
 * Coverage counts, computed by the server's `summarize()`.
 *
 * 🔴 The client MUST render these numbers as received and must never recompute
 * them from the link array. `visible` deliberately excludes edges with an
 * unreadable endpoint; a client-side recount would be trivially "corrected"
 * into leaking the volume of objects the caller may not see.
 *
 * @public
 */
export interface TraceCoverage {
  total: number
  visible: number
  restricted: number
  byKind: Partial<Record<TraceLinkKind, number>>
}

/**
 * The reply of one traceability domain request.
 *
 * @public
 */
export interface TraceLinksResult {
  links: TraceLinkView[]
  coverage: TraceCoverage
}

/**
 * What the UI renders. `available: false` means the traceability domain handler
 * is not installed in this deployment's pipeline — NOT "there are no links".
 * The two must stay distinguishable or the section silently claims zero
 * coverage on a server that simply cannot answer.
 *
 * @public
 */
export interface TraceLinksState {
  available: boolean
  links: TraceLinkView[]
  coverage: TraceCoverage
}

/**
 * Which end of the edge the caller is looking from.
 *
 * @public
 */
export type TraceDirection = 'outgoing' | 'incoming'
