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
  One trace edge, rendered from the far endpoint's point of view.

  🔴 There are exactly two branches and they are mutually exclusive:

  - `isEndpointRenderable(endpoint)` — the SERVER decided this caller may read
    the endpoint and shipped the document inline. Only here is any content
    rendered, and it is rendered by `ObjectPresenter` from the shipped `doc`.
  - otherwise — the restricted placeholder. It renders one translated string and
    nothing else: no title, no identifier, no class label, no assignee, no
    status, no id. `TraceEndpointView` carries an `_id` in this branch, and it is
    deliberately NOT displayed and NOT put in a link, a tooltip or a `data-*`
    attribute; an opaque ref is still an object handle.

  There is no third branch that "tries harder": this component never issues a
  `findAll` for a hidden endpoint, so there is no path where a client-side read
  could resurrect what the server withheld.
-->
<script lang="ts">
  import { Label } from '@hcengineering/ui'
  import { ObjectPresenter } from '@hcengineering/view-resources'

  import type { TraceDirection, TraceLinkView } from '../types'
  import { farEndpoint, isEndpointRenderable } from '../utils'
  import traceability from '../plugin'
  import TraceLinkKindPresenter from './TraceLinkKindPresenter.svelte'
  import UnlinkImplementsButton from './UnlinkImplementsButton.svelte'

  export let value: TraceLinkView
  export let direction: TraceDirection = 'outgoing'
  /** Number of concrete versions this logical relationship was asserted against. */
  export let versions: number = 1
  /** Offer the withdrawal entry point on edges that support one. */
  export let unlinkable: boolean = false

  $: endpoint = farEndpoint(value, direction)
  $: renderable = isEndpointRenderable(endpoint)

  //
  // 🔴 FOUR CONDITIONS, ALL NECESSARY.
  //
  // - `unlinkable` — the containing view opted in.
  // - `kind === 'implements'` — `unlinkImplements` is the only withdrawal
  //   command that exists. Showing the button on a `verifies` or `defect-of`
  //   edge would offer an action nothing can carry out.
  // - `state === 'active'` — an already-`revoked` edge has nothing to withdraw,
  //   and `orphaned` means an endpoint is gone, so the pair the command is keyed
  //   on cannot be named.
  // - BOTH endpoints renderable — the server refuses a caller who cannot read
  //   either end, so a button shown next to a restricted placeholder could only
  //   ever fail. It would also assert that the hidden object is a work item or a
  //   requirement, which the restricted branch exists to withhold.
  //
  $: bothVisible = isEndpointRenderable(value.source) && isEndpointRenderable(value.target)
  $: canUnlink = unlinkable && value.kind === 'implements' && value.state === 'active' && bothVisible
</script>

<div class="trace-link flex-row-center flex-gap-2">
  <TraceLinkKindPresenter kind={value.kind} />
  {#if renderable && endpoint.doc !== undefined && endpoint._class !== undefined}
    <span class="trace-link__endpoint overflow-label">
      <!--
        Only `value` is passed. `ObjectPresenter` then either renders the
        document the server already shipped, or — if it arrived without a
        `space` — re-reads it through the ordinary client query, which is space
        filtered on the server exactly like the endpoint resolve was. Passing
        `objectId` / `_class` instead would take the branch that queries by id,
        i.e. one more round trip for a document we were already handed.
      -->
      <ObjectPresenter value={endpoint.doc} />
    </span>
    {#if canUnlink}
      <!-- Edge direction, not screen direction. Passing `endpoint._id` would swap the pair on one of the two pages. -->
      <span class="trace-link__unlink">
        <UnlinkImplementsButton workItem={value.source._id} requirement={value.target._id} on:unlinked on:failed />
      </span>
    {/if}
    {#if versions > 1}
      <!--
        Cross-version audit history. The relationship is one logical fact but was
        asserted against several concrete versions, and that count is meaningful
        information, so it is surfaced rather than silently collapsed.
      -->
      <span class="trace-link__versions" title={`${versions}`}>×{versions}</span>
    {/if}
  {:else}
    <span class="trace-link__restricted overflow-label">
      <Label label={traceability.string.RestrictedLink} />
    </span>
  {/if}
</div>

<style lang="scss">
  .trace-link {
    min-width: 0;
    padding: 0.25rem 0;
  }
  .trace-link__endpoint {
    min-width: 0;
  }
  .trace-link__unlink {
    flex-shrink: 0;
    margin-left: 0.25rem;
  }
  .trace-link__versions {
    flex-shrink: 0;
    font-size: 0.6875rem;
    color: var(--theme-dark-color);
  }
  .trace-link__restricted {
    min-width: 0;
    font-style: italic;
    color: var(--theme-darker-color);
  }
</style>
