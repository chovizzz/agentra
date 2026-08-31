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
  The ONE withdrawal entry point for an `implements` edge, for BOTH directions —
  the requirement page listing its work items and the issue page listing its
  requirements pass the same (work item, requirement) pair, so both land on the
  same ledger row and the same edge.

  🔴 CONFIRMED, NEVER ONE-CLICK. Withdrawing an assertion is the deliberate act
  `TraceLinkState` describes as "a human explicitly withdrew the assertion", and
  it has a consequence the word "unlink" does not convey: the server's
  `ArchivableGuard` only blocks physical deletion of an object that still
  carries a NON-revoked edge, so revoking the last one hands the delete back.
  The confirmation copy says so.

  ⚠️ The button never writes a `TraceLink` itself. A client-side write would
  bypass the caller-readability guard, the pair claim and the two activity
  records — and `DOMAIN_RELATION` is excluded from Activity, so the withdrawal
  would leave no audit trail at all.
-->
<script lang="ts">
  import type { Doc, Ref } from '@hcengineering/core'
  import { getClient, MessageBox } from '@hcengineering/presentation'
  import { Button, showPopup } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'

  import { unlinkImplements } from '../commands'
  import traceability from '../plugin'

  /** The edge SOURCE. Always the work item, never "the far end". */
  export let workItem: Ref<Doc>
  /** The edge TARGET. Always the requirement. */
  export let requirement: Ref<Doc>
  export let kind: 'regular' | 'ghost' | 'link' = 'ghost'
  export let size: 'small' | 'medium' | 'large' = 'small'

  const client = getClient()
  const dispatch = createEventDispatcher()

  let running = false

  function confirm (): void {
    if (running) return
    showPopup(
      MessageBox,
      {
        label: traceability.string.UnlinkImplementsTitle,
        message: traceability.string.UnlinkImplementsConfirm
      },
      undefined,
      (ok?: boolean) => {
        if (ok !== true) return
        void revoke()
      }
    )
  }

  async function revoke (): Promise<void> {
    running = true
    try {
      const outcome = await unlinkImplements(client, workItem, requirement)
      if (outcome.kind === 'ok') {
        // ⚠️ `alreadyRevoked` is reported, not hidden. It is a success — the
        // assertion is withdrawn — but telling the user "done" for an act
        // somebody else already performed misdescribes what just happened.
        dispatch('unlinked', outcome.result)
      } else {
        // Surfaced, never swallowed: a refused command means the edge is STILL
        // live, and a silent no-op reads as success.
        console.error('traceability: unlinkImplements refused', outcome)
        dispatch('failed', outcome)
      }
    } finally {
      running = false
    }
  }
</script>

<Button
  label={traceability.string.UnlinkImplements}
  {kind}
  {size}
  loading={running}
  id={'trace-unlink-implements-button'}
  on:click={confirm}
/>
