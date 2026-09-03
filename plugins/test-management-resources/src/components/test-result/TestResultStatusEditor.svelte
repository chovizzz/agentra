<!--
// Copyright © 2024 Hardcore Engineering Inc.
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
<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { Data } from '@hcengineering/core'
  import { TestResult, TestRunStatus } from '@hcengineering/test-management'
  import { getClient } from '@hcengineering/presentation'
  import {
    Button,
    ButtonKind,
    ButtonSize,
    Icon,
    SelectPopup,
    eventToHTMLElement,
    showPopup,
    Label
  } from '@hcengineering/ui'

  import { EditBoxPopup } from '@hcengineering/view-resources'

  import { defaultTestRunStatuses, testRunStatusAssets } from '../../types'
  import testManagement from '../../plugin'

  export let value: TestResult['status'] | undefined
  export let object: TestResult | Data<TestResult>
  export let kind: ButtonKind = 'link'
  export let size: ButtonSize = 'large'
  export let justify: 'left' | 'center' = 'left'
  export let width: string | undefined = undefined
  export let disabled = false
  export let shouldShowAvatar: boolean = true
  export let accent: boolean = false

  const dispatch = createEventDispatcher()
  const client = getClient()

  $: itemsInfo = defaultTestRunStatuses.map((status) => ({
    id: status,
    isSelected: value === status,
    ...testRunStatusAssets[status]
  }))

  function handlePopupOpen (event: MouseEvent): void {
    showPopup(
      SelectPopup,
      { value: itemsInfo, placeholder: testManagement.string.SetStatus },
      eventToHTMLElement(event),
      changeStatus
    )
  }

  async function changeStatus (newStatus: TestResult['status'] | null | undefined): Promise<void> {
    if (disabled || newStatus == null || value === newStatus) {
      return
    }

    // 🔴 A Blocked result MUST say why. The server refuses the write outright
    // (`BlockedReasonGuardMiddleware`), so without this prompt the pick would
    // just throw and the status would silently snap back. Asking here is the
    // convenience; the guard is the rule.
    //
    // ⚠️ The reason already on the object counts — re-blocking a result that
    // was blocked before does not have to be re-justified.
    if (newStatus === TestRunStatus.Blocked && !hasBlockedReason(object)) {
      askBlockedReason(newStatus)
      return
    }

    value = newStatus
    dispatch('change', value)

    if (object !== undefined && '_id' in object) {
      await client.update(object, { status: newStatus })
    }
  }

  function hasBlockedReason (it: TestResult | Data<TestResult>): boolean {
    const reason = (it as Partial<TestResult>)?.blockedReason
    return typeof reason === 'string' && reason.trim().length > 0
  }

  function askBlockedReason (newStatus: TestResult['status']): void {
    showPopup(EditBoxPopup, { value: '', format: 'text' }, undefined, (reason) => {
      const trimmed = typeof reason === 'string' ? reason.trim() : ''
      if (trimmed === '') {
        // Cancelled, or an empty reason — either way the status does NOT move.
        // Writing it anyway would produce the record the guard forbids and the
        // user would see the change vanish on the next refresh.
        return
      }
      void applyBlocked(newStatus, trimmed)
    })
  }

  async function applyBlocked (newStatus: TestResult['status'], reason: string): Promise<void> {
    value = newStatus
    dispatch('change', value)
    if (object !== undefined && '_id' in object) {
      // ONE transaction: the guard evaluates the status and the reason together,
      // so writing them separately would be refused on the first half.
      await client.update(object, { status: newStatus, blockedReason: reason })
    }
  }

  $: icon = value === undefined ? testManagement.icon.StatusNonTested : testRunStatusAssets[value].icon
  $: label = value === undefined ? testManagement.string.StatusNonTested : testRunStatusAssets[value].label
</script>

{#if kind === 'list'}
  <button
    class="flex-no-shrink clear-mins cursor-pointer content-pointer-events-none"
    {disabled}
    on:click={handlePopupOpen}
  >
    <Icon {icon} {size} />
  </button>
{:else if kind === 'list-header'}
  <div class="flex-row-center pl-0-5">
    {#if shouldShowAvatar}
      <Icon {icon} {size} />
    {/if}
    <span class="overflow-label" class:ml-1-5={shouldShowAvatar} class:fs-bold={accent}><Label {label} /></span>
  </div>
{:else}
  <Button
    {label}
    {kind}
    {icon}
    {justify}
    {size}
    {width}
    {disabled}
    showTooltip={{ label: testManagement.string.SetStatus }}
    on:click={handlePopupOpen}
  />
{/if}
