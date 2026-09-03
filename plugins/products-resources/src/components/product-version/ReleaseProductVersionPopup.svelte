<!--
//
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
//

  The client entry point for `ReleaseProductVersion` (REL-003 / REL-004 /
  REL-006). Until this existed the command was reachable only by hand crafting a
  `domainRequest`, so the gate, the audit record and the requirement write-back
  had no way to be triggered from the product.

  🔴 THE OPEN POPUP IS ONE UNIT OF INTENT, AND THE KEY SAYS SO. The idempotency
  key is `releaseProductVersionIdempotencyKey(version._id)` — a pure function of
  the version, computed fresh on every attempt rather than captured at mount.
  A double click, a reopened popup, an F5 mid-flight, a second browser tab and a
  second release manager therefore all present the SAME key and collapse onto one
  ledger row: the second caller REPLAYS the first caller's stored result instead
  of racing it. Deriving it from `generateId()`, from the clock or from the
  session would leave the ledger correct and never consulted.

  🔴 NOTHING HERE WRITES `state`. `Released` is reachable only through the
  command; the UI dropdown excludes it and this popup does not go near it.

  🔴 THE GATE IS SHOWN BEFORE THE BUTTON IS PRESSED (PRD §7.5). `previewReleaseGate`
  is a READ — no ledger row, no idempotency key, no writes — answered from the
  same `evaluateReleaseGate` the release runs, so what this popup shows and what
  the release then decides cannot disagree. Without it the only way to learn why
  a version cannot ship was to press Release and read a bare `gate-failed`
  envelope that carries no report at all.

  ⚠️ THE PREVIEW IS RE-FETCHED, NEVER CACHED ACROSS ATTEMPTS. Gate state moves
  while the popup is open — a defect is closed, a run turns green — so it is
  reloaded on mount, on every `value._id` change and after each failed release.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte'

  import type { Doc, Ref } from '@hcengineering/core'
  import { Card, getClient } from '@hcengineering/presentation'
  import { Button, EditBox, Label, Spinner } from '@hcengineering/ui'
  import { ProductVersionState, type ProductVersion } from '@hcengineering/products'

  import {
    canReleaseProductVersionState,
    previewReleaseGate,
    releaseProductVersion,
    releaseProductVersionIdempotencyKey,
    releaseReasonLabel,
    type GatePreviewOutcome,
    type ReleaseOutcome
  } from '../../release'
  import products from '../../plugin'
  import ReleaseGateView from './ReleaseGateView.svelte'

  export let value: ProductVersion

  const dispatch = createEventDispatcher()
  const client = getClient()

  let waiverReason: string = ''
  let running: boolean = false
  let outcome: ReleaseOutcome | undefined
  let preview: GatePreviewOutcome | undefined
  /**
   * WHICH version `preview` describes.
   *
   * 🔴 WITHOUT IT THE POPUP SHOWS THE PREVIOUS VERSION'S GATE UNDER THE NEW
   * TITLE. `preview` survives a `value` change, so between the switch and the
   * new answer arriving the template would happily render v1's blockers while
   * the card names v2 — a wrong gate presented with full confidence. Clearing
   * it on a version change makes that window show the loading state instead.
   */
  let previewOf: Ref<ProductVersion> | undefined
  let previewing: boolean = false

  // ⚠️ Keyed on the id, so reopening the popup on a different version reloads
  // rather than showing the previous version's gate. `loadPreview` is not in the
  // dependency set on purpose — it never changes, and listing it would re-run
  // this block on every reassignment.
  $: void loadPreview(value._id)

  /**
   * 🔴 THE WAIVER IS NOT FORWARDED TO THE PREVIEW. A waiver flips `passed` to
   * true over an unchanged blocker list, so previewing with one would show a
   * green gate while the user is still typing the reason — and hide the very
   * items the reason is supposed to justify. The preview always shows the
   * UNWAIVED truth; the release applies the waiver.
   */
  async function loadPreview (version: Ref<ProductVersion>): Promise<void> {
    if (previewOf !== version) {
      // A DIFFERENT version: drop the stale report rather than show it under the
      // new name. A refresh of the SAME version keeps the current report on
      // screen next to the spinner — no flicker, and nothing is misattributed.
      preview = undefined
    }
    previewing = true
    try {
      // ⚠️ THE ARGUMENT, NOT `value._id`. Reading the live `value` here would
      // request one version and validate the answer against another.
      const next = await previewReleaseGate(client, { version })
      // ⚠️ Assigned only if the popup is still on the same version: an await
      // that resolves after the user switched would otherwise show a stale gate
      // under the new title.
      if (value._id === version) {
        preview = next
        previewOf = version
      }
    } finally {
      if (value._id === version) {
        previewing = false
      }
    }
  }

  // 🔴 Recomputed from `value._id`, never stored in a `let` that a re-render
  // could leave stale — and never seeded from `generateId()`. This IS the
  // deduplication.
  $: idempotencyKey = releaseProductVersionIdempotencyKey(value._id as Ref<Doc>)

  $: alreadyReleased = value.state === ProductVersionState.Released
  $: releasable = canReleaseProductVersionState(value.state)

  /**
   * Consulted by `PopupInstance.escapeClose` before Escape or an overlay click
   * tears this component down. Without it a release in flight loses the gate
   * report it is about to render: the call itself is safe to repeat because
   * `idempotencyKey` is derived from the version, so a reopened dialog replays
   * rather than releasing twice -- but the blockers the user needed to read
   * would be gone. The header close button stays unconditional on purpose;
   * walking away from a release must remain possible.
   */
  export function canClose (): boolean {
    return !running
  }

  async function run (): Promise<void> {
    if (running) {
      // ⚠️ Belt and braces on top of the disabled button. The key would make a
      // second in-flight call harmless (the server answers 409, or replays), but
      // a second call still costs a round trip and would race this component's
      // own `outcome`.
      return
    }
    running = true
    try {
      const trimmed = waiverReason.trim()
      outcome = await releaseProductVersion(client, {
        version: value._id,
        idempotencyKey,
        // ⚠️ OMITTED WHEN BLANK, never sent as `''`. The server refuses an empty
        // waiver reason outright (`waiver-without-reason`) rather than reading it
        // as "no waiver", so sending one would turn "I did not ask for a waiver"
        // into an error.
        ...(trimmed !== '' ? { waiverReason: trimmed } : {})
      })
      if (outcome.kind === 'refused') {
        // 🔴 RELOADED, NOT REUSED. A `gate-failed` envelope carries no report,
        // so the only way to say WHY is to ask the gate again — and by now the
        // blockers may already differ from the ones shown at mount.
        await loadPreview(value._id)
      }
    } finally {
      running = false
    }
  }
</script>

<Card
  label={products.string.ReleaseProductVersion}
  canSave={false}
  okAction={() => {}}
  on:close={() => {
    dispatch('close')
  }}
  hideAttachments
>
  <div class="flex-col flex-gap-3">
    {#if alreadyReleased}
      <div class="release-popup__note"><Label label={products.string.ReleaseAlreadyDone} /></div>
    {:else if !releasable}
      <div class="release-popup__note"><Label label={products.string.ReasonIllegalTransition} /></div>
    {/if}

    <!-- PRD §7.5: the gate, BEFORE the button. -->
    <div class="release-popup__section"><Label label={products.string.ReleaseGate} /></div>
    {#if preview === undefined}
      <div class="release-popup__note">
        <Label label={products.string.GatePreviewLoading} />
        <Spinner size={'small'} />
      </div>
    {:else if preview.kind === 'ready'}
      <ReleaseGateView gate={preview.result.gate} />
    {:else if preview.kind === 'refused'}
      <div class="release-popup__note"><Label label={releaseReasonLabel(preview.reason)} /></div>
    {:else}
      <!-- 🔴 Never rendered as a passing gate. "Could not check" is its own
           sentence; falling back to an empty report would show "Ready to
           release" with no evidence behind it. -->
      <div class="release-popup__note"><Label label={products.string.GatePreviewUnavailable} /></div>
    {/if}
    <div>
      <Button
        label={products.string.RefreshGate}
        kind={'ghost'}
        size={'small'}
        disabled={previewing || running}
        on:click={async () => {
          await loadPreview(value._id)
        }}
      />
    </div>

    <!-- REL-006. Blank means "no waiver"; see `run()`. -->
    <EditBox
      label={products.string.WaiverReason}
      placeholder={products.string.WaiverReasonPlaceholder}
      bind:value={waiverReason}
      disabled={running || alreadyReleased}
    />

    {#if outcome === undefined}
      <!-- 🔴 THE PREVIEW NEVER GATES THIS BUTTON. `disabled` is computed from
           `value.state` alone; `preview` is advisory display. Wiring it in
           (`disabled={... || preview?.result.gate.passed !== true}`) would make
           the client's reading of the gate authoritative — and `parseGateReport`
           is deliberately lenient about optional fields, so a malformed reply
           carrying `passed: true` would then become permission rather than a
           wrong sentence. The server re-evaluates on every release and answers
           `gate-failed`; that is the only authority. -->
      <Button
        label={products.string.Release}
        kind={'primary'}
        disabled={running || alreadyReleased || !releasable}
        on:click={run}
      />
      {#if running}<Spinner size={'small'} />{/if}
    {:else if outcome.kind === 'released' || outcome.kind === 'replayed'}
      <div class="release-popup__note">
        <!-- 🔴 `replayed` never claims "released just now": the answer came out
             of the ledger, or the version was already `Released`. -->
        <Label label={outcome.kind === 'released' ? products.string.ReleaseDone : products.string.ReleaseAlreadyDone} />
      </div>
      {#if outcome.result.writeBackIncomplete}
        <!-- ⚠️ A sentence, not a count. The number of requirements left behind
             is withheld for the same reason blocker counts are. -->
        <div class="release-popup__note"><Label label={products.string.ReleaseWriteBackIncomplete} /></div>
      {/if}
      <ReleaseGateView gate={outcome.result.gate} />
    {:else if outcome.kind === 'in-progress'}
      <div class="release-popup__note"><Label label={products.string.ReleaseInProgress} /></div>
      <!-- RETRYABLE, and the same key: this is a replay attempt, not a second
           release. -->
      <Button label={products.string.Release} kind={'regular'} disabled={running} on:click={run} />
    {:else if outcome.kind === 'refused'}
      <div class="release-popup__note"><Label label={releaseReasonLabel(outcome.reason)} /></div>
      <!-- Offered again on purpose: a gate refusal is not a lock. Fix the
           blockers and press it again — same key, fresh evaluation. -->
      <Button label={products.string.Release} kind={'regular'} disabled={running} on:click={run} />
    {:else if outcome.kind === 'unavailable'}
      <div class="release-popup__note"><Label label={products.string.ReleaseUnavailable} /></div>
    {:else}
      <div class="release-popup__note"><Label label={products.string.ReleaseErrored} /></div>
    {/if}
  </div>
</Card>

<style lang="scss">
  .release-popup__note {
    font-size: 0.8125rem;
    color: var(--theme-darker-color);
  }
  .release-popup__section {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--theme-caption-color);
  }
</style>
