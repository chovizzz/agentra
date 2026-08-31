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

import type { Class, Mixin, Ref, Type } from '@hcengineering/core'
import type { Asset, IntlString, Plugin } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'

import type { Cycle, CycleIssue, CycleStatus } from './types'

export * from './types'

/**
 * @public
 */
export const cycleId = 'cycle' as Plugin

/**
 * @public
 */
const cycle = plugin(cycleId, {
  class: {
    Cycle: '' as Ref<Class<Cycle>>,
    // A `Type` subclass. It exists purely so that view mixins (SortFuncs,
    // AllValuesFunc, AttributeFilter, AttributePresenter) have a class to hang
    // off — grouping and filtering resolve the attribute's `attrClass`, never
    // the class that owns the attribute.
    TypeCycleStatus: '' as Ref<Class<Type<CycleStatus>>>
  },
  mixin: {
    // Extends the UPSTREAM `tracker.class.Issue` with `cycle`. Never patch the
    // upstream class: a mixin is additive and survives upstream syncs.
    CycleIssue: '' as Ref<Mixin<CycleIssue>>
  },
  string: {
    Cycles: '' as IntlString,
    Cycle: '' as IntlString,
    ConfigLabel: '' as IntlString,
    ConfigDescription: '' as IntlString,
    Name: '' as IntlString,
    Goal: '' as IntlString,
    Status: '' as IntlString,
    StartDate: '' as IntlString,
    EndDate: '' as IntlString,
    Capacity: '' as IntlString,
    Sequence: '' as IntlString,
    StatusPlanned: '' as IntlString,
    StatusActive: '' as IntlString,
    StatusCompleted: '' as IntlString,
    StatusCancelled: '' as IntlString,

    // ── Creation / selection ────────────────────────────────────────────────
    CreateCycle: '' as IntlString,
    NewCycle: '' as IntlString,
    // 🔴 Shown INSIDE the create dialog, not as a toast, and it exists because
    // `Card.handleOkClick` (packages/presentation) has NO `.catch`: a rejected
    // `okAction` neither closes the dialog nor clears `okProcessing`, so the
    // Create button stays in its loading state for good with nothing on screen
    // explaining why. `CreateCycle.svelte` therefore resolves on failure and
    // renders this instead — see the header there for how the resulting
    // spurious `close` is swallowed.
    CreateCycleFailed: '' as IntlString,
    NoCycle: '' as IntlString,
    SelectCycle: '' as IntlString,

    // ── CompleteCycle ───────────────────────────────────────────────────────
    CompleteCycle: '' as IntlString,
    CompleteCycleHint: '' as IntlString,
    Complete: '' as IntlString,
    RolloverPolicy: '' as IntlString,
    RolloverKeep: '' as IntlString,
    RolloverBacklog: '' as IntlString,
    RolloverMove: '' as IntlString,
    RolloverTarget: '' as IntlString,
    NoNextCycle: '' as IntlString,
    OpenIssues: '' as IntlString,
    DoneIssues: '' as IntlString,
    TotalIssues: '' as IntlString,
    RolledOverIssues: '' as IntlString,
    CycleCompleted: '' as IntlString,
    // 🔴 Rendered in the Cycle's Activity timeline, and its id is duplicated as
    // a wire constant in `server-plugins/agentra-core-resources`
    // (`CYCLE_COMPLETED_MESSAGE`) because that package cannot depend on this
    // one. Renaming this key breaks the snapshot record's label.
    CycleCompletedActivity: '' as IntlString,
    CycleAlreadyCompleted: '' as IntlString,
    CompleteCycleInProgress: '' as IntlString,
    CompleteCycleUnavailable: '' as IntlString,
    CompleteCycleErrored: '' as IntlString,

    // ── Refusal reasons the server may return ───────────────────────────────
    ReasonCycleNotFound: '' as IntlString,
    ReasonIllegalCycleTransition: '' as IntlString,
    ReasonRolloverTargetRequired: '' as IntlString,
    ReasonRolloverTargetInvalid: '' as IntlString,
    ReasonMalformedInput: '' as IntlString,
    ReasonUnknown: '' as IntlString,

    // ── SetCycle (bulk edit) ────────────────────────────────────────────────
    // The action's own label, and the picker's placeholder.
    SetCycle: '' as IntlString,
    // 🔴 Shown INSTEAD of the picker, never alongside a partial result: a bulk
    // edit that spans two projects is refused whole, because a Cycle belongs to
    // exactly one project and no single answer can be right for all of them.
    SetCycleCrossProject: '' as IntlString,
    // Likewise whole-batch: if any selected issue is not writable by the
    // caller, nothing is offered and no count is produced.
    SetCycleForbidden: '' as IntlString,
    SetCycleEmpty: '' as IntlString
  },
  icon: {
    Cycles: '' as Asset,
    Cycle: '' as Asset
  }
})

/**
 * @public
 */
export default cycle
