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

import type { Doc, Ref } from '@hcengineering/core'

import { traceLinkInheritsOnRevision } from './links'
import type { TraceLinkKind } from './types'

/**
 * The slice of a trace edge coverage arithmetic needs.
 *
 * Structural rather than `TraceLink` so the client can feed it the
 * permission-filtered `TraceLinkView` it already holds, without a second read
 * and without the temptation to reach past the server's per-endpoint filter.
 *
 * @public
 */
export interface CoverageEdge {
  kind: TraceLinkKind
  /** The concrete version the edge points AT. */
  target: Ref<Doc>
  /** `normId(target)`, i.e. the logical object across revisions. */
  targetBaseId?: Ref<Doc>
  /** The concrete source, e.g. the test case that verifies. */
  source: Ref<Doc>
}

/**
 * The verdict a single verifying test case currently carries.
 *
 * Deliberately a string union rather than `TraceRunStatus`: this package must
 * not depend on `test-management`, and the four words are the whole vocabulary
 * coverage needs.
 *
 * @public
 */
export type CoverageVerdict = 'passed' | 'failed' | 'blocked' | 'skipped' | 'untested'

/**
 * @public
 */
export interface RequirementCoverage {
  /** Verifies edges pointing at THIS revision. The completeness numerator. */
  covered: number
  /**
   * Verifies edges pointing at an EARLIER revision of the same logical
   * requirement.
   *
   * 🔴 Reported separately and NEVER folded into `covered`. Technical Spec
   * §3.2.1 fixes the completeness scope at "current version": an edge onto a
   * superseded revision is audit history, not coverage. Merging the two is
   * exactly the bug that would make a revised requirement look verified when
   * nobody has re-confirmed a single case against the new text.
   */
  stale: number
  passed: number
  failed: number
  blocked: number
  skipped: number
  untested: number
  /**
   * `true` when this revision has no coverage of its own but an earlier one did
   * — the state the Requirement page must call out, because it is the ONLY way
   * a reader can tell "never tested" apart from "was tested, then revised".
   */
  supersededCoverage: boolean
}

/**
 * @public
 */
export const emptyRequirementCoverage: RequirementCoverage = {
  covered: 0,
  stale: 0,
  passed: 0,
  failed: 0,
  blocked: 0,
  skipped: 0,
  untested: 0,
  supersededCoverage: false
}

/**
 * Coverage of ONE requirement revision.
 *
 * `verdicts` maps a verifying test case onto its latest verdict; a case with no
 * entry counts as `untested`, which is the honest reading of "linked but never
 * run".
 *
 * @public
 */
export function summariseRequirementCoverage (
  edges: readonly CoverageEdge[],
  revision: Ref<Doc>,
  logicalId: Ref<Doc>,
  verdicts: ReadonlyMap<Ref<Doc>, CoverageVerdict>
): RequirementCoverage {
  const result = { ...emptyRequirementCoverage }
  const counted = new Set<Ref<Doc>>()

  for (const edge of edges) {
    if (edge.kind !== 'verifies') continue

    if (edge.target === revision) {
      // De-duplicated by SOURCE: one test case verifying this revision counts
      // once however many edges history left behind.
      if (counted.has(edge.source)) continue
      counted.add(edge.source)
      result.covered++
      const verdict = verdicts.get(edge.source) ?? 'untested'
      result[verdict]++
      continue
    }

    // A different concrete id. It is stale coverage only if it belongs to the
    // SAME logical requirement; edges towards some other requirement entirely
    // are not this revision's business.
    if ((edge.targetBaseId ?? edge.target) === logicalId) {
      result.stale++
    }
  }

  result.supersededCoverage = result.covered === 0 && result.stale > 0
  return result
}

/**
 * Which edges a NEW revision of a document inherits from its predecessor.
 *
 * 🔴 THE `verifies` ROW IS THE POINT. Technical Spec §3.2.1 makes `verifies`
 * and `delivered-in` non-inheriting so that revising a requirement drops its
 * coverage to zero and forces QA to re-confirm that the case still verifies the
 * new text; the other four kinds survive, because a delivery or a defect does
 * not stop being a fact when the wording changes. This function is the single
 * place that table is executed, so a future inheritance trigger cannot quietly
 * disagree with it.
 *
 * ⚠️ A NEW REVISION ARRIVES AS A `TxCreateDoc` WITH A FRESH `_id`, not as an
 * update — `VersioningMiddleware.setVersionData` stamps `baseId` / `version` on
 * a create. Any caller that tries to recognise a revision by "was this an
 * update?" will never fire; and any guard written as "reject creation from
 * nothing" will reject legitimate first revisions.
 *
 * @public
 */
export function inheritableTraceEdges<T extends CoverageEdge> (edges: readonly T[], previousRevision: Ref<Doc>): T[] {
  return edges.filter((edge) => edge.target === previousRevision && traceLinkInheritsOnRevision[edge.kind])
}

/**
 * The SOURCE-side half of the same table.
 *
 * 🔴 BOTH SIDES ARE NEEDED, and the asymmetry is not cosmetic. §3.2.1's table is
 * written from the requirement's point of view, where the requirement is the
 * TARGET (`implements` / `verifies` / `converted-to` / `defect-of` all point AT
 * it). But `delivered-in` has the requirement as the SOURCE, and Lead — also a
 * versionable card — is the SOURCE of `converted-to`. A revision handler that
 * only re-pointed targets would silently never inherit anything for those, and
 * the omission is invisible: the non-inheriting kinds look correct precisely
 * because nothing was carried.
 *
 * Reads the SAME `traceLinkInheritsOnRevision` record as
 * {@link inheritableTraceEdges}, so the two halves cannot disagree about a kind.
 *
 * @public
 */
export function inheritableTraceEdgesFrom<T extends CoverageEdge> (
  edges: readonly T[],
  previousRevision: Ref<Doc>
): T[] {
  return edges.filter((edge) => edge.source === previousRevision && traceLinkInheritsOnRevision[edge.kind])
}
