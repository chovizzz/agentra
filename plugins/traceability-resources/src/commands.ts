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

import type { Class, Client, Doc, DomainParams, DomainResult, OperationDomain, Ref } from '@hcengineering/core'
import type {
  CommandOutcomeView,
  ImplementsPair,
  LinkImplementsBatch,
  LinkImplementsResult,
  UnlinkImplementsBatch,
  UnlinkImplementsResult
} from '@hcengineering/traceability'

//
// 🔴 THE `implements` CALL SHAPES NOW LIVE IN `@hcengineering/traceability`.
// They had to move: `traceability.function.{LinkImplements,LinkImplementsPairs,
// UnlinkImplements}` is typed `Resource<…Fn>`, and a caller resolving one of
// those ids must be able to name the argument and result types without
// importing THIS package — which is the whole point of the indirection.
//
// They are re-exported unchanged so every existing
// `from '@hcengineering/traceability-resources'` import keeps working.
//
export type {
  CommandOutcomeView,
  ImplementsPair,
  LinkImplementsBatch,
  LinkImplementsResult,
  UnlinkImplementsBatch,
  UnlinkImplementsResult
} from '@hcengineering/traceability'

/**
 * The operation domain Agentra commands are invoked on.
 *
 * 🔴 Structurally copied from `@hcengineering/server-agentra-core-resources`
 * rather than imported: a browser bundle must never depend on a `server-*`
 * package (it drags `server-core`, i.e. the transactor, into the client bundle).
 * `crm-lite-resources` copies the conversion wire types for the same reason.
 *
 * @public
 */
export const AGENTRA_COMMAND_DOMAIN = 'agentra-command' as OperationDomain

/**
 * 🔴 ONE OPERATION FOR ALL THREE `verifies` ENTRY POINTS — the test case page,
 * the requirement page and the bulk dialog. They differ only in what they pass
 * as `testCase` / `requirement`.
 *
 * @public
 */
export const AGENTRA_OP_LINK_VERIFIES = 'linkVerifies'

/**
 * 🔴 ONE OPERATION FOR BOTH `implements` ENTRY POINTS — the requirement page
 * ("pick work items") and the issue page ("pick requirements"). They differ
 * only in which end the user had open; the assertion is the same one read from
 * opposite sides.
 *
 * @public
 */
export const AGENTRA_OP_LINK_IMPLEMENTS = 'linkImplements'

/**
 * 🔴 THE WITHDRAWAL OF ONE `implements` ASSERTION — a SEPARATE operation, not a
 * flag on {@link AGENTRA_OP_LINK_IMPLEMENTS}. Sharing one operation would put
 * both intents in one ledger namespace, so the link of a pair would occupy the
 * row the later unlink needs and the unlink would replay "linked".
 *
 * @public
 */
export const AGENTRA_OP_UNLINK_IMPLEMENTS = 'unlinkImplements'

/**
 * Split a requirement into work items (PM-006).
 *
 * @public
 */
export const AGENTRA_OP_CREATE_WORK_ITEMS = 'createWorkItems'

/**
 * @public
 */
export const AGENTRA_OP_CREATE_DEFECT = 'createDefect'

/**
 * Prefix of the derived `verifies` idempotency key. PART OF THE PERSISTED
 * CONTRACT: the ledger row id is `commandExecutionId(command, idempotencyKey)`,
 * so changing this string re-points every future request away from the
 * executions already recorded.
 *
 * @public
 */
export const LINK_VERIFIES_KEY_PREFIX = 'traceability:link-verifies:v1'

/**
 * Prefix of the derived `implements` idempotency key. PART OF THE PERSISTED
 * CONTRACT — see {@link LINK_VERIFIES_KEY_PREFIX}.
 *
 * @public
 */
export const LINK_IMPLEMENTS_KEY_PREFIX = 'traceability:link-implements:v1'

/**
 * Prefix of the derived `unlink implements` idempotency key. PART OF THE
 * PERSISTED CONTRACT — see {@link LINK_VERIFIES_KEY_PREFIX}.
 *
 * ⚠️ DISTINCT FROM {@link LINK_IMPLEMENTS_KEY_PREFIX}, and it has to be: the two
 * keys address rows under two different server command namespaces, and a shared
 * prefix would be one typo away from a link and an unlink of the same pair
 * colliding on one ledger row.
 *
 * @public
 */
export const UNLINK_IMPLEMENTS_KEY_PREFIX = 'traceability:unlink-implements:v1'

/**
 * @public
 */
export const CREATE_WORK_ITEMS_KEY_PREFIX = 'traceability:create-work-items:v1'

/**
 * @public
 */
export const CREATE_DEFECT_KEY_PREFIX = 'traceability:create-defect:v1'

/**
 * The idempotency key for linking one (test case, requirement) pair.
 *
 * 🔴 DERIVED FROM THE PAIR, NOT FROM THE CLICK. The obvious implementation —
 * `generateId()` per click or per opened dialog — makes every repetition a NEW
 * ledger entry, so the outer claim has nothing to deduplicate: a double click, a
 * re-opened dialog, a page reload mid-flight, a second browser tab, a second
 * user and the bulk dialog all produce different keys and all run the body. The
 * ledger stays correct and is simply never consulted.
 *
 * Deriving it from `(testCase, requirement)` makes "this pair is linked" the
 * unit of intent, which is the unit the server enforces anyway: the inner claim
 * is `(LINK_VERIFIES_PAIR, "<case> <requirement>")` and the edge `_id` is
 * `sha256(kind ‖ case ‖ requirement)`. Every caller therefore converges on one
 * ledger row as well as on one edge, and the second caller REPLAYS the first
 * one's stored result instead of racing it.
 *
 * @public
 */
export function linkVerifiesIdempotencyKey (testCase: Ref<Doc>, requirement: Ref<Doc>): string {
  return `${LINK_VERIFIES_KEY_PREFIX}:${testCase}:${requirement}`
}

/**
 * The idempotency key for linking one (work item, requirement) pair.
 *
 * 🔴 A PURE FUNCTION OF THE PAIR, AND OF THE PAIR ONLY. That is what makes the
 * two entry points ONE assertion: the requirement page passes (picked issue,
 * this requirement) and the issue page passes (this issue, picked requirement),
 * so both produce the SAME string for the same pair and converge on the same
 * ledger row. Deriving it from the click, the dialog or the near end instead
 * would give the two directions two different keys, both would run the body,
 * and the second would collide on the derived edge id.
 *
 * ⚠️ The argument ORDER is (work item, requirement), matching the edge
 * direction `WorkItem --implements--> Requirement`. Callers must not pass the
 * "near" end first; there is no near end in the key.
 *
 * @public
 */
export function linkImplementsIdempotencyKey (workItem: Ref<Doc>, requirement: Ref<Doc>): string {
  return `${LINK_IMPLEMENTS_KEY_PREFIX}:${workItem}:${requirement}`
}

/**
 * The idempotency key for withdrawing one (work item, requirement) assertion.
 *
 * 🔴 A PURE FUNCTION OF THE PAIR, exactly like
 * {@link linkImplementsIdempotencyKey} and for the same reason: whichever end
 * the user had open, "this pair is no longer asserted" is one intent and must
 * land on one ledger row, so a double click or a reload replays instead of
 * running the body twice.
 *
 * ⚠️ The argument ORDER is (work item, requirement), matching the edge direction
 * `WorkItem --implements--> Requirement`. There is no near end in the key.
 *
 * @public
 */
export function unlinkImplementsIdempotencyKey (workItem: Ref<Doc>, requirement: Ref<Doc>): string {
  return `${UNLINK_IMPLEMENTS_KEY_PREFIX}:${workItem}:${requirement}`
}

/**
 * The idempotency key for one batch of work items split off a requirement.
 *
 * ⚠️ NOT a pure function of the requirement alone, and deliberately so: two
 * batches against one requirement are two legitimate intents ("split it
 * further"). The `batch` component is what separates them, and a caller that
 * wants a repeated submit to be idempotent must keep it stable across the
 * retries of ONE dialog — which is exactly what a value minted when the dialog
 * OPENS does, and what one minted per click does not.
 *
 * @public
 */
export function createWorkItemsIdempotencyKey (requirement: Ref<Doc>, batch: string): string {
  return `${CREATE_WORK_ITEMS_KEY_PREFIX}:${requirement}:${batch}`
}

/**
 * The idempotency key for raising a defect against one target.
 *
 * 🔴 KEYED ON THE TARGET, which is what makes "the button opens the existing
 * bug" true rather than aspirational. A per-click key would file a second
 * defect for the same failure on the second click; the server's target claim
 * would still stop the duplicate, but the caller would get a fresh ledger row
 * recording an intent that was never carried out.
 *
 * @public
 */
export function createDefectIdempotencyKey (target: Ref<Doc>): string {
  return `${CREATE_DEFECT_KEY_PREFIX}:${target}`
}

/**
 * The reply envelope. Structurally copied — see {@link AGENTRA_COMMAND_DOMAIN}.
 *
 * @public
 */
export type AgentraCommandResult<T = Record<string, any>> =
  | { ok: true, executionId: string, replayed: boolean, preempted: boolean, result: T }
  | AgentraCommandFailure

/**
 * The refusal half of {@link AgentraCommandResult}.
 *
 * 🔴 A NAMED TYPE, NOT AN INLINE UNION MEMBER, BECAUSE `parse` HAS TO CAST TO
 * IT. See the note in `parse` — this file's source is compiled twice under two
 * different sets of compiler options, and the looser one cannot narrow the
 * union by its `ok` discriminant.
 *
 * @public
 */
export interface AgentraCommandFailure {
  ok: false
  code: number
  reason: string
  message: string
  /** See {@link PartialWriteRisk}. Absent on a server older than this field. */
  partialWrite?: PartialWriteRisk
  /** For a batch command, elements known to exist at the moment of refusal. */
  itemsWritten?: number
}

/**
 * Whether a refusal may have left documents behind.
 *
 * 🔴 STRUCTURALLY COPIED from `PartialWriteRisk` in
 * `@hcengineering/server-agentra-core-resources`, for the same reason as
 * {@link AGENTRA_COMMAND_DOMAIN}: a browser bundle must not depend on a
 * `server-*` package.
 *
 * 🔴 A SECOND AXIS, NOT A RESTATEMENT OF `retryable`. `retryable` says whether
 * calling again can produce a result; this says whether anything already
 * exists. Reading a terminal 400 as "nothing happened" is the mistake: the
 * server writes a work-item batch ONE ITEM AT A TIME and does not roll back, so
 * a terminal refusal from item 4 leaves three issues behind.
 *
 * ⚠️ `'unclassified'` MEANS "ASSUME IT WROTE", not "clean". It is what an
 * un-audited command reports and what {@link parse} substitutes when the field
 * is missing entirely — a server that predates it cannot be assumed innocent.
 *
 * @public
 */
export type PartialWriteRisk = 'none' | 'possible' | 'unclassified'

/**
 * The refusal arm, widened with the write-risk answer.
 *
 * `partialWrite` is REQUIRED here even though the wire field is optional:
 * {@link parse} substitutes `'unclassified'` for an absent one, so a consumer
 * never has to invent a default — and therefore never gets to invent `'none'`.
 *
 * @public
 */
export interface CommandRefusalView {
  kind: 'refused'
  reason: string
  message: string
  retryable: boolean
  partialWrite: PartialWriteRisk
  /**
   * How many elements of the batch are KNOWN to exist. Absent when the command
   * is not a batch or the server did not say. **Absent is not zero** — pair it
   * with `partialWrite` and never with a bare `?? 0`.
   */
  itemsWritten?: number
}

/**
 * {@link CommandOutcomeView} with the refusal arm carrying the write risk.
 *
 * 🔴 A WIDENING, NOT A REPLACEMENT. Every arm is assignable to the matching arm
 * of `CommandOutcomeView<T>`, so existing callers typed against that keep
 * compiling and simply do not see the new field. It is declared here rather
 * than on `CommandOutcomeView` itself because that type lives in
 * `@hcengineering/traceability`, the leaf descriptor package, which is outside
 * this delivery's file boundary. Hoisting it there is the follow-up: it would
 * let `mayHaveWritten`-style logic in every consumer read one field instead of
 * keeping its own list of reason strings.
 *
 * @public
 */
export type CommandOutcomeRiskView<T> =
  | { kind: 'ok', result: T, replayed: boolean }
  | CommandRefusalView
  | { kind: 'unavailable' }
  | { kind: 'errored', message: string }

/**
 * The write risk of any outcome, refusal or not.
 *
 * 🔴 THE WHOLE POINT OF THE SERVER-SIDE FLAG IS THAT NOBODY KEEPS A LIST OF
 * REASON STRINGS ANY MORE. A consumer that needs "may work items exist?" calls
 * this and nothing else; when the server gains a refusal reason, this answer
 * changes with it and no client ships a stale copy of the classification.
 *
 * The three non-refusal arms are decided here because the wire cannot speak
 * about them: `unavailable` means the domain request was never routed, so no
 * body ran; `errored` means the REPLY was lost, not the request, so it may well
 * have run; `ok` obviously wrote.
 *
 * @public
 */
export function outcomeWriteRisk (outcome: CommandOutcomeRiskView<unknown> | undefined): PartialWriteRisk {
  if (outcome === undefined) return 'none'
  switch (outcome.kind) {
    case 'ok':
      return 'possible'
    case 'unavailable':
      return 'none'
    case 'errored':
      return 'possible'
    case 'refused':
      return outcome.partialWrite
  }
}

/**
 * `true` for everything except a proven-clean outcome.
 *
 * ⚠️ `'unclassified'` COUNTS AS "MAY HAVE WRITTEN". Only `'none'` is a licence
 * to tell a user that nothing was created.
 *
 * @public
 */
export function outcomeMayHaveWritten (outcome: CommandOutcomeRiskView<unknown> | undefined): boolean {
  return outcomeWriteRisk(outcome) !== 'none'
}

/**
 * @public
 */
export interface LinkVerifiesResult {
  testCase: Ref<Doc>
  requirement: Ref<Doc>
  traceLink: Ref<Doc>
  alreadyLinked: boolean
}

/**
 * @public
 */
export interface VerifiesPair {
  testCase: Ref<Doc>
  requirement: Ref<Doc>
}

/**
 * @public
 */
export interface LinkVerifiesBatch {
  linked: number
  /** Pairs that were already asserted — a success, not a failure. */
  alreadyLinked: number
  failures: Array<{ pair: VerifiesPair, outcome: CommandOutcomeView<LinkVerifiesResult> }>
}

/**
 * @public
 */
export interface CreateDefectResult {
  target: Ref<Doc>
  /** ⚠️ ABSENT when `restricted` is set — a defect the caller may not read has no id to hand back. */
  bug?: Ref<Doc>
  traceLink?: Ref<Doc>
  alreadyReported: boolean
  /** A defect exists but this caller may not see it. Render that, and offer no link. */
  restricted?: boolean
}

/** 409 means "the result does not exist yet"; everything else is terminal. */
function isRetryable (code: number): boolean {
  return code === 409
}

function parse<T> (value: unknown): CommandOutcomeRiskView<T> {
  if (value == null || typeof value !== 'object') {
    // `{ domain, value: null }` is what an unrouted domain request returns.
    return { kind: 'unavailable' }
  }
  const envelope = value as AgentraCommandResult<T>
  if (envelope.ok === true) {
    return { kind: 'ok', result: envelope.result, replayed: envelope.replayed }
  }
  if (envelope.ok === false) {
    // 🔴 AN EXPLICIT CAST, NOT NARROWING, AND IT MUST STAY ONE.
    //
    // This file is type checked TWICE under two different configurations.
    // Every `-resources` package sets `main: src/index.ts`, so `dev/prod`
    // compiles this SOURCE — and `dev/prod/tsconfig.json` does not extend the
    // rig and has no `strict`. Without `strictNullChecks` TypeScript does not
    // narrow this union by its boolean discriminant, so every field below is
    // `TS2339: Property does not exist on type '{ ok: true, ... }'` there while
    // this package's own `tsc` (rig `ui` profile, strict) is perfectly happy.
    //
    // ⚠️ Deleting the cast passes `rushx validate` in this folder and breaks
    // `rush validate` for the whole repo. That asymmetry is why it looks
    // redundant. The `true` half above needs no cast — only the `false` half
    // fails to narrow.
    const failure = envelope as AgentraCommandFailure
    return {
      kind: 'refused',
      reason: failure.reason,
      message: failure.message,
      retryable: isRetryable(failure.code),
      // 🔴 `'unclassified'` FOR AN ABSENT FIELD, NEVER `'none'`. A server that
      // does not send it has not told us the batch is clean; it has told us
      // nothing, and the safe reading of nothing is "assume it wrote".
      partialWrite: failure.partialWrite ?? 'unclassified',
      itemsWritten: failure.itemsWritten
    }
  }
  return { kind: 'unavailable' }
}

async function call<T> (client: Client, op: string, params: Record<string, any>): Promise<CommandOutcomeRiskView<T>> {
  // ⚠️ The inner key is `params`, the same spelling the server destructures.
  // `DomainParams` is `Record<string, any>`, so writing `query` here is not a
  // type error on either side — the server would simply read `undefined`.
  const payload: DomainParams = { [op]: { params } }
  try {
    const result: DomainResult<unknown> = await client.domainRequest(AGENTRA_COMMAND_DOMAIN, payload)
    return parse<T>(result?.value)
  } catch (err: unknown) {
    // Not swallowed — turned into a state the caller renders. `toCommandResult`
    // rethrows anything it does not recognise on purpose, so without this the
    // exception escapes the click handler and the dialog sits on its opening
    // hint as if nothing had happened.
    console.error(`traceability: ${op} threw`, err)
    return { kind: 'errored', message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Assert `TestCase --verifies--> Requirement`.
 *
 * 🔴 THE ONLY WAY a `verifies` edge is created. All three entry points call
 * this; none of them writes a `TraceLink` directly. A direct client write would
 * bypass the server matrix check, the pair claim and the two activity records —
 * and `DOMAIN_RELATION` is excluded from Activity, so the edge would land with
 * no audit trail at all.
 *
 * @public
 */
export async function linkVerifies (
  client: Client,
  testCase: Ref<Doc>,
  requirement: Ref<Doc>
): Promise<CommandOutcomeView<LinkVerifiesResult>> {
  return await call<LinkVerifiesResult>(client, AGENTRA_OP_LINK_VERIFIES, {
    testCase,
    requirement,
    idempotencyKey: linkVerifiesIdempotencyKey(testCase, requirement)
  })
}

/**
 * Link many pairs from one bulk action.
 *
 * ⚠️ ONE COMMAND CALL PER PAIR, deliberately. A "bulk" server operation would
 * need its own claim, its own partial-failure semantics and its own replay
 * story; looping here keeps every pair on the same per-pair key, so a bulk run
 * that is interrupted half way can simply be repeated and the pairs that already
 * landed replay instead of duplicating.
 *
 * @public
 */
export async function linkVerifiesPairs (client: Client, pairs: readonly VerifiesPair[]): Promise<LinkVerifiesBatch> {
  const batch: LinkVerifiesBatch = { linked: 0, alreadyLinked: 0, failures: [] }
  for (const pair of pairs) {
    const outcome = await linkVerifies(client, pair.testCase, pair.requirement)
    if (outcome.kind === 'ok') {
      if (outcome.result.alreadyLinked) batch.alreadyLinked++
      else batch.linked++
    } else {
      // 🔴 The loop does NOT stop on the first failure. A bulk link is a set of
      // independent assertions; abandoning the rest because one requirement was
      // unreadable would silently drop work the user asked for, and the retry
      // (which replays the pairs that landed) is free.
      batch.failures.push({ pair, outcome })
    }
  }
  return batch
}

/**
 * @public
 */
export interface WorkItemDraft {
  title: string
  taskType?: Ref<Doc>
  assignee?: Ref<Doc>
  priority?: number
}

/**
 * @public
 */
export interface CreateWorkItemsResult {
  requirement: Ref<Doc>
  workItems: Array<{ workItem: Ref<Doc>, traceLink: Ref<Doc>, created: boolean }>
}

/**
 * Assert `WorkItem --implements--> Requirement`.
 *
 * 🔴 THE ONLY WAY an `implements` edge is created from the UI, and the ONE call
 * behind BOTH directions. Neither entry point writes a `TraceLink` directly: a
 * client-side write would bypass the server matrix check, the pair claim and
 * the two activity records — and `DOMAIN_RELATION` is excluded from Activity,
 * so the edge would land with no audit trail at all.
 *
 * @public
 */
export async function linkImplements (
  client: Client,
  workItem: Ref<Doc>,
  requirement: Ref<Doc>
): Promise<CommandOutcomeView<LinkImplementsResult>> {
  return await call<LinkImplementsResult>(client, AGENTRA_OP_LINK_IMPLEMENTS, {
    workItem,
    requirement,
    idempotencyKey: linkImplementsIdempotencyKey(workItem, requirement)
  })
}

/**
 * Link many pairs from one picker confirmation.
 *
 * ⚠️ ONE COMMAND CALL PER PAIR, deliberately — see {@link linkVerifiesPairs}.
 *
 * @public
 */
export async function linkImplementsPairs (
  client: Client,
  pairs: readonly ImplementsPair[]
): Promise<LinkImplementsBatch> {
  const batch: LinkImplementsBatch = { linked: 0, alreadyLinked: 0, failures: [] }
  for (const pair of pairs) {
    const outcome = await linkImplements(client, pair.workItem, pair.requirement)
    if (outcome.kind === 'ok') {
      if (outcome.result.alreadyLinked) batch.alreadyLinked++
      else batch.linked++
    } else {
      // 🔴 The loop does NOT stop on the first failure — see `linkVerifiesPairs`.
      batch.failures.push({ pair, outcome })
    }
  }
  return batch
}

/**
 * Withdraw `WorkItem --implements--> Requirement`.
 *
 * 🔴 THE EDGE IS REVOKED, NOT DELETED, and the client cannot do it either way
 * by itself. `TraceLinkState` calls `revoked` "a human explicitly withdrew the
 * assertion"; the row survives because the matrix is an audit artefact, and a
 * client-side write would bypass the server's readability guard, the pair claim
 * and the two activity records — `DOMAIN_RELATION` is excluded from Activity,
 * so the withdrawal would leave no trace at all.
 *
 * ⚠️ WITHDRAWING RELEASES THE DELETE PROTECTION on both endpoints: the server's
 * `ArchivableGuard` refuses to physically delete an object that still carries a
 * NON-revoked edge, so unlinking the last one makes the work item and the
 * requirement deletable again. Worth saying in the confirmation copy.
 *
 * @public
 */
export async function unlinkImplements (
  client: Client,
  workItem: Ref<Doc>,
  requirement: Ref<Doc>
): Promise<CommandOutcomeView<UnlinkImplementsResult>> {
  return await call<UnlinkImplementsResult>(client, AGENTRA_OP_UNLINK_IMPLEMENTS, {
    workItem,
    requirement,
    idempotencyKey: unlinkImplementsIdempotencyKey(workItem, requirement)
  })
}

/**
 * Withdraw many pairs from one confirmation.
 *
 * ⚠️ ONE COMMAND CALL PER PAIR, deliberately — see {@link linkVerifiesPairs}.
 *
 * @public
 */
export async function unlinkImplementsPairs (
  client: Client,
  pairs: readonly ImplementsPair[]
): Promise<UnlinkImplementsBatch> {
  const batch: UnlinkImplementsBatch = { revoked: 0, alreadyRevoked: 0, failures: [] }
  for (const pair of pairs) {
    const outcome = await unlinkImplements(client, pair.workItem, pair.requirement)
    if (outcome.kind === 'ok') {
      if (outcome.result.alreadyRevoked) batch.alreadyRevoked++
      else batch.revoked++
    } else {
      // 🔴 The loop does NOT stop on the first failure — see `linkVerifiesPairs`.
      batch.failures.push({ pair, outcome })
    }
  }
  return batch
}

/**
 * Split a requirement into work items, each carrying an `implements` edge back
 * to it.
 *
 * ⚠️ `batch` must be stable across the retries of ONE dialog and different
 * between two deliberate splits — see {@link createWorkItemsIdempotencyKey}.
 *
 * @public
 */
export async function createWorkItems (
  client: Client,
  requirement: Ref<Doc>,
  project: Ref<Doc>,
  items: readonly WorkItemDraft[],
  batch: string
): Promise<CommandOutcomeRiskView<CreateWorkItemsResult>> {
  return await call<CreateWorkItemsResult>(client, AGENTRA_OP_CREATE_WORK_ITEMS, {
    requirement,
    project,
    items,
    idempotencyKey: createWorkItemsIdempotencyKey(requirement, batch)
  })
}

/**
 * Raise (or resolve to) the defect for one failed result, test case or
 * requirement.
 *
 * @public
 */
export async function createDefect (
  client: Client,
  target: Ref<Doc>,
  targetClass: Ref<Class<Doc>>,
  project: Ref<Doc>,
  options: { actual?: string, assignee?: Ref<Doc> } = {}
): Promise<CommandOutcomeView<CreateDefectResult>> {
  return await call<CreateDefectResult>(client, AGENTRA_OP_CREATE_DEFECT, {
    target,
    targetClass,
    project,
    ...options,
    idempotencyKey: createDefectIdempotencyKey(target)
  })
}
