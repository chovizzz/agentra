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

import type { Doc, Ref } from '@hcengineering/core'
import { createWorkItemsIdempotencyKey } from '@hcengineering/traceability-resources/src/commands'
import type { CommandOutcomeView, CreateWorkItemsResult } from '@hcengineering/traceability-resources/src/commands'

import {
  applyOutcome,
  beginAttempt,
  canSubmit,
  createSplitState,
  createWorkItemsReasonLabel,
  emptyRow,
  isSubjectFrozen,
  mayHaveWritten,
  mintWorkItemBatch,
  selectedDrafts,
  splitCounts,
  type SplitState
} from '../workItems'

const REQUIREMENT = 'req-1' as Ref<Doc>
const PROJECT_A = 'project-a' as Ref<Doc>
const PROJECT_B = 'project-b' as Ref<Doc>

function titled (state: SplitState, ...titles: string[]): SplitState {
  return { ...state, rows: titles.map((title) => ({ ...emptyRow(), title })) }
}

function ready (batch: string, ...titles: string[]): SplitState {
  const state = createSplitState(batch)
  return { ...titled(state, ...titles), project: PROJECT_A }
}

const errored: CommandOutcomeView<CreateWorkItemsResult> = { kind: 'errored', message: 'socket hang up' }
const inProgress: CommandOutcomeView<CreateWorkItemsResult> = {
  kind: 'refused',
  reason: 'claim-held',
  message: 'running',
  retryable: true
}

function ok (created: boolean[]): CommandOutcomeView<CreateWorkItemsResult> {
  return {
    kind: 'ok',
    replayed: false,
    result: {
      requirement: REQUIREMENT,
      workItems: created.map((it, index) => ({
        workItem: `issue-${index}` as Ref<Doc>,
        traceLink: `link-${index}` as Ref<Doc>,
        created: it
      }))
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 🔴 THE BATCH. This is the one invariant the whole dialog exists to hold: it
// is minted when the dialog OPENS and is the same value for every attempt made
// from that dialog. A batch minted per submit would make every retry a new
// ledger row over new derived ids, so the user who clicks twice gets two
// complete sets of work items — the precise duplicate the idempotency machinery
// is there to prevent.
// ───────────────────────────────────────────────────────────────────────────
describe('createWorkItems dialog: the batch is minted once and never moves', () => {
  it('survives three attempts, two of which failed, unchanged', () => {
    let state = ready('batch-fixed', 'Design', 'Build')
    const seen: string[] = []

    // Attempt 1 — the transport died. It may have half-run.
    let attempt = beginAttempt(state)
    seen.push(attempt.batch)
    state = applyOutcome(attempt.state, errored)

    // Attempt 2 — a claim is still held (409).
    attempt = beginAttempt(state)
    seen.push(attempt.batch)
    state = applyOutcome(attempt.state, inProgress)

    // Attempt 3 — through. Item 0 had in fact been written by attempt 1.
    attempt = beginAttempt(state)
    seen.push(attempt.batch)
    state = applyOutcome(attempt.state, ok([false, true]))

    expect(seen).toEqual(['batch-fixed', 'batch-fixed', 'batch-fixed'])
    expect(state.batch).toBe('batch-fixed')
    expect(state.attempts).toBe(3)
  })

  it('sends byte-identical idempotency keys across a retry', () => {
    let state = ready('batch-fixed', 'Design')
    const first = beginAttempt(state)
    state = applyOutcome(first.state, errored)
    const second = beginAttempt(state)

    // The key is what the server actually dedupes on; asserting on `batch`
    // alone would not notice a caller that re-derived the key from a click.
    expect(createWorkItemsIdempotencyKey(REQUIREMENT, second.batch)).toBe(
      createWorkItemsIdempotencyKey(REQUIREMENT, first.batch)
    )
  })

  it('never mutates the batch, whatever else the state does', () => {
    const state = ready('batch-fixed', 'Design')
    const after = applyOutcome(beginAttempt(state).state, errored)
    expect(after.batch).toBe(state.batch)
    // The originals are left alone too — the state is a value, so a stale
    // reference cannot resurrect an old row list on a retry.
    expect(state.attempts).toBe(0)
    expect(state.outcome).toBeUndefined()
  })

  it('mints a DIFFERENT batch for a newly opened dialog', () => {
    // Close-and-re-open is the ONLY way to plan a second, deliberate split, so
    // two mints must never collide.
    const mints = new Set([mintWorkItemBatch(), mintWorkItemBatch(), mintWorkItemBatch()])
    expect(mints.size).toBe(3)
    expect(createSplitState(mintWorkItemBatch()).batch).not.toBe(createSplitState(mintWorkItemBatch()).batch)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The subject: (requirement, project, batch). The requirement is a prop; the
// batch is above; the project is the one the user picks — and the one this
// client's key does NOT carry.
// ───────────────────────────────────────────────────────────────────────────
describe('createWorkItems dialog: the project is part of the subject', () => {
  it('refuses to submit before a project has been chosen', () => {
    const state = titled(createSplitState('b'), 'Design')
    expect(state.project).toBeUndefined()
    expect(canSubmit(state)).toBe(false)
    expect(() => beginAttempt(state)).toThrow(/no project/)
  })

  it('sends the project the user picked, not a guess', () => {
    const state = { ...ready('b', 'Design'), project: PROJECT_B }
    expect(beginAttempt(state).project).toBe(PROJECT_B)
  })

  it('freezes the project once an attempt has gone out', () => {
    // 🔴 The reason: the ledger namespace is `(requirement, project, key)` on
    // the server while the key here is `(requirement, batch)`. Retrying with
    // the project switched does not resume the first attempt, it starts a
    // second one — and files a full set of work items into the new project
    // while whatever the first attempt wrote stays in the old one.
    const state = applyOutcome(beginAttempt(ready('b', 'Design')).state, errored)
    expect(isSubjectFrozen(state)).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The rows. The server's coordinate for item `n` is its LIST INDEX, so the list
// is as much a part of the subject as the project is.
// ───────────────────────────────────────────────────────────────────────────
describe('createWorkItems dialog: the row list is frozen with the subject', () => {
  it('is editable before the first attempt and frozen after it', () => {
    const state = ready('b', 'Design')
    expect(isSubjectFrozen(state)).toBe(false)
    expect(isSubjectFrozen(beginAttempt(state).state)).toBe(true)
  })

  it('replays exactly the same items, in the same order, on a retry', () => {
    // Were a row inserted between the two attempts, item `n` of the retry would
    // derive a DIFFERENT `_id` than item `n` of the first attempt: the retry
    // would duplicate everything from the insertion point and strand the
    // originals. `isSubjectFrozen` is what the UI gates row editing on.
    let state = ready('b', 'Design', 'Build', 'Ship')
    const first = beginAttempt(state)
    state = applyOutcome(first.state, errored)
    const second = beginAttempt(state)
    expect(second.items).toEqual(first.items)
    expect(second.items.map((it) => it.title)).toEqual(['Design', 'Build', 'Ship'])
  })

  it('sends only ticked rows, trimmed, and drops blank ones', () => {
    const state: SplitState = {
      ...ready('b'),
      rows: [
        { id: '1', title: '  Design  ', selected: true },
        { id: '2', title: 'Not this one', selected: false },
        { id: '3', title: '   ', selected: true },
        { id: '4', title: 'Ship', selected: true }
      ]
    }
    expect(selectedDrafts(state)).toEqual([{ title: 'Design' }, { title: 'Ship' }])
  })

  it('refuses to submit when nothing is ticked', () => {
    const state: SplitState = {
      ...ready('b'),
      rows: [{ id: '1', title: 'Design', selected: false }]
    }
    expect(canSubmit(state)).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// What may be offered again, and what may not.
// ───────────────────────────────────────────────────────────────────────────
describe('createWorkItems dialog: retryability', () => {
  it('offers a retry after a transport error and after a 409', () => {
    expect(canSubmit(applyOutcome(beginAttempt(ready('b', 'Design')).state, errored))).toBe(true)
    expect(canSubmit(applyOutcome(beginAttempt(ready('b', 'Design')).state, inProgress))).toBe(true)
  })

  it('withdraws the button once the batch has landed', () => {
    // Repeating a succeeded batch could only replay the stored result, and
    // offering "create" again invites the user to re-open and duplicate.
    expect(canSubmit(applyOutcome(beginAttempt(ready('b', 'Design')).state, ok([true])))).toBe(false)
  })

  it('withdraws the button on a CLEAN refusal and when unavailable', () => {
    // Nothing was written and repetition changes nothing, so the honest offer
    // is to close.
    for (const reason of ['requirement-not-found', 'requirement-not-latest', 'project-not-found', 'no-items']) {
      const refused: CommandOutcomeView<CreateWorkItemsResult> = {
        kind: 'refused',
        reason,
        message: reason,
        retryable: false
      }
      expect(mayHaveWritten(refused)).toBe(false)
      expect(canSubmit(applyOutcome(beginAttempt(ready('b', 'Design')).state, refused))).toBe(false)
    }
    expect(canSubmit(applyOutcome(beginAttempt(ready('b', 'Design')).state, { kind: 'unavailable' }))).toBe(false)
  })

  // 🔴 THE REGRESSION THIS DESCRIBE BLOCK EXISTS FOR. `CreateWorkItemsError` is
  // always `code = 400`, which the client renders as `retryable: false` — but
  // the server writes the batch ONE ISSUE AT A TIME and rolls nothing back, so
  // three of those reasons can arrive with part of the batch committed.
  // Withdrawing the retry button there leaves "close and re-open" as the only
  // move, and re-opening mints a new batch that writes the survivors a second
  // time.
  it('KEEPS the button after a 400 that may have written part of the batch', () => {
    for (const reason of ['task-type-not-found', 'sequence-unavailable', 'issue-id-taken', 'a-reason-added-later']) {
      const refused: CommandOutcomeView<CreateWorkItemsResult> = {
        kind: 'refused',
        reason,
        message: reason,
        retryable: false
      }
      expect(mayHaveWritten(refused)).toBe(true)
      expect(canSubmit(applyOutcome(beginAttempt(ready('b', 'Design')).state, refused))).toBe(true)
    }
  })

  it('says a transport error may have written, and an unrouted request may not', () => {
    expect(mayHaveWritten(errored)).toBe(true)
    expect(mayHaveWritten({ kind: 'unavailable' })).toBe(false)
    expect(mayHaveWritten(undefined)).toBe(false)
  })
})

describe('createWorkItems dialog: rendering the result', () => {
  it('counts a replayed item as existing, not as a failure', () => {
    const outcome = ok([true, false, true])
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(splitCounts(outcome.result)).toEqual({ created: 2, existing: 1 })
  })

  it('maps every server refusal reason to its own label', () => {
    const reasons = [
      'requirement-not-found',
      'requirement-not-latest',
      'project-not-found',
      'task-type-not-found',
      'no-items',
      'issue-id-taken',
      'sequence-unavailable'
    ]
    const labels = reasons.map(createWorkItemsReasonLabel)
    expect(new Set(labels).size).toBe(reasons.length)
    for (const label of labels) {
      expect(String(label).startsWith('requirements:string:')).toBe(true)
    }
  })

  it('falls back to the generic label for a reason the server adds later', () => {
    // Landing an unknown reason on a WRONG specific label would tell the user
    // to fix something that is not broken.
    expect(createWorkItemsReasonLabel('malformed-input')).toBe(createWorkItemsReasonLabel('something-new'))
  })
})
