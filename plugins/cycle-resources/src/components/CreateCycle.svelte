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
  `createComponent` of the Tracker navigation special. `SpecialView.showCreateDialog`
  calls `showPopup(createComponent, { ...createComponentProps, space })`, so
  `space` is the tracker Project currently open in the navigator — which is
  exactly the space a Cycle must live in (§3.4: a Cycle's space IS the Project
  its issues live in, so cycle visibility is issue visibility).

  ⚠️ `sequence` IS ASSIGNED HERE, not by the server. It is the per-project
  ordinal that makes "Cycle 7" stable and human referable, and it is also the
  primary key of `compareCycleOrder`, i.e. of what `nextCycleAfter` calls "the
  next cycle". Leaving it at 0 would make every cycle in a project tie and push
  the rollover default onto the `startDate` fallback.

  ⚠️ It is read-then-write with no claim, so two people creating a cycle in the
  same project at the same second can both land on the same number. That is a
  cosmetic collision, not a correctness one: `compareCycleOrder` breaks the tie
  on `startDate` and then on `_id`, so the order stays total either way.
-->
<script lang="ts">
  import type { Cycle } from '@hcengineering/cycle'
  import { DateRangeMode, type Ref, type Space } from '@hcengineering/core'
  import type { IntlString } from '@hcengineering/platform'
  import { Card as CardDialog, createQuery, getClient } from '@hcengineering/presentation'
  import { DatePresenter, EditBox, Label } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'

  import cyclePlugin from '../plugin'

  export let space: Ref<Space>

  const dispatch = createEventDispatcher()
  const client = getClient()

  const DAY = 24 * 60 * 60 * 1000

  let name: string = ''
  let startDate: number | null = Date.now()
  let endDate: number | null = Date.now() + 14 * DAY

  const query = createQuery()
  let existing: Cycle[] = []
  // `Cycle.space` is narrowed to `Ref<Project>`; the navigator hands us the
  // generic `Ref<Space>` it holds. The narrowing is the model's assertion about
  // WHICH spaces are valid, not a runtime check this component can perform.
  $: query.query(cyclePlugin.class.Cycle, { space: space as Cycle['space'] }, (res) => {
    existing = res
  })

  $: nextSequence = existing.reduce((max, it) => Math.max(max, it.sequence ?? 0), 0) + 1

  // `endDate` before `startDate` is refused rather than silently swapped: the
  // pair is what a burndown is computed against, and a silently reordered range
  // is a range the user never asked for.
  let running = false

  $: canSave = name.trim().length > 0 && startDate != null && endDate != null && endDate >= startDate && !running

  /**
   * `PopupInstance.escapeClose` asks the mounted component before `Escape` or a
   * click on the overlay tears the dialog down.
   *
   * ⚠️ THIS DIALOG NEEDS NO IDEMPOTENCY KEY — it is a plain create, a failed
   * one writes nothing, and re-opening it to create a cycle is the user's own
   * intent, not a duplicate. The single window worth closing is the one where
   * the dialog is DISMISSED WHILE THE CREATE IS STILL IN FLIGHT: `createDoc` is
   * not cancelled by the popup going away, so the user who re-opens and submits
   * again ends up with two cycles for one intent. Refusing the accidental
   * dismissals (never the header's close button) is enough to shut that window,
   * because the deliberate abandon leaves no attempt running behind it.
   */
  export function canClose (): boolean {
    return !running
  }

  /**
   * The failure message, rendered inside the dialog rather than raised as a
   * toast: the dialog is still standing with what the user typed, so the
   * explanation belongs next to the button that just failed.
   */
  let error: IntlString | undefined = undefined

  /**
   * 🔴 ONE SHOT, AND IT IS WHAT KEEPS THE DIALOG STANDING AFTER A FAILURE.
   *
   * `Card.handleOkClick` (packages/presentation/src/components/Card.svelte)
   * dispatches `close` as soon as `okAction`'s promise RESOLVES — success and
   * failure alike. That half is platform-wide behaviour that dozens of upstream
   * dialogs depend on, so it is deliberately NOT changed.
   *
   * `save` resolves on failure (it turns the error into the inline `error`
   * message rather than throwing), so the `close` that follows in the same
   * `.then` is swallowed exactly once and the dialog stays open with the typed
   * values intact.
   *
   * ⚠️ Safe because `Card` dispatches that `close` in the microtask that
   * follows this promise resolving: no user click can be interleaved between
   * the flag being set and it being consumed. The header's own close button
   * therefore keeps working after a failure, because by then the flag is back
   * to `false`.
   *
   * ℹ️ The OTHER half of the old `Card` bug — a REJECTED `okAction` leaving
   * `okProcessing` latched at `true`, which killed the Create button for the
   * rest of the dialog's life — is fixed in `Card` itself on this branch (see
   * `docs/upstream-card-okaction-rejection.md`). Resolving-on-failure is
   * nevertheless kept, because rejecting would keep the button alive but would
   * ALSO surface the handled business failure as an unhandled rejection to the
   * global reporter in `packages/analytics-providers`, and would tie this
   * dialog to a fix that upstream has not taken yet.
   */
  let swallowNextClose = false

  async function save (): Promise<void> {
    if (!canSave || startDate == null || endDate == null) return
    running = true
    error = undefined
    try {
      await client.createDoc(cyclePlugin.class.Cycle, space, {
        name: name.trim(),
        goal: null,
        // 🔴 Every cycle starts `planned`. `cycleTransitions` has no edge INTO
        // `planned`, so a cycle created in any other state could never be walked
        // back; and `active` on creation would silently claim work had begun.
        status: 'planned',
        startDate,
        endDate,
        sequence: nextSequence
      })
    } catch (err: any) {
      console.error(err)
      // Nothing was written — `createDoc` is a single transaction — so the
      // copy may state that plainly and invite a retry.
      error = cyclePlugin.string.CreateCycleFailed
      swallowNextClose = true
      return
    } finally {
      // Cleared on BOTH paths. Clearing it is what stops a failed attempt from
      // locking `Escape` out for good (`canClose` reads it).
      running = false
    }
    dispatch('close')
  }
</script>

<CardDialog
  label={cyclePlugin.string.NewCycle}
  okAction={save}
  okLabel={cyclePlugin.string.CreateCycle}
  {canSave}
  width={'medium'}
  on:close={() => {
    if (swallowNextClose) {
      swallowNextClose = false
      return
    }
    dispatch('close')
  }}
>
  <EditBox bind:value={name} placeholder={cyclePlugin.string.Name} kind={'large-style'} autoFocus />

  {#if error !== undefined}
    <div class="create-cycle__error"><Label label={error} /></div>
  {/if}

  <svelte:fragment slot="pool">
    <DatePresenter
      bind:value={startDate}
      mode={DateRangeMode.DATE}
      editable
      kind={'regular'}
      label={cyclePlugin.string.StartDate}
      icon={cyclePlugin.icon.Cycle}
    />
    <DatePresenter
      bind:value={endDate}
      mode={DateRangeMode.DATE}
      editable
      kind={'regular'}
      label={cyclePlugin.string.EndDate}
      icon={cyclePlugin.icon.Cycle}
    />
  </svelte:fragment>
</CardDialog>

<style lang="scss">
  .create-cycle__error {
    margin-top: 0.75rem;
    color: var(--theme-error-color);
    font-size: 0.8125rem;
  }
</style>
