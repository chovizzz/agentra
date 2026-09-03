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
  `inlineEditor` of `view.mixin.AttributeEditor` on `cycle.class.Cycle`.

  🔴 THE MIXIN GOES ON THE TARGET CLASS, NOT ON `cycle.mixin.CycleIssue`. The
  attribute being edited is `CycleIssue.cycle`, a `RefTo(Cycle)`, and
  `getAttributePresenterClass` rewrites a `RefTo`'s `attrClass` to `type.to`
  before `getAttrEditor` looks the editor mixin up. Registering the editor on
  the mixin that OWNS the attribute would never be found — exactly the same
  resolution rule that already forced `AttributePresenter` and `AttributeFilter`
  onto `cycle.class.Cycle`.

  🔴 WITHOUT IT THE FIELD DOES NOT RENDER. `AttributeBarEditor` wraps its whole
  body in `{#if editor}`, so an Issue's `cycle` field was invisible rather than
  read-only.

  ⚠️ `space` is the ISSUE's space, and a Cycle lives in the tracker Project its
  issues live in — so filtering the candidate list by `space` is not a
  convenience, it is what keeps a cycle from another project out of the picker.
  With no space the query is left open rather than silently empty, because an
  empty picker with no explanation is the worse failure.
-->
<script lang="ts">
  import { compareCycleOrder, isTerminalCycleStatus, type Cycle, type CycleStatus } from '@hcengineering/cycle'
  import type { Ref, Space } from '@hcengineering/core'
  import type { IntlString } from '@hcengineering/platform'
  import { createQuery } from '@hcengineering/presentation'
  import {
    Button,
    Icon,
    Label,
    SelectPopup,
    eventToHTMLElement,
    showPopup,
    type ButtonKind,
    type ButtonSize,
    type PopupResult
  } from '@hcengineering/ui'

  import cyclePlugin from '../plugin'

  export let value: Ref<Cycle> | null | undefined = undefined
  export let onChange: ((value: Ref<Cycle> | null) => void) | undefined = undefined
  export let space: Ref<Space> | undefined = undefined
  export let readonly: boolean = false
  export let kind: ButtonKind = 'link'
  export let size: ButtonSize = 'large'
  export let width: string | undefined = '100%'
  export let justify: 'left' | 'center' = 'left'
  export let label: IntlString = cyclePlugin.string.Cycle

  const statusLabels: Record<CycleStatus, IntlString> = {
    planned: cyclePlugin.string.StatusPlanned,
    active: cyclePlugin.string.StatusActive,
    completed: cyclePlugin.string.StatusCompleted,
    cancelled: cyclePlugin.string.StatusCancelled
  }

  const query = createQuery()
  let cycles: Cycle[] = []
  // `Cycle.space` is narrowed to `Ref<Project>`; `AttributeBarEditor` passes the
  // host document's generic `Ref<Space>`. Cycles and issues share the project
  // space by design (§3.4), so the narrowing holds wherever this editor is used.
  $: query.query(cyclePlugin.class.Cycle, space !== undefined ? { space: space as Cycle['space'] } : {}, (res) => {
    cycles = [...res].sort(compareCycleOrder)
  })

  $: selected = value != null ? cycles.find((it) => it._id === value) : undefined

  // ⚠️ A terminal cycle stays in the list ONLY while it is the current value.
  // Offering `completed` / `cancelled` cycles as destinations would let an
  // issue be filed into a cycle that is already closed, which is precisely what
  // `CompleteCycle`'s rollover exists to prevent; keeping the current one
  // visible is what stops the button from going blank on an already-closed
  // cycle.
  $: items = [
    {
      id: null,
      icon: cyclePlugin.icon.Cycle,
      label: cyclePlugin.string.NoCycle,
      isSelected: value == null
    },
    ...cycles
      .filter((it) => !isTerminalCycleStatus(it.status) || it._id === value)
      .map((it) => ({
        id: it._id,
        icon: cyclePlugin.icon.Cycle,
        text: it.name,
        isSelected: it._id === value,
        category: statusLabels[it.status]
      }))
  ]

  let popup: PopupResult | undefined
  $: popup?.update({ value: items })

  function open (event: MouseEvent): void {
    event.stopPropagation()
    if (readonly || onChange === undefined) return
    popup = showPopup(
      SelectPopup,
      { value: items, placeholder: cyclePlugin.string.SelectCycle, searchable: true },
      eventToHTMLElement(event),
      (picked) => {
        popup = undefined
        // `SelectPopup` reports a dismissal as `undefined` and the explicit
        // "No cycle" row as `null`. Collapsing the two would clear the field
        // every time the user pressed Escape.
        if (picked === undefined) return
        onChange?.(picked === null ? null : (picked as Ref<Cycle>))
      }
    )
  }
</script>

<Button {kind} {size} {width} {justify} disabled={readonly} on:click={open}>
  <svelte:fragment slot="content">
    <div class="flex-row-center flex-gap-1 overflow-label">
      <Icon icon={cyclePlugin.icon.Cycle} size={'small'} />
      {#if selected !== undefined}
        <span class="overflow-label">{selected.name}</span>
      {:else}
        <span class="overflow-label content-dark-color"><Label label={cyclePlugin.string.NoCycle} /></span>
      {/if}
    </div>
  </svelte:fragment>
</Button>
