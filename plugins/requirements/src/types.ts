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

import type { Card } from '@hcengineering/card'
import type { Employee } from '@hcengineering/contact'
import type { MarkupBlobRef, Ref } from '@hcengineering/core'
import type { Product, ProductVersion } from '@hcengineering/products'

/**
 * Internal enum values are PascalCase without spaces (Technical Spec §3.9), so
 * `In Delivery` is stored as `InDelivery`. Display text always goes through
 * `requirements-assets/lang/*.json`.
 *
 * 🔴 Append-only: never reorder or rename a member, never remove one. Persisted
 * cards and Trace Link metadata store the literal string.
 *
 * @public
 */
export type RequirementStatus =
  | 'Draft'
  | 'Reviewing'
  | 'Approved'
  | 'InDelivery'
  | 'Validating'
  | 'Released'
  | 'Rejected'
  | 'Cancelled'

/**
 * Canonical ordering used for sorting the `status` attribute and for the list of
 * values returned by the `AllValuesFunc` resource, so a status nothing is in yet
 * still gets a group.
 *
 * @public
 */
export const requirementStatusOrder: RequirementStatus[] = [
  'Draft',
  'Reviewing',
  'Approved',
  'InDelivery',
  'Validating',
  'Released',
  'Rejected',
  'Cancelled'
]

/**
 * 🔴 Append-only, same rule as `RequirementStatus`.
 *
 * Technical Spec §3.9 has no dedicated row for requirement priority, so this
 * mirrors the priority vocabulary already used by `crm-lite` and upstream
 * `tracker` rather than inventing a third one.
 *
 * @public
 */
export type RequirementPriority = 'NoPriority' | 'Urgent' | 'High' | 'Medium' | 'Low'

/**
 * @public
 */
export const requirementPriorityOrder: RequirementPriority[] = ['Urgent', 'High', 'Medium', 'Low', 'NoPriority']

/**
 * The requirement state machine (Technical Spec §3.3, PRD §5.2):
 *
 *   Draft -> Reviewing -> Approved -> InDelivery -> Validating -> Released
 *
 * `Reviewing` may bounce back to `Draft` or be `Rejected`; a rejected
 * requirement may be reworked back into `Draft`. Anything that has not been
 * released may be `Cancelled`. `Released` is terminal.
 *
 * @public
 */
export const requirementTransitions: Record<RequirementStatus, RequirementStatus[]> = {
  Draft: ['Reviewing', 'Cancelled'],
  Reviewing: ['Approved', 'Rejected', 'Draft', 'Cancelled'],
  Approved: ['InDelivery', 'Draft', 'Cancelled'],
  InDelivery: ['Validating', 'Cancelled'],
  Validating: ['Released', 'InDelivery', 'Cancelled'],
  Released: [],
  Rejected: ['Draft', 'Cancelled'],
  Cancelled: []
}

/**
 * @public
 */
export function canTransitionRequirement (from: RequirementStatus, to: RequirementStatus): boolean {
  if (from === to) return true
  return requirementTransitions[from]?.includes(to) ?? false
}

/**
 * A requirement is considered closed once it can no longer move anywhere.
 *
 * @public
 */
export function isTerminalRequirementStatus (status: RequirementStatus): boolean {
  return (requirementTransitions[status]?.length ?? 0) === 0
}

/**
 * Typing helper for the documents carried by the `requirements:masterTag:Requirement`
 * MasterTag. There is no `@Model` class behind it: the tag is created at model
 * build time with `createSystemType`, and its business fields are individual
 * `core.class.Attribute` documents.
 *
 * ⚠️ `product` and `targetVersion` are deliberately plain `TypeRef` ATTRIBUTES,
 * not TraceLink edges: `ViewOptionsModel.groupBy` only accepts attribute keys,
 * and PRD REQ-006 requires grouping requirements by product version.
 * ⚠️ The `delivered-in` TraceLink edge that earlier drafts double-wrote
 * alongside `targetVersion` has been dropped — the attribute is the only record.
 *
 * ℹ️ Cross-module relations (source Lead, Work Item, Test Case) are NOT fields
 * here: they are queried through TraceLink (`converted-to` / `implements` /
 * `verifies`), per Technical Spec §3.3. Count fields such as `sourceCount` /
 * `workItemCount` would be rebuildable caches, never the source of truth, and
 * are intentionally not modelled in this task.
 *
 * @public
 */
export interface Requirement extends Card {
  status: RequirementStatus
  priority: RequirementPriority
  owner?: Ref<Employee>
  product?: Ref<Product>
  targetVersion?: Ref<ProductVersion>
  acceptanceCriteria?: MarkupBlobRef | null
}
