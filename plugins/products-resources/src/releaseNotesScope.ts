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

import type { Class, Doc, DocumentQuery, FindOptions, FindResult, Ref } from '@hcengineering/core'
import type { ProductVersion } from '@hcengineering/products'

import type { ReleaseNotesCandidate, ReleaseNotesInput } from './releaseNotes'

/**
 * The read surface the scope query needs.
 *
 * Structural rather than `Client`, so a test can hand in a five-line fake, and
 * so it is obvious that nothing here writes. Mirrors `ReleaseGateReader` on the
 * server for the same reasons.
 *
 * @public
 */
export interface ReleaseNotesReader {
  findAll: <T extends Doc>(
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ) => Promise<FindResult<T>>
}

/**
 * Class references, spelled as the literals the plugin descriptors resolve to.
 *
 * 🔴 LITERALS RATHER THAN IMPORTS, AND THAT IS THE CONSTRAINT TALKING. Pulling
 * `@hcengineering/requirements`, `@hcengineering/tracker` and
 * `@hcengineering/traceability` into this package would add three cross-package
 * dependencies to a browser bundle that has none of them today. `plugin()` ids
 * are `'<pluginId>:<kind>:<name>'` by construction — the same spelling the
 * server command uses for `products:string:ProductVersionStateReleased` — so the
 * literal IS the ref.
 *
 * ⚠️ THE RISK THIS CARRIES, STATED: renaming a descriptor key on the other side
 * would not fail to compile here, it would make the query match nothing and the
 * release notes come out empty. That is why {@link collectReleaseNotesScope}
 * reports `restricted` from a comparison rather than assuming a short result is
 * the whole truth, and why these three constants are pinned by an assertion in
 * `__tests__/releaseNotesScope.test.ts`.
 *
 * @public
 */
export const REQUIREMENT_CLASS = 'requirements:masterTag:Requirement' as Ref<Class<Doc>>

/** @public */
export const TRACE_LINK_CLASS = 'traceability:class:TraceLink' as Ref<Class<Doc>>

/** @public */
export const ISSUE_CLASS = 'tracker:class:Issue' as Ref<Class<Doc>>

/** The trace kind that attaches an issue to the version it shipped in. */
const DELIVERED_IN = 'delivered-in'

/** The trace kind that marks an issue as a defect of something. */
const DEFECT_OF = 'defect-of'

interface TraceLinkRow extends Doc {
  docA: Ref<Doc>
  docB: Ref<Doc>
  kind: string
  state: string
}

interface TitledRow extends Doc {
  title?: string
  name?: string
  identifier?: string
}

/**
 * @public
 */
export interface ReleaseNotesScopeOptions {
  /**
   * The SECOND defect signal, when the caller can resolve it.
   *
   * Task 18b classifies as a bug fix anything with a `defect-of` edge **or**
   * whose task type is Bug. This module resolves the edge itself; the task type
   * lives in `task`'s `TaskType` documents. A caller that can resolve it passes
   * this predicate and the rule is complete.
   *
   * 🔴 AND THE SIGNAL STAYS INJECTED BECAUSE THERE IS NOTHING TO PIN — this is
   * NOT the same situation as {@link REQUIREMENT_CLASS}, where a cross-package
   * dependency was avoided by spelling a stable descriptor id as a literal.
   * `TaskType` HAS no stable "Bug" id to spell:
   *
   * - `models/tracker/src/index.ts` seeds exactly ONE `task.class.TaskType` for
   *   issues — `tracker.taskTypes.Issue`, `name: 'Issue'` — under exactly one
   *   `TaskTypeDescriptor`, `tracker.descriptors.Issue`. Nothing in the model
   *   declares a Bug type;
   * - a workspace's "Bug" task type is therefore created at RUNTIME by an
   *   admin. Its `_id` comes from `generateId()`, so it differs per workspace,
   *   and its `name` is a free-form, user-editable, untranslated string;
   * - `TaskType` carries no marker that would separate the two: no category, no
   *   flag, and one shared descriptor.
   *
   * So `import tracker from '@hcengineering/tracker'` would NOT complete the
   * rule — it exports no Bug ref to import. The only implementable in-package
   * version would be `taskType.name === 'Bug'`, which breaks on a rename, on a
   * non-English workspace, and on the perfectly ordinary "Defect" spelling.
   * Guessing wrong silently is worse than not guessing, so the resolution is
   * left to a caller that actually knows its workspace's configuration.
   *
   * ⚠️ ABSENT MEANS "edge only", not "not a defect". The consequence is a bug
   * with no `defect-of` edge landing under 改进 rather than 缺陷修复 — a
   * misfiled line in an EDITABLE document a human can correct in place. That is
   * the trade this deliberately takes: a recoverable misfile over a heuristic
   * that is confidently wrong.
   */
  isDefect?: (issue: Doc) => boolean
  /**
   * A restriction the CALLER already knows about, OR-ed into the result.
   *
   * 🔴 THIS EXISTS BECAUSE CLIENT-SIDE DETECTION IS INCOMPLETE, and saying so is
   * better than implying otherwise. {@link collectReleaseNotesScope} runs
   * entirely through the caller's own reader, so it can only notice the ONE
   * restriction that leaves a trace: a `delivered-in` edge whose issue does not
   * come back. Two others leave no trace at all and are invisible from here:
   *
   * - a REQUIREMENT in a space the caller cannot read simply is not in the
   *   `targetVersion` result, and there is no global count to compare against;
   * - a `delivered-in` EDGE in an unreadable space is not in the edge result
   *   either, so even the comparison above never sees it.
   *
   * The server side has both views (`evaluateReleaseGate` decides over a
   * privileged `auditor` and echoes through the caller's `viewer`), so a caller
   * holding a gate report can pass `ReleaseGateReport.restricted` here and the
   * notes inherit the accurate answer.
   *
   * ⚠️ A BOOLEAN, like everything else about restriction — never a count.
   */
  restrictedHint?: boolean
}

/**
 * Collect the version's delivered scope.
 *
 * 🔴 TWO CHANNELS, BECAUSE THE DATA MODEL HAS TWO — and this is the one place
 * Task 18b's text ("条目只来自 `delivered-in` 边") does not match the shipped
 * schema. `requirements/src/types.ts` records that the `delivered-in` EDGE was
 * DROPPED for requirements in favour of the `targetVersion` ATTRIBUTE, so that
 * `ViewOptionsModel.groupBy` could group by it; `evaluateReleaseGate` reads the
 * attribute for exactly the same reason. Reading only the edges would make the
 * 需求 section permanently empty while the gate was blocking on those very
 * requirements — the "两套口径必然对不上" the task warns about, arriving from
 * the opposite direction.
 *
 * So the rule that is actually honoured is the INTENT of "来源唯一": the scope
 * is whatever the RELEASE GATE considers scope, read the same way the gate
 * reads it. Nothing here runs a second, independent scope query.
 *
 * 🔴 `restricted` IS MEASURED, NOT ASSUMED. Every `delivered-in` edge names an
 * issue; the issues that do not come back from the caller's own query are ones
 * the caller may not read. That difference is reported as a BOOLEAN and the
 * count is discarded — see `ReleaseNotesDocument.restricted`.
 *
 * ⚠️ AND IT IS A LOWER BOUND, NOT THE WHOLE TRUTH. Running through the caller's
 * reader means an unreadable REQUIREMENT, or an unreadable `delivered-in` EDGE,
 * leaves no trace to compare against and cannot be detected from the browser at
 * all. `restrictedHint` is how a caller that holds a gate report supplies the
 * server's accurate answer; without it, `restricted: false` means "nothing was
 * observed to be withheld", not "nothing was withheld".
 *
 * @public
 */
export async function collectReleaseNotesScope (
  reader: ReleaseNotesReader,
  version: Ref<ProductVersion>,
  options: ReleaseNotesScopeOptions = {}
): Promise<ReleaseNotesInput> {
  const candidates: ReleaseNotesCandidate[] = []
  let restricted = false

  // ── Requirements: the `targetVersion` attribute. ─────────────────────────
  const scoped = await reader.findAll<TitledRow>(
    REQUIREMENT_CLASS as Ref<Class<TitledRow>>,
    {
      targetVersion: version
    } as unknown as DocumentQuery<TitledRow>
  )
  for (const requirement of scoped) {
    candidates.push(toCandidate(requirement, 'requirement'))
  }

  // ── Issues: `delivered-in` trace edges. ──────────────────────────────────
  const edges = await reader.findAll<TraceLinkRow>(
    TRACE_LINK_CLASS as Ref<Class<TraceLinkRow>>,
    {
      // `docB` is the persisted name of the TARGET endpoint — the only spelling
      // the Postgres relation schema promotes to an indexed column.
      docB: version as Ref<Doc>,
      kind: DELIVERED_IN,
      state: 'active'
    } as unknown as DocumentQuery<TraceLinkRow>
  )
  const deliveredIds = [...new Set(edges.map((it) => it.docA))]

  if (deliveredIds.length > 0) {
    const issues = await reader.findAll<TitledRow>(
      ISSUE_CLASS as Ref<Class<TitledRow>>,
      {
        _id: { $in: deliveredIds }
      } as unknown as DocumentQuery<TitledRow>
    )
    // An edge whose issue did not come back is an issue in a space this caller
    // cannot read. One boolean; the number is deliberately dropped on the floor.
    restricted = issues.length < deliveredIds.length

    const defects = await findDefectIds(reader, deliveredIds)
    for (const issue of issues) {
      const candidate = toCandidate(issue, 'work-item')
      if (defects.has(issue._id) || options.isDefect?.(issue) === true) {
        candidate.isDefect = true
      }
      candidates.push(candidate)
    }
  }

  // OR-ed, never AND-ed: this function's own detection is a LOWER BOUND (see
  // `restrictedHint`), so a hint saying "yes" always wins and a hint saying "no"
  // can never clear a restriction this function actually observed.
  return { candidates, restricted: restricted || options.restrictedHint === true }
}

/**
 * Which of these issues carry a `defect-of` edge.
 *
 * ⚠️ Queried in ONE round trip over `$in` rather than per issue: a release with
 * a hundred delivered items would otherwise fire a hundred requests, and the
 * partial results of a failure halfway through would silently reclassify the
 * rest as improvements.
 */
async function findDefectIds (reader: ReleaseNotesReader, ids: Array<Ref<Doc>>): Promise<Set<Ref<Doc>>> {
  const edges = await reader.findAll<TraceLinkRow>(
    TRACE_LINK_CLASS as Ref<Class<TraceLinkRow>>,
    {
      docA: { $in: ids },
      kind: DEFECT_OF,
      state: 'active'
    } as unknown as DocumentQuery<TraceLinkRow>
  )
  return new Set(edges.map((it) => it.docA))
}

/**
 * ⚠️ `title` then `name` then empty. `Requirement extends Card` carries `title`,
 * `Issue` carries `title`, and `name` is the fallback for anything else that
 * ends up in scope. An entry with no readable label is still LISTED —
 * `entryLine` falls back to the identifier and then to the id — because
 * dropping it would understate what shipped.
 */
function toCandidate (doc: TitledRow, origin: 'requirement' | 'work-item'): ReleaseNotesCandidate {
  return {
    id: doc._id,
    objectClass: doc._class,
    ...(doc.identifier !== undefined ? { identifier: doc.identifier } : {}),
    title: doc.title ?? doc.name ?? '',
    origin
  }
}
