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
  🔴 ONE POPUP FOR ALL THREE `verifies` ENTRY POINTS.

  The test-case page fixes the case and picks requirements; the requirement page
  fixes the requirement and picks cases; the bulk action fixes MANY cases and
  picks requirements. All three end in `linkVerifiesPairs`, which calls the ONE
  `linkVerifies` command once per pair, each on its own pair-derived idempotency
  key. Giving any entry point its own write path would have to reproduce the
  server matrix check, the pair claim and the two activity records — and would
  drift from them the first time one of the three changed.

  ⚠️ The picker never writes anything itself. A `TraceLink` created client side
  would bypass every one of those guarantees, and `DOMAIN_RELATION` is excluded
  from Activity so it would leave no audit trail at all.
-->
<script lang="ts">
  import type { Class, Doc, Ref } from '@hcengineering/core'
  import presentation, { getClient, ObjectPopup } from '@hcengineering/presentation'
  import type { IntlString } from '@hcengineering/platform'
  import { ObjectPresenter } from '@hcengineering/view-resources'
  import { createEventDispatcher } from 'svelte'

  import { linkVerifiesPairs, type LinkVerifiesBatch, type VerifiesPair } from '../commands'

  /**
   * Which side the caller pinned. `'requirement'` means "these test cases are
   * fixed, pick requirements"; `'testCase'` means the mirror image.
   */
  export let pick: 'requirement' | 'testCase'
  /** The class the picker lists — supplied by the caller so this package keeps no dependency on either module. */
  export let pickClass: Ref<Class<Doc>>
  /** The already-fixed side. One entry for a detail page, many for the bulk action. */
  export let fixed: Array<Ref<Doc>>
  export let placeholder: IntlString = presentation.string.Search
  export let searchField: string = 'name'
  /** Requirements that are already verified, so the picker can pre-tick them. */
  export let selectedObjects: Array<Ref<Doc>> = []

  const client = getClient()
  const dispatch = createEventDispatcher()

  let running = false

  function pairsFor (picked: Array<Ref<Doc>>): VerifiesPair[] {
    const out: VerifiesPair[] = []
    for (const one of fixed) {
      for (const other of picked) {
        out.push(pick === 'requirement' ? { testCase: one, requirement: other } : { testCase: other, requirement: one })
      }
    }
    return out
  }

  async function handler (e: CustomEvent<any>): Promise<void> {
    if (e.detail == null || running) {
      return
    }
    const picked: Array<Ref<Doc>> = Array.isArray(e.detail) ? e.detail : [e.detail]
    // ⚠️ Only ADDITIONS are acted on. Unticking a row does NOT revoke the edge:
    // a trace edge is an audit fact, and withdrawing one is a separate,
    // deliberate act (`state: 'revoked'`) that must not happen as a side effect
    // of a checkbox.
    const additions = picked.filter((it) => !selectedObjects.includes(it))
    if (additions.length === 0) {
      return
    }
    running = true
    try {
      const batch: LinkVerifiesBatch = await linkVerifiesPairs(client, pairsFor(additions))
      dispatch('linked', batch)
    } finally {
      running = false
    }
  }
</script>

<ObjectPopup
  _class={pickClass}
  multiSelect
  {selectedObjects}
  {searchField}
  {placeholder}
  loading={running}
  on:close={handler}
  on:update={handler}
>
  <svelte:fragment slot="item" let:item>
    <ObjectPresenter value={item} props={{ type: 'text' }} />
  </svelte:fragment>
</ObjectPopup>
