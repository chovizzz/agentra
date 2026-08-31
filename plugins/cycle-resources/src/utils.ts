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

import cyclePlugin, {
  canTransitionCycle,
  cycleStatusOrder,
  type CycleRolloverPolicy,
  type CycleStatus
} from '@hcengineering/cycle'
import type {
  Class,
  Client,
  Doc,
  DomainParams,
  DomainResult,
  OperationDomain,
  Ref,
  TxOperations
} from '@hcengineering/core'
import type { IntlString } from '@hcengineering/platform'
import type { AnyComponent } from '@hcengineering/ui'

/**
 * `SortFunc` implementation for `cycle.class.TypeCycleStatus`.
 *
 * Grouping resolves the attribute's `attrClass` and then calls the `SortFuncs`
 * mixin registered on that class, so this is what orders the grouped sections.
 * Values not in the canonical order (data written by an older/newer build) are
 * kept and pushed to the end rather than dropped.
 *
 * @public
 */
export async function sortCycleStatuses (_: TxOperations, values: CycleStatus[]): Promise<CycleStatus[]> {
  return [...values].sort((a, b) => rank(a) - rank(b))
}

/**
 * `AllValuesFunc` implementation: what makes an empty status still render as a
 * group when "show empty groups" is on.
 *
 * @public
 */
export async function getAllCycleStatuses (): Promise<CycleStatus[]> {
  return cycleStatusOrder
}

function rank (value: CycleStatus): number {
  const idx = cycleStatusOrder.indexOf(value)
  return idx === -1 ? cycleStatusOrder.length : idx
}

// ───────────────────────────────────────────────────────────────────────────
// Inline status editing (`view.mixin.AttributeEditor` on TypeCycleStatus).
// ───────────────────────────────────────────────────────────────────────────

/**
 * The outcome of one inline status pick, as a value rather than as a side
 * effect, so the state machine is unit testable without a Svelte runtime.
 *
 * `unchanged` is kept apart from `accepted` on purpose: `canTransitionCycle`
 * answers `true` for `from === to` (a self transition is trivially legal), but
 * writing the value back would still produce a pointless Tx and an Activity
 * entry claiming the status "changed" to what it already was.
 *
 * @public
 */
export type CycleStatusChange =
  | { kind: 'accepted', status: CycleStatus }
  | { kind: 'unchanged' }
  | { kind: 'rejected', from: CycleStatus, to: CycleStatus }

/**
 * The statuses the inline editor may OFFER for a cycle currently in `from`.
 *
 * Returned in `cycleStatusOrder` so the dropdown reads in the same sequence as
 * the grouped list sections.
 *
 * ⚠️ This is the first of two gates and it is the COSMETIC one. Filtering the
 * list is not enforcement: `DropdownLabelsIntl` can dispatch `selected` for an
 * id that is no longer in `items` (the cycle's status can change underneath an
 * open popup), so {@link resolveCycleStatusChange} re-checks on the way in and
 * is the gate that actually refuses.
 *
 * 🔴 `completed` is deliberately NOT offered even though `active -> completed`
 * is a legal transition. Completing a cycle is not a field edit: Technical Spec
 * §4 defines it as the `CompleteCycle` command, which also has to roll issues
 * over and record a snapshot. A bare status write here would produce a
 * completed cycle with its open issues still hanging off it and no snapshot at
 * all — a half-done completion that nothing would ever finish, because the
 * command refuses a cycle that is already `completed`.
 *
 * @public
 */
export function cycleStatusChoices (from: CycleStatus | undefined): CycleStatus[] {
  // No current status at all — nothing has been asserted yet, so nothing can be
  // violated. Offer the whole vocabulary minus the command-owned one.
  if (from === undefined) {
    return cycleStatusOrder.filter((to) => to !== COMMAND_OWNED_STATUS)
  }
  // ⚠️ `to === from` is kept unconditionally, INCLUDING when the current status
  // is the command-owned `completed`. The dropdown renders its button from the
  // selected item, so filtering the current value out would leave an
  // already-completed cycle showing a blank status control. Picking it back is
  // a no-op — `resolveCycleStatusChange` reports `unchanged`.
  return cycleStatusOrder.filter((to) => to === from || (to !== COMMAND_OWNED_STATUS && canTransitionCycle(from, to)))
}

/**
 * The status only `CompleteCycle` may write. See {@link cycleStatusChoices}.
 *
 * @public
 */
export const COMMAND_OWNED_STATUS: CycleStatus = 'completed'

/**
 * The gate. Given the value on screen and the value picked, say what — if
 * anything — may be written.
 *
 * 🔴 `canTransitionCycle` is the single source of truth for legality; this
 * function adds only the `from === to` short circuit and the command-owned
 * refusal. Do not reimplement the transition table here:
 * `plugins/cycle/src/types.ts` owns it.
 *
 * @public
 */
export function resolveCycleStatusChange (from: CycleStatus | undefined, to: CycleStatus): CycleStatusChange {
  if (from === to) {
    return { kind: 'unchanged' }
  }
  if (to === COMMAND_OWNED_STATUS) {
    // Reachable when the dropdown was opened on a value that has since moved,
    // or when a caller passes it directly. Either way this editor may not write
    // it — see `cycleStatusChoices`.
    return { kind: 'rejected', from: from ?? 'planned', to }
  }
  if (from === undefined) {
    return { kind: 'accepted', status: to }
  }
  return canTransitionCycle(from, to) ? { kind: 'accepted', status: to } : { kind: 'rejected', from, to }
}

// ───────────────────────────────────────────────────────────────────────────
// CompleteCycle (the client half of `agentra-command`).
// ───────────────────────────────────────────────────────────────────────────

/**
 * The operation domain the Agentra command middleware answers on.
 *
 * 🔴 Must stay identical to `AGENTRA_COMMAND_DOMAIN` in
 * `server-plugins/agentra-core-resources/src/commandRequest.ts`. It is a plain
 * string on the wire; a typo here does not fail to compile, it falls through
 * `BaseMiddleware.provideDomainRequest` to `{ domain, value: null }`, which
 * {@link parseCompleteCycleResult} reports as `unavailable` rather than as a
 * silent success.
 *
 * @public
 */
export const AGENTRA_COMMAND_DOMAIN = 'agentra-command' as OperationDomain

/**
 * @public
 */
export const AGENTRA_OP_COMPLETE_CYCLE = 'completeCycle'

/**
 * Prefix of the derived idempotency key. Part of the persisted contract: the
 * ledger row id is `commandExecutionId(command, idempotencyKey)`, so changing
 * this string re-points every future request away from the executions already
 * recorded and a completed cycle would look uncompleted to the ledger.
 *
 * @public
 */
export const COMPLETE_CYCLE_KEY_PREFIX = 'cycle:complete-cycle:v1'

/**
 * The idempotency key for completing one cycle.
 *
 * 🔴 DERIVED FROM THE CYCLE, NOT FROM THE CLICK, and the justification is
 * stronger here than for `convertLeadToRequirement`: `completed` is a TERMINAL
 * state in `cycleTransitions`, so "complete THIS cycle" can succeed at most
 * once in the life of the cycle. There is no second intent for a second key to
 * express. A `generateId()` per click would give a double click, a reopened
 * dialog, a page reload mid-flight and a second browser tab four different
 * ledger rows, all of which would run the body — the ledger would stay correct
 * and would simply never be consulted.
 *
 * ⚠️ TRADE-OFF, stated explicitly. Two callers who pick DIFFERENT rollover
 * policies converge on one ledger row, so the second one replays the first
 * one's result instead of applying its own policy. That is the correct
 * outcome, not a limitation: by the time the second call arrives the cycle is
 * already `completed`, its issues have already been dealt with, and applying a
 * second policy would move issues out of a cycle that is closed. The UI reports
 * the replay as "already completed" and shows what actually happened.
 *
 * ⚠️ A key is not a lock. `CommandRunner` treats `failed` as always retryable
 * and `running` as retryable once stale, so a refused or crashed attempt does
 * NOT wedge the cycle forever — only a `succeeded` row is replayed.
 *
 * @public
 */
export function completeCycleIdempotencyKey (cycle: Ref<Doc>): string {
  return `${COMPLETE_CYCLE_KEY_PREFIX}:${cycle}`
}

/**
 * Wire shape of `CompleteCycleInput`.
 *
 * 🔴 Structurally copied rather than imported. The real declaration lives in
 * `@hcengineering/server-agentra-core-resources`, a `server-*` bundle that this
 * browser package must not depend on (and adding the dependency would rewrite
 * `pnpm-lock.yaml`). `crm-lite-resources` and `traceability-resources` copy
 * their wire types for the same reason.
 *
 * @public
 */
export interface CompleteCycleRequest {
  cycle: Ref<Doc>
  idempotencyKey: string
  rolloverPolicy: CycleRolloverPolicy
  /** Required iff `rolloverPolicy === 'move'`. */
  rolloverTarget?: Ref<Doc>
}

/**
 * The statistics snapshot the command records.
 *
 * ⚠️ NOT stored on the Cycle. Technical Spec §3.4 forbids hand-maintained
 * velocity / burndown / rollover fields; the snapshot's home is the command
 * ledger row, which is immutable once `succeeded` and is exactly the audit
 * record §4 asks for.
 *
 * @public
 */
export interface CompleteCycleSnapshot {
  total: number
  done: number
  open: number
  rolledOver: number
}

/**
 * The refusal reasons `CompleteCycleError` can carry, plus the middleware's own
 * `malformed-input`. Listed explicitly so that a reason the server adds later
 * lands on the generic label instead of on a wrong specific one.
 *
 * @public
 */
export type CompleteCycleReason =
  | 'cycle-not-found'
  | 'illegal-transition'
  | 'rollover-target-required'
  | 'rollover-target-invalid'
  | 'malformed-input'

/**
 * What the UI is allowed to say after one call. Same five families as
 * `ConvertLeadOutcome`, and for the same reasons — see that type's header.
 *
 * @public
 */
export type CompleteCycleOutcome =
  | {
    kind: 'completed' | 'replayed'
    executionId: string
    cycle: Ref<Doc>
    snapshot: CompleteCycleSnapshot
    retryable: false
  }
  | { kind: 'in-progress', code: number, reason: string, message: string, retryable: true }
  | { kind: 'refused', code: number, reason: string, message: string, retryable: false }
  | { kind: 'unavailable', retryable: false }
  | { kind: 'errored', message: string, retryable: false }

const UNAVAILABLE: CompleteCycleOutcome = { kind: 'unavailable', retryable: false }

function isRecord (value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object'
}

function readSnapshot (value: unknown): CompleteCycleSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const { total, done, open, rolledOver } = value
  if (
    typeof total !== 'number' ||
    typeof done !== 'number' ||
    typeof open !== 'number' ||
    typeof rolledOver !== 'number'
  ) {
    return undefined
  }
  return { total, done, open, rolledOver }
}

/**
 * Narrows an untrusted `DomainResult.value` into a {@link CompleteCycleOutcome}.
 *
 * 🔴 FAIL CLOSED. Every branch demands the fields it is about to render, and
 * anything else becomes `unavailable`. In particular `ok: true` without a
 * readable snapshot is NOT reported as a success: it would put "cycle
 * completed, N issues rolled over" on screen with no N. `value: null` — what an
 * unrouted domain request returns when the middleware is not registered —
 * lands here too.
 *
 * @public
 */
export function parseCompleteCycleResult (value: unknown): CompleteCycleOutcome {
  if (!isRecord(value)) {
    return UNAVAILABLE
  }
  if (value.ok === true) {
    const result = value.result
    if (typeof value.executionId !== 'string' || !isRecord(result) || typeof result.cycle !== 'string') {
      return UNAVAILABLE
    }
    const snapshot = readSnapshot(result.snapshot)
    if (snapshot === undefined) {
      return UNAVAILABLE
    }
    // Two independent ways for the server to say "this already happened": the
    // ledger replayed a stored result, or the body found the cycle already
    // `completed`. Either one means "nothing new happened just now".
    const replayed = value.replayed === true || result.alreadyCompleted === true
    return {
      kind: replayed ? 'replayed' : 'completed',
      executionId: value.executionId,
      cycle: result.cycle as Ref<Doc>,
      snapshot,
      retryable: false
    }
  }
  if (value.ok === false) {
    if (typeof value.code !== 'number' || typeof value.reason !== 'string') {
      return UNAVAILABLE
    }
    const message = typeof value.message === 'string' ? value.message : ''
    if (value.code === 409) {
      return { kind: 'in-progress', code: 409, reason: value.reason, message, retryable: true }
    }
    // 400 and anything else well formed. An unrecognised code is deliberately
    // treated as NOT retryable: inviting the user to hammer a state this build
    // does not understand is the worse of the two mistakes.
    return { kind: 'refused', code: value.code, reason: value.reason, message, retryable: false }
  }
  return UNAVAILABLE
}

/**
 * The user facing explanation of a 400.
 *
 * Every known reason is mapped explicitly, so a reason added on the server
 * shows the generic sentence rather than an unrelated specific one.
 *
 * @public
 */
export function completeCycleReasonLabel (reason: string): IntlString {
  const labels: Record<CompleteCycleReason, IntlString> = {
    'cycle-not-found': cyclePlugin.string.ReasonCycleNotFound,
    'illegal-transition': cyclePlugin.string.ReasonIllegalCycleTransition,
    'rollover-target-required': cyclePlugin.string.ReasonRolloverTargetRequired,
    'rollover-target-invalid': cyclePlugin.string.ReasonRolloverTargetInvalid,
    'malformed-input': cyclePlugin.string.ReasonMalformedInput
  }
  return labels[reason as CompleteCycleReason] ?? cyclePlugin.string.ReasonUnknown
}

/**
 * Invoke the completion command.
 *
 * 🔴 The inner key is `params`. `AgentraCommandRequestMiddleware.handleCommand`
 * destructures `args.completeCycle.params`; naming it `query` — the other
 * plausible spelling — makes the server read `undefined`, and it is not a type
 * error on either side because `DomainParams` is `Record<string, any>`.
 *
 * @public
 */
export async function completeCycle (client: Client, request: CompleteCycleRequest): Promise<CompleteCycleOutcome> {
  const params: DomainParams = { [AGENTRA_OP_COMPLETE_CYCLE]: { params: request } }
  try {
    const result: DomainResult<unknown> = await client.domainRequest(AGENTRA_COMMAND_DOMAIN, params)
    return parseCompleteCycleResult(result?.value)
  } catch (err: unknown) {
    // 🔴 Not swallowed — turned into a state the popup RENDERS. Only
    // `CommandInProgressError`, `CommandPreemptedError` and `CompleteCycleError`
    // come back as envelopes; `toCommandResult` rethrows everything else on
    // purpose, so without this the exception would escape the click handler and
    // leave the dialog sitting on its opening hint as if nothing happened.
    console.error('cycle: completeCycle threw', err)
    return { kind: 'errored', message: err instanceof Error ? err.message : String(err), retryable: false }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// "Link requirements" — the ISSUE side of the `implements` edge.
//
// 🔴 THE THREE IDS BELOW ARE WRITTEN OUT AS STRINGS ON PURPOSE, and adding the
// imports that would produce them is the wrong fix. This package depends on
// `core / cycle / platform / presentation / ui / view` and nothing else; taking
// a dependency on `@hcengineering/traceability(-resources)` or
// `@hcengineering/requirements` for three `Ref`s would rewrite
// `pnpm-lock.yaml` and, in the traceability case, drag that package's Svelte
// entry point into this module. It is the same trade
// `requirements-resources/src/workItems.ts` records for
// `TRACKER_PROJECT_CLASS`, and the one `traceability-resources` records when it
// copies the literal `'agentra-command'`.
//
// ⚠️ They are PERSISTED plugin ids — the model builds documents and loads
// strings under them — so they are exactly as stable as an import would be.
// What an import would buy is a compile error if the far side renamed a key;
// `linkRequirementsPopupProps` is unit tested against these literals instead.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The picker both `implements` directions share.
 *
 * ⚠️ `traceability-resources` is registered under `traceabilityId` in
 * `dev/prod/src/platform.ts` (`addLocation`), so `showPopup` resolves this id
 * lazily at click time — which is also why no build-time dependency is needed.
 *
 * @public
 */
export const LINK_IMPLEMENTS_POPUP = 'traceability:component:LinkImplementsPopup' as AnyComponent

/**
 * Requirement is a **MasterTag**, not a class — `requirements:masterTag:...`,
 * not `requirements:class:...`. `createSystemType` files it as a
 * `ClassifierKind.CLASS` classifier, so it is a legal `pickClass` and
 * `Hierarchy.hasClass` answers for it.
 *
 * @public
 */
export const REQUIREMENT_MASTER_TAG = 'requirements:masterTag:Requirement' as Ref<Class<Doc>>

/**
 * ⚠️ `traceability:string:*`, loaded unconditionally by the `traceabilityId`
 * strings loader. The `…ToRequirement` spelling is the ISSUE-side one ("select
 * requirements this work item implements"); `LinkImplementsFromRequirement` is
 * its mirror and would read backwards here.
 *
 * @public
 */
export const LINK_IMPLEMENTS_TO_REQUIREMENT = 'traceability:string:LinkImplementsToRequirement' as IntlString

/**
 * Props for {@link LINK_IMPLEMENTS_POPUP}, opened from an Issue.
 *
 * 🔴 `fixed` IS AN ARRAY, AND THAT IS THE WHOLE REASON THIS FUNCTION EXISTS.
 * `LinkImplementsPopup` declares `export let fixed: Array<Ref<Doc>>` and
 * iterates it with `for (const one of fixed)`. Handed a bare `Ref` — which is a
 * string — that loop iterates CHARACTERS and sends one bogus pair per character
 * to the `linkImplements` command. TypeScript cannot see it (`showPopup` takes
 * `props: any`) so the failure is runtime-only.
 *
 * 🔴 THIS IS ALSO WHY THE ACTION CANNOT BE `view.actionImpl.ShowPopup`. That
 * generic impl's `fillProps` special-cases only `_object` and `_objects`; every
 * other key is copied straight off the document (`actionImpl.ts:479-488`), so
 * `{ _id: 'fixed' }` would deliver exactly the bare string described above.
 *
 * ⚠️ `searchField` is `'title'`, the Card field. `'name'` — what the Cycle
 * picker uses — does not exist on a Requirement and would search nothing.
 *
 * @public
 */
export function linkRequirementsPopupProps (issue: Ref<Doc>): {
  pick: 'requirement'
  pickClass: Ref<Class<Doc>>
  fixed: Array<Ref<Doc>>
  searchField: string
  placeholder: IntlString
} {
  return {
    // "The work item is fixed, pick requirements."
    pick: 'requirement',
    // 🔴 No default on this side: the popup only defaults `pickClass` for the
    // work-item direction (`tracker.class.Issue`), so the requirement side must
    // always name its own class.
    pickClass: REQUIREMENT_MASTER_TAG,
    fixed: [issue],
    searchField: 'title',
    placeholder: LINK_IMPLEMENTS_TO_REQUIREMENT
  }
}
