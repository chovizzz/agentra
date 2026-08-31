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
  import type { Cycle } from '@hcengineering/cycle'
  import { Icon, tooltip } from '@hcengineering/ui'

  import cycle from '../plugin'

  export let value: Cycle | undefined
  export let shouldShowAvatar: boolean = true
  export let accent: boolean = false
</script>

{#if value}
  <div class="flex-presenter" use:tooltip={{ label: cycle.string.Cycle }}>
    {#if shouldShowAvatar}
      <div class="icon">
        <Icon icon={cycle.icon.Cycle} size={'small'} />
      </div>
    {/if}
    <span title={value.name} class="overflow-label label" class:fs-bold={accent}>{value.name}</span>
  </div>
{/if}
