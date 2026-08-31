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
  import type { RequirementStatus } from '@hcengineering/requirements'
  import { Label } from '@hcengineering/ui'

  import requirements from '../plugin'

  export let value: RequirementStatus | undefined
  export let kind: string | undefined = undefined
  export let size: string | undefined = undefined

  // Display text never lives in the component: every status maps to an
  // IntlString served from `requirements-assets/lang/*.json`. That is also what
  // keeps the §3.9 split honest — `InDelivery` is the stored value, "In
  // Delivery" is only ever a translation.
  const labels: Record<RequirementStatus, IntlString> = {
    Draft: requirements.string.StatusDraft,
    Reviewing: requirements.string.StatusReviewing,
    Approved: requirements.string.StatusApproved,
    InDelivery: requirements.string.StatusInDelivery,
    Validating: requirements.string.StatusValidating,
    Released: requirements.string.StatusReleased,
    Rejected: requirements.string.StatusRejected,
    Cancelled: requirements.string.StatusCancelled
  }

  $: label = value !== undefined ? labels[value] : undefined
</script>

{#if label !== undefined}
  <span class="overflow-label" class:fs-bold={kind === 'list-header'} data-size={size}>
    <Label {label} />
  </span>
{/if}
