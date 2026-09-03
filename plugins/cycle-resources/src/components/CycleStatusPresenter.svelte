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
  import type { CycleStatus } from '@hcengineering/cycle'
  import type { IntlString } from '@hcengineering/platform'
  import { Label } from '@hcengineering/ui'

  import cycle from '../plugin'

  export let value: CycleStatus | undefined
  export let kind: string | undefined = undefined
  export let size: string | undefined = undefined

  // Display text never lives in the component: every status maps to an
  // IntlString served from `cycle-assets/lang/*.json`. That is also what keeps
  // the §3.9 split honest — `planned` is the stored value, "Planned" is only
  // ever a translation.
  const labels: Record<CycleStatus, IntlString> = {
    planned: cycle.string.StatusPlanned,
    active: cycle.string.StatusActive,
    completed: cycle.string.StatusCompleted,
    cancelled: cycle.string.StatusCancelled
  }

  $: label = value !== undefined ? labels[value] : undefined
</script>

{#if label !== undefined}
  <span class="overflow-label" class:fs-bold={kind === 'list-header'} data-size={size}>
    <Label {label} />
  </span>
{/if}
