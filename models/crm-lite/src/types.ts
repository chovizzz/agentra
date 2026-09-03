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

import { type CrmPipeline, type LeadPriority, type LeadSource, type LeadStatus } from '@hcengineering/crm-lite'
import { IndexKind, type Domain, type Type } from '@hcengineering/core'
import { Index, Model, Prop, TypeBoolean, TypeNumber, TypeString, UX } from '@hcengineering/model'
import core, { TDoc, TType } from '@hcengineering/model-core'

import crmLite from './plugin'

/**
 * Pipelines and sources are ordinary configuration documents, so they get their
 * own domain. Leads themselves live in `DOMAIN_CARD`, because a Lead IS a Card
 * (its MasterTag extends `card.class.Card`) — there is no second table for them.
 *
 * @public
 */
export const DOMAIN_CRM_LITE = 'crm-lite' as Domain

/**
 * A `Type` subclass exists for one reason: view mixins attach to the attribute's
 * `attrClass`, not to the class that owns the attribute. `SortFuncs`,
 * `AllValuesFunc` and `AttributePresenter` all need a class to hang off, and
 * that class is this one.
 *
 * Precedent outside the Task domain: `TTypeDocumentState` in
 * `models/controlled-documents/src/types.ts`.
 *
 * @public
 */
@Model(crmLite.class.TypeLeadStatus, core.class.Type)
export class TTypeLeadStatus extends TType {}

/**
 * @public
 */
export function TypeLeadStatus (): Type<LeadStatus> {
  return { _class: crmLite.class.TypeLeadStatus, label: crmLite.string.Status }
}

/**
 * @public
 */
@Model(crmLite.class.TypeLeadPriority, core.class.Type)
export class TTypeLeadPriority extends TType {}

/**
 * @public
 */
export function TypeLeadPriority (): Type<LeadPriority> {
  return { _class: crmLite.class.TypeLeadPriority, label: crmLite.string.Priority }
}

/**
 * @public
 */
@Model(crmLite.class.CrmPipeline, core.class.Doc, DOMAIN_CRM_LITE)
@UX(crmLite.string.Pipeline, crmLite.icon.CrmLite)
export class TCrmPipeline extends TDoc implements CrmPipeline {
  @Prop(TypeString(), crmLite.string.Name)
  @Index(IndexKind.FullText)
    name!: string

  @Prop(TypeString(), crmLite.string.Description)
    description?: string

  // Stage list is stored as plain strings: the state machine itself is code
  // (`leadTransitions`), the pipeline only decides which stages are shown.
  @Prop(TypeString(), crmLite.string.Stages)
    stages!: LeadStatus[]

  @Prop(TypeNumber(), crmLite.string.Order)
    order!: number

  @Prop(TypeBoolean(), crmLite.string.DefaultPipeline)
    isDefault?: boolean

  @Prop(TypeBoolean(), core.string.Archived)
    archived?: boolean
}

/**
 * @public
 */
@Model(crmLite.class.LeadSource, core.class.Doc, DOMAIN_CRM_LITE)
@UX(crmLite.string.Source, crmLite.icon.CrmLite)
export class TLeadSource extends TDoc implements LeadSource {
  @Prop(TypeString(), crmLite.string.Name)
  @Index(IndexKind.FullText)
    name!: string

  @Prop(TypeString(), crmLite.string.Description)
    description?: string

  @Prop(TypeNumber(), crmLite.string.Order)
    order!: number

  @Prop(TypeBoolean(), core.string.Archived)
    archived?: boolean
}
