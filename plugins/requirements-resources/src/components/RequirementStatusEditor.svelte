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
  `inlineEditor` of `view.mixin.AttributeEditor` on `requirements.class.TypeRequirementStatus`.

  The props below are exactly what `AttributeBarEditor` (packages/presentation)
  hands every attribute editor, which is why the state machine is enforceable
  HERE rather than only server side: the editor is given both the CURRENT value
  and the `onChange` callback, so it can decline to call it.

  🔴 Two gates, and the second one is the one that matters:
    1. `requirementStatusChoices` filters what the dropdown OFFERS — cosmetic.
    2. `resolveRequirementStatusChange` re-checks the pick before `onChange` is called
       and drops it on the floor when illegal. A popup opened while the requirement was
       in one status and answered after someone else moved it hits this gate
       with a stale `from` and is refused.
-->
<script lang="ts">
  import type { RequirementStatus } from '@hcengineering/requirements'
  import type { IntlString } from '@hcengineering/platform'
  import { DropdownLabelsIntl, type ButtonKind, type ButtonSize, type DropdownIntlItem } from '@hcengineering/ui'

  import requirements from '../plugin'
  import { requirementStatusChoices, resolveRequirementStatusChange } from '../utils'

  export let value: RequirementStatus | undefined = undefined
  export let onChange: ((value: RequirementStatus) => void) | undefined = undefined
  export let readonly: boolean = false
  export let kind: ButtonKind = 'link'
  export let size: ButtonSize = 'large'
  export let width: string | undefined = '100%'
  export let justify: 'left' | 'center' = 'left'
  export let label: IntlString = requirements.string.Status

  // Display text never lives in the component: every status maps to an
  // IntlString served from `requirements-assets/lang/*.json`.
  const labels: Record<RequirementStatus, IntlString> = {
    Draft: requirements.string.StatusDraft,
    Reviewing: requirements.string.StatusReviewing,
    Approved: requirements.string.StatusApproved,
    InDelivery: requirements.string.StatusInDelivery,
    Validating: requirements.string.StatusValidating,
    Released: requirements.string.StatusReleased,
    Rejected: requirements.string.StatusRejected,
    Cancelled: requirements.string.StatusCancelled
  }

  $: items = requirementStatusChoices(value).map((status): DropdownIntlItem => ({ id: status, label: labels[status] }))

  // The dropdown writes its own pick into `selected` before the `selected` event
  // reaches us, so a refusal has to put it back explicitly — otherwise the
  // button would go on displaying a status the requirement was never moved to.
  let selected: DropdownIntlItem['id'] | undefined
  $: selected = value

  function handleSelected (picked: unknown): void {
    if (readonly || onChange === undefined) {
      selected = value
      return
    }
    const change = resolveRequirementStatusChange(value, picked as RequirementStatus)
    if (change.kind !== 'accepted') {
      if (change.kind === 'rejected') {
        console.warn('requirements: refused illegal requirement status transition', change.from, '->', change.to)
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
