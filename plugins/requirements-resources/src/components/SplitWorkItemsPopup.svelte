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
  PM-006: split one requirement into a batch of work items, each carrying an
  `implements` edge back to it. The ONLY entry point to the `createWorkItems`
  command, which until now had no UI at all.

  🔴 THE BATCH IS MINTED HERE, ONCE, WHEN THE COMPONENT IS CREATED — never in
  the submit handler. `createWorkItemsIdempotencyKey(requirement, batch)` is
  what the server dedupes on and what every derived issue `_id` hangs off, so a
  per-click batch turns the second click into a SECOND COMPLETE SET of work
  items. See `mintWorkItemBatch` in `../workItems` for the full argument. The
  `const` is load bearing: making it reactive (`$:`) would re-mint it whenever
  any prop changed.

  🔴 THE PROJECT IS PART OF THE SUBJECT, not a detail of the payload. The server
  namespaces the ledger row AND every derived id on `(requirement, project,
  key)` while this client's key carries only `(requirement, batch)`, so a retry
  with the project switched is a NEW batch in disguise — it files a full second
  set into the new project. It is therefore asked for explicitly (never guessed
  from anything) and frozen, together with the row list, the moment the first
  attempt goes out.
-->
<script lang="ts">
  import type { Class, Doc, Ref, Space } from '@hcengineering/core'
  import { Card as CardDialog, getClient } from '@hcengineering/presentation'
  import { createWorkItems } from '@hcengineering/traceability-resources'
  import { Button, CheckBox, DropdownLabels, EditBox, Label, Spinner } from '@hcengineering/ui'
  import type { DropdownTextItem } from '@hcengineering/ui'
  import { createEventDispatcher, onMount } from 'svelte'

  import requirements from '../plugin'
  import {
    TRACKER_PROJECT_CLASS,
    applyOutcome,
    beginAttempt,
    canSubmit,
    createSplitState,
    createWorkItemsReasonLabel,
    emptyRow,
    isSubjectFrozen,
    mayHaveWritten,
    mintWorkItemBatch,
    splitCounts,
    type SplitState
  } from '../workItems'

  /** The requirement being split. Fixed for the life of the dialog. */
  export let requirement: Ref<Doc>

  const client = getClient()
  const dispatch = createEventDispatcher()

  // 🔴 ONE MINT PER OPENED DIALOG. Do not turn this into a reactive statement.
  const batch = mintWorkItemBatch()

  let state: SplitState = createSplitState(batch)
  let running = false
  let projects: Space[] = []
  /**
   * The project list could not be read AT ALL — as opposed to "this workspace
   * has no projects yet", which is an empty `projects` and a legitimate state.
   *
   * 🔴 THIS IS THE TRIPWIRE UNDER `TRACKER_PROJECT_CLASS`. That id is a string
   * literal precisely so this package needs no tracker dependency, and the risk
   * a literal carries is that it stops matching. Without the two guards below
   * that failure surfaces as an EMPTY DROPDOWN plus an unhandled promise
   * rejection in the console (`Client.findAll` calls
   * `hierarchy.getDomain(_class)`, which THROWS `domain not found: …` for an id
   * the model does not carry) — i.e. it looks exactly like "no projects yet",
   * which is the one reading that would send a user hunting in the wrong place.
   */
  let projectsUnavailable = false

  $: frozen = isSubjectFrozen(state)
  $: ready = canSubmit(state) && !running
  $: outcome = state.outcome
  $: projectItems = projects.map((project): DropdownTextItem => ({ id: project._id, label: project.name }))

  onMount(() => {
    void loadProjects()
  })

  /**
   * ⚠️ Read as `Space`, which is what a tracker `Project` derives from, so this
   * package still needs no tracker dependency — see `TRACKER_PROJECT_CLASS`.
   * Archived projects are left out: filing a fresh batch into one is never the
   * intent, and the list is the only place the mistake could be made.
   */
  async function loadProjects (): Promise<void> {
    // Asked BEFORE the query, because `findAll` would throw rather than answer:
    // `hasClass` is the one cheap question that separates "this deployment has
    // no tracker" and "the id no longer matches" from "no projects yet".
    if (!client.getHierarchy().hasClass(TRACKER_PROJECT_CLASS)) {
      projectsUnavailable = true
      console.error(`requirements: ${TRACKER_PROJECT_CLASS} is not in this model — cannot list projects`)
      return
    }
    try {
      projects = await client.findAll<Space>(TRACKER_PROJECT_CLASS as Ref<Class<Space>>, { archived: false })
    } catch (err: unknown) {
      // Not swallowed — turned into a state the dialog renders.
      projectsUnavailable = true
      console.error('requirements: failed to read tracker projects', err)
    }
  }

  function addRow (): void {
    if (frozen) return
    state = { ...state, rows: [...state.rows, emptyRow()] }
  }

  function removeRow (id: string): void {
    if (frozen) return
    const rows = state.rows.filter((row) => row.id !== id)
    // Never leave the dialog with nothing to type into.
    state = { ...state, rows: rows.length > 0 ? rows : [emptyRow()] }
  }

  function toggleRow (id: string, selected: boolean): void {
    if (frozen) return
    state = { ...state, rows: state.rows.map((row) => (row.id === id ? { ...row, selected } : row)) }
  }

  function retitleRow (id: string, title: string): void {
    if (frozen) return
    state = { ...state, rows: state.rows.map((row) => (row.id === id ? { ...row, title } : row)) }
  }

  function pickProject (project: string): void {
    if (frozen) return
    state = { ...state, project: project as Ref<Doc> }
  }

  /**
   * `PopupInstance.escapeClose` asks the mounted component before it tears the
   * dialog down, and BOTH accidental dismissals — `Escape` and a click on the
   * overlay — go through it.
   *
   * 🔴 REFUSING WHILE A REQUEST IS IN FLIGHT IS NOT POLITENESS. Losing the
   * dialog loses the batch, and the only way back in mints a NEW one: a request
   * that was landing while the overlay was clicked would be written a second
   * time, in full, under different derived ids. The header's close button
   * bypasses this hook, which is correct — abandoning a batch has to stay
   * possible, it just must not happen by accident.
   */
  export function canClose (): boolean {
    return !running
  }

  async function submit (): Promise<void> {
    if (!canSubmit(state) || running) return
    running = true
    try {
      // `beginAttempt` is what freezes the subject, and it reads `state.batch`
      // rather than minting one — the retry below therefore travels on the very
      // same key as the attempt that failed.
      const attempt = beginAttempt(state)
      state = attempt.state
      const result = await createWorkItems(client, requirement, attempt.project, attempt.items, attempt.batch)
      state = applyOutcome(state, result)
      if (result.kind === 'ok') {
        // The caller reloads its edge list on close, so a successful batch shows
        // up without this component knowing anything about the section.
        dispatch('created', result.result)
      } else {
        // Surfaced, never swallowed — a refusal means nothing was filed, and the
        // dialog says so rather than sitting on its opening hint.
        console.error('requirements: createWorkItems did not succeed', result)
      }
    } finally {
      running = false
    }
  }
</script>

<!--
  🔴 THE SUBMIT BUTTON IS IN THE BODY, NOT IN THE CARD'S FOOTER, AND THAT IS NOT
  cosmetic. `Card.handleOkClick` (packages/presentation) dispatches `close` as
  soon as `okAction`'s promise RESOLVES — success or failure alike — and
  `createWorkItems` resolves on every path, because it turns refusals and
  transport errors into an outcome rather than throwing. Wiring submit to
  `okAction` would therefore tear the dialog down on a 409 or a dropped
  connection, and the user's only way back in mints a NEW BATCH over NEW derived
  ids: a half-written batch would be written a second time in full. That is the
  precise duplication this whole component is built to prevent.

  `canSave={false}` keeps the same accident off the keyboard path: `Enter` and
  `Ctrl+Enter` both route through `handleOkClick`, which does nothing unless
  `canSave` is set.
-->
<CardDialog
  label={requirements.string.SplitIntoWorkItems}
  okAction={() => {}}
  canSave={false}
  hideFooter
  width={'medium'}
  on:close={() => {
    dispatch('close')
  }}
>
  <div class="split flex-col flex-gap-3">
    <div class="split__hint"><Label label={requirements.string.SplitHint} /></div>

    <!--
      🔴 `autoSelect={false}`. Filing a batch into whichever project happened to
      sort first is exactly the mistake `DefectButton` refuses to make ("the
      project is asked for rather than guessed"), and here it would be worse:
      the project also decides which ledger row and which derived ids the batch
      lands on.
    -->
    <div class="split__project">
      <span class="split__label"><Label label={requirements.string.SplitProject} /></span>
      <DropdownLabels
        items={projectItems}
        selected={state.project}
        placeholder={requirements.string.SplitPickProject}
        kind={'regular'}
        size={'medium'}
        justify={'left'}
        disabled={frozen}
        autoSelect={false}
        allowDeselect={false}
        showDropdownIcon
        dataId={'split-work-items-project'}
        on:selected={(evt) => {
          pickProject(String(evt.detail))
        }}
      />
    </div>

    {#if projectsUnavailable}
      <!--
        ⚠️ Said out loud rather than left as an empty dropdown. Submitting is
        already impossible (`canSubmit` requires a project), so the only thing
        missing was telling the user WHY — and "the project list could not be
        read" points at the deployment, where the fault is, instead of at the
        user's own workspace.
      -->
      <div class="split__warning"><Label label={requirements.string.SplitProjectsUnavailable} /></div>
    {/if}

    <div class="split__rows flex-col flex-gap-2">
      {#each state.rows as row (row.id)}
        <div class="split__row flex-row-center flex-gap-2">
          <CheckBox
            checked={row.selected}
            readonly={frozen}
            on:value={(evt) => {
              toggleRow(row.id, evt.detail)
            }}
          />
          <div class="split__title">
            <EditBox
              value={row.title}
              placeholder={requirements.string.SplitWorkItemTitle}
              disabled={frozen}
              on:value={(evt) => {
                retitleRow(row.id, String(evt.detail ?? ''))
              }}
            />
          </div>
          {#if !frozen}
            <Button
              label={requirements.string.SplitRemoveWorkItem}
              kind={'ghost'}
              size={'small'}
              on:click={() => {
                removeRow(row.id)
              }}
            />
          {/if}
        </div>
      {/each}
    </div>

    {#if !frozen}
      <div>
        <Button
          label={requirements.string.SplitAddWorkItem}
          kind={'regular'}
          size={'small'}
          id={'split-work-items-add'}
          on:click={addRow}
        />
      </div>
    {:else if ready || running}
      <!--
        Says WHY the rows went read-only, and it is shown ONLY while the retry
        button is actually on screen: its whole point is to steer the user to
        that button rather than to close-and-re-open. After a refusal that
        cannot be retried there is nothing to steer towards, and the reason line
        below already explains itself.
      -->
      <div class="split__frozen"><Label label={requirements.string.SplitFrozen} /></div>
    {/if}

    {#if outcome !== undefined}
      {#if outcome.kind === 'ok'}
        {@const counts = splitCounts(outcome.result)}
        <div class="split__ok">
          <Label label={requirements.string.SplitSucceeded} params={counts} />
        </div>
      {:else if outcome.kind === 'refused' && outcome.retryable}
        <!-- 409: the result does not exist YET. Retrying on the same key is the
             correct advice, and cannot double-create. -->
        <div class="split__wait"><Label label={requirements.string.SplitInProgress} /></div>
      {:else if outcome.kind === 'refused'}
        <!--
          🔴 A 400 IS NOT PROOF THAT NOTHING WAS WRITTEN. The server writes the
          batch one issue at a time and rolls nothing back, so
          `sequence-unavailable` / `task-type-not-found` / `issue-id-taken` can
          all arrive with part of the batch already committed. Saying "nothing
          was created" there would send the user to close-and-re-open, which is
          the one action that duplicates.
        -->
        <div class="split__error">
          <Label
            label={mayHaveWritten(outcome) ? requirements.string.SplitRefusedPartial : requirements.string.SplitRefused}
          />
        </div>
        <div class="split__reason"><Label label={createWorkItemsReasonLabel(outcome.reason)} /></div>
      {:else if outcome.kind === 'errored'}
        <!-- The call may have half-run, so this must NOT claim nothing changed. -->
        <div class="split__error"><Label label={requirements.string.SplitErrored} /></div>
      {:else}
        <div class="split__error"><Label label={requirements.string.SplitUnavailable} /></div>
      {/if}
    {/if}

    {#if running}
      <div class="split__spinner"><Spinner size={'small'} /></div>
    {/if}

    {#if ready || running}
      <div class="split__submit">
        <Button
          label={frozen ? requirements.string.SplitRetry : requirements.string.SplitCreate}
          kind={'primary'}
          size={'medium'}
          loading={running}
          disabled={!ready}
          id={'split-work-items-submit'}
          on:click={() => {
            void submit()
          }}
        />
      </div>
    {/if}
  </div>
</CardDialog>

<style lang="scss">
  .split {
    width: 100%;
    padding: 0 1rem 1rem;
  }
  .split__hint,
  .split__reason,
  .split__frozen {
    font-size: 0.8125rem;
    color: var(--theme-dark-color);
  }
  .split__project {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .split__label {
    color: var(--theme-dark-color);
  }
  .split__title {
    flex-grow: 1;
    min-width: 0;
  }
  .split__ok {
    color: var(--theme-caption-color);
  }
  .split__wait {
    color: var(--theme-warning-color);
  }
  .split__error {
    color: var(--theme-error-color);
  }
  .split__warning {
    font-size: 0.8125rem;
    color: var(--theme-warning-color);
  }
  .split__submit {
    display: flex;
    justify-content: flex-end;
  }
</style>
