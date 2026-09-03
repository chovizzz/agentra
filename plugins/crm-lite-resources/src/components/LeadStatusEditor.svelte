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
  `inlineEditor` of `view.mixin.AttributeEditor` on `crmLite.class.TypeLeadStatus`.

  The props below are exactly what `AttributeBarEditor` (packages/presentation)
  hands every attribute editor, which is why the state machine is enforceable
  HERE rather than only server side: the editor is given both the CURRENT value
  and the `onChange` callback, so it can decline to call it.

  🔴 Two gates, and the second one is the one that matters:
    1. `leadStatusChoices` filters what the dropdown OFFERS — cosmetic.
    2. `resolveLeadStatusChange` re-checks the pick before `onChange` is called
       and drops it on the floor when illegal. A popup opened while the lead was
       in one status and answered after someone else moved it hits this gate
       with a stale `from` and is refused.

  ⚠️ NEITHER GATE IS THE ENFORCEMENT. `LeadGuardMiddleware`
  (`@hcengineering/server-crm-lite`) refuses illegal transitions on every write
  path, including the kanban drag this component cannot see. What lives here is
  the part the server cannot do: asking.

  🔴 `Converted` IS HANDED OFF TOO, and for a stricter reason than
  `Disqualified`: it is not merely missing a payload, it is UNWRITABLE. The
  transition table allows `Qualifying -> Converted`, but
  `LeadGuardMiddleware.enforceConversionEvidence` additionally demands an
  idempotency-ledger row that no transaction entering the pipeline can create,
  so a plain `{ status: 'Converted' }` write is refused with
  `converted-requires-command`. The pick therefore opens `ConvertLeadPopup`,
  which goes through the command instead — the same popup the
  `ConvertLeadToRequirement` action opens, so both routes share one idempotency
  key and converge on one Requirement.

  🔴 `Disqualified` IS HANDED OFF, NOT WRITTEN. It is a legal transition out of
  every non-terminal state, so it is legitimately in the dropdown — but it also
  REQUIRES a reason, which a dropdown cannot collect. Writing it bare would be
  refused by the server and the user would see an unexplained platform error on
  a pick the UI had just offered them. So the pick opens
  `DisqualifyLeadPopup` instead, and that popup writes status and reason in one
  transaction. Removing `Disqualified` from the state machine was the other
  option and is worse: it would make a legal status unreachable.
-->
<script lang="ts">
  import type { Lead, LeadStatus } from '@hcengineering/crm-lite'
  import type { IntlString } from '@hcengineering/platform'
  import {
    DropdownLabelsIntl,
    showPopup,
    type ButtonKind,
    type ButtonSize,
    type DropdownIntlItem
  } from '@hcengineering/ui'

  import ConvertLeadPopup from './ConvertLeadPopup.svelte'
  import DisqualifyLeadPopup from './DisqualifyLeadPopup.svelte'
  import crmLite from '../plugin'
  import { isLeadReadonly, leadStatusChoices, requiresConversionCommand, resolveLeadStatusChange } from '../utils'

  export let value: LeadStatus | undefined = undefined
  export let onChange: ((value: LeadStatus) => void) | undefined = undefined
  // `AttributeBarEditor` passes `{object}` to every attribute editor it renders,
  // which is what makes the hand-off below possible: the reason popup needs the
  // whole Lead (`_class`, `space`, `_id`), not just the status value.
  export let object: Lead | undefined = undefined
  export let readonly: boolean = false
  export let kind: ButtonKind = 'link'
  export let size: ButtonSize = 'large'
  export let width: string | undefined = '100%'
  export let justify: 'left' | 'center' = 'left'
  export let label: IntlString = crmLite.string.Status

  // Display text never lives in the component: every status maps to an
  // IntlString served from `crm-lite-assets/lang/*.json`.
  const labels: Record<LeadStatus, IntlString> = {
    New: crmLite.string.StatusNew,
    Contacted: crmLite.string.StatusContacted,
    Qualifying: crmLite.string.StatusQualifying,
    Converted: crmLite.string.StatusConverted,
    Disqualified: crmLite.string.StatusDisqualified
  }

  $: items = leadStatusChoices(value).map((status): DropdownIntlItem => ({ id: status, label: labels[status] }))

  // A converted lead is closed: the transition table gives it no legal target
  // anyway, so disabling the control states that fact instead of leaving a live
  // dropdown whose every pick would be refused.
  $: locked = readonly || isLeadReadonly(value)

  // The dropdown writes its own pick into `selected` before the `selected` event
  // reaches us, so a refusal has to put it back explicitly — otherwise the
  // button would go on displaying a status the lead was never moved to.
  let selected: DropdownIntlItem['id'] | undefined
  $: selected = value

  function handleSelected (picked: unknown): void {
    if (locked || onChange === undefined) {
      selected = value
      return
    }
    if (requiresConversionCommand(picked as LeadStatus)) {
      // Always put the dropdown back: the status moves only if the command
      // succeeds, and it is the lead's own reactive value that must move the
      // button — never this click.
      selected = value
      if (object === undefined) {
        console.warn('crm-lite: cannot run the conversion command without the lead document')
        return
      }
      showPopup(ConvertLeadPopup, { value: object }, 'top')
      return
    }
    if (picked === 'Disqualified') {
      // Always put the dropdown back first: the write, if it happens at all,
      // happens in the popup, and the lead's own reactive value is what should
      // move the button — not this click.
      selected = value
      if (object === undefined) {
        // No document to write to (a draft form, or a host that does not pass
        // `object`). Writing a reasonless `Disqualified` would be refused by the
        // server anyway, so refuse here where the cause is knowable.
        console.warn('crm-lite: cannot collect a disqualification reason without the lead document')
        return
      }
      showPopup(DisqualifyLeadPopup, { value: object }, 'top')
      return
    }
    const change = resolveLeadStatusChange(value, picked as LeadStatus)
    if (change.kind !== 'accepted') {
      if (change.kind === 'rejected') {
        console.warn('crm-lite: refused illegal lead status transition', change.from, '->', change.to)
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
