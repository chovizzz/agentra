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
  `inlineEditor` of `view.mixin.AttributeEditor` on `cycle.class.TypeCycleStatus`.

  🔴 WITHOUT THIS COMPONENT THE FIELD DOES NOT RENDER AT ALL. `AttributeBarEditor`
  (packages/presentation) wraps its ENTIRE body in `{#if editor}`, and `editor`
  comes from `getAttrEditor`, which reads `view.mixin.AttributeEditor` off the
  attribute's `attrClass`. A `classPresenter(...)` call that passes only a
  presenter therefore produces a status column that is invisible in `EditDoc`
  and in the Issue side panel — not a read-only one.

  The props below are exactly what `AttributeBarEditor` hands every attribute
  editor, which is why the state machine is enforceable HERE: the editor is
  given both the CURRENT value and the `onChange` callback, so it can decline to
  call it.

  🔴 Two gates, and the second one is the one that matters:
    1. `cycleStatusChoices` filters what the dropdown OFFERS — cosmetic.
    2. `resolveCycleStatusChange` re-checks the pick before `onChange` is called
       and drops it on the floor when illegal. A popup opened while the cycle
       was `planned` and answered after someone else cancelled it hits this gate
       with a stale `from` and is refused.

  🔴 `completed` IS NOT IN THE DROPDOWN, on purpose. `active -> completed` is a
  legal transition, but Technical Spec §4 defines reaching it as the
  `CompleteCycle` COMMAND, which also rolls issues over and records a snapshot.
  A bare status write here would produce a completed cycle whose open issues
  still hang off it and whose snapshot never exists — and nothing would ever
  finish the job, because the command refuses a cycle that is already
  `completed`. The "Complete cycle" action is the way there.
-->
<script lang="ts">
  import type { Cycle, CycleStatus } from '@hcengineering/cycle'
  import type { IntlString } from '@hcengineering/platform'
  import { DropdownLabelsIntl, type ButtonKind, type ButtonSize, type DropdownIntlItem } from '@hcengineering/ui'

  import cycle from '../plugin'
  import { cycleStatusChoices, resolveCycleStatusChange } from '../utils'

  export let value: CycleStatus | undefined = undefined
  export let onChange: ((value: CycleStatus) => void) | undefined = undefined
  // `AttributeBarEditor` passes `{object}` to every attribute editor it renders.
  // Unused for the write itself, but kept in the signature so the component can
  // be dropped anywhere an attribute editor is expected without a prop warning.
  export let object: Cycle | undefined = undefined
  export let readonly: boolean = false
  export let kind: ButtonKind = 'link'
  export let size: ButtonSize = 'large'
  export let width: string | undefined = '100%'
  export let justify: 'left' | 'center' = 'left'
  export let label: IntlString = cycle.string.Status

  // Display text never lives in the component: every status maps to an
  // IntlString served from `cycle-assets/lang/*.json`. That is also what keeps
  // the §3.9 split honest — `planned` is the stored value, "Planned" is only
  // ever a translation.
  const labels: Record<CycleStatus, IntlString> = {
    planned: cycle.string.StatusPlanned,
    active: cycle.string.StatusActive,
    completed: cycle.string.StatusCompleted,
    cancelled: cycle.string.StatusCancelled
  }

  $: items = cycleStatusChoices(value).map((status): DropdownIntlItem => ({ id: status, label: labels[status] }))

  // The dropdown writes its own pick into `selected` before the `selected` event
  // reaches us, so a refusal has to put it back explicitly — otherwise the
  // button would go on displaying a status the cycle was never moved to.
  let selected: DropdownIntlItem['id'] | undefined
  $: selected = value

  function handleSelected (picked: unknown): void {
    if (readonly || onChange === undefined) {
      selected = value
      return
    }
    const change = resolveCycleStatusChange(value, picked as CycleStatus)
    if (change.kind !== 'accepted') {
      if (change.kind === 'rejected') {
        console.warn('cycle: refused illegal cycle status transition', change.from, '->', change.to)
      }
      selected = value
      return
    }
    onChange(change.status)
  }
</script>

<DropdownLabelsIntl
  {items}
  {label}
  bind:selected
  disabled={readonly}
  {kind}
  {size}
  {width}
  {justify}
  shouldUpdateUndefined={false}
  on:selected={(e) => {
    handleSelected(e.detail)
  }}
/>
