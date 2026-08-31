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
  import type { IntlString } from '@hcengineering/platform'
  import type { RequirementPriority } from '@hcengineering/requirements'
  import { Label } from '@hcengineering/ui'

  import requirements from '../plugin'

  export let value: RequirementPriority | undefined
  export let kind: string | undefined = undefined
  export let size: string | undefined = undefined

  const labels: Record<RequirementPriority, IntlString> = {
    NoPriority: requirements.string.PriorityNoPriority,
    Urgent: requirements.string.PriorityUrgent,
    High: requirements.string.PriorityHigh,
    Medium: requirements.string.PriorityMedium,
    Low: requirements.string.PriorityLow
  }

  $: label = value !== undefined ? labels[value] : undefined
</script>

{#if label !== undefined}
  <span class="overflow-label" class:fs-bold={kind === 'list-header'} data-size={size}>
    <Label {label} />
  </span>
{/if}
