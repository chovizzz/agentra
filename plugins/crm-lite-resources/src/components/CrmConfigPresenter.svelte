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
<script lang="ts">
  import type { CrmPipeline, LeadSource } from '@hcengineering/crm-lite'

  // 🔴 THIS IS AN `ObjectPresenter`, AND THAT IS WHAT MAKES `pipeline` /
  // `source` FILTERABLE AT ALL. A `RefTo` filter key is never dropped for want
  // of a target-class `AttributeFilter` — `buildFilterKey` falls back to
  // `attribute.type._class`, and `core.class.RefTo` supplies the generic
  // `ObjectFilter` (`plugins/view-resources/src/filter.ts:243-265`,
  // `models/view/src/index.ts:1113`). What the generic filter then needs is an
  // `ObjectPresenter` to draw its candidate rows, and `getPresenter` THROWS
  // when there is none — so without this component, listing `pipeline` or
  // `source` in `ClassFilters` would crash the filter bar on open rather than
  // degrade.
  //
  // One component serves both classes: they are configuration documents that
  // differ in their extra fields, not in how they identify themselves.
  export let value: CrmPipeline | LeadSource | undefined
  export let inline: boolean = false
  export let accent: boolean = false
  export let kind: string | undefined = undefined

  // ⚠️ Archived rows still have to render. `LeadSource.archived` exists so a
  // deployment can retire a source WITHOUT breaking the leads that reference
  // it; a historical lead pointing at an archived source must still show what
  // it was won or lost through, or the audit trail loses its meaning.
  $: archived = value?.archived === true
</script>

{#if value !== undefined}
  <span
    class="overflow-label"
    class:inline-presenter={inline}
    class:fs-bold={accent || kind === 'list-header'}
    class:content-halfcontent-color={archived}
  >
    {value.name}
  </span>
{/if}
