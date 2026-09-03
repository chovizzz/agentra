<!--
// Copyright © 2024 Hardcore Engineering Inc.
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
  import { BreadcrumbsElement } from '@hcengineering/presentation'
  import { translate } from '@hcengineering/platform'
  import { ScrollerBar, themeStore } from '@hcengineering/ui'
  import { TestRunStatus } from '@hcengineering/test-management'

  import { type TestRunStats } from '../../testRunUtils'
  import { testRunStatusAssets } from '../../types'

  export let value: TestRunStats

  let divScroll: HTMLElement

  // Driven off `testRunStatuses` rather than a hand-written list of segments.
  // The version this replaced hard-coded four `<BreadcrumbsElement>` blocks, so
  // `Skipped` had no segment at all — and, because the titles were literal
  // strings, the Blocked segment was labelled "Failed".
  const palette: Record<TestRunStatus, string> = {
    [TestRunStatus.Untested]: '#4CA6EE',
    [TestRunStatus.Blocked]: '#D27540',
    [TestRunStatus.Failed]: '#D15045',
    [TestRunStatus.Passed]: '#46A44F',
    [TestRunStatus.Skipped]: '#8E8E93'
  }

  function count (stats: TestRunStats, status: TestRunStatus): number {
    switch (status) {
      case TestRunStatus.Untested:
        return stats.untested
      case TestRunStatus.Blocked:
        return stats.blocked
      case TestRunStatus.Passed:
        return stats.completed
      case TestRunStatus.Failed:
        return stats.failed
      case TestRunStatus.Skipped:
        return stats.skipped
    }
  }

  // Display order puts the two "not a verdict" buckets at the ends.
  const order: TestRunStatus[] = [
    TestRunStatus.Untested,
    TestRunStatus.Blocked,
    TestRunStatus.Failed,
    TestRunStatus.Skipped,
    TestRunStatus.Passed
  ]

  interface Segment {
    status: TestRunStatus
    label: string
    color: string
    position: 'start' | 'middle' | 'end'
  }

  $: segments = order.map<Segment>((status, index) => ({
    status,
    label: count(value, status).toString(),
    color: palette[status],
    position: index === 0 ? 'start' : index === order.length - 1 ? 'end' : 'middle'
  }))

  async function titleOf (status: TestRunStatus, language: string): Promise<string> {
    return await translate(testRunStatusAssets[status].label, {}, language)
  }
</script>

<!--TODO: Refactor and get rid of hardcoded colors-->
<ScrollerBar gap="none" bind:scroller={divScroll}>
  {#each segments as segment (segment.status)}
    {#await titleOf(segment.status, $themeStore.language) then title}
      <BreadcrumbsElement
        noGap
        label={segment.label}
        position={segment.position}
        color={segment.color}
        fontColor="white"
        {title}
        selected
      />
    {/await}
  {/each}
</ScrollerBar>
