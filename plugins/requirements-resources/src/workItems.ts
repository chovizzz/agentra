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

import { generateId, type Class, type Doc, type Ref } from '@hcengineering/core'
import type { IntlString } from '@hcengineering/platform'
// ⚠️ TYPE-ONLY, and it has to stay that way. `@hcengineering/traceability-resources`
// re-exports Svelte components from its entry point, so a VALUE import here
// would drag the Svelte runtime into this module — and this module is imported
// directly by the node-environment unit tests. The same rule `sections.ts`
// states for `@hcengineering/presentation`.
import type { CommandOutcomeView, CreateWorkItemsResult, WorkItemDraft } from '@hcengineering/traceability-resources'

import requirements from './plugin'

/**
 * The tracker project class, as a plugin id rather than as an import.
 *
 * 🔴 DELIBERATELY NOT `import tracker from '@hcengineering/tracker'`. This
 * package has no tracker dependency and must not grow one for a single `Ref`:
 * that is the same decision `RequirementDeliverySection` records when it leaves
 * `pickClass` unset and lets `LinkImplementsPopup` supply
 * `tracker.class.Issue`. There is no equivalent donor for the PROJECT class, so
 * the id is written out. It is a persisted plugin id — the model builds every
 * project document under it — so it is exactly as stable as the string
 * `'agentra-command'` that `traceability-resources` copies for the same reason.
 *
 * ⚠️ The projects are read as `core.class.Space` (which is what `Project`
 * derives from) wherever a field is needed, so nothing here depends on the
 * tracker-specific shape either.
 *
 * @public
 */
export const TRACKER_PROJECT_CLASS = 'tracker:class:Project' as Ref<Class<Doc>>

/**
 * One editable row of the split dialog.
 *
 * `id` exists only so Svelte's keyed `{#each}` does not recycle inputs when a
 * row above is removed; it never reaches the server. The SERVER's coordinate is
 * the LIST INDEX (`createWorkItemsRoles.issue(index)`), which is why
 * {@link isSubjectFrozen} forbids editing the list once an attempt has been
 * made.
 *
 * @public
 */
export interface WorkItemRow {
  id: string
  title: string
  selected: boolean
}

/**
 * The whole dialog, as a value.
 *
 * Kept a plain data structure rather than a bag of Svelte `let`s so the rules
 * that actually matter — batch stability, the frozen subject, what may be
 * submitted — are unit testable without a Svelte runtime.
 *
 * @public
 */
export interface SplitState {
  /** 🔴 Minted ONCE, when the dialog opens. See {@link mintWorkItemBatch}. */
  batch: string
  project: Ref<Doc> | undefined
  rows: WorkItemRow[]
  /** How many times the command has been CALLED, successfully or not. */
  attempts: number
  outcome: CommandOutcomeView<CreateWorkItemsResult> | undefined
}

/**
 * Mint the `batch` component of the idempotency key.
 *
 * 🔴 CALL THIS EXACTLY ONCE PER OPENED DIALOG, AND NEVER ON SUBMIT. The key the
 * server dedupes on is `createWorkItemsIdempotencyKey(requirement, batch)`, and
 * every issue `_id` the command derives hangs off it. Minting per click makes
 * every retry a NEW ledger row over NEW derived ids, so a user who clicks
 * "create" twice — or clicks once, gets a timeout, and clicks again — gets TWO
 * COMPLETE SETS of work items. The idempotency machinery would still be
 * correct; it would simply never be consulted, which is the failure mode
 * `traceability-resources/src/commands.ts` warns about in
 * {@link createWorkItemsIdempotencyKey}.
 *
 * ⚠️ THIS IS NOT THE `generateId()` THE COMMAND LAYER FORBIDS. That rule is
 * about OBJECT IDENTITY: a command must never call `generateId()` to name a
 * document, because a replay would then name a second one. A batch is not an
 * identity, it is the caller's statement of "which split this is" — the one
 * input the server cannot derive, because two splits of one requirement are two
 * legitimate intents. `crm-lite-resources/src/components/LeadIntakeForm.svelte`
 * mints its `submissionId` the same way and for the same reason.
 *
 * ⚠️ A NEW DIALOG IS A NEW BATCH, on purpose. Re-opening the dialog means the
 * user wants to split the requirement FURTHER, and those work items must not
 * collide with the first batch's.
 *
 * @public
 */
export function mintWorkItemBatch (): string {
  return generateId()
}

/**
 * A freshly opened dialog: one empty, ticked row and the batch it will keep for
 * its whole life.
 *
 * ⚠️ The batch is a PARAMETER rather than minted in here, so the caller is the
 * one place that decides when a batch begins — and so a test can pin it.
 *
 * @public
 */
export function createSplitState (batch: string): SplitState {
  return {
    batch,
    project: undefined,
    rows: [emptyRow()],
    attempts: 0,
    outcome: undefined
  }
}

/**
 * @public
 */
export function emptyRow (): WorkItemRow {
  return { id: generateId(), title: '', selected: true }
}

/**
 * The rows that would actually be sent, in list order.
 *
 * ⚠️ ORDER AND MEMBERSHIP ARE THE CONTRACT, not just the titles: the server
 * derives issue `_id` number `n` from the list POSITION, so two calls that
 * differ by one dropped row are two different sets of ids, not an edit of the
 * first set. {@link isSubjectFrozen} is what keeps that from happening across a
 * retry.
 *
 * @public
 */
export function selectedDrafts (state: SplitState): WorkItemDraft[] {
  return state.rows
    .filter((row) => row.selected && row.title.trim().length > 0)
    .map((row) => ({
      title: row.title.trim()
    }))
}

/**
 * 🔴 AFTER THE FIRST ATTEMPT THE SUBJECT IS FIXED — the project AND the row
 * list, not just one of them.
 *
 * The project, because it is part of the subject on the server side and NOT
 * part of the key on this side: the ledger namespace is
 * `CreateWorkItems:<requirement>:<project>` while the client key is
 * `…:<requirement>:<batch>`. Retrying with the project switched therefore does
 * not resume the first attempt, it starts a SECOND one — one that will happily
 * file a full set of work items into the new project while whatever the first
 * attempt managed to write stays in the old one. An `errored` outcome cannot
 * even tell us whether that happened.
 *
 * The rows, because the derived id of item `n` is a function of its INDEX.
 * Adding, removing or re-ordering rows between two attempts re-points every id
 * from the edit onwards, so the retry both duplicates the items it shifted and
 * strands the originals. Editing a title is just as bad in the other direction:
 * the id is unchanged, the server finds the issue already written and skips it,
 * so the corrected title is silently discarded.
 *
 * The escape hatch is deliberately "close and re-open" — that is what mints a
 * new batch, and a new batch is precisely what a different set of work items
 * needs.
 *
 * @public
 */
export function isSubjectFrozen (state: SplitState): boolean {
  return state.attempts > 0
}

/**
 * The refusals that PROVE nothing was written.
 *
 * 🔴 THE SERVER'S 400 DOES NOT MEAN "NOTHING HAPPENED", and assuming it does is
 * how this dialog would create duplicates. `runCreate` writes the batch ONE
 * ISSUE AT A TIME and nothing rolls back
 * (`server-plugins/agentra-core-resources/src/commands/createWorkItems.ts`), so
 * `task-type-not-found`, `sequence-unavailable` and `issue-id-taken` can all be
 * raised from item `n` with items `0…n-1` already committed — and every
 * `CreateWorkItemsError` carries `code = 400`, which this client renders as
 * `retryable: false`.
 *
 * The five listed here are the only ones raised BEFORE the write loop begins
 * (or by the middleware, in the case of `malformed-input`), so for those, and
 * only for those, "nothing was created" is a true statement and repeating the
 * call cannot help.
 */
const CLEAN_REFUSALS = new Set([
  'requirement-not-found',
  'requirement-not-latest',
  'project-not-found',
  'no-items',
  'malformed-input'
])

/**
 * Whether this outcome may have left work items behind.
 *
 * ⚠️ This is the question the COPY has to answer honestly. Telling a user that
 * nothing was created when half the batch exists sends them to "close and
 * re-open", which mints a new batch and writes the surviving half a second
 * time — the exact duplication the whole idempotency design exists to prevent.
 *
 * @public
 */
export function mayHaveWritten (outcome: CommandOutcomeView<CreateWorkItemsResult> | undefined): boolean {
  if (outcome === undefined) return false
  switch (outcome.kind) {
    case 'ok':
      return true
    case 'unavailable':
      // The domain request was never routed, so no body ever ran.
      return false
    case 'errored':
      // The reply was lost, not the request. It may well have run.
      return true
    case 'refused':
      return !CLEAN_REFUSALS.has(outcome.reason)
  }
}

/**
 * Whether the "create" button may be offered again.
 *
 * 🔴 RETRYING ON THE SAME KEY IS THE SAFE MOVE, AND IT IS THE ONLY ONE. Every
 * outcome that may have written something stays retryable here even when the
 * server called it terminal, because the alternative the user is otherwise left
 * with — close the dialog and open a new one — is the DANGEROUS action: it
 * mints a new batch and re-derives every id. A retry cannot duplicate anything;
 * at worst it reports the same refusal again.
 *
 * `ok` is withdrawn (repeating it could only replay the stored result) and so
 * is `unavailable` (nothing is routed, so nothing will change).
 */
function isRetryable (outcome: CommandOutcomeView<CreateWorkItemsResult> | undefined): boolean {
  if (outcome === undefined) return true
  switch (outcome.kind) {
    case 'ok':
      return false
    case 'unavailable':
      return false
    case 'errored':
      return true
    case 'refused':
      // A 409 says the result does not exist YET. A 400 over a half-written
      // batch says the batch needs picking up, not abandoning.
      return outcome.retryable || mayHaveWritten(outcome)
  }
}

/**
 * Whether the "create" button may be offered.
 *
 * @public
 */
export function canSubmit (state: SplitState): boolean {
  if (state.project === undefined) return false
  if (selectedDrafts(state).length === 0) return false
  return isRetryable(state.outcome)
}

/**
 * Record that an attempt is being made. Returns the payload, so that the one
 * function that freezes the subject is also the one that reads it.
 *
 * 🔴 IT DOES NOT TOUCH `batch`. That is the whole point of this module.
 *
 * @public
 */
export function beginAttempt (state: SplitState): {
  state: SplitState
  project: Ref<Doc>
  items: WorkItemDraft[]
  batch: string
} {
  if (state.project === undefined) {
    throw new Error('createWorkItems: refusing to submit a batch with no project')
  }
  return {
    state: { ...state, attempts: state.attempts + 1, outcome: undefined },
    project: state.project,
    items: selectedDrafts(state),
    batch: state.batch
  }
}

/**
 * @public
 */
export function applyOutcome (state: SplitState, outcome: CommandOutcomeView<CreateWorkItemsResult>): SplitState {
  return { ...state, outcome }
}

/**
 * How a successful batch reads: what this attempt wrote versus what an earlier
 * attempt had already written.
 *
 * ⚠️ `created: false` IS A SUCCESS. It means the derived id was already taken
 * by this very batch — the retry did its job. Rendering it as a failure would
 * push the user into re-opening the dialog and creating a genuine duplicate.
 *
 * @public
 */
export function splitCounts (result: CreateWorkItemsResult): { created: number, existing: number } {
  const created = result.workItems.filter((it) => it.created).length
  return { created, existing: result.workItems.length - created }
}

/**
 * The refusal reasons `CreateWorkItemsError` can carry, plus the middleware's
 * own `malformed-input`. Listed explicitly so a reason the server adds later
 * lands on the generic label instead of on a wrong specific one.
 *
 * @public
 */
export function createWorkItemsReasonLabel (reason: string): IntlString {
  switch (reason) {
    case 'requirement-not-found':
      return requirements.string.SplitReasonRequirementNotFound
    case 'requirement-not-latest':
      return requirements.string.SplitReasonRequirementNotLatest
    case 'project-not-found':
      return requirements.string.SplitReasonProjectNotFound
    case 'task-type-not-found':
      return requirements.string.SplitReasonTaskTypeNotFound
    case 'no-items':
      return requirements.string.SplitReasonNoItems
    case 'issue-id-taken':
      return requirements.string.SplitReasonIssueIdTaken
    case 'sequence-unavailable':
      return requirements.string.SplitReasonSequenceUnavailable
    default:
      return requirements.string.SplitReasonUnknown
  }
}
