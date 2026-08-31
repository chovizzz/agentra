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
  The `card.class.CardSection` that carries Task 7's form validation on a Lead's
  detail page.

  🔴 IT DOES NOT RE-RENDER THE FIELDS. `card.section.Properties`
  (`card.sectionComponent.PropertiesSection`) already renders every Lead
  attribute through `CardAttributeEditor`, and this block sits below it saying
  only what is still MISSING. Duplicating the editors here would give the user
  two places to type the same value into, and would need a second, divergent
  copy of the presenter/editor wiring the model already hangs on the TYPE
  classes.

  🔴 EXPERIENCE LAYER, NOT ENFORCEMENT. `LeadGuardMiddleware` never looks at
  account / contact / owner / nextActionAt — they are optional attributes and
  leads legitimately arrive without them from the import tool, from migrations
  and from any API caller. Nothing here blocks a write; see `validateLeadFields`
  in `../utils` for why a client-side write gate would be enforcement theatre.

  ⚠️ A CardSection is GLOBAL — the class has no `attachTo` and `getCardSections`
  filters only on `checkVisibility`. `CheckLeadFieldsVisibility` is therefore
  the whole of the scoping, exactly as for the traceability block.

  ⚠️ The panel passes the card as `doc`; this component declares `doc`. Do not
  rename it to `object` — `EditCardTableOfContents.svelte` renders every section
  as `<Component is={section.component} props={{ doc, readonly, hidden, ... }} />`
  and a mismatch throws on first render rather than merely rendering empty.
-->
<script lang="ts">
  import type { Lead } from '@hcengineering/crm-lite'
  import { Label } from '@hcengineering/ui'
  import { createEventDispatcher, onMount } from 'svelte'

  import crmLite from '../plugin'
  import { isLeadReadonly, leadRequiredFieldLabel, validateLeadFields } from '../utils'

  export let doc: Lead
  export let hidden: boolean = false
  /**
   * Part of the section contract and deliberately unused: this block is a
   * read-only summary in every state, so there is nothing for it to disable.
   */
  export let readonly: boolean = false
  void readonly

  $: verdict = validateLeadFields(doc)
  $: locked = isLeadReadonly(doc?.status)

  const dispatch = createEventDispatcher()

  // 🔴 The card panel refuses to track scroll position until EVERY section has
  // reported in (`handleScroll` waits for `sections.every(sectionLoaded)`), so a
  // section that never dispatches `loaded` freezes the table of contents for the
  // whole page — not only for itself.
  onMount(() => {
    dispatch('loaded')
  })
</script>

{#if !hidden}
  <div class="section-lead-fields">
    {#if locked}
      <div class="section-lead-fields__locked"><Label label={crmLite.string.ConvertedReadonly} /></div>
    {/if}
    {#if verdict.complete}
      <div class="section-lead-fields__ok"><Label label={crmLite.string.RequiredFieldsComplete} /></div>
    {:else}
      <div class="section-lead-fields__missing"><Label label={crmLite.string.RequiredFieldsMissing} /></div>
      <ul class="section-lead-fields__list">
        {#each verdict.missing as field (field)}
          <li><Label label={leadRequiredFieldLabel(field)} /></li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style lang="scss">
  .section-lead-fields {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0 1rem;
    font-size: 0.8125rem;
  }
  .section-lead-fields__locked {
    color: var(--theme-warning-color);
  }
  .section-lead-fields__ok {
    color: var(--theme-dark-color);
  }
  .section-lead-fields__missing {
    color: var(--theme-error-color);
  }
  .section-lead-fields__list {
    margin: 0.25rem 0 0 1rem;
    color: var(--theme-caption-color);
    list-style: disc;
  }
</style>
