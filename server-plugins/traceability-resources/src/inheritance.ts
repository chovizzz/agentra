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

import core, {
  type Class,
  type Data,
  type Doc,
  type Ref,
  type Space,
  type Tx,
  type TxCreateDoc
} from '@hcengineering/core'
import {
  inheritableTraceEdges,
  inheritableTraceEdgesFrom,
  traceLinkId,
  type CoverageEdge,
  type TraceLink
} from '@hcengineering/traceability'

/**
 * A `TxCreateDoc` that is really a NEW REVISION of an existing document.
 *
 * @public
 */
export interface RevisionCreate {
  /** The `_id` of the NEW revision. A revision gets a fresh id, never the old one. */
  objectId: Ref<Doc>
  objectClass: Ref<Class<Doc>>
  objectSpace: Ref<Space>
  /** The stable logical identity shared by every revision in the chain. */
  baseId: Ref<Doc>
  /**
   * The version number `VersioningMiddleware.setVersionData` stamped on this
   * create, when it stamped one. Load bearing for picking the predecessor: see
   * `TraceabilityMiddleware.findPredecessor`.
   */
  version?: number
}

/**
 * Recognise "this create is a revision" the only way that actually works.
 *
 * 🔴 A NEW REVISION ARRIVES AS A `TxCreateDoc` WITH A FRESH `_id`, not as an
 * update — `VersioningMiddleware.setVersionData` stamps `baseId` / `version` /
 * `isLatest` onto the CREATE's attributes. Anything written as "was this an
 * update?" never fires at all.
 *
 * `baseId === objectId` is the FIRST revision, i.e. a genuine create:
 * `setVersionData` sets `tx.attributes.baseId = tx.objectId` on that branch. A
 * missing `baseId` is an unversioned class. Both mean "nothing to inherit from",
 * and returning `undefined` for them is what keeps a first revision from
 * inheriting its own edges.
 *
 * @public
 */
export function readRevisionCreate (tx: Tx): RevisionCreate | undefined {
  if (tx._class !== core.class.TxCreateDoc) return undefined
  const create = tx as TxCreateDoc<Doc>
  const baseId = (create.attributes as { baseId?: Ref<Doc> })?.baseId
  if (baseId === undefined || baseId === create.objectId) return undefined
  const version = (create.attributes as { version?: number })?.version
  return {
    objectId: create.objectId,
    objectClass: create.objectClass,
    objectSpace: create.objectSpace,
    baseId,
    version: typeof version === 'number' ? version : undefined
  }
}

/**
 * One edge to be created on the successor revision.
 *
 * @public
 */
export interface InheritedEdge {
  _id: Ref<TraceLink>
  space: Ref<Space>
  attributes: Data<TraceLink>
  /** The predecessor edge this one was carried from. Audit only. */
  inheritedFrom: Ref<TraceLink>
}

type Candidate = CoverageEdge & { link: TraceLink }

function candidates (edges: readonly TraceLink[]): Candidate[] {
  return (
    edges
      // 🔴 `active` ONLY. `revoked` is a human withdrawing the assertion and
      // `orphaned` means the far end was deleted; carrying either forward would
      // resurrect a claim nobody makes any more, and would do it silently,
      // because a revision produces no activity of its own on the edge domain.
      .filter((link) => link.state === 'active')
      // A degenerate self-link cannot be inherited coherently: re-pointing it
      // would yield TWO edges (old→new and new→old) with different derived ids,
      // neither of which is the fact anyone asserted. `validateTraceLink`
      // already refuses to create one, so this only ever fires on corrupt data.
      .filter((link) => link.docA !== link.docB)
      .map((link) => ({
        kind: link.kind,
        target: link.docB,
        targetBaseId: link.targetBaseId,
        source: link.docA,
        link
      }))
  )
}

/**
 * The `_id`s an inheritance pass WOULD produce, before knowing which already
 * exist. Used to ask the database "which of these are already there?" in one
 * read, which is what makes the pass re-entrant.
 *
 * @public
 */
export function inheritedEdgeIds (
  edges: readonly TraceLink[],
  previous: Ref<Doc>,
  revision: RevisionCreate
): Array<Ref<TraceLink>> {
  return plan(edges, previous, revision).map((edge) => edge._id)
}

/**
 * Every edge the successor revision should carry, EXCLUDING the ones whose
 * derived id is already taken.
 *
 * ## Idempotence
 *
 * The id is `traceLinkId(kind, source, target)` = `sha256('<kind> <a> <b>')`
 * truncated to 24 hex chars — the same derivation every other edge writer in the
 * tree uses. Two passes over the same revision therefore compute the SAME ids,
 * `existing` removes them, and the second pass emits nothing. Even if `existing`
 * were stale, the Postgres `PRIMARY KEY("workspaceId", _id)` on the relation
 * table is the real arbiter and a duplicate collides there.
 *
 * ## Re-entrancy
 *
 * `existing` is computed per-pass, from the database, rather than from "did we
 * run before?" — so a pass that landed only some of its edges is repaired by
 * simply running the pass again, with no bookkeeping to keep in sync.
 *
 * ⚠️ RE-ENTRANT DOES NOT MEAN THE REVISION CREATE ITSELF IS REPLAYABLE. Re-sending
 * the original `TxCreateDoc` does NOT repair a half-written pass: the document
 * insert has no `ON CONFLICT` clause (`PostgresAdapter.insert` calls `upload`
 * with `handleConflicts = false`), so the replay dies on the primary key before
 * inheritance is ever reached. What this function guarantees is that ANY caller
 * that can supply `(edges, previous, revision)` again — a reconciliation job, a
 * migration — converges, which is why the whole planner is exported rather than
 * being private to the middleware.
 *
 * @public
 */
export function planInheritedEdges (
  edges: readonly TraceLink[],
  previous: Ref<Doc>,
  revision: RevisionCreate,
  existing: ReadonlySet<Ref<TraceLink>>
): InheritedEdge[] {
  return plan(edges, previous, revision).filter((edge) => !existing.has(edge._id))
}

function plan (edges: readonly TraceLink[], previous: Ref<Doc>, revision: RevisionCreate): InheritedEdge[] {
  const pool = candidates(edges)
  const out: InheritedEdge[] = []
  const seen = new Set<Ref<TraceLink>>()

  const push = (edge: InheritedEdge): void => {
    // Two different predecessor edges can collapse onto the same derived id
    // (same kind, same far end); the logical key is `(kind, source, target)`, so
    // that is ONE edge and must be ONE create.
    if (seen.has(edge._id)) return
    seen.add(edge._id)
    out.push(edge)
  }

  // The predecessor is the TARGET: `converted-to` / `implements` / `verifies` /
  // `defect-of` all point AT a requirement. Re-point `docB`.
  for (const edge of inheritableTraceEdges(pool, previous)) {
    const link = edge.link
    if (link.docA === revision.objectId) continue
    push({
      _id: traceLinkId(link.kind, link.docA, revision.objectId),
      space: link.space,
      inheritedFrom: link._id,
      attributes: {
        docA: link.docA,
        sourceClass: link.sourceClass,
        docB: revision.objectId,
        targetClass: revision.objectClass,
        kind: link.kind,
        sourceBaseId: link.sourceBaseId,
        // `normId(successor) = successor.baseId`, and every revision in the
        // chain shares it — taken from the tx rather than copied off the old
        // edge so a mis-stamped predecessor cannot propagate.
        targetBaseId: revision.baseId,
        state: 'active',
        metadata: { inheritedFrom: link._id, inheritedOnRevisionOf: previous }
      }
    })
  }

  // The predecessor is the SOURCE: `delivered-in` has the requirement on the
  // left, and a Lead is the source of `converted-to`. Re-point `docA`.
  for (const edge of inheritableTraceEdgesFrom(pool, previous)) {
    const link = edge.link
    if (link.docB === revision.objectId) continue
    push({
      _id: traceLinkId(link.kind, revision.objectId, link.docB),
      space: link.space,
      inheritedFrom: link._id,
      attributes: {
        docA: revision.objectId,
        sourceClass: revision.objectClass,
        docB: link.docB,
        targetClass: link.targetClass,
        kind: link.kind,
        sourceBaseId: revision.baseId,
        targetBaseId: link.targetBaseId,
        state: 'active',
        metadata: { inheritedFrom: link._id, inheritedOnRevisionOf: previous }
      }
    })
  }

  return out
}
