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
  The delivery block on a Requirement detail page, and `implements` ENTRY POINT 1
  ("this requirement — pick work items"). Entry point 2 lives on the issue side
  and opens the SAME `LinkImplementsPopup` with the two roles swapped; both end
  in the one `linkImplements` command on a key derived from the pair.

  It is also where an `implements` assertion is WITHDRAWN from the requirement
  side. This section does not go through `TraceLinksSection` — it runs its own,
  `implements`-only query so the delivery copy and the "split into work items"
  action can sit on the same block — so it does not inherit that section's
  withdrawal entry point either, and had to grow one. The rows themselves are
  `TraceLinkPresenter`, i.e. the SAME component `TraceLinksSection` renders, so
  the four conditions that decide whether a withdrawal is offered at all are
  stated in exactly one place.

  🔴 PROP NAME. `EditCardTableOfContents.svelte` renders every section as
  `<Component is={section.component} props={{ doc, readonly, hidden, ... }} />`,
  so the card arrives as `doc`. A component declaring `object` would be handed
  `undefined` and throw on first render.

  🔴 `dispatch('loaded')` IS MANDATORY. The card panel refuses to track scroll
  position until every section has reported in (`handleScroll` waits for
  `sections.every(sectionLoaded)`), so a section that never dispatches freezes
  the table of contents for the WHOLE page.
-->
<script lang="ts">
  import type { Card } from '@hcengineering/card'
  import type { Doc, Ref } from '@hcengineering/core'
  import { getClient } from '@hcengineering/presentation'
  import type { IntlString } from '@hcengineering/platform'
  import traceability, { type UnlinkImplementsResult } from '@hcengineering/traceability'
  import {
    LinkImplementsPopup,
    TraceLinkPresenter,
    findIncomingTraceLinks,
    groupTraceLinks,
    isRestrictedLink,
    type TraceLinkGroup
  } from '@hcengineering/traceability-resources'
  import { Button, Label, showPopup } from '@hcengineering/ui'
  import { createEventDispatcher, onMount } from 'svelte'

  import requirements from '../plugin'
  import SplitWorkItemsPopup from './SplitWorkItemsPopup.svelte'

  export let doc: Card
  export let hidden: boolean = false
  /**
   * Part of the section contract. Forwarded to the two write entry points — the
   * linking / splitting buttons and the per-edge WITHDRAWAL button: a read-only
   * panel must not offer to create edges, and withdrawing one is a write of the
   * same kind (it is also a privilege change — see the confirmation copy).
   */
  export let readonly: boolean = false

  const client = getClient()
  const dispatch = createEventDispatcher()

  let implementers: Array<Ref<Doc>> = []
  let restricted = 0
  /**
   * The visible edges, grouped exactly the way `TraceLinksSection` groups them:
   * one ROW per logical relationship, with the number of concrete versions it
   * was asserted against. `groupTraceLinks` drops restricted edges itself, so
   * the rows below can never render a placeholder that would disclose how many
   * hidden work items this requirement has — that stays the single count-free
   * line at the bottom.
   */
  let groups: TraceLinkGroup[] = []
  /**
   * The outcome of the LAST withdrawal attempt, or `undefined`.
   *
   * ⚠️ IT HAS TO BE SAID SOMEWHERE. A successful withdrawal makes the row
   * vanish from a list that only ever shows `active` edges, and "the row is
   * gone" is indistinguishable from "nothing happened" — while a REFUSED
   * withdrawal leaves the row exactly where it was, which reads as success. The
   * one line below is the only thing that tells those three cases apart.
   */
  let notice: IntlString | undefined = undefined

  $: void reloadFor(doc?._id)

  async function reloadFor (_id: Ref<Doc> | undefined): Promise<void> {
    if (_id === undefined) return
    await reload()
  }

  /**
   * ⚠️ THE EDGES CANNOT BE LIVE-QUERIED. They are read through the server's
   * permission-filtered domain request, not through `findAll`, so there is no
   * `createQuery` that watches them — the block reloads after its own writes and
   * on navigation, which is what every other traceability block here does.
   */
  async function reload (): Promise<void> {
    if (doc === undefined) return
    const state = await findIncomingTraceLinks(client, { doc: doc._id, kinds: ['implements'] })
    implementers = state.links.filter((link) => !isRestrictedLink(link)).map((link) => link.source._id)
    restricted = state.links.filter(isRestrictedLink).length
    // ⚠️ `'incoming'` — this requirement is the TARGET of every edge here, so
    // the far end (the one the row shows, and the one the grouping keys on) is
    // the work item. Passing `'outgoing'` would group by this requirement and
    // collapse every work item into one row.
    groups = groupTraceLinks(state.links, 'incoming')
  }

  /**
   * 🔴 RELOAD, do not splice the row out locally — the same rule
   * `TraceLinksSection` follows. The server owns which edges are `active`, and a
   * client that removed a row on its own would be asserting an outcome it did
   * not read back. Re-reading is also what makes `alreadyRevoked` honest: in
   * that case THIS attempt changed nothing, and the list was already correct.
   */
  function onUnlinked (result: UnlinkImplementsResult): void {
    notice = result.alreadyRevoked
      ? traceability.string.ImplementsAlreadyUnlinked
      : traceability.string.ImplementsUnlinked
    void reload()
  }

  function onUnlinkFailed (): void {
    // The edge is STILL LIVE. Saying nothing would leave a user who clicked
    // "withdraw", confirmed, and still sees the row unable to tell a refusal
    // from a rendering lag.
    notice = traceability.string.UnlinkImplementsFailed
  }

  function link (): void {
    notice = undefined
    showPopup(
      LinkImplementsPopup,
      {
        // ⚠️ `pick: 'workItem'` means "the requirement is fixed, pick work
        // items". `pickClass` is deliberately NOT passed: the popup defaults it
        // to `tracker.class.Issue`, which is what keeps this package free of a
        // tracker dependency.
        pick: 'workItem',
        fixed: [doc._id],
        selectedObjects: implementers,
        placeholder: traceability.string.LinkImplementsFromRequirement
      },
      undefined,
      () => {
        void reload()
      }
    )
  }

  /**
   * PM-006, and the second way an `implements` edge is born on this page: rather
   * than picking work items that already exist, describe the ones that do not.
   *
   * 🔴 THE DIALOG OWNS THE BATCH, and it must be a FRESH COMPONENT INSTANCE
   * every time. `showPopup` creates one per call, which is what makes "close and
   * re-open" mean "a new batch" — the one thing a user has to be able to do to
   * split a requirement twice. Hoisting the batch up here, or keeping one popup
   * instance alive across opens, would silently turn the second split into a
   * replay of the first.
   */
  function split (): void {
    notice = undefined
    showPopup(SplitWorkItemsPopup, { requirement: doc._id }, undefined, () => {
      // Runs on close, whatever the outcome: a batch that half succeeded still
      // put edges on this requirement, and they have to appear.
      void reload()
    })
  }

  onMount(() => {
    dispatch('loaded')
  })
</script>

{#if !hidden}
  <div class="section-delivery">
    <div class="header">
      <span class="title"><Label label={traceability.string.Delivery} /></span>
      {#if !readonly}
        <div class="actions">
          <Button
            label={requirements.string.SplitIntoWorkItems}
            kind={'regular'}
            size={'small'}
            on:click={split}
            id={'requirement-split-work-items'}
          />
          <Button
            label={traceability.string.LinkImplements}
            kind={'regular'}
            size={'small'}
            on:click={link}
            id={'requirement-link-implements'}
          />
        </div>
      {/if}
    </div>

    {#if notice !== undefined}
      <div class="notice"><Label label={notice} /></div>
    {/if}

    {#if implementers.length === 0 && restricted === 0}
      <div class="warning"><Label label={traceability.string.DeliveryNone} /></div>
    {/if}

    <!--
      🔴 THE WITHDRAWAL ENTRY POINT, AND THE REASON THE ROWS ARE RENDERED BY
      `TraceLinkPresenter` RATHER THAN BY THIS FILE.

      The button may only appear on an ACTIVE `implements` edge whose BOTH
      endpoints the caller can read, and that rule is already written once, in
      `TraceLinkPresenter`. Restating it here would be a second copy of a
      security-shaped condition that nothing keeps in step — and the copy would
      have to be re-derived every time the presenter's rule changed.

      `unlinkable` is `!readonly`, not `true`: the section already refuses to
      offer edge CREATION in a read-only panel, and withdrawal is the same kind
      of write. The server refuses either way; this only stops the UI from
      offering an act the panel says is unavailable.
    -->
    {#each groups as group (group.key)}
      <TraceLinkPresenter
        value={group.links[0]}
        direction={'incoming'}
        versions={group.links.length}
        unlinkable={!readonly}
        on:unlinked={(e) => {
          onUnlinked(e.detail)
        }}
        on:failed={onUnlinkFailed}
      />
    {/each}

    {#if restricted > 0}
      <!--
        🔴 THE COUNT IS DELIBERATELY NOT RENDERED. Technical Spec §6.2: a caller
        who may not read the objects may not learn how many of them there are
        either. `TraceCoveragePresenter` and `RequirementCoverageSection` state
        the same rule for the same reason.
      -->
      <div class="restricted"><Label label={traceability.string.RestrictedLink} /></div>
    {/if}
  </div>
{/if}

<style lang="scss">
  .section-delivery {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0 1rem;
    gap: 0.5rem;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .title {
    font-weight: 500;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .warning {
    color: var(--theme-warning-color);
  }
  .restricted {
    color: var(--theme-dark-color);
  }
  .notice {
    color: var(--theme-dark-color);
  }
</style>
