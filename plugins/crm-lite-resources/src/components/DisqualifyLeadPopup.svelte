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
  Reason collection for `status -> Disqualified`.

  🔴 THIS DIALOG IS NOT THE ENFORCEMENT. `LeadGuardMiddleware` refuses a
  reasonless or illegal `Disqualified` write on EVERY path — the kanban drag in
  `KanbanView.getUpdateProps`, a script, a future view. What this dialog buys is
  that the user is asked for the reason up front instead of being shown a
  server error after the fact. Same division of labour as `ConvertLeadPopup`,
  where the state machine also lives on the server.

  🔴 STATUS AND REASON GO IN ONE TX. Two writes would be refused by the guard on
  the first of them (no reason yet), and the other order would leave a lead
  carrying a rejection note it was never rejected with.
-->
<script lang="ts">
  import type { Lead } from '@hcengineering/crm-lite'
  import { Card as CardDialog, getClient } from '@hcengineering/presentation'
  import { Button, Label, Spinner, TextArea } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'

  import crmLite from '../plugin'
  import { canDisqualifyLead, disqualifyLead, resolveDisqualifyIntent } from '../utils'

  export let value: Lead

  const dispatch = createEventDispatcher()
  const client = getClient()

  // `string | undefined` to match `TextArea.value`; the intent resolver is fed
  // the coalesced value so an untouched box is an empty reason, not a crash.
  let reason: string | undefined = value.disqualifyReason
  let failed = false
  let running = false

  $: allowed = canDisqualifyLead(value.status)
  $: intent = resolveDisqualifyIntent(value.status, reason ?? '')
  $: ready = allowed && intent.kind === 'ready' && !running

  /**
   * `PopupInstance.escapeClose` (packages/ui) asks the mounted component before
   * `Escape` or a click on the overlay tears the dialog down. Losing it while
   * the write is in flight would leave the user with neither the confirmation
   * nor the `DisqualifyFailed` line — i.e. believing a refused disqualification
   * went through. The header's close button deliberately still closes
   * unconditionally: abandoning the reason has to stay possible.
   */
  export function canClose (): boolean {
    return !running
  }

  async function save (): Promise<void> {
    if (intent.kind !== 'ready' || running) return
    running = true
    failed = false
    try {
      // `intent.reason` and NOT `reason`: the intent carries the TRIMMED value,
      // which is the one the server will accept.
      await disqualifyLead(client, value, intent.reason)
      dispatch('close')
    } catch (err: unknown) {
      // The guard throws; the platform turns that into a rejected promise here.
      // Rendered rather than swallowed, because the lead on screen still shows
      // its old status and the user would otherwise think the click worked.
      console.error('crm-lite: disqualifyLead was refused', err)
      failed = true
    } finally {
      running = false
    }
  }
</script>

<!--
  🔴 THE SUBMIT BUTTON IS IN THE BODY, NOT IN THE CARD'S FOOTER.
  `Card.handleOkClick` (packages/presentation/src/components/Card.svelte)
  dispatches `close` as soon as `okAction`'s promise RESOLVES, and `save`
  resolves on BOTH paths — it catches the guard's refusal and renders it rather
  than rethrowing. Wired to `okAction`, a refused disqualification closed the
  dialog exactly like a successful one: `DisqualifyFailed` was unreachable
  markup and the user was left believing a write that never happened.

  `canSave={false}` keeps `Enter` / `Ctrl+Enter` off the same path.
-->
<CardDialog
  label={crmLite.string.DisqualifyLead}
  okAction={() => {}}
  canSave={false}
  width={'small'}
  hideFooter
  on:close={() => {
    dispatch('close')
  }}
>
  <div class="disqualify-lead flex-col flex-gap-3">
    <div class="disqualify-lead__lead">{value.title}</div>

    {#if !allowed}
      <!-- `Converted` and `Disqualified` are terminal. The action is offered on
           every lead so that the explanation exists; hiding it would replace
           the explanation with silence. -->
      <div class="disqualify-lead__error"><Label label={crmLite.string.DisqualifyNotAllowed} /></div>
    {:else}
      <div class="disqualify-lead__hint"><Label label={crmLite.string.DisqualifyHint} /></div>
      <TextArea
        bind:value={reason}
        placeholder={crmLite.string.DisqualifyReasonPlaceholder}
        width={'100%'}
        height={'6rem'}
      />
      {#if failed}
        <div class="disqualify-lead__error"><Label label={crmLite.string.DisqualifyFailed} /></div>
      {/if}
      {#if running}
        <div class="disqualify-lead__spinner"><Spinner size={'small'} /></div>
      {/if}
      <div class="disqualify-lead__submit">
        <Button
          kind={'primary'}
          label={crmLite.string.Disqualify}
          loading={running}
          disabled={!ready}
          id={'disqualify-lead-submit'}
          on:click={() => {
            void save()
          }}
        />
      </div>
    {/if}
  </div>
</CardDialog>

<style lang="scss">
  .disqualify-lead__lead {
    font-weight: 500;
    color: var(--theme-caption-color);
  }
  .disqualify-lead__hint {
    font-size: 0.8125rem;
    color: var(--theme-dark-color);
  }
  .disqualify-lead__error {
    color: var(--theme-error-color);
  }
  .disqualify-lead__submit {
    display: flex;
    justify-content: flex-end;
  }
</style>
