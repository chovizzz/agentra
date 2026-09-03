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
  🔴 ONE POPUP FOR BOTH `implements` DIRECTIONS.

  The requirement page fixes the requirement and picks work items; the issue
  page fixes the issue and picks requirements. Both end in `linkImplementsPairs`,
  which calls the ONE `linkImplements` command once per pair on a key derived
  from the PAIR — so the two directions land on the same ledger row and the same
  edge, and neither can produce a second one. A mirrored component for the
  reverse direction would have to reproduce the server matrix check, the pair
  claim and the two activity records, and would drift from them the first time
  one of the two changed.

  ⚠️ The picker never writes anything itself. A `TraceLink` created client side
  would bypass every one of those guarantees, and `DOMAIN_RELATION` is excluded
  from Activity so it would leave no audit trail at all.
-->
<script lang="ts">
  import type { Class, Doc, Ref } from '@hcengineering/core'
  import presentation, { getClient, ObjectPopup } from '@hcengineering/presentation'
  import type { IntlString } from '@hcengineering/platform'
  import tracker from '@hcengineering/tracker'
  import { ObjectPresenter } from '@hcengineering/view-resources'
  import { createEventDispatcher } from 'svelte'

  import { linkImplementsPairs, type ImplementsPair, type LinkImplementsBatch } from '../commands'

  /**
   * Which side the caller pinned. `'requirement'` means "these work items are
   * fixed, pick requirements"; `'workItem'` means the mirror image.
   */
  export let pick: 'requirement' | 'workItem'
  /**
   * The class the picker lists.
   *
   * ⚠️ Optional ONLY for the work-item side, where it defaults to
   * `tracker.class.Issue` — this package already depends on tracker (see
   * `DefectButton`), and that default is what lets `requirements-resources`
   * open the picker without taking a tracker dependency of its own. The
   * requirement side has no default: this package must not depend on the
   * requirements module, so that caller always names its own class.
   */
  export let pickClass: Ref<Class<Doc>> | undefined = undefined
  /** The already-fixed side. One entry for a detail page, many for a bulk action. */
  export let fixed: Array<Ref<Doc>>
  export let placeholder: IntlString = presentation.string.Search
  export let searchField: string = 'title'
  /** Objects already linked, so the picker can pre-tick them. */
  export let selectedObjects: Array<Ref<Doc>> = []

  const client = getClient()
  const dispatch = createEventDispatcher()

  let running = false

  $: listed = pickClass ?? (pick === 'workItem' ? (tracker.class.Issue as Ref<Class<Doc>>) : undefined)

  function pairsFor (picked: Array<Ref<Doc>>): ImplementsPair[] {
    const out: ImplementsPair[] = []
    for (const one of fixed) {
      for (const other of picked) {
        // ⚠️ The pair is always written (work item, requirement) — the edge
        // direction — never (near, far). That is what makes the key the two
        // directions derive identical.
        out.push(pick === 'requirement' ? { workItem: one, requirement: other } : { workItem: other, requirement: one })
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
      const batch: LinkImplementsBatch = await linkImplementsPairs(client, pairsFor(additions))
      dispatch('linked', batch)
    } finally {
      running = false
    }
  }
</script>

{#if listed !== undefined}
  <ObjectPopup
    _class={listed}
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
{/if}
