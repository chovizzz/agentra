<!--
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
-->
<!--
  The Tracker navigation special. A thin wrapper around the generic
  `workbench.component.SpecialView`, and the wrapper exists for ONE reason.

  🔴 `SpecialView` DOES NOT SCOPE ITS LIST BY `space`. It accepts a `space` prop
  and forwards it to the viewlet component, but the query it actually runs is
  built from `baseQuery` + the `BaseQuery` mixin + the viewlet's own baseQuery
  ONLY (`SpecialView.svelte`), and `List.svelte` uses that query verbatim —
  `space` reaches it just as a prop for the "create" affordance
  (`List.svelte`, `newObjectProps`). Registering the special directly against
  `workbench.component.SpecialView` therefore produces a "Cycles" page under
  every project that lists EVERY project's cycles. It looks right and is wrong,
  which is the worst kind of wrong: the rollover target picker and the complete
  dialog would happily offer a foreign project's cycle.

  🔴 `baseQuery` IS THE SEAM, and it has to be applied HERE rather than in the
  model, because it needs the RUNTIME space. `Workbench.svelte` renders a
  special with `{ ...componentProps, currentSpace, space: currentSpace }` — the
  two space props come AFTER the model's `componentProps`, so a model-side
  `baseQuery` could never see the project the user is actually in.

  ⚠️ `Component` (from `@hcengineering/ui`) resolves an `AnyComponent` id at
  RUNTIME, which is what lets this file target `workbench:component:SpecialView`
  without `@hcengineering/cycle-resources` depending on
  `@hcengineering/workbench-resources`. Same trade-off as the wire constants in
  `models/cycle`: no lockfile churn, at the cost of a rename upstream not
  failing to compile.

  ⚠️ Upstream precedent for "a per-project special needs its own component":
  Tracker's own `Milestones.svelte` exists for exactly this, and does exactly
  this — `query={{ space: currentSpace }}`.
-->
<script lang="ts">
  import type { Ref, Space } from '@hcengineering/core'
  import type { AnyComponent } from '@hcengineering/ui/src/types'
  import { Component } from '@hcengineering/ui'

  import cyclePlugin from '../plugin'

  export let space: Ref<Space> | undefined = undefined

  const SPECIAL_VIEW = 'workbench:component:SpecialView' as AnyComponent

  // 🔴 FAILS CLOSED. With no space there is no project to scope to, and the
  // honest answer is an empty list rather than every project's cycles: this
  // page is reached only from inside a project, so a missing space means
  // something upstream changed, not that the user asked for a global view.
  $: baseQuery = space !== undefined ? { space } : { space: null }
</script>

<Component
  is={SPECIAL_VIEW}
  props={{
    _class: cyclePlugin.class.Cycle,
    icon: cyclePlugin.icon.Cycles,
    label: cyclePlugin.string.Cycles,
    createLabel: cyclePlugin.string.CreateCycle,
    createComponent: cyclePlugin.component.CreateCycle,
    baseQuery,
    space
  }}
/>
