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
import type { Organization, Person } from '@hcengineering/contact'
import type { Doc, Ref, Timestamp } from '@hcengineering/core'

/**
 * Internal enum values are PascalCase without spaces (Technical Spec §3.9).
 * Display text always goes through `crm-lite-assets/lang/*.json`.
 *
 * 🔴 Append-only: never reorder or rename a member, never remove one. Persisted
 * documents and Trace Link metadata store the literal string.
 *
 * @public
 */
export type LeadStatus = 'New' | 'Contacted' | 'Qualifying' | 'Converted' | 'Disqualified'

/**
 * Canonical ordering used for kanban columns and for sorting the `status`
 * attribute. Also the value list returned by the `AllValuesFunc` resource, so
 * empty columns still render.
 *
 * @public
 */
export const leadStatusOrder: LeadStatus[] = ['New', 'Contacted', 'Qualifying', 'Converted', 'Disqualified']

/**
 * 🔴 Append-only, same rule as `LeadStatus`.
 *
 * @public
 */
export type LeadPriority = 'NoPriority' | 'Urgent' | 'High' | 'Medium' | 'Low'

/**
 * @public
 */
export const leadPriorityOrder: LeadPriority[] = ['Urgent', 'High', 'Medium', 'Low', 'NoPriority']

/**
 * The lead state machine (Technical Spec §3.1):
 *   New -> Contacted -> Qualifying -> Converted
 * and any non-`Converted` state may go to `Disqualified` (which requires a reason).
 *
 * `Converted` is terminal.
 *
 * @public
 */
export const leadTransitions: Record<LeadStatus, LeadStatus[]> = {
  New: ['Contacted', 'Disqualified'],
  Contacted: ['Qualifying', 'Disqualified'],
  Qualifying: ['Converted', 'Disqualified'],
  Converted: [],
  Disqualified: []
}

/**
 * @public
 */
export function canTransitionLead (from: LeadStatus, to: LeadStatus): boolean {
  if (from === to) return true
  return leadTransitions[from]?.includes(to) ?? false
}

/**
 * Moving into `Disqualified` must always carry a reason.
 *
 * @public
 */
export function requiresDisqualifyReason (to: LeadStatus): boolean {
  return to === 'Disqualified'
}

/**
 * A configurable sales pipeline. Modelled as a document rather than a hard coded
 * enum so deployments can add their own; the *stages* it lists are `LeadStatus`
 * values, which stay a closed enum because the state machine is code.
 *
 * @public
 */
export interface CrmPipeline extends Doc {
  name: string
  description?: string
  stages: LeadStatus[]
  order: number
  isDefault?: boolean
  archived?: boolean
}

/**
 * A configurable lead source (campaign, referral, inbound, ...). Also a document,
 * not an enum, so it can be maintained without a migration.
 *
 * @public
 */
export interface LeadSource extends Doc {
  name: string
  description?: string
  order: number
  archived?: boolean
}

/**
 * Typing helper for the documents carried by the `crm-lite:masterTag:Lead`
 * MasterTag. There is no `@Model` class behind it: the tag is created at model
 * build time with `createSystemType`, and its attributes are individual
 * `core.class.Attribute` documents. Accounts and contacts are NOT duplicated —
 * they are references into `contact.Organization` / `contact.Person`.
 *
 * @public
 */
export interface Lead extends Card {
  account?: Ref<Organization>
  contact?: Ref<Person>
  source?: Ref<LeadSource>
  pipeline?: Ref<CrmPipeline>
  owner?: Ref<Person>
  status: LeadStatus
  priority: LeadPriority
  nextActionAt?: Timestamp | null
  disqualifyReason?: string
}
