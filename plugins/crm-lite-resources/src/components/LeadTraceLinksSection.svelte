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
  The `card.class.CardSection` body that puts the traceability block on a Lead's
  detail page. Registered by `models/crm-lite` and scoped to Leads by
  `CheckLeadTraceLinksVisibility`.

  🔴 THIS FILE EXISTS FOR ONE REASON: THE PROP NAME.
  `EditCardTableOfContents.svelte` renders every section as
  `<Component is={section.component} props={{ doc, readonly, hidden, ... }} />`,
  i.e. the card arrives as `doc`. `TraceLinksSection` declares `export let
  object: Doc`. Registering it as the section component directly would leave
  `object` undefined and `normId(doc)` would throw on first render — the block
  would not be "empty", it would be broken. The adapter below is the whole job.

  🔴 The referenced component is addressed by its PLATFORM id, not imported.
  `traceability-resources` is registered as the UI location for `traceabilityId`
  (`addLocation(traceabilityId, ...)` in `dev/prod/src/platform.ts` and
  `desktop/src/ui/platform.ts`), so `Component` resolves the id at runtime. A
  build-time `import` would instead mean a new package dependency and a
  rewritten `pnpm-lock.yaml` — the same trade-off, and the same resolution, that
  `ConvertLeadRequest` in `../utils` already documents for the wire types.

  ⚠️ NOTHING is passed that would widen what the block shows. `kinds` / `states`
  / `normalize` are deliberately left at their defaults so the server's
  per-endpoint permission filter and the component's own "restricted link"
  degradation stay exactly as `plugins/traceability-resources` implemented them.
-->
<script lang="ts">
  import type { Card } from '@hcengineering/card'
  import { Component, type AnyComponent } from '@hcengineering/ui'
  import { createEventDispatcher, onMount } from 'svelte'

  export let doc: Card
  export let hidden: boolean = false
  /**
   * Part of the section contract, accepted and deliberately NOT forwarded: the
   * traceability block is read only in every state it has, so there is nothing
   * for it to disable, and forwarding an undeclared prop would only produce a
   * Svelte "unknown prop" warning.
   */
  export let readonly: boolean = false
  void readonly

  /**
   * `traceability:component:TraceLinksSection`, as produced by `mergeIds` in
   * `plugins/traceability-resources/src/plugin.ts` (`plugin + ':' + 'component'
   * + ':' + key`, see `identify` in `foundations/core/packages/platform`).
   */
  const TraceLinksSection = 'traceability:component:TraceLinksSection' as AnyComponent

  const dispatch = createEventDispatcher()

  // The card panel refuses to track scroll position until every section has
  // reported in (`handleScroll` waits for `sections.every(sectionLoaded)`), so a
  // section that never dispatches `loaded` freezes the table of contents for the
  // whole page — not just for itself.
  onMount(() => {
    dispatch('loaded')
  })
</script>

{#if !hidden}
  <div class="section-trace-links">
    <Component is={TraceLinksSection} showLoading={false} props={{ object: doc }} />
  </div>
{/if}

<style lang="scss">
  .section-trace-links {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0 1rem;
  }
</style>
