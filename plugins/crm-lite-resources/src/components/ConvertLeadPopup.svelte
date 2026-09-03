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
  🔴 The three server reply families are rendered as three DIFFERENT states, and
  that is the CRM-T006 acceptance point:

    409  -> `in-progress`, retryable, the Convert button stays enabled;
    400  -> `refused`,     not retryable, the button is withdrawn and the
                           specific `reason` is explained;
    ok   -> `converted` or `replayed`; `replayed` never says "converted", it
                           offers the requirement that already exists (CRM-T005).

  A fourth state, `unavailable`, covers "no handler / unreadable reply". It is
  reported as such rather than folded into either failure, because this client
  cannot tell whether anything happened, and must not imply that it did not.
-->
<script lang="ts">
  import card, { type Card } from '@hcengineering/card'
  import type { Doc, Ref } from '@hcengineering/core'
  import type { Lead } from '@hcengineering/crm-lite'
  import { Card as CardDialog, getClient } from '@hcengineering/presentation'
  import { Button, Label, Spinner, navigate } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import { getObjectLinkFragment } from '@hcengineering/view-resources'
  import { createEventDispatcher } from 'svelte'

  import crmLite from '../plugin'
  import {
    convertLeadIdempotencyKey,
    convertLeadReasonLabel,
    convertLeadToRequirement,
    type ConvertLeadOutcome
  } from '../utils'

  export let value: Lead

  const dispatch = createEventDispatcher()
  const client = getClient()

  // 🔴 Derived from the lead, so it is the SAME key for every click, for a
  // re-opened dialog, for a reload mid-flight and for a second tab. See
  // `convertLeadIdempotencyKey` for why a per-click `generateId()` would make
  // the server's idempotency ledger unreachable. `$:` rather than a const only
  // so that a recycled popup instance re-derives it if `value` is swapped.
  $: idempotencyKey = convertLeadIdempotencyKey(value._id)

  let running = false
  let outcome: ConvertLeadOutcome | undefined = undefined

  async function convert (): Promise<void> {
    if (running) return
    running = true
    try {
      outcome = await convertLeadToRequirement(client, {
        lead: value._id,
        idempotencyKey,
        // Carried through so the new Requirement inherits the lead's owner. The
        // server treats every one of these as optional.
        ...(value.owner !== undefined ? { owner: value.owner as Ref<Doc> } : {})
      })
    } finally {
      running = false
    }
  }

  async function openRequirement (requirement: Ref<Doc>): Promise<void> {
    const doc = await client.findOne(card.class.Card, { _id: requirement as Ref<Card> })
    if (doc === undefined) return
    const hierarchy = client.getHierarchy()
    const panel = hierarchy.classHierarchyMixin(doc._class, view.mixin.ObjectPanel)
    const loc = await getObjectLinkFragment(hierarchy, doc, {}, panel?.component ?? view.component.EditDoc)
    dispatch('close')
    navigate(loc)
  }

  // The button is offered again only while repeating the call could produce a
  // different answer: before the first attempt, and after a 409.
  $: canRetry = outcome === undefined || outcome.retryable

  /**
   * `PopupInstance.escapeClose` (packages/ui) asks the mounted component before
   * it tears the dialog down, and BOTH accidental dismissals — `Escape` and a
   * click on the overlay — go through it. Refusing while the request is in
   * flight keeps the four outcome states reachable: a dialog that vanished
   * mid-call leaves the user with no idea whether the lead was converted, and
   * the `replayed` branch — the one that hands back the requirement that
   * already exists — is precisely what they would lose. The header's close
   * button bypasses this hook, which is correct: abandoning the attempt has to
   * stay possible, it just must not happen by accident.
   */
  export function canClose (): boolean {
    return !running
  }
</script>

<!--
  🔴 THE CONVERT BUTTON IS IN THE BODY, NOT IN THE CARD'S FOOTER.
  `Card.handleOkClick` (packages/presentation/src/components/Card.svelte)
  dispatches `close` as soon as `okAction`'s promise RESOLVES — success and
  failure alike — and `convertLeadToRequirement` resolves on every path,
  because it turns refusals and transport errors into an outcome rather than
  throwing. Wired to `okAction`, the dialog therefore tore itself down the
  instant the call came back, and EVERY state this component renders — the 409
  "retry", the 400 reason, the `replayed` link to the requirement that already
  exists, even the success message — was unreachable dead markup.

  `canSave={false}` keeps the same accident off the keyboard: `Enter` and
  `Ctrl+Enter` both route through `handleOkClick`, which does nothing unless
  `canSave` is set.
-->
<CardDialog
  label={crmLite.string.ConvertToRequirement}
  okAction={() => {}}
  canSave={false}
  width={'small'}
  hideFooter
  on:close={() => {
    dispatch('close')
  }}
>
  <div class="convert-lead flex-col flex-gap-3">
    <div class="convert-lead__lead">{value.title}</div>

    {#if outcome === undefined}
      <div class="convert-lead__hint"><Label label={crmLite.string.ConvertLeadHint} /></div>
    {:else if outcome.kind === 'converted' || outcome.kind === 'replayed'}
      <!-- Bound out of the union here: inside a closure `outcome` is a mutable
           `let` and the narrowing would be lost. -->
      {@const requirement = outcome.requirement}
      <div class="convert-lead__ok">
        <Label label={outcome.kind === 'replayed' ? crmLite.string.ConvertReplayed : crmLite.string.ConvertSucceeded} />
      </div>
      <Button
        kind={'primary'}
        label={crmLite.string.OpenRequirement}
        on:click={() => {
          void openRequirement(requirement)
        }}
      />
    {:else if outcome.kind === 'in-progress'}
      <!-- 409: the result does not exist YET. Retrying is the correct advice. -->
      <div class="convert-lead__wait"><Label label={crmLite.string.ConvertInProgress} /></div>
    {:else if outcome.kind === 'refused'}
      <!-- 400: repeating changes nothing, so say what has to change instead. -->
      <div class="convert-lead__error"><Label label={crmLite.string.ConvertRefused} /></div>
      <div class="convert-lead__reason"><Label label={convertLeadReasonLabel(outcome.reason)} /></div>
    {:else if outcome.kind === 'errored'}
      <!-- The server rethrew. It may have half-run, so this must NOT say
           "nothing was changed". -->
      <div class="convert-lead__error"><Label label={crmLite.string.ConvertErrored} /></div>
    {:else}
      <div class="convert-lead__error"><Label label={crmLite.string.ConvertUnavailable} /></div>
    {/if}

    {#if running}
      <div class="convert-lead__spinner"><Spinner size={'small'} /></div>
    {/if}

    {#if canRetry}
      <div class="convert-lead__submit">
        <Button
          kind={'primary'}
          label={crmLite.string.Convert}
          loading={running}
          disabled={running}
          id={'convert-lead-submit'}
          on:click={() => {
            void convert()
          }}
        />
      </div>
    {/if}
  </div>
</CardDialog>

<style lang="scss">
  .convert-lead__lead {
    font-weight: 500;
    color: var(--theme-caption-color);
  }
  .convert-lead__hint,
  .convert-lead__reason {
    font-size: 0.8125rem;
    color: var(--theme-dark-color);
  }
  .convert-lead__ok {
    color: var(--theme-caption-color);
  }
  .convert-lead__wait {
    color: var(--theme-warning-color);
  }
  .convert-lead__error {
    color: var(--theme-error-color);
  }
  .convert-lead__submit {
    display: flex;
    justify-content: flex-end;
  }
</style>
