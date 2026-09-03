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
  The delivery DASHBOARD of one object: its trace edges rolled up by kind, in
  both directions.

  🔴 PROP NAME. `EditCardTableOfContents.svelte` passes `doc`, not `object`. A
  component declaring `object` is handed `undefined` and throws on first render.

  🔴 `dispatch('loaded')` IS MANDATORY — the card panel's scroll tracking waits
  for every section to report in.

  🔴 EVERY NUMBER ON THIS PAGE IS THE SERVER'S, RENDERED VERBATIM. `TraceCoverage`
  is computed by the traceability domain handler's `summarize()` over the
  permission-filtered edge set (`./types.ts` states the rule); recomputing any
  of it from the `links` array would turn a count into a channel for the volume
  of objects the caller may not read.

  🔴 `restricted` IS SHOWN AS EXISTENCE, NEVER AS A NUMBER. Technical Spec §6.2:
  "聚合计数默认也不包含无权对象，避免侧信道泄漏". `byKind` likewise reports only
  what `visible` covers, so a hidden `verifies` edge cannot be inferred from the
  per-kind row either.

  ⚠️ A DASHBOARD WITH NO DATA IS NOT A DASHBOARD OF ZEROES. `available: false`
  means the traceability domain handler is not installed in this deployment —
  the page says so rather than reporting a clean sheet nobody measured. This is
  the same distinction the release gate draws between a missing pass rate and a
  pass rate of 0%.
-->
<script lang="ts">
  import type { Doc, Ref } from '@hcengineering/core'
  import { getClient } from '@hcengineering/presentation'
  import type { TraceLinkKind } from '@hcengineering/traceability'
  import { Label } from '@hcengineering/ui'
  import { createEventDispatcher, onMount } from 'svelte'

  import traceability from '../plugin'
  import type { TraceCoverage } from '../types'
  import { findIncomingTraceLinks, findOutgoingTraceLinks, traceLinkKindLabel } from '../utils'

  /** The card. Named `doc` because that is what the panel passes. */
  export let doc: Doc | undefined = undefined
  export let hidden: boolean = false
  /** Part of the section contract. A dashboard is read-only in every state. */
  export let readonly: boolean = false

  void readonly

  const client = getClient()
  const dispatch = createEventDispatcher()

  const emptyCoverage: TraceCoverage = { total: 0, visible: 0, restricted: 0, byKind: {} }

  let outgoing: TraceCoverage = emptyCoverage
  let incoming: TraceCoverage = emptyCoverage
  let available = true

  $: void reloadFor(doc?._id)
  $: outgoingKinds = kindRows(outgoing)
  $: incomingKinds = kindRows(incoming)
  $: restricted = outgoing.restricted > 0 || incoming.restricted > 0
  $: empty = outgoing.visible === 0 && incoming.visible === 0 && !restricted

  async function reloadFor (_id: Ref<Doc> | undefined): Promise<void> {
    if (_id === undefined) return
    await reload()
  }

  /**
   * ⚠️ THE EDGES CANNOT BE LIVE-QUERIED — permission-filtered domain request,
   * not `findAll`. Same as every other traceability block here.
   */
  async function reload (): Promise<void> {
    if (doc === undefined) return
    const out = await findOutgoingTraceLinks(client, { doc: doc._id })
    const inc = await findIncomingTraceLinks(client, { doc: doc._id })
    available = out.available && inc.available
    outgoing = out.coverage
    incoming = inc.coverage
  }

  /**
   * ⚠️ A kind with no visible edge is DROPPED rather than shown as zero. Under
   * restriction a zero row and a hidden row look identical, and printing the
   * zero invites the reader to conclude nothing of that kind exists — which is
   * exactly the inference `restricted` refuses to support.
   */
  function kindRows (coverage: TraceCoverage): Array<[TraceLinkKind, number]> {
    return Object.entries(coverage.byKind)
      .filter(([, count]) => (count ?? 0) > 0)
      .map(([kind, count]) => [kind as TraceLinkKind, count])
  }
</script>

{#if !hidden}
  <div class="delivery-dashboard">
    <div class="delivery-dashboard__head">
      <span class="delivery-dashboard__title"><Label label={traceability.string.Dashboard} /></span>
    </div>

    {#if !available}
      <div class="delivery-dashboard__warning"><Label label={traceability.string.TimelineUnavailable} /></div>
    {:else}
      {#if empty}
        <div class="delivery-dashboard__warning"><Label label={traceability.string.DashboardEmpty} /></div>
      {/if}

      <div class="delivery-dashboard__grid">
        <div class="delivery-dashboard__panel">
          <span class="delivery-dashboard__panel-title"><Label label={traceability.string.DashboardOutgoing} /></span>
          <span class="delivery-dashboard__total">{outgoing.visible}</span>
          {#each outgoingKinds as [kind, count] (kind)}
            <div class="delivery-dashboard__row">
              <Label label={traceLinkKindLabel(kind)} />
              <b>{count}</b>
            </div>
          {/each}
        </div>

        <div class="delivery-dashboard__panel">
          <span class="delivery-dashboard__panel-title"><Label label={traceability.string.DashboardIncoming} /></span>
          <span class="delivery-dashboard__total">{incoming.visible}</span>
          {#each incomingKinds as [kind, count] (kind)}
            <div class="delivery-dashboard__row">
              <Label label={traceLinkKindLabel(kind)} />
              <b>{count}</b>
            </div>
          {/each}
        </div>
      </div>

      {#if restricted}
        <!--
          🔴 EXISTENCE ONLY, in ONE row for BOTH directions. Splitting it per
          direction would already be a two-bit answer where the spec allows one.
        -->
        <div class="delivery-dashboard__restricted"><Label label={traceability.string.RestrictedLink} /></div>
      {/if}
    {/if}
  </div>
{/if}

<style lang="scss">
  .delivery-dashboard {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0 1rem;
    gap: 0.5rem;
  }
  .delivery-dashboard__title {
    font-weight: 500;
  }
  .delivery-dashboard__warning {
    color: var(--theme-warning-color);
  }
  .delivery-dashboard__grid {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .delivery-dashboard__panel {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 10rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.375rem;
  }
  .delivery-dashboard__panel-title {
    font-size: 0.75rem;
    color: var(--theme-dark-color);
  }
  .delivery-dashboard__total {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--theme-caption-color);
  }
  .delivery-dashboard__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.75rem;
  }
  .delivery-dashboard__restricted {
    color: var(--theme-dark-color);
    font-style: italic;
  }
</style>
