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
  The client half of the `CompleteCycle` command (Technical Spec §4).

  🔴 THIS DIALOG IS NOT THE ENFORCEMENT. The command re-reads the cycle, checks
  `canTransitionCycle`, validates the rollover target and refuses anything
  illegal. What lives here is the part the server cannot do: ASKING which
  rollover policy the closer wants, and RENDERING the five outcome families
  apart from one another — "already running, retry" is not the same message as
  "this cycle cannot be completed", and "operation failed" is an acceptable
  rendering of neither.

  🔴 THE ROLLOVER TARGET IS RESOLVED HERE AND SHIPPED IN THE REQUEST. The server
  deliberately does NOT pick "the next cycle" itself: a cycle created between a
  crashed attempt and its replay would change the answer, and the two halves of
  one rollover would land in different cycles. `nextCycleAfter` picks the
  default, the user may override it, and the server only validates.
-->
<script lang="ts">
  import {
    isTerminalCycleStatus,
    nextCycleAfter,
    compareCycleOrder,
    type Cycle,
    type CycleRolloverPolicy
  } from '@hcengineering/cycle'
  import type { Ref } from '@hcengineering/core'
  import { getEmbeddedLabel, type IntlString } from '@hcengineering/platform'
  import { Card as CardDialog, createQuery, getClient } from '@hcengineering/presentation'
  import { Button, DropdownLabelsIntl, Label, Loading, type DropdownIntlItem } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'

  import cyclePlugin from '../plugin'
  import {
    completeCycle,
    completeCycleIdempotencyKey,
    completeCycleReasonLabel,
    type CompleteCycleOutcome
  } from '../utils'

  export let value: Cycle

  const dispatch = createEventDispatcher()
  const client = getClient()

  const policyLabels: Record<CycleRolloverPolicy, IntlString> = {
    keep: cyclePlugin.string.RolloverKeep,
    backlog: cyclePlugin.string.RolloverBacklog,
    move: cyclePlugin.string.RolloverMove
  }

  const query = createQuery()
  let cycles: Cycle[] = []
  $: query.query(cyclePlugin.class.Cycle, { space: value.space }, (res) => {
    cycles = [...res].sort(compareCycleOrder)
  })

  $: suggested = nextCycleAfter(cycles, value)
  // Only non-terminal, strictly-later cycles are legitimate destinations; the
  // server refuses everything else, so offering more would only manufacture a
  // refusal the user cannot act on.
  $: targets = cycles.filter(
    (it) => it._id !== value._id && !isTerminalCycleStatus(it.status) && compareCycleOrder(it, value) > 0
  )

  let policy: CycleRolloverPolicy = 'keep'
  let target: Ref<Cycle> | undefined
  // Re-arms only while the user has not chosen: an explicit pick must survive
  // the query re-firing.
  $: if (target === undefined) target = suggested?._id

  $: policyItems = (['keep', 'backlog', 'move'] as CycleRolloverPolicy[]).map(
    (it): DropdownIntlItem => ({ id: it, label: policyLabels[it] })
  )
  // `getEmbeddedLabel` turns a runtime string into an IntlString the intl
  // dropdown renders verbatim — a cycle's NAME is user data and has no
  // translation key.
  $: targetItems = targets.map((it): DropdownIntlItem => ({ id: it._id, label: getEmbeddedLabel(it.name) }))

  let running = false
  let outcome: CompleteCycleOutcome | undefined

  $: needsTarget = policy === 'move'
  $: ready = !running && outcome === undefined && (!needsTarget || target !== undefined)

  /**
   * `PopupInstance.escapeClose` (packages/ui) asks the mounted component before
   * `Escape` or a click on the overlay tears the dialog down.
   *
   * 🔴 REFUSING WHILE THE CALL IS IN FLIGHT IS NOT POLITENESS. `completeCycle`
   * moves issues one at a time and rolls nothing back, so a dialog lost
   * mid-call takes with it the only report of what actually happened — the
   * snapshot counts, the `in-progress` retry advice, and the `errored` warning
   * that the cycle may have partially changed. The header's close button still
   * closes unconditionally: abandoning the attempt has to stay possible, it
   * just must not happen by accident.
   */
  export function canClose (): boolean {
    return !running
  }

  async function run (): Promise<void> {
    if (running) return
    running = true
    try {
      outcome = await completeCycle(client, {
        cycle: value._id,
        // 🔴 Derived from the CYCLE, not from the click. `completed` is
        // terminal, so "complete this cycle" is a once-per-cycle intent and a
        // per-click key would make every retry a fresh execution.
        idempotencyKey: completeCycleIdempotencyKey(value._id),
        rolloverPolicy: policy,
        ...(needsTarget && target !== undefined ? { rolloverTarget: target } : {})
      })
    } finally {
      running = false
    }
  }
</script>

<!--
  🔴 THE COMPLETE BUTTON IS IN THE BODY, NOT IN THE CARD'S FOOTER.
  `Card.handleOkClick` (packages/presentation/src/components/Card.svelte)
  dispatches `close` the moment `okAction`'s promise RESOLVES — success and
  failure alike — and `completeCycle` resolves on every path, because it
  envelopes refusals and transport errors as an outcome instead of throwing.
  Wired to `okAction`, the dialog tore itself down as soon as the call came
  back, which made every branch below unreachable: the snapshot counts, the
  409 "already being completed, retry", the refusal reason, and the `errored`
  line warning that the cycle may have partially changed. `hideFooter={outcome
  !== undefined}` could never fire either — the outcome was never on screen.

  `canSave={false}` keeps `Enter` / `Ctrl+Enter` off the same path.
-->
<CardDialog
  label={cyclePlugin.string.CompleteCycle}
  okAction={() => {}}
  canSave={false}
  width={'medium'}
  hideFooter
  on:close={() => {
    dispatch('close')
  }}
>
  <div class="complete-cycle flex-col flex-gap-3">
    <div class="complete-cycle__name">{value.name}</div>

    {#if running}
      <Loading />
    {:else if outcome === undefined}
      <div class="complete-cycle__hint"><Label label={cyclePlugin.string.CompleteCycleHint} /></div>

      <DropdownLabelsIntl
        items={policyItems}
        label={cyclePlugin.string.RolloverPolicy}
        kind={'regular'}
        size={'medium'}
        width={'100%'}
        justify={'left'}
        selected={policy}
        on:selected={(e) => {
          policy = e.detail
        }}
      />

      {#if needsTarget}
        {#if targetItems.length === 0}
          <div class="complete-cycle__error"><Label label={cyclePlugin.string.NoNextCycle} /></div>
        {:else}
          <DropdownLabelsIntl
            items={targetItems}
            label={cyclePlugin.string.RolloverTarget}
            kind={'regular'}
            size={'medium'}
            width={'100%'}
            justify={'left'}
            selected={target}
            on:selected={(e) => {
              target = e.detail
            }}
          />
        {/if}
      {/if}
    {:else if outcome.kind === 'completed' || outcome.kind === 'replayed'}
      <div class="complete-cycle__ok">
        <Label
          label={outcome.kind === 'replayed'
            ? cyclePlugin.string.CycleAlreadyCompleted
            : cyclePlugin.string.CycleCompleted}
        />
      </div>
      <div class="complete-cycle__stats flex-col flex-gap-1">
        <div><Label label={cyclePlugin.string.TotalIssues} />: {outcome.snapshot.total}</div>
        <div><Label label={cyclePlugin.string.DoneIssues} />: {outcome.snapshot.done}</div>
        <div><Label label={cyclePlugin.string.OpenIssues} />: {outcome.snapshot.open}</div>
        <div><Label label={cyclePlugin.string.RolledOverIssues} />: {outcome.snapshot.rolledOver}</div>
      </div>
    {:else if outcome.kind === 'in-progress'}
      <!-- Retryable: the result does not exist YET. Distinguishing it from a
           refusal is the whole reason the server envelopes failures instead of
           throwing them. -->
      <div class="complete-cycle__error"><Label label={cyclePlugin.string.CompleteCycleInProgress} /></div>
    {:else if outcome.kind === 'refused'}
      <div class="complete-cycle__error"><Label label={completeCycleReasonLabel(outcome.reason)} /></div>
    {:else if outcome.kind === 'unavailable'}
      <!-- The ONE case where "nothing happened" may be stated: an unrouted
           domain request never reached the command at all. -->
      <div class="complete-cycle__error"><Label label={cyclePlugin.string.CompleteCycleUnavailable} /></div>
    {:else}
      <!-- The call THREW. Unlike `unavailable`, the body may have run and
           partially completed, so this must not claim otherwise. -->
      <div class="complete-cycle__error"><Label label={cyclePlugin.string.CompleteCycleErrored} /></div>
    {/if}

    <!-- Withdrawn once an outcome is on screen: `completed` / `replayed` are
         terminal, and neither a 400 refusal nor an `errored` cycle gets better
         by being asked again from a dialog whose form is no longer rendered.
         A 409 is the one retryable case, and it is reached by re-opening — the
         idempotency key is derived from the cycle, so that is the same key. -->
    {#if outcome === undefined}
      <div class="complete-cycle__submit">
        <Button
          kind={'primary'}
          label={cyclePlugin.string.Complete}
          loading={running}
          disabled={!ready}
          id={'complete-cycle-submit'}
          on:click={() => {
            void run()
          }}
        />
      </div>
    {/if}
  </div>
</CardDialog>

<style lang="scss">
  .complete-cycle__name {
    font-weight: 500;
    color: var(--theme-caption-color);
  }
  .complete-cycle__hint {
    font-size: 0.8125rem;
    color: var(--theme-dark-color);
  }
  .complete-cycle__ok {
    color: var(--theme-caption-color);
    font-weight: 500;
  }
  .complete-cycle__error {
    color: var(--theme-error-color);
  }
  .complete-cycle__submit {
    display: flex;
    justify-content: flex-end;
  }
</style>
