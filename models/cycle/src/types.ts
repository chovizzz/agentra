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

import {
  DateRangeMode,
  IndexKind,
  type Domain,
  type MarkupBlobRef,
  type Ref,
  type Timestamp,
  type Type
} from '@hcengineering/core'
import { type Cycle, type CycleIssue, type CycleStatus } from '@hcengineering/cycle'
import {
  Index,
  Mixin,
  Model,
  Prop,
  TypeCollaborativeDoc,
  TypeDate,
  TypeNumber,
  TypeRef,
  TypeString,
  UX
} from '@hcengineering/model'
import core, { TDoc, TType } from '@hcengineering/model-core'
import { TIssue } from '@hcengineering/model-tracker'
import tracker, { type Project } from '@hcengineering/tracker'

import cycle from './plugin'

/**
 * Cycles get their own domain rather than joining `DOMAIN_TRACKER`: the module
 * owns its own table, so an upstream tracker migration can never trip over rows
 * it does not know about, and dropping the module is a single-table concern.
 *
 * ⚠️ The Issue side of the relation is a MIXIN and therefore lives in the
 * upstream Issue row (`DOMAIN_TASK`) as a `cycle:mixin:CycleIssue` sub-object.
 * There is no join table.
 *
 * @public
 */
export const DOMAIN_CYCLE = 'cycle' as Domain

/**
 * A `Type` subclass exists for one reason: view mixins attach to the attribute's
 * `attrClass`, not to the class that owns the attribute. `SortFuncs`,
 * `AllValuesFunc`, `AttributeFilter` and `AttributePresenter` all need a class
 * to hang off, and that class is this one.
 *
 * Precedent: upstream `TTypeMilestoneStatus` in `models/tracker/src/types.ts`.
 *
 * @public
 */
@Model(cycle.class.TypeCycleStatus, core.class.Type)
export class TTypeCycleStatus extends TType {}

/**
 * @public
 */
export function TypeCycleStatus (): Type<CycleStatus> {
  return { _class: cycle.class.TypeCycleStatus, label: cycle.string.Status }
}

/**
 * 🔴 Not `isCustom: true` anywhere in this file: a custom attribute is
 * user-deletable from the settings page and is skipped by server side index
 * generation. These are product fields, not user extensions.
 *
 * @public
 */
@Model(cycle.class.Cycle, core.class.Doc, DOMAIN_CYCLE)
@UX(cycle.string.Cycle, cycle.icon.Cycle, '', 'name', undefined, cycle.string.Cycles)
export class TCycle extends TDoc implements Cycle {
  @Prop(TypeString(), cycle.string.Name)
  @Index(IndexKind.FullText)
    name!: string

  @Prop(TypeCollaborativeDoc(), cycle.string.Goal)
    goal?: MarkupBlobRef | null

  @Prop(TypeCycleStatus(), cycle.string.Status)
  @Index(IndexKind.Indexed)
    status!: CycleStatus

  @Prop(TypeDate(DateRangeMode.DATE), cycle.string.StartDate)
    startDate!: Timestamp

  @Prop(TypeDate(DateRangeMode.DATE), cycle.string.EndDate)
    endDate!: Timestamp

  @Prop(TypeNumber(), cycle.string.Capacity)
    capacity?: number

  @Prop(TypeNumber(), cycle.string.Sequence)
    sequence!: number

  // A Cycle lives in the tracker Project its issues live in, so cycle
  // visibility is exactly issue visibility — no second permission surface.
  declare space: Ref<Project>
}

/**
 * The Issue side of the relation.
 *
 * 🔴 A MIXIN on the upstream `tracker.class.Issue`, never a patch to the
 * upstream class: `plugins/tracker/src/index.ts` and
 * `models/tracker/src/types.ts` would then conflict on every upstream sync.
 *
 * ℹ️ `TCycleIssue extends TIssue` is what the platform requires of a mixin
 * model class (same shape as upstream `TIssueTypeData`, and as `TCandidate
 * extends TPerson` in `models/recruit`). It declares NO other field, so the
 * mixin adds exactly one attribute.
 *
 * @public
 */
@Mixin(cycle.mixin.CycleIssue, tracker.class.Issue)
@UX(cycle.string.Cycle, cycle.icon.Cycle)
export class TCycleIssue extends TIssue implements CycleIssue {
  // ⚠️ Deliberately NO `@Index(IndexKind.Indexed)` here, unlike `Cycle.status`.
  // `DomainHelper` (foundations/server/packages/core/src/domainHelper.ts) walks
  // every class INCLUDING mixins, resolves the mixin's domain to the host's
  // (`DOMAIN_TASK`) and would ask for an index on the bare key `cycle` — but a
  // mixin value is stored NESTED under the mixin id
  // (`cycle:mixin:CycleIssue.cycle`, which is exactly the key `makeFilterQuery`
  // builds). The index would therefore cover a field that does not exist.
  // Upstream agrees by example: every `@Index` on a mixin `@Prop` in this repo
  // is `IndexKind.FullText`, which `DomainHelper` skips (`models/recruit`,
  // `models/lead`).
  @Prop(TypeRef(cycle.class.Cycle), cycle.string.Cycle, { icon: cycle.icon.Cycle })
    cycle?: Ref<Cycle> | null
}
