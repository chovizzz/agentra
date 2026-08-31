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
  import { type Class, type Ref } from '@hcengineering/core'
  import { createQuery } from '@hcengineering/presentation'
  import { type Build } from '@hcengineering/test-management'

  import testManagement from '../../plugin'
  import BuildPresenter from './BuildPresenter.svelte'

  // ⚠️ An `AttributePresenter` receives the REF, an `ObjectPresenter` receives
  // the DOC. `TestRun.build` is a `TypeRef`, so this is the half that resolves
  // one into the other — the same split `TestSuiteRefPresenter` uses.
  export let value: Ref<Build> | undefined
  export let _class: Ref<Class<Build>> = testManagement.class.Build

  let build: Build | undefined

  const query = createQuery()
  $: value !== undefined &&
    query.query(_class, { _id: value }, (res) => {
      ;[build] = res
    })
</script>

{#if value}
  <BuildPresenter value={build} />
{/if}
