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

import type { CardSpace, MasterTag } from '@hcengineering/card'
import type { Class, Ref } from '@hcengineering/core'
import type { Asset, IntlString, Plugin } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'

export * from './types'

/**
 * @public
 */
export const requirementsId = 'requirements' as Plugin

/**
 * @public
 */
const requirements = plugin(requirementsId, {
  masterTag: {
    // Requirement is a MasterTag, NOT a Tag. `Tag extends MasterTag, Mixin<Card>`
    // is a mixin and therefore can never be a document's `_class`; on top of
    // that `classHierarchyMixin` only walks the `extends` chain, so a Tag can
    // never take part in card versioning. The tag itself is produced by
    // `createSystemType()` in `models/requirements`.
    Requirement: '' as Ref<MasterTag>
  },
  class: {
    // `Type` subclasses. They exist purely so that view mixins (SortFuncs,
    // AllValuesFunc, AttributePresenter) have a class to hang off — grouping
    // resolves the attribute's `attrClass`, not the owning class.
    TypeRequirementStatus: '' as Ref<Class<any>>,
    TypeRequirementPriority: '' as Ref<Class<any>>
  },
  space: {
    // A second dedicated global CardSpace, alongside the CRM one. Requirements
    // are kept out of `crm-lite`'s space so the product lifecycle is not coupled
    // to CRM (Technical Spec §3.3).
    //
    // 🔴 Deliberately NOT `card.space.Default`: that space is created with
    // `private: false, autoJoin: true`, which would make every requirement
    // readable by the whole workspace.
    //
    // 🔴 It also deliberately reuses the single upstream `card.spaceType.SpaceType`
    // instead of declaring its own SpaceType: `models/card/src/migration.ts`
    // (`migrateRolesToBaseRole`) rewrites every Role whose `attachedTo` is not
    // `card.spaceType.SpaceType` back to it, so a private SpaceType would be
    // silently undone.
    //
    // ⚠️ `CardSpace.types` is a CLIENT-SIDE allow-list only — `createCard` does
    // not validate it server side. It is not a security boundary.
    Requirements: '' as Ref<CardSpace>
  },
  string: {
    Requirements: '' as IntlString,
    ConfigLabel: '' as IntlString,
    ConfigDescription: '' as IntlString,
    Requirement: '' as IntlString,
    RequirementsSpace: '' as IntlString,
    RequirementsSpaceDescription: '' as IntlString,
    Status: '' as IntlString,
    Priority: '' as IntlString,
    Owner: '' as IntlString,
    Product: '' as IntlString,
    TargetVersion: '' as IntlString,
    AcceptanceCriteria: '' as IntlString,
    StatusDraft: '' as IntlString,
    StatusReviewing: '' as IntlString,
    StatusApproved: '' as IntlString,
    StatusInDelivery: '' as IntlString,
    StatusValidating: '' as IntlString,
    StatusReleased: '' as IntlString,
    StatusRejected: '' as IntlString,
    StatusCancelled: '' as IntlString,
    PriorityNoPriority: '' as IntlString,
    PriorityUrgent: '' as IntlString,
    PriorityHigh: '' as IntlString,
    PriorityMedium: '' as IntlString,
    PriorityLow: '' as IntlString
  },
  icon: {
    Requirements: '' as Asset,
    Requirement: '' as Asset
  }
})

/**
 * @public
 */
export default requirements
