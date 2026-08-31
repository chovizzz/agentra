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

import type { Class, Doc, FindOptions, Lookup, Ref } from '@hcengineering/core'
import type { TraceLink } from '@hcengineering/traceability'

/**
 * The four fields the endpoint filter has to read off a `TraceLink`.
 *
 * 🔴 THIS LIST IS THE REASON THE FILTER IS A QUERY REWRITE AND NOT A PURE
 * RESULT FILTER. Every one of these is an ordinary attribute, so any caller can
 * put `projection: { _id: 1 }` on the request and make all four vanish from the
 * rows the filter is handed. A pure result filter would then have nothing to
 * match on, and "no match" in a filter written the obvious way means "let it
 * through" — i.e. the projection would be a one-line bypass of the whole
 * control. {@link widenProjection} closes that by forcing the fields back into
 * the projection sent downstream, and {@link stripAddedFields} removes them
 * again on the way out so the caller still gets exactly the shape it asked for.
 *
 * @public
 */
export const TRACE_ENDPOINT_FIELDS: string[] = ['docA', 'docB', 'sourceClass', 'targetClass']

/**
 * The fields the same decision needs off a `TxCreateDoc<TraceLink>` in the
 * transaction domain.
 *
 * 🔴 The tx log is a SECOND copy of every edge. `SpaceSecurityMiddleware` keys
 * `DOMAIN_TX` on `objectSpace`, which for a trace edge is `core.space.Workspace`
 * — readable by everyone — so `findAll(core.class.Tx, { objectClass:
 * traceability.class.TraceLink })` hands back `attributes` carrying `docA`,
 * `docB`, `sourceClass` and `targetClass` verbatim. Filtering the edge rows
 * while leaving their creation transactions readable would be no fix at all.
 *
 * @public
 */
export const TRACE_TX_FIELDS: string[] = ['objectClass', 'attributes']

/**
 * @public
 */
export interface WidenedFind<T extends Doc> {
  options: FindOptions<T> | undefined
  /** Fields this call added and {@link stripAddedFields} must remove again. */
  added: string[]
}

/**
 * Force the fields a filter needs back into an explicit projection.
 *
 * 🔴 THIS IS WHY THE FILTER IS A QUERY REWRITE AND NOT A PURE RESULT FILTER.
 * Every field it decides on is an ordinary attribute, so any caller can put
 * `projection: { _id: 1 }` on the request and make them vanish from the rows the
 * filter is handed. A filter that only inspects what it is given would then find
 * nothing to match, and "no match" written the natural way means "let it
 * through" — the projection would be a one-line bypass of the whole control.
 * {@link stripAddedFields} removes the additions again on the way out, so the
 * caller still gets exactly the shape it asked for.
 *
 * A request with NO projection is left completely alone: it already returns
 * whole documents, so there is nothing to add and nothing to strip.
 *
 * ⚠️ INCLUSION AND EXCLUSION PROJECTIONS ARE NOT THE SAME PROBLEM, and treating
 * them alike corrupts the caller's request. `filterProjection` in the Postgres
 * adapter classifies a projection as exclusion only when it has a `0` and no
 * `1`, and treats a MIXED one as inclusion — so blindly adding `field: 1` to
 * `{ title: 0 }` would flip the whole request from "everything but the title" to
 * "nothing but the fields we added". In exclusion mode the needed fields are
 * already coming back, and the only repair required is to lift an explicit
 * exclusion of one of them.
 *
 * `_class` is forced in but NOT stripped unless the caller explicitly excluded
 * it: the adapter emits it as a real column whenever the projection does not
 * name it (`getProjection` adds `_id`/`_class` when absent), so removing it
 * would hand back less than an unfiltered query would.
 *
 * @public
 */
export function widenProjection<T extends Doc> (options: FindOptions<T> | undefined, fields: string[]): WidenedFind<T> {
  const projection = options?.projection
  if (projection === undefined || fields.length === 0) {
    return { options, added: [] }
  }
  const widened: Record<string, 0 | 1> = { ...(projection as Record<string, 0 | 1>) }
  const values = Object.values(widened)
  const exclusionMode = values.some((v) => v === 0) && !values.some((v) => v === 1)
  const added: string[] = []

  for (const field of [...fields, '_class']) {
    if (exclusionMode) {
      // Present by default; only an explicit exclusion has to be lifted.
      if (widened[field] === 0) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete widened[field]
        added.push(field)
      }
    } else {
      if (widened[field] === 1) continue
      // A `0` inside an inclusion projection is already dead weight for the
      // adapter, but the caller meant "not this one", so it is stripped back.
      if (widened[field] === 0 || field !== '_class') added.push(field)
      widened[field] = 1
    }
  }
  if (added.length === 0) return { options, added: [] }
  return { options: { ...options, projection: widened as FindOptions<T>['projection'] }, added }
}

/**
 * Remove the fields {@link widenProjection} added, without touching the ones the
 * caller actually asked for.
 *
 * Copies rather than mutates: the rows come out of the adapter and may be shared
 * with a cache, and deleting a field in place would corrupt the next reader.
 *
 * @public
 */
export function stripAddedFields<T extends Doc> (docs: T[], added: string[]): T[] {
  if (added.length === 0) return docs
  return docs.map((doc) => {
    if (!added.some((field) => (doc as any)[field] !== undefined)) return doc
    const copy: any = { ...doc }
    for (const field of added) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete copy[field]
    }
    return copy as T
  })
}

/**
 * Visibility is keyed by CLASS **and** id, for the same reason `query.ts` keys
 * it that way: an id alone would let a resolution under one class satisfy a
 * lookup under another.
 *
 * @public
 */
export function endpointKey (_class: Ref<Class<Doc>>, _id: Ref<Doc>): string {
  return `${_class} ${_id}`
}

/**
 * The two (class, id) pairs an edge has to be judged on, or `undefined` when the
 * row cannot be judged at all.
 *
 * 🔴 `undefined` means DROP, never "let it through". A row reaching this point
 * without all four fields is either malformed or the residue of a projection
 * {@link widenProjection} failed to widen; in both cases the filter has no way
 * to establish that the caller may see the edge, and the only safe answer to
 * "cannot establish" is no.
 *
 * @public
 */
export function edgeEndpoints (
  edge: Partial<TraceLink> | undefined
): Array<{ _class: Ref<Class<Doc>>, _id: Ref<Doc> }> | undefined {
  if (edge === undefined || edge === null || typeof edge !== 'object') return undefined
  const { docA, docB, sourceClass, targetClass } = edge
  // ⚠️ A non-empty STRING, not merely "not undefined". `null` survives the
  // adapter for a column it could not fill, and an empty or non-string value
  // would be handed to `head.findAll` as a classifier — turning a row that
  // should simply have been dropped into a thrown request. Fail closed, quietly.
  if (![docA, docB, sourceClass, targetClass].every((v) => typeof v === 'string' && v.length > 0)) {
    return undefined
  }
  return [
    { _class: sourceClass as Ref<Class<Doc>>, _id: docA as Ref<Doc> },
    { _class: targetClass as Ref<Class<Doc>>, _id: docB as Ref<Doc> }
  ]
}

/**
 * Every class a `lookup` option could bring back documents of.
 *
 * `$lookup` is a second door into the same rows: a reverse lookup
 * `{ _id: { edges: [traceability.class.TraceLink, 'docA'] } }` hangs whole edge
 * documents off a query whose own `_class` is an ordinary domain class, so the
 * `_class` gate never fires. Walking the SPEC rather than the results keeps that
 * check free — it is a handful of string comparisons on an option object, not a
 * scan of every returned document.
 *
 * @public
 */
export function lookupClasses<T extends Doc> (lookup: Lookup<T> | undefined): Array<Ref<Class<Doc>>> {
  if (lookup === undefined || lookup === null || typeof lookup !== 'object') return []
  const out: Array<Ref<Class<Doc>>> = []
  const push = (value: unknown): void => {
    if (typeof value === 'string') {
      out.push(value as Ref<Class<Doc>>)
    } else if (Array.isArray(value) && typeof value[0] === 'string') {
      out.push(value[0] as Ref<Class<Doc>>)
    }
  }
  for (const [key, value] of Object.entries(lookup as Record<string, unknown>)) {
    if (key === '_id' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Reverse lookups: `{ _id: { key: Class | [Class, field] } }`.
      for (const nested of Object.values(value as Record<string, unknown>)) {
        push(nested)
      }
    } else {
      push(value)
    }
  }
  return out
}

/**
 * Drop unreadable edges from a document's `$lookup` payload.
 *
 * Returns the same object when nothing changed, so the common case allocates
 * nothing; otherwise both the document and its `$lookup` are copied, because
 * neither is ours to mutate.
 *
 * @public
 */
export function filterLookup<T extends Doc> (doc: T, isEdge: (doc: Doc) => boolean, keep: (edge: Doc) => boolean): T {
  const lookup = (doc as any).$lookup
  if (lookup === undefined || lookup === null || typeof lookup !== 'object') return doc
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(lookup as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      const kept = value.filter((item) => !isEdge(item as Doc) || keep(item as Doc))
      if (kept.length !== value.length) changed = true
      next[key] = kept
    } else if (value !== null && typeof value === 'object' && isEdge(value as Doc) && !keep(value as Doc)) {
      changed = true
      next[key] = undefined
    } else {
      next[key] = value
    }
  }
  if (!changed) return doc
  return { ...doc, $lookup: next } as unknown as T
}

/**
 * What `total` may still be claimed after `dropped` rows were removed.
 *
 * 🔴 The pre-filter `total` MUST NOT survive: when `options.total` is set the
 * adapter counts every row the query matched, restricted ones included, and
 * handing that number back would republish exactly the figure the filter exists
 * to withhold — the number of edges whose endpoints the caller may not see.
 *
 * When the adapter merely echoed the page length (`total === length`, which is
 * what `toFindResult` produces for an uncounted query) the filtered length is
 * still the honest answer. When it is a real server-side count there is no
 * honest answer available here, so this returns `-1`, the value this codebase
 * already uses for "unknown" (`Table.svelte`, `RelationshipTable.svelte` and
 * `OptimizeSkills.svelte` all branch on `total === -1`).
 *
 * @public
 */
export function adjustTotal (total: number, length: number, kept: number): number {
  if (kept === length) return total
  return total === length ? kept : -1
}
