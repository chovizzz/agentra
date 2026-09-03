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

import { type Type } from '@hcengineering/core'
import { Model } from '@hcengineering/model'
import core, { TType } from '@hcengineering/model-core'
import { type RequirementPriority, type RequirementStatus } from '@hcengineering/requirements'

import requirements from './plugin'

/**
 * A `Type` subclass exists for one reason: view mixins attach to the attribute's
 * `attrClass`, not to the class that owns the attribute. `SortFuncs`,
 * `AllValuesFunc` and `AttributePresenter` all need a class to hang off, and
 * that class is this one.
 *
 * Precedent outside the Task domain: `TTypeDocumentState` in
 * `models/controlled-documents/src/types.ts`.
 *
 * ℹ️ There is deliberately no domain and no `@Model` class for Requirement
 * itself: a Requirement IS a Card (its MasterTag extends `card.class.Card`), so
 * it lives in `DOMAIN_CARD` and there is no second table for it.
 *
 * @public
 */
@Model(requirements.class.TypeRequirementStatus, core.class.Type)
export class TTypeRequirementStatus extends TType {}

/**
 * @public
 */
export function TypeRequirementStatus (): Type<RequirementStatus> {
  return { _class: requirements.class.TypeRequirementStatus, label: requirements.string.Status }
}

/**
 * @public
 */
@Model(requirements.class.TypeRequirementPriority, core.class.Type)
export class TTypeRequirementPriority extends TType {}

/**
 * @public
 */
export function TypeRequirementPriority (): Type<RequirementPriority> {
  return { _class: requirements.class.TypeRequirementPriority, label: requirements.string.Priority }
}
