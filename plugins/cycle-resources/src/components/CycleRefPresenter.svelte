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
  import type { Ref } from '@hcengineering/core'
  import { createQuery } from '@hcengineering/presentation'

  import cyclePlugin from '../plugin'
  import CyclePresenter from './CyclePresenter.svelte'

  // The Issue mixin stores a `Ref<Cycle>`; an AttributePresenter for a `RefTo`
  // is resolved on the TARGET class and is handed the raw ref, so the document
  // has to be fetched here.
  export let value: Ref<Cycle> | null | undefined
  export let accent: boolean = false

  const query = createQuery()
  let doc: Cycle | undefined

  $: if (value != null) {
    query.query(cyclePlugin.class.Cycle, { _id: value }, (res) => {
      doc = res[0]
    })
  } else {
    doc = undefined
  }
</script>

<CyclePresenter value={doc} {accent} />
