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

  The gate report as PRD §7.5 allows it to be shown.

  🔴 TWO RULES THIS COMPONENT EXISTS TO HOLD.

  1. `passRate` ABSENT IS NOT 0%. The template never touches `gate.passRate`
     directly and never writes `?? 0`; it renders `passRateDisplay(gate)`, whose
     three cases are "a rate", "no verdicts yet" and "suppressed because the
     scope is restricted". Showing 0% would blame a version for evidence nobody
     produced, or leak that its runs exist at all.

  2. `restricted` IS A BOOLEAN AND STAYS ONE. The withheld blockers are stripped
     from the list by `visibleBlockers` and re-surfaced as ONE sentence with no
     number — "存在受限范围内的阻断项". A count of the blockers a caller may not
     read is a cross-space side channel, which is why the server never sends it;
     re-deriving it here (`blockers.filter(...).length`) would restore it. Same
     rule, same wording, as `TraceCoveragePresenter`.
-->
<script lang="ts">
  import { Label } from '@hcengineering/ui'

  import { passRateDisplay, visibleBlockers, blockerLabel, type ReleaseGateReport } from '../../release'
  import products from '../../plugin'

  export let gate: ReleaseGateReport

  $: rate = passRateDisplay(gate)
  $: blockers = visibleBlockers(gate)
</script>

<div class="release-gate flex-col flex-gap-2">
  <div class="release-gate__verdict" class:passed={gate.passed}>
    <Label label={gate.passed ? products.string.ReleaseGatePassed : products.string.ReleaseGateFailed} />
  </div>

  {#if gate.waived}
    <div class="release-gate__note">
      <Label label={products.string.ReleaseGateWaived} />
    </div>
  {/if}

  <div class="release-gate__rate">
    <Label label={products.string.PassRate} />
    <span class="release-gate__value">
      {#if rate.kind === 'known'}
        {rate.value.toFixed(2)}%
      {:else if rate.kind === 'no-verdicts'}
        <!-- 🔴 Words, not "0%". -->
        <Label label={products.string.PassRateNoVerdicts} />
      {:else}
        <Label label={products.string.PassRateRestricted} />
      {/if}
    </span>
    <span class="release-gate__threshold">
      <Label label={products.string.PassRateThreshold} />
      {gate.passRateThreshold}%
    </span>
  </div>

  {#if blockers.length > 0}
    <div class="release-gate__blockers">
      <div class="release-gate__section"><Label label={products.string.ReleaseBlockers} /></div>
      <ul>
        {#each blockers as blocker (`${blocker.kind}:${blocker.object ?? ''}`)}
          <li>
            <Label label={blockerLabel(blocker.kind)} />
            {#if blocker.detail !== undefined}
              <span class="release-gate__detail">{blocker.detail}</span>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if gate.restricted}
    <!-- 🔴 ONE LINE, NO NUMBER. See the header comment. -->
    <div class="release-gate__restricted">
      <Label label={products.string.BlockerRestricted} />
    </div>
  {/if}

  {#if gate.notEvaluated.length > 0}
    <div class="release-gate__note">
      <Label label={products.string.NotEvaluated} />
      <span class="release-gate__detail">{gate.notEvaluated.join(', ')}</span>
    </div>
  {/if}
</div>

<style lang="scss">
  .release-gate {
    font-size: 0.8125rem;
  }
  .release-gate__verdict {
    font-weight: 600;
    color: var(--theme-warning-color);

    &.passed {
      color: var(--theme-caption-color);
    }
  }
  .release-gate__section {
    font-weight: 500;
    color: var(--theme-caption-color);
  }
  .release-gate__value {
    font-weight: 500;
    color: var(--theme-caption-color);
  }
  .release-gate__threshold,
  .release-gate__detail {
    color: var(--theme-darker-color);
  }
  .release-gate__note,
  .release-gate__restricted {
    font-style: italic;
    color: var(--theme-darker-color);
  }
  ul {
    margin: 0;
    padding-left: 1rem;
  }
</style>
