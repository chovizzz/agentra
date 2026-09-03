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
  import type { LeadStatus } from '@hcengineering/crm-lite'
  import type { IntlString } from '@hcengineering/platform'
  import { Label } from '@hcengineering/ui'

  import crmLite from '../plugin'

  export let value: LeadStatus | undefined
  export let kind: string | undefined = undefined
  export let size: string | undefined = undefined

  // Display text never lives in the component: every status maps to an
  // IntlString served from `crm-lite-assets/lang/*.json`.
  const labels: Record<LeadStatus, IntlString> = {
    New: crmLite.string.StatusNew,
    Contacted: crmLite.string.StatusContacted,
    Qualifying: crmLite.string.StatusQualifying,
    Converted: crmLite.string.StatusConverted,
    Disqualified: crmLite.string.StatusDisqualified
  }

  $: label = value !== undefined ? labels[value] : undefined
</script>

{#if label !== undefined}
  <span class="overflow-label" class:fs-bold={kind === 'list-header'} data-size={size}>
    <Label {label} />
  </span>
{/if}
