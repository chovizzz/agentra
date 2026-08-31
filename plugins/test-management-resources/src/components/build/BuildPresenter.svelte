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
  import { Icon } from '@hcengineering/ui'
  import { type Build } from '@hcengineering/test-management'

  import testManagement from '../../plugin'

  export let value: Build | undefined

    // ⚠️ Required, not decorative: `TestRun.build` is a `TypeRef`, and both
    // `ObjectFilter` and every table cell resolve it through
    // `getAttributePresenter`, which THROWS when the target class has none.
</script>

{#if value !== undefined}
  <span class="flex-row-center flex-no-shrink">
    <Icon icon={testManagement.icon.Build} size={'small'} />
    <span class="ml-1 overflow-label">{value.name}</span>
  </span>
{/if}
