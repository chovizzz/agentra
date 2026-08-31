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
  The coverage block on a Requirement detail page, and `verifies` ENTRY POINT 2.

  🔴 PROP NAME. `EditCardTableOfContents.svelte` renders every section as
  `<Component is={section.component} props={{ doc, readonly, hidden, ... }} />`,
  so the card arrives as `doc`. A component declaring `object` would be handed
  `undefined` and throw on first render — the block would be broken, not empty.

  🔴 `dispatch('loaded')` IS MANDATORY. The card panel refuses to track scroll
  position until every section has reported in (`handleScroll` waits for
  `sections.every(sectionLoaded)`), so a section that never dispatches freezes
  the table of contents for the WHOLE page, not just for itself.
-->
<script lang="ts">
  import type { Card } from '@hcengineering/card'
  import type { Doc, Ref } from '@hcengineering/core'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import testManagement, { type TestCase } from '@hcengineering/test-management'
  import traceability from '@hcengineering/traceability'
  import { LinkVerifiesPopup, findIncomingTraceLinks, isRestrictedLink } from '@hcengineering/traceability-resources'
  import { Button, Label, showPopup } from '@hcengineering/ui'
  import { createEventDispatcher, onMount } from 'svelte'

  import { emptyRequirementCoverageState, requirementCoverage, type RequirementCoverageState } from '../coverage'

  export let doc: Card
  export let hidden: boolean = false
  /**
   * Part of the section contract. Forwarded to the linking button only: the
   * numbers are read-only in every state, but a read-only panel must not offer
   * to create edges.
   */
  export let readonly: boolean = false

  const client = getClient()
  const dispatch = createEventDispatcher()

  let coverage: RequirementCoverageState = emptyRequirementCoverageState
  let verified: Array<Ref<Doc>> = []

  /**
   * ⚠️ THE EDGES CANNOT BE LIVE-QUERIED. They are read through the server's
   * permission-filtered domain request, not through `findAll`, so there is no
   * `createQuery` that watches them. The verdicts CAN be watched — and this
   * query is deliberately scoped to the verifying cases rather than to every
   * `TestResult` in the workspace, which on a real project is tens of thousands
   * of documents held live for a summary of half a dozen numbers.
   */
  const resultsQuery = createQuery()

  $: void reloadFor(doc?._id)

  async function reloadFor (_id: Ref<Doc> | undefined): Promise<void> {
    if (_id === undefined) return
    await reload()
  }

  async function reload (): Promise<void> {
    if (doc === undefined) return
    coverage = await requirementCoverage(client, doc)
    verified = await verifiedCases()
    watchVerdicts(verified as Array<Ref<TestCase>>)
  }

  function watchVerdicts (cases: Array<Ref<TestCase>>): void {
    if (cases.length === 0) {
      resultsQuery.unsubscribe()
      return
    }
    resultsQuery.query(testManagement.class.TestResult, { testCase: { $in: cases } }, () => {
      // Only the arithmetic is redone; re-entering `reload` here would restart
      // this very subscription on every callback.
      void refreshCoverage()
    })
  }

  async function refreshCoverage (): Promise<void> {
    if (doc === undefined) return
    coverage = await requirementCoverage(client, doc)
  }

  /**
   * The cases already linked to THIS revision, so the picker pre-ticks them and
   * a second confirmation of the same pair is not offered as new work.
   */
  async function verifiedCases (): Promise<Array<Ref<Doc>>> {
    const state = await findIncomingTraceLinks(client, { doc: doc._id, kinds: ['verifies'] })
    return state.links.filter((link) => !isRestrictedLink(link)).map((link) => link.source._id)
  }

  function link (): void {
    showPopup(
      LinkVerifiesPopup,
      {
        pick: 'testCase',
        pickClass: testManagement.class.TestCase,
        fixed: [doc._id],
        selectedObjects: verified,
        placeholder: traceability.string.LinkVerifiesFromRequirement
      },
      undefined,
      () => {
        void reload()
      }
    )
  }

  onMount(() => {
    dispatch('loaded')
  })
</script>

{#if !hidden}
  <div class="section-coverage">
    <div class="header">
      <span class="title"><Label label={traceability.string.Coverage} /></span>
      {#if !readonly}
        <Button
          label={traceability.string.LinkVerifies}
          kind={'regular'}
          size={'small'}
          on:click={link}
          id={'requirement-link-verifies'}
        />
      {/if}
    </div>

    {#if coverage.supersededCoverage}
      <!-- 🔴 Technical Spec §3.2.1: a revision inherits no `verifies` edge, so
           coverage drops to zero and QA must re-confirm. Saying only "0" would
           read as "never tested"; this line is what makes the difference legible. -->
      <div class="warning"><Label label={traceability.string.CoverageSuperseded} /></div>
    {:else if coverage.covered === 0}
      <div class="warning"><Label label={traceability.string.CoverageNone} /></div>
    {/if}

    <div class="grid">
      <div class="cell"><Label label={traceability.string.CoverageCovered} /><b>{coverage.covered}</b></div>
      <div class="cell"><Label label={traceability.string.CoveragePassed} /><b>{coverage.passed}</b></div>
      <div class="cell"><Label label={traceability.string.CoverageFailed} /><b>{coverage.failed}</b></div>
      <div class="cell"><Label label={traceability.string.CoverageBlocked} /><b>{coverage.blocked}</b></div>
      <div class="cell"><Label label={traceability.string.CoverageSkipped} /><b>{coverage.skipped}</b></div>
      <div class="cell"><Label label={traceability.string.CoverageUntested} /><b>{coverage.untested}</b></div>
      {#if coverage.stale > 0}
        <div class="cell"><Label label={traceability.string.CoverageStale} /><b>{coverage.stale}</b></div>
      {/if}
      {#if coverage.restricted > 0}
        <!--
          🔴 THE COUNT IS DELIBERATELY NOT RENDERED. Technical Spec §6.2:
          "聚合计数默认也不包含无权对象，避免侧信道泄漏" — a caller who may not
          read the objects may not learn how many of them there are either.
          `TraceCoveragePresenter` states the same rule for the same reason, and
          printing the number here would reopen the side channel it closes.
          The boolean fact that something is hidden is all that is surfaced.
        -->
        <div class="cell restricted"><Label label={traceability.string.RestrictedLink} /></div>
      {/if}
    </div>
  </div>
{/if}

<style lang="scss">
  .section-coverage {
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
  .warning {
    color: var(--theme-warning-color);
  }
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .cell {
    display: flex;
    gap: 0.25rem;
    align-items: baseline;
  }
  .restricted {
    color: var(--theme-dark-color);
  }
</style>
