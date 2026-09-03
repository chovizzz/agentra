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
  `inlineEditor` of `view.mixin.AttributeEditor` on `requirements.class.TypeRequirementPriority`.

  ℹ️ Priority has NO state machine — it is a flat vocabulary, so every value is
  reachable from every other one and there is nothing to refuse. The asymmetry
  with `RequirementStatusEditor` is deliberate; do not "harmonise" the two by inventing
  a priority transition table.
-->
<script lang="ts">
  import { requirementPriorityOrder, type RequirementPriority } from '@hcengineering/requirements'
  import type { IntlString } from '@hcengineering/platform'
  import { DropdownLabelsIntl, type ButtonKind, type ButtonSize, type DropdownIntlItem } from '@hcengineering/ui'

  import requirements from '../plugin'

  export let value: RequirementPriority | undefined = undefined
  export let onChange: ((value: RequirementPriority) => void) | undefined = undefined
  export let readonly: boolean = false
  export let kind: ButtonKind = 'link'
  export let size: ButtonSize = 'large'
  export let width: string | undefined = '100%'
  export let justify: 'left' | 'center' = 'left'
  export let label: IntlString = requirements.string.Priority

  const labels: Record<RequirementPriority, IntlString> = {
    NoPriority: requirements.string.PriorityNoPriority,
    Urgent: requirements.string.PriorityUrgent,
    High: requirements.string.PriorityHigh,
    Medium: requirements.string.PriorityMedium,
    Low: requirements.string.PriorityLow
  }

  const items: DropdownIntlItem[] = requirementPriorityOrder.map((priority) => ({
    id: priority,
    label: labels[priority]
  }))

  let selected: DropdownIntlItem['id'] | undefined
  $: selected = value

  function handleSelected (picked: unknown): void {
    if (readonly || onChange === undefined) {
      selected = value
      return
    }
    if (picked === value) return
    onChange(picked as RequirementPriority)
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
