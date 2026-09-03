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
  `verifies` ENTRY POINT 1 (test case detail page) plus the `defect-of` entry
  for a TestCase.

  ⚠️ The picker calls the SAME `linkVerifies` command as the requirement page and
  the bulk action, on the SAME pair-derived idempotency key — see
  `LinkVerifiesPopup`. Nothing here writes a `TraceLink`.
-->
<script lang="ts">
  import type { Ref } from '@hcengineering/core'
  import { getClient } from '@hcengineering/presentation'
  import requirements from '@hcengineering/requirements'
  import type { TestCase } from '@hcengineering/test-management'
  import traceability from '@hcengineering/traceability'
  import {
    DefectButton,
    LinkVerifiesPopup,
    TraceLinksSection,
    findOutgoingTraceLinks,
    isRestrictedLink
  } from '@hcengineering/traceability-resources'
  import { Button, Label, showPopup } from '@hcengineering/ui'

  export let object: TestCase

  const client = getClient()

  let verified: Array<Ref<any>> = []
  let reloadToken = 0

  $: void refresh(object?._id)

  async function refresh (_id: Ref<TestCase> | undefined): Promise<void> {
    if (_id === undefined) return
    // 🔴 OUTGOING: the matrix direction is `TestCase --verifies--> Requirement`,
    // so the case is `docA`. Asking for incoming edges here would silently
    // return nothing and the picker would offer to re-link every requirement.
    const state = await findOutgoingTraceLinks(client, { doc: _id, kinds: ['verifies'] })
    verified = state.links.filter((link) => !isRestrictedLink(link)).map((link) => link.target._id)
  }

  function link (): void {
    showPopup(
      LinkVerifiesPopup,
      {
        pick: 'requirement',
        pickClass: requirements.masterTag.Requirement,
        fixed: [object._id],
        selectedObjects: verified,
        // Requirements are Cards: their display field is `title`, not `name`.
        searchField: 'title',
        placeholder: traceability.string.LinkVerifiesToRequirement
      },
      undefined,
      () => {
        reloadToken++
        void refresh(object._id)
      }
    )
  }
</script>

<div class="trace-block">
  <div class="header">
    <span class="fs-title"><Label label={traceability.string.Traceability} /></span>
    <div class="buttons">
      <Button
        label={traceability.string.LinkVerifies}
        kind={'regular'}
        size={'small'}
        id={'test-case-link-verifies'}
        on:click={link}
      />
      <DefectButton {object} />
    </div>
  </div>
  {#key reloadToken}
    <TraceLinksSection {object} />
  {/key}
</div>

<style lang="scss">
  .trace-block {
    display: flex;
    flex-direction: column;
    width: 100%;
    gap: 0.5rem;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .buttons {
    display: flex;
    gap: 0.5rem;
  }
</style>
