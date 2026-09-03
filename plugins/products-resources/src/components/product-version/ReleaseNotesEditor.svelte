<!--
//
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
//

  REL-005: generate editable release notes, classified into requirements,
  improvements and bug fixes. PRD §7.5 requires the release page to show them.

  🔴 GENERATE, THEN EDIT — and generation never silently overwrites. Any
  non-empty body is confirmed first (`releaseNotesNeedConfirmation`), because
  nothing in the schema records "a human touched this": `modifiedOn` moves on
  every unrelated edit to the version and `releaseNotesGeneratedOn` only says
  when the generator last ran. Over-asking is recoverable; over-writing is not.

  🔴 A RELEASED VERSION'S NOTES ARE READ ONLY. Once shipped, the body is the
  audit statement of what shipped. `isFrozenProductVersionState` also covers
  `Archived`, whose documents were copied forward to a child version.

  🔴 A POINT-IN-TIME SNAPSHOT. `delivered-in` does not inherit on revision
  (Task 18a), so the notes describe the scope AT GENERATION TIME; editing a
  requirement afterwards does not rewrite them, and `releaseNotesGeneratedOn` is
  what makes that visible instead of surprising.
-->
<script lang="ts">
  import { translate } from '@hcengineering/platform'
  import { MessageBox, MessageViewer, getClient } from '@hcengineering/presentation'
  import { StyledTextBox } from '@hcengineering/text-editor-resources'
  import { Button, Label, showPopup, themeStore } from '@hcengineering/ui'
  import { isFrozenProductVersionState, type ProductVersion } from '@hcengineering/products'

  import {
    buildReleaseNotes,
    releaseNotesNeedConfirmation,
    renderReleaseNotes,
    type ReleaseNotesLabels
  } from '../../releaseNotes'
  import { collectReleaseNotesScope } from '../../releaseNotesScope'
  import { previewReleaseGate } from '../../release'
  import products from '../../plugin'

  export let object: ProductVersion
  export let readonly: boolean = false

  const client = getClient()

  let generating: boolean = false

  $: frozen = isFrozenProductVersionState(object.state)
  $: canEdit = !readonly && !frozen
  $: notes = object.releaseNotes ?? ''

  /**
   * 🔴 Translated HERE, at generation time, and frozen into the stored body.
   * The notes are a hand editable artefact — re-translating the headings around
   * a line somebody corrected would mean rewriting a document they own. So the
   * body keeps the language it was generated in.
   */
  async function sectionLabels (): Promise<ReleaseNotesLabels> {
    const lang = $themeStore.language
    const [requirements, improvements, bugFixes, other, restricted, empty] = await Promise.all([
      translate(products.string.SectionRequirements, {}, lang),
      translate(products.string.SectionImprovements, {}, lang),
      translate(products.string.SectionBugFixes, {}, lang),
      translate(products.string.SectionOther, {}, lang),
      translate(products.string.ReleaseNotesRestricted, {}, lang),
      translate(products.string.ReleaseNotesEmpty, {}, lang)
    ])
    return { requirements, improvements, 'bug-fixes': bugFixes, other, restricted, empty }
  }

  async function generate (): Promise<void> {
    if (generating || !canEdit) {
      return
    }
    generating = true
    try {
      // ⚠️ Read through the CALLER's client, never a privileged one. What the
      // release manager may not read must not appear in the notes; the missing
      // entries collapse into one line with no count.
      //
      // 🔴 THE CLIENT'S OWN "restricted" ANSWER IS ONLY A LOWER BOUND. It is
      // inferred by comparing how many rows came back against how many were
      // asked for, so it sees an Issue that was filtered out — and cannot see a
      // Requirement or a trace edge that was filtered out, because those leave
      // no trace in the browser at all. The gate preview is evaluated against
      // the global view and reports the accurate answer, so pass it in as a
      // hint. `collectReleaseNotesScope` ORs it with what it observed: a hint
      // saying "yes" wins, a hint saying "no" cannot clear a restriction the
      // client did see.
      //
      // ⚠️ Deliberately best-effort. The preview is a server round trip that
      // can be refused or fail, and none of that should stop a release manager
      // from generating notes — an absent hint just falls back to the lower
      // bound, which is what this line did before.
      const preview = await previewReleaseGate(client, { version: object._id })
      const restrictedHint = preview.kind === 'ready' ? preview.result.gate.restricted : undefined
      const scope = await collectReleaseNotesScope(client, object._id, { restrictedHint })
      const markup = renderReleaseNotes(buildReleaseNotes(scope), await sectionLabels())
      await client.update(object, {
        releaseNotes: markup,
        releaseNotesGeneratedOn: Date.now()
      })
    } finally {
      generating = false
    }
  }

  function onGenerate (): void {
    if (!releaseNotesNeedConfirmation(object.releaseNotes)) {
      void generate()
      return
    }
    showPopup(MessageBox, {
      label: products.string.ReleaseNotesOverwriteTitle,
      message: products.string.ReleaseNotesOverwriteConfirm,
      action: generate
    })
  }
</script>

<div class="release-notes flex-col flex-gap-2">
  <div class="release-notes__header flex-row-center flex-gap-2">
    <span class="release-notes__title"><Label label={products.string.ReleaseNotes} /></span>
    {#if object.releaseNotesGeneratedOn !== undefined}
      <span class="release-notes__stamp">
        <Label label={products.string.ReleaseNotesGeneratedOn} />
        {new Date(object.releaseNotesGeneratedOn).toLocaleString()}
      </span>
    {/if}
    {#if canEdit}
      <Button
        label={object.releaseNotes === undefined
          ? products.string.GenerateReleaseNotes
          : products.string.RegenerateReleaseNotes}
        kind={'regular'}
        size={'small'}
        disabled={generating}
        on:click={onGenerate}
      />
    {/if}
  </div>

  {#if frozen}
    <div class="release-notes__note"><Label label={products.string.ReleaseNotesReadonly} /></div>
  {/if}

  {#if canEdit}
    <StyledTextBox
      alwaysEdit
      showButtons={false}
      content={notes}
      placeholder={products.string.ReleaseNotesEmpty}
      on:value={(evt) => {
        void client.update(object, { releaseNotes: evt.detail })
      }}
    />
  {:else if notes !== ''}
    <MessageViewer message={notes} />
  {:else}
    <div class="release-notes__note"><Label label={products.string.ReleaseNotesEmpty} /></div>
  {/if}
</div>

<style lang="scss">
  .release-notes {
    font-size: 0.8125rem;
  }
  .release-notes__title {
    font-weight: 600;
    color: var(--theme-caption-color);
  }
  .release-notes__stamp,
  .release-notes__note {
    color: var(--theme-darker-color);
  }
</style>
