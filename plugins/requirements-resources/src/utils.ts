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

import type { TxOperations } from '@hcengineering/core'
import {
  canTransitionRequirement,
  requirementPriorityOrder,
  requirementStatusOrder,
  type RequirementPriority,
  type RequirementStatus
} from '@hcengineering/requirements'

/**
 * `SortFunc` implementation for `requirements.class.TypeRequirementStatus`.
 *
 * Grouping resolves the attribute's `attrClass` and then calls the `SortFuncs`
 * mixin registered on that class, so this is what orders the grouped sections.
 * Values not in the canonical order (data written by an older/newer build) are
 * kept and pushed to the end rather than dropped.
 *
 * @public
 */
export async function sortRequirementStatuses (
  _: TxOperations,
  values: RequirementStatus[]
): Promise<RequirementStatus[]> {
  return [...values].sort((a, b) => rank(requirementStatusOrder, a) - rank(requirementStatusOrder, b))
}

/**
 * `AllValuesFunc` implementation: what makes an empty status still render as a
 * group when "show empty groups" is on.
 *
 * @public
 */
export async function getAllRequirementStatuses (): Promise<RequirementStatus[]> {
  return requirementStatusOrder
}

/**
 * @public
 */
export async function sortRequirementPriorities (
  _: TxOperations,
  values: RequirementPriority[]
): Promise<RequirementPriority[]> {
  return [...values].sort((a, b) => rank(requirementPriorityOrder, a) - rank(requirementPriorityOrder, b))
}

/**
 * @public
 */
export async function getAllRequirementPriorities (): Promise<RequirementPriority[]> {
  return requirementPriorityOrder
}

function rank<T> (order: T[], value: T): number {
  const idx = order.indexOf(value)
  return idx === -1 ? order.length : idx
}

// ───────────────────────────────────────────────────────────────────────────
// Inline status / priority editing (`view.mixin.AttributeEditor`).
// ───────────────────────────────────────────────────────────────────────────

/**
 * The outcome of one inline status pick, as a value rather than as a side
 * effect, so the state machine is unit testable without a Svelte runtime.
 *
 * `unchanged` is kept apart from `accepted` on purpose: `canTransitionRequirement`
 * answers `true` for `from === to` (a self transition is trivially legal), but
 * writing the value back would still produce a pointless Tx and an Activity
 * entry claiming the status "changed" to what it already was.
 *
 * @public
 */
export type RequirementStatusChange =
  | { kind: 'accepted', status: RequirementStatus }
  | { kind: 'unchanged' }
  | { kind: 'rejected', from: RequirementStatus, to: RequirementStatus }

/**
 * The statuses the inline editor may OFFER for a requirement currently in
 * `from`, in `requirementStatusOrder` so the dropdown reads in the same
 * sequence as the grouped list sections.
 *
 * ⚠️ This is the first of two gates and it is the cosmetic one. Filtering the
 * list is not enforcement: `DropdownLabelsIntl` can dispatch `selected` for an
 * id that is no longer in `items` (the requirement's status can change
 * underneath an open popup), so {@link resolveRequirementStatusChange}
 * re-checks on the way in and is the gate that actually refuses.
 *
 * @public
 */
export function requirementStatusChoices (from: RequirementStatus | undefined): RequirementStatus[] {
  // No current status at all — nothing has been asserted yet, so nothing can be
  // violated. Offer the whole vocabulary rather than silently offering nothing.
  if (from === undefined) {
    return [...requirementStatusOrder]
  }
  return requirementStatusOrder.filter((to) => canTransitionRequirement(from, to))
}

/**
 * The gate. Given the value on screen and the value picked, say what — if
 * anything — may be written.
 *
 * 🔴 `canTransitionRequirement` is the single source of truth for legality; this
 * function adds only the `from === to` short circuit. Do not reimplement the
 * transition table here: `plugins/requirements/src/types.ts` owns it.
 *
 * @public
 */
export function resolveRequirementStatusChange (
  from: RequirementStatus | undefined,
  to: RequirementStatus
): RequirementStatusChange {
  if (from === to) {
    return { kind: 'unchanged' }
  }
  if (from === undefined) {
    return { kind: 'accepted', status: to }
  }
  return canTransitionRequirement(from, to) ? { kind: 'accepted', status: to } : { kind: 'rejected', from, to }
}
