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
  `inlineEditor` of `view.mixin.AttributeEditor` on `crmLite.class.TypeLeadPriority`.

  ℹ️ Priority has NO state machine — it is a flat vocabulary, so every value is
  reachable from every other one and there is nothing to refuse. The asymmetry
  with `LeadStatusEditor` is deliberate; do not "harmonise" the two by inventing
  a priority transition table.
-->
<script lang="ts">
  import { leadPriorityOrder, type Lead, type LeadPriority } from '@hcengineering/crm-lite'
  import type { IntlString } from '@hcengineering/platform'
  import { DropdownLabelsIntl, type ButtonKind, type ButtonSize, type DropdownIntlItem } from '@hcengineering/ui'

  import crmLite from '../plugin'
  import { isLeadReadonly } from '../utils'

  export let value: LeadPriority | undefined = undefined
  export let onChange: ((value: LeadPriority) => void) | undefined = undefined
  // `AttributeBarEditor` hands `{object}` to every attribute editor, which is
  // the only way this component can know the lead's STATUS — priority carries
  // no state of its own.
  export let object: Lead | undefined = undefined
  export let readonly: boolean = false
  export let kind: ButtonKind = 'link'
  export let size: ButtonSize = 'large'
  export let width: string | undefined = '100%'
  export let justify: 'left' | 'center' = 'left'
  export let label: IntlString = crmLite.string.Priority

  const labels: Record<LeadPriority, IntlString> = {
    NoPriority: crmLite.string.PriorityNoPriority,
    Urgent: crmLite.string.PriorityUrgent,
    High: crmLite.string.PriorityHigh,
    Medium: crmLite.string.PriorityMedium,
    Low: crmLite.string.PriorityLow
  }

  const items: DropdownIntlItem[] = leadPriorityOrder.map((priority) => ({ id: priority, label: labels[priority] }))

  // Task 7: a converted lead is read only. Priority has no state machine to
  // express that through, so the lead's status has to say it — hence `object`.
  //
  // ⚠️ STRICTER THAN THE SERVER, DELIBERATELY. `LeadGuardMiddleware` guards
  // `status` and `disqualifyReason` and nothing else, so it would accept a
  // priority change on a converted lead. Withholding a gesture the server would
  // have allowed is the safe direction; the reverse is what puts an unexplained
  // platform error on screen.
  $: locked = readonly || isLeadReadonly(object?.status)

  let selected: DropdownIntlItem['id'] | undefined
  $: selected = value

  function handleSelected (picked: unknown): void {
    if (locked || onChange === undefined) {
      selected = value
      return
    }
    if (picked === value) return
    onChange(picked as LeadPriority)
  }
</script>

<DropdownLabelsIntl
  {items}
  {label}
  bind:selected
  disabled={locked}
  {kind}
  {size}
  {width}
  {justify}
  shouldUpdateUndefined={false}
  on:selected={(e) => {
    handleSelected(e.detail)
  }}
/>
