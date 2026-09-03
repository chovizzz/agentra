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
  import { createEventDispatcher, onMount } from 'svelte'

  import { AttachmentStyleBoxCollabEditor } from '@hcengineering/attachment-resources'
  import { ActionContext, createQuery, getClient } from '@hcengineering/presentation'
  import { type Class, type Ref } from '@hcengineering/core'
  import { isTestCaseContentFrozen, type TestCase } from '@hcengineering/test-management'
  import { Panel } from '@hcengineering/panel'
  import { EditBox, Breadcrumb, Label } from '@hcengineering/ui'
  import { DocAttributeBar } from '@hcengineering/view-resources'
  import { StyledTextBox } from '@hcengineering/text-editor-resources'

  import StatusEditor from './StatusEditor.svelte'
  import TestCaseTraceability from './TestCaseTraceability.svelte'
  import TestSteps from './TestSteps.svelte'
  import testManagement from '../../plugin'

  export let _id: Ref<TestCase>
  export let _class: Ref<Class<TestCase>>

  let object: TestCase | undefined

  const dispatch = createEventDispatcher()
  const client = getClient()
  const hierarchy = client.getHierarchy()

  let oldLabel: string | undefined = ''
  let rawLabel: string | undefined = ''
  let descriptionBox: AttachmentStyleBoxCollabEditor

  const query = createQuery()

  $: _id !== undefined &&
    _class !== undefined &&
    query.query(_class, { _id }, async (result) => {
      ;[object] = result
    })

  /**
   * QA-T019: an `Approved` case is read-only.
   *
   * ⚠️ THIS IS THE EXPERIENCE, NOT THE ENFORCEMENT. Every control below is
   * disabled while `frozen`, and this early return catches the ones that fire
   * from a blur or a debounce after the flag flipped — but the rule that
   * actually holds is `SnapshotGuardMiddleware`'s, because the import tool, a
   * REST caller and a script never load this component.
   *
   * 🔴 THE CLIENT IS NEVER MORE PERMISSIVE THAN THE SERVER. It freezes exactly
   * `APPROVED_TEST_CASE_FROZEN_FIELDS` (via {@link isTestCaseContentFrozen}) and
   * it freezes `status` NOWHERE — the status control below stays live, since
   * moving the case back to review is the only way out of the gate and a UI
   * that greyed it out would be a dead end rather than a gate.
   */
  async function change<K extends keyof TestCase> (field: K, value: TestCase[K]) {
    if (object !== undefined && !frozen) {
      await client.update(object, { [field]: value })
    }
  }

  $: if (oldLabel !== object?.name) {
    oldLabel = object?.name
    rawLabel = object?.name
  }

  $: frozen = object !== undefined && isTestCaseContentFrozen(object)
  // `status` leaves the attribute bar while frozen because the bar is readonly
  // as a whole and there is no per-key switch; the banner below carries the
  // live control instead, so the escape hatch never disappears.
  $: ignoreKeys = frozen ? ['name', 'status'] : ['name']

  $: descriptionKey = hierarchy.getAttribute(testManagement.class.TestCase, 'description')

  onMount(() => dispatch('open', { ignoreKeys: [] }))
</script>

{#if object}
  <ActionContext context={{ mode: 'editor' }} />
  <Panel
    {object}
    isHeader={false}
    isAside={false}
    isSub={false}
    adaptive={'disabled'}
    on:open
    on:close={() => dispatch('close')}
  >
    <svelte:fragment slot="title">
      <Breadcrumb icon={testManagement.icon.TestCase} title={object.name} size={'large'} isCurrent />
    </svelte:fragment>

    {#if frozen}
      <div class="approved-banner flex-row-center flex-gap-2 mt-4">
        <span class="fs-bold"><Label label={testManagement.string.ApprovedCaseReadonly} /></span>
        <span class="content-dark-color"><Label label={testManagement.string.ApprovedCaseReadonlyHint} /></span>
        <StatusEditor value={object.status} {object} kind={'regular'} size={'small'} />
      </div>
    {/if}

    <EditBox
      bind:value={rawLabel}
      disabled={frozen}
      placeholder={testManagement.string.NamePlaceholder}
      kind="large-style"
      on:blur={async () => {
        const trimmedLabel = rawLabel?.trim()

        if (trimmedLabel?.length === 0) {
          rawLabel = oldLabel
        } else if (trimmedLabel !== object?.name) {
          await change('name', trimmedLabel ?? '')
        }
      }}
    />

    <div class="w-full mt-6">
      <AttachmentStyleBoxCollabEditor
        focusIndex={30}
        {object}
        key={{ key: 'description', attr: descriptionKey }}
        bind:this={descriptionBox}
        identifier={object?._id}
        readonly={frozen}
        placeholder={testManagement.string.DescriptionPlaceholder}
      />
    </div>

    <div class="w-full mt-6">
      <span class="fs-title"><Label label={testManagement.string.Preconditions} /></span>
      <StyledTextBox
        alwaysEdit={!frozen}
        readonly={frozen}
        showButtons={false}
        isScrollable={false}
        content={object.preconditions ?? ''}
        placeholder={testManagement.string.DescriptionPlaceholder}
        on:value={(evt) => {
          void change('preconditions', evt.detail)
        }}
      />
    </div>

    <div class="w-full mt-6">
      <TestSteps {object} />
    </div>

    <div class="w-full mt-6">
      <TestCaseTraceability {object} />
    </div>

    <svelte:fragment slot="aside">
      <DocAttributeBar {object} {ignoreKeys} readonly={frozen} />
    </svelte:fragment>
  </Panel>
{/if}

<style lang="scss">
  .approved-banner {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.375rem;
    background-color: var(--theme-warning-color-10, var(--theme-bg-accent-color));
  }
</style>
