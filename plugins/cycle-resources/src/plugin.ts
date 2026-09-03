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

import cycle, { cycleId } from '@hcengineering/cycle'
import type { Doc } from '@hcengineering/core'
import { mergeIds, type Resource } from '@hcengineering/platform'
import type { AnyComponent } from '@hcengineering/ui/src/types'
import type { GetAllValuesFunc, SortFunc, ViewActionAvailabilityFunction } from '@hcengineering/view'

export default mergeIds(cycleId, cycle, {
  component: {
    CycleStatusPresenter: '' as AnyComponent,
    // ObjectPresenter (renders a Cycle document) and AttributePresenter
    // (renders a `Ref<Cycle>` held by the Issue mixin) are two different
    // lookups: for a `RefTo` attribute the presenter is resolved on the TARGET
    // class, so both mixins live on `cycle.class.Cycle`.
    CyclePresenter: '' as AnyComponent,
    CycleRefPresenter: '' as AnyComponent,
    // `view.mixin.AttributeEditor.inlineEditor` on `cycle.class.TypeCycleStatus`.
    // 🔴 Without it `AttributeBarEditor` renders NOTHING for the field — its
    // whole body is wrapped in `{#if editor}` — so the status looks absent
    // rather than read-only.
    CycleStatusEditor: '' as AnyComponent,
    // `view.mixin.AttributeEditor.inlineEditor` on `cycle.class.Cycle`.
    // ⚠️ On the TARGET class, not on `cycle.mixin.CycleIssue`:
    // `getAttributePresenterClass` rewrites a `RefTo` attribute's `attrClass` to
    // `type.to`, and `getAttrEditor` then looks the mixin up on THAT class.
    CycleEditor: '' as AnyComponent,
    CreateCycle: '' as AnyComponent,
    CompleteCyclePopup: '' as AnyComponent,
    // `Action.actionPopup` for `SetCycle`. A thin guard in front of the
    // UPSTREAM `view.component.ValueSelector`: it refuses a selection that
    // spans projects (or that the caller cannot fully write) rather than
    // letting the batch run on the subset that happens to qualify.
    SetCyclePopup: '' as AnyComponent,
    // The Tracker navigation special. A wrapper around
    // `workbench.component.SpecialView` that exists because that component does
    // NOT scope its list by `space` — see the component's own header.
    CyclesView: '' as AnyComponent
  },
  actionImpl: {
    CompleteCycle: '' as Resource<(doc?: Doc | Doc[]) => Promise<void>>,
    // `Action.action` for "Link requirements", offered on an Issue.
    // 🔴 A DEDICATED IMPL RATHER THAN `view.actionImpl.ShowPopup`, because the
    // popup's `fixed` prop is an ARRAY and `ShowPopup.fillProps` cannot produce
    // one — see `linkRequirementsPopupProps`.
    LinkRequirements: '' as Resource<(doc?: Doc | Doc[]) => Promise<void>>
  },
  function: {
    // Hung on `cycle.class.TypeCycleStatus` via `view.mixin.SortFuncs` /
    // `view.mixin.AllValuesFunc`. Without the pair, grouped list/table sections
    // come out in arbitrary order and a status nothing is in yet gets no group.
    CycleStatusSort: '' as SortFunc,
    GetAllCycleStatuses: '' as GetAllValuesFunc,
    // Hides the "Complete cycle" action on a cycle that cannot legally reach
    // `completed`. The command refuses those anyway; this only keeps the menu
    // from offering an action that is guaranteed to fail.
    CanCompleteCycle: '' as Resource<ViewActionAvailabilityFunction<Doc>>,
    // `Action.visibilityTester` for `SetCycle`. Hides the action outright when
    // any member of the selection is out of bounds — the refusal is whole-batch
    // so that no "n of m" count is ever produced for objects the caller may not
    // see.
    CanSetCycle: '' as Resource<ViewActionAvailabilityFunction<Doc>>,
    // `Action.visibilityTester` for "Link requirements".
    // 🔴 THE ONLY GATE ON THE LIST/CONTEXT-MENU PATH. The read-only protection
    // the detail page gets from `EditIssue`'s `effectiveReadonly` does not
    // reach a right-click in a list, so every refusal has to be stated here.
    CanLinkRequirements: '' as Resource<ViewActionAvailabilityFunction<Doc>>
  }
})
