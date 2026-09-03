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
  import { SortingOrder, type Markup } from '@hcengineering/core'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import { StyledTextBox } from '@hcengineering/text-editor-resources'
  import { Button, IconAdd, IconDelete, IconDownOutline, IconUpOutline, Label } from '@hcengineering/ui'
  import {
    TestCaseStatus,
    addTestStep,
    rankBetween,
    registerTestCaseEdit,
    type TestCase,
    type TestStep
  } from '@hcengineering/test-management'

  import testManagement from '../../plugin'

  export let object: TestCase
  export let readonly: boolean = false

  const client = getClient()
  const query = createQuery()

  let steps: TestStep[] = []

  $: query.query(
    testManagement.class.TestStep,
    { attachedTo: object._id },
    (result) => {
      steps = result
    },
    { sort: { rank: SortingOrder.Ascending } }
  )

  /**
   * Every mutation goes through here so the two side effects can never be
   * forgotten: the revision counter advances (snapshots are keyed on it) and an
   * `Approved` case falls back into review.
   */
  async function touched (): Promise<void> {
    await registerTestCaseEdit(client, object)
  }

  async function add (): Promise<void> {
    // 🔴 The rank is computed here, client side, and NOT left to `RANK_AUTO`.
    // `RankMiddleware.setRank` looks for the last document of the class in the
    // SPACE, with no `attachedTo` term — so the server would hand this step a
    // rank derived from some other test case's last step.
    await addTestStep(client, object, { action: '', expectedResult: '' })
    await touched()
  }

  async function remove (step: TestStep): Promise<void> {
    await client.removeCollection(
      step._class,
      step.space,
      step._id,
      step.attachedTo,
      step.attachedToClass,
      step.collection
    )
    await touched()
  }

  async function move (index: number, delta: -1 | 1): Promise<void> {
    const target = index + delta
    if (target < 0 || target >= steps.length) {
      return
    }
    const step = steps[index]
    // Reinsert between the neighbour we jump over and whatever is beyond it.
    const before = delta === -1 ? steps[target - 1]?.rank : steps[target]?.rank
    const after = delta === -1 ? steps[target]?.rank : steps[target + 1]?.rank
    await client.update(step, { rank: rankBetween(before, after) })
    await touched()
  }

  async function edit (step: TestStep, key: 'action' | 'testData' | 'expectedResult', value: Markup): Promise<void> {
    if (step[key] === value) {
      return
    }
    await client.update(step, { [key]: value })
    await touched()
  }
</script>

<div class="flex-row-center flex-between mb-2">
  <span class="fs-title"><Label label={testManagement.string.Steps} /></span>
  {#if !readonly}
    <Button
      icon={IconAdd}
      kind={'ghost'}
      label={testManagement.string.AddStep}
      on:click={() => {
        void add()
      }}
    />
  {/if}
</div>

{#if object.status === TestCaseStatus.Approved && !readonly}
  <div class="mb-2 content-dark-color">
    <Label label={testManagement.string.ApprovedCaseEditWarning} />
  </div>
{/if}

{#if steps.length === 0}
  <div class="content-dark-color"><Label label={testManagement.string.NoSteps} /></div>
{:else}
  <div class="flex-col">
    {#each steps as step, index (step._id)}
      <div class="step flex-col mb-4">
        <div class="flex-row-center flex-between mb-1">
          <span class="fs-bold">{index + 1}</span>
          {#if !readonly}
            <div class="flex-row-center">
              <Button
                icon={IconUpOutline}
                kind={'ghost'}
                size={'small'}
                disabled={index === 0}
                showTooltip={{ label: testManagement.string.MoveStepUp }}
                on:click={() => {
                  void move(index, -1)
                }}
              />
              <Button
                icon={IconDownOutline}
                kind={'ghost'}
                size={'small'}
                disabled={index === steps.length - 1}
                showTooltip={{ label: testManagement.string.MoveStepDown }}
                on:click={() => {
                  void move(index, 1)
                }}
              />
              <Button
                icon={IconDelete}
                kind={'ghost'}
                size={'small'}
                showTooltip={{ label: testManagement.string.RemoveStep }}
                on:click={() => {
                  void remove(step)
                }}
              />
            </div>
          {/if}
        </div>

        <span class="label"><Label label={testManagement.string.StepAction} /></span>
        <StyledTextBox
          alwaysEdit={!readonly}
          showButtons={false}
          isScrollable={false}
          content={step.action}
          placeholder={testManagement.string.StepActionPlaceholder}
          on:value={(evt) => {
            void edit(step, 'action', evt.detail)
          }}
        />

        <span class="label mt-2"><Label label={testManagement.string.StepTestData} /></span>
        <StyledTextBox
          alwaysEdit={!readonly}
          showButtons={false}
          isScrollable={false}
          content={step.testData ?? ''}
          placeholder={testManagement.string.StepTestDataPlaceholder}
          on:value={(evt) => {
            void edit(step, 'testData', evt.detail)
          }}
        />

        <span class="label mt-2"><Label label={testManagement.string.StepExpectedResult} /></span>
        <StyledTextBox
          alwaysEdit={!readonly}
          showButtons={false}
          isScrollable={false}
          content={step.expectedResult}
          placeholder={testManagement.string.StepExpectedResultPlaceholder}
          on:value={(evt) => {
            void edit(step, 'expectedResult', evt.detail)
          }}
        />
      </div>
    {/each}
  </div>
{/if}

<style lang="scss">
  .step {
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.5rem;
    padding: 0.75rem;
  }

  .label {
    color: var(--theme-dark-color);
    font-size: 0.75rem;
  }
</style>
