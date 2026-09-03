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

import type { Doc, MarkupBlobRef, Ref, Space, Timestamp } from '@hcengineering/core'
import type { Issue, Project } from '@hcengineering/tracker'

/**
 * 🔴 Technical Spec §3.9 stores Cycle status in LOWERCASE, unlike every other
 * enum in the fork (Requirement / ProductVersion / TestRun are PascalCase).
 * That is deliberate and called out in the spec: "Cycle 与 Issue 依赖两组是小写
 * 连字符而非 PascalCase … 均不得为了统一风格而改写". Display text always comes
 * from `cycle-assets/lang/*.json`.
 *
 * 🔴 Append-only: never rename, reorder or remove a member — the literal string
 * is what is persisted.
 *
 * @public
 */
export type CycleStatus = 'planned' | 'active' | 'completed' | 'cancelled'

/**
 * Canonical ordering, used both by the `SortFuncs` resource (group order) and by
 * `AllValuesFunc` (so a status nothing is in yet still gets a group).
 *
 * @public
 */
export const cycleStatusOrder: CycleStatus[] = ['planned', 'active', 'completed', 'cancelled']

/**
 * The cycle state machine (Technical Spec §3.4):
 *
 *   planned -> active -> completed
 *
 * A cycle that has not completed may be `cancelled`; `completed` and
 * `cancelled` are terminal. The `CompleteCycle` command (Task 11) is what
 * drives `active -> completed` together with issue rollover; this table is the
 * model-side vocabulary it will validate against.
 *
 * @public
 */
export const cycleTransitions: Record<CycleStatus, CycleStatus[]> = {
  planned: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
}

/**
 * @public
 */
export function canTransitionCycle (from: CycleStatus, to: CycleStatus): boolean {
  if (from === to) return true
  return cycleTransitions[from]?.includes(to) ?? false
}

/**
 * @public
 */
export function isTerminalCycleStatus (status: CycleStatus): boolean {
  return (cycleTransitions[status]?.length ?? 0) === 0
}

/**
 * What `CompleteCycle` does with the issues that are still open when a cycle is
 * closed.
 *
 * 🔴 AN EXPLICIT PARAMETER, NOT AN IMPLIED CONVENTION. Technical Spec §4 lists
 * the command's input as `cycle` + `rolloverPolicy`, and the whole point of
 * naming the policy is that "what happens to the leftovers" is a decision the
 * closer makes, not something the server guesses from the data.
 *
 *   - `keep`    — leave every open issue attached to the cycle that just
 *                 closed. The cycle's membership stays a truthful record of
 *                 what was actually in it; nothing moves.
 *   - `backlog` — clear `CycleIssue.cycle` on every open issue, i.e. send them
 *                 back to the project backlog with no cycle at all.
 *   - `move`    — move every open issue to ONE named target cycle, supplied by
 *                 the caller as `rolloverTarget`.
 *
 * 🔴 `move` DOES NOT MEAN "the server picks the next cycle". Resolving "next"
 * on the server would make the command non-deterministic across re-entries: a
 * cycle created between a crashed attempt and its replay would change the
 * answer, and issues from one run would land somewhere different from issues of
 * the next. {@link nextCycleAfter} does the picking on the CLIENT, the resolved
 * id travels in the request, and the server only validates it. That is what
 * makes the rollover step replayable.
 *
 * 🔴 Append-only: the literal strings travel on the wire and are recorded in
 * the command ledger.
 *
 * @public
 */
export type CycleRolloverPolicy = 'keep' | 'backlog' | 'move'

/**
 * Canonical ordering for pickers.
 *
 * @public
 */
export const cycleRolloverPolicies: CycleRolloverPolicy[] = ['keep', 'backlog', 'move']

/**
 * @public
 */
export function isCycleRolloverPolicy (value: unknown): value is CycleRolloverPolicy {
  return typeof value === 'string' && (cycleRolloverPolicies as string[]).includes(value)
}

/**
 * A Cycle (sprint / iteration) inside a Tracker project.
 *
 * 🔴 It is a plain `Doc` in its own domain, NOT a Card and NOT a Task: it is a
 * Tracker EXTENSION object (Technical Spec §3.4), and its `space` is the
 * upstream `tracker.class.Project` the issues already live in. Reusing the
 * project space is what keeps cycle visibility identical to issue visibility —
 * no second permission surface.
 *
 * ⚠️ There are deliberately NO velocity / burndown / rollover fields here.
 * §3.4: "速度、燃尽和滚动数据从 Activity/Issue 快照计算，不以手工字段作为事实来源".
 * Everything a burndown needs is already recoverable: issue status history from
 * Activity, and cycle membership history from the `TxMixin` transactions that
 * write `cycle.mixin.CycleIssue.cycle`.
 *
 * @public
 */
export interface Cycle extends Doc {
  space: Ref<Project>
  name: string
  goal?: MarkupBlobRef | null
  status: CycleStatus
  startDate: Timestamp
  endDate: Timestamp
  /** Planned capacity, in the same unit the project uses for estimation. */
  capacity?: number
  /** Per-project ordinal, so "Cycle 7" is stable and human referable. */
  sequence: number
}

/**
 * The Issue side of the relation, carried as a MIXIN on the upstream
 * `tracker.class.Issue`.
 *
 * 🔴 Adding a field to upstream `tracker.Issue` itself was rejected: every
 * upstream sync would conflict on `plugins/tracker/src/index.ts` and
 * `models/tracker/src/types.ts`. A mixin is additive and upstream-clean.
 *
 * ⚠️ Consequence, verified and accepted (see the module's model tests): a mixin
 * attribute IS filterable in the stock Tracker views —
 * `FilterTypePopup.getOwnTypes` walks the mixin descendants of `Issue` and
 * `makeFilterQuery` prefixes the key with the mixin id — but it is NOT
 * group-able there, because `groupByCategory` resolves the key with
 * `hierarchy.getAttribute(Issue, key)`, which cannot see a mixin attribute.
 *
 * @public
 */
export interface CycleIssue extends Issue {
  cycle?: Ref<Cycle> | null
}

/**
 * The cycle that comes after `current`, by the module's own total order.
 *
 * 🔴 THE ORDER IS `(sequence, startDate, _id)`, COMPARED AS A TUPLE, and every
 * component is load bearing:
 *
 *   - `sequence` is the documented per-project ordinal (§3.4) and is what a
 *     human means by "cycle 7 comes after cycle 6";
 *   - `startDate` breaks the tie that the migration guarantees will exist:
 *     `backfillCycleDefaults` writes `sequence: 0` to every row that predates
 *     the field, so a workspace upgraded from an older build can legitimately
 *     hold several cycles all numbered 0;
 *   - `_id` breaks the remaining tie so the answer is total rather than
 *     "whichever the adapter returned first".
 *
 * ⚠️ Terminal cycles are never offered: rolling unfinished work into a cycle
 * that is itself `completed` or `cancelled` would hide the work rather than
 * reschedule it. The caller gets `undefined` and must choose another policy —
 * the command refuses a terminal target as well, so this is a courtesy, not the
 * enforcement.
 *
 * ⚠️ Pure and side-effect free ON PURPOSE: it takes the candidate list rather
 * than a client, so the rule is unit testable without a platform.
 *
 * @public
 */
export function nextCycleAfter (cycles: Cycle[], current: Cycle): Cycle | undefined {
  const after = cycles.filter(
    (it) =>
      it._id !== current._id && it.space === current.space && !isTerminalCycleStatus(it.status) && isAfter(it, current)
  )
  return after.sort(compareCycleOrder)[0]
}

function isAfter (candidate: Cycle, current: Cycle): boolean {
  return compareCycleOrder(candidate, current) > 0
}

/**
 * The total order {@link nextCycleAfter} sorts by. Exported so a list view can
 * present cycles in the same sequence the rollover default follows.
 *
 * @public
 */
export function compareCycleOrder (a: Cycle, b: Cycle): number {
  if (a.sequence !== b.sequence) return a.sequence - b.sequence
  if (a.startDate !== b.startDate) return a.startDate - b.startDate
  return a._id < b._id ? -1 : a._id > b._id ? 1 : 0
}

/**
 * Why a bulk `SetCycle` can be refused.
 *
 * 🔴 Every one of these refuses the WHOLE selection. A per-document skip is not
 * an option here: a bulk edit that silently drops rows leaves the user believing
 * work was re-scheduled when it was not, and a "3 of 5 updated" count is itself
 * a side channel — it tells the caller how many objects exist behind a wall they
 * are not allowed to see.
 *
 * @public
 */
export type CycleBulkRefusal =
  /** Nothing was selected. */
  | 'empty'
  /**
   * The selection spans more than one project. A `Cycle` belongs to exactly one
   * `tracker.class.Project` (`Cycle.space`), so no single cycle can legally be
   * the answer for all of them.
   */
  | 'cross-project'
  /** At least one selected issue is not writable by the caller. */
  | 'forbidden'

/**
 * @public
 */
export type CycleBulkSelection<T, S extends Ref<Space> = Ref<Project>> =
  | { ok: true, space: S, docs: T[] }
  | { ok: false, reason: CycleBulkRefusal }

/**
 * The admission rule for a bulk "Set cycle".
 *
 * 🔴 PURE AND INJECTABLE ON PURPOSE. `canEdit` is a parameter rather than a
 * client call so the rule is unit testable without a platform — the same choice
 * {@link nextCycleAfter} makes.
 *
 * ⚠️ GENERIC OVER THE SPACE TYPE. A `Cycle`'s own space is narrowed to
 * `Ref<Project>`, but the callers hold `Doc`s whose `space` is the generic
 * `Ref<Space>` the platform hands them — pinning the parameter to `Ref<Project>`
 * would force every call site into a cast, which is exactly how a wrong `space`
 * gets waved through.
 *
 * ⚠️ ORDER MATTERS, AND IT IS `cross-project` BEFORE `forbidden`. Reporting
 * "forbidden" first would let a caller probe which foreign projects exist by
 * watching which reason comes back; the shape of the selection is something the
 * caller already knows, so refusing on it first leaks nothing.
 *
 * @public
 */
export function checkCycleBulkSelection<S extends Ref<Space>, T extends { _id: Ref<Doc>, space: S }> (
  docs: T[],
  canEdit: (doc: T) => boolean
): CycleBulkSelection<T, S> {
  if (docs.length === 0) {
    return { ok: false, reason: 'empty' }
  }
  const space = docs[0].space
  if (docs.some((it) => it.space !== space)) {
    return { ok: false, reason: 'cross-project' }
  }
  if (!docs.every((it) => canEdit(it))) {
    return { ok: false, reason: 'forbidden' }
  }
  return { ok: true, space, docs }
}

/**
 * A cycle that may still receive issues: everything but the terminal states.
 *
 * Assigning work to a `completed` or `cancelled` cycle would hide it rather than
 * schedule it — the same rule the rollover target picker already enforces.
 *
 * @public
 */
export function isCycleAssignable (cycle: Pick<Cycle, 'status'>): boolean {
  return !isTerminalCycleStatus(cycle.status)
}
