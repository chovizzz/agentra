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
  🔴 The one number rendered is the server's `summarize().visible`, verbatim. It
  already EXCLUDES every edge with an unreadable endpoint, and this component
  must never re-derive it from the link array — doing so would turn the count
  into a channel for the volume of hidden objects.

  🔴 `coverage.restricted` is deliberately NOT rendered as a number. Spec §6.2:
  "聚合计数默认也不包含无权对象，避免侧信道泄漏" — a caller who may not read
  the objects may not learn how many of them there are either. All that is
  surfaced is the boolean fact that at least one restricted link exists.
-->
<script lang="ts">
  import { Label } from '@hcengineering/ui'

  import type { TraceCoverage } from '../types'
  import traceability from '../plugin'

  export let value: TraceCoverage
</script>

<span class="trace-coverage flex-row-center flex-gap-2">
  <span class="trace-coverage__count">{value.visible}</span>
  <Label label={traceability.string.TraceLinks} />
  {#if value.restricted > 0}
    <span class="trace-coverage__restricted">
      <Label label={traceability.string.RestrictedLink} />
    </span>
  {/if}
</span>

<style lang="scss">
  .trace-coverage {
    font-size: 0.75rem;
    color: var(--theme-dark-color);
  }
  .trace-coverage__count {
    font-weight: 500;
    color: var(--theme-caption-color);
  }
  .trace-coverage__restricted {
    font-style: italic;
    color: var(--theme-darker-color);
  }
</style>
