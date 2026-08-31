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

import type { Doc, Ref, Timestamp } from '@hcengineering/core'

import { sha256Hex } from './sha256'

/**
 * Lifecycle of a single command attempt.
 *
 * `status` is the ONLY authoritative field. `result` / `error` / `finishedOn`
 * are leftovers of whichever attempt wrote them last and are meaningful only
 * while `status` agrees (`result` iff `succeeded`, `error` iff `failed`).
 *
 * @public
 */
export type CommandExecutionStatus = 'running' | 'succeeded' | 'failed'

/**
 * The idempotency ledger row for one `(command, idempotencyKey)` pair.
 *
 * 🔴 There is exactly one of these per logical command invocation, and its
 * `_id` is DERIVED from the pair (see {@link commandExecutionId}). That is what
 * makes the claim exclusive: the Postgres `PRIMARY KEY("workspaceId", _id)` on
 * the domain table is the only genuine cross-process mutual-exclusion primitive
 * available to a plugin in this codebase.
 *
 * 🔴 `TxApplyIf.scope` is NOT an alternative. `ApplyTxMiddleware.scopes` is a
 * per-process `Map`, and when `scope == null` the `notMatch` clause is not
 * evaluated at all, so it degrades to nothing across transactor replicas.
 * `createIndex` in the Postgres adapter is an empty function, so a plugin
 * cannot declare a unique index either.
 *
 * @public
 */
export interface CommandExecution extends Doc {
  /** Command name, e.g. `ConvertLeadToRequirement`. */
  command: string
  /** Caller-supplied idempotency key, unique per logical invocation. */
  idempotencyKey: string
  /**
   * Random token stamped by whoever created (or last took over) this row.
   *
   * 🔴 This is the ADAPTER-INDEPENDENT half of the claim. On Postgres the
   * primary key does the excluding and `23505` tells the loser it lost, but
   * `MongoAdapter.tx()` runs its inserts through `bulkWrite(..., ordered:
   * false)` inside a `try/catch` that only calls `ctx.error` — a duplicate
   * `_id` there is DROPPED SILENTLY, so a losing writer sees no error at all.
   * Re-reading the row and comparing `attemptId` catches that case: the loser
   * finds the winner's token and falls back to the replay / conflict paths
   * instead of running the body a second time.
   */
  attemptId: string
  status: CommandExecutionStatus
  /** When the CURRENT attempt started. Reset on every preemption. */
  startedOn: Timestamp
  finishedOn?: Timestamp
  /** Payload replayed verbatim to later callers using the same key. */
  result?: Record<string, any>
  /** Failure reason. Meaningful only when `status === 'failed'`. */
  error?: string
  /**
   * Attempt counter, incremented atomically to take over a stale claim.
   *
   * 🔴 This is a compare-and-swap token, not a statistic. A preemptor reads
   * `epoch`, issues an operator-only `$inc` update with `retrieve: true`, and
   * proceeds only if the returned value is exactly `read + 1`. The operator
   * path in `PostgresAdapterBase.txUpdateDoc` runs inside `mgr.write` (a real
   * `BEGIN`/`COMMIT`) and re-reads the row with `SELECT ... FOR UPDATE`, so two
   * concurrent preemptors serialize and exactly one sees `read + 1`.
   */
  epoch: number
}

/**
 * Length of a platform `Ref`. `isId()` in `foundations/core/.../utils.ts`
 * validates ids at runtime against `/^[0-9a-f]{24,24}$/`, and `generateId()`
 * emits exactly 24 lowercase hex chars. A derived id must be indistinguishable
 * from that or the platform rejects it.
 *
 * @public
 */
export const COMMAND_EXECUTION_ID_LENGTH = 24

/**
 * How long a `running` claim is honoured before it may be preempted.
 *
 * Must comfortably exceed the slowest command body. Too short and a live
 * command gets its ledger row stolen mid-flight (the epoch guard turns that
 * into a lost result rather than corruption, but it is still a wasted run);
 * too long and a crashed transactor blocks the key for that duration.
 *
 * @public
 */
export const DEFAULT_COMMAND_STALE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Deterministic `_id` for a command execution: the first 24 lowercase hex
 * chars of `sha256(command + separator + idempotencyKey)`.
 *
 * 🔴 THIS IS THE UNIQUENESS MECHANISM. Two callers racing on the same
 * `(command, idempotencyKey)` derive the same `_id` and therefore collide on
 * the primary key; the loser gets Postgres `23505`, which is not in
 * `ConnectionMgr.isRetryableError` and so surfaces immediately instead of being
 * silently retried. `PostgresAdapter.tx()` routes `TxCreateDoc` through
 * `insert()` to `upload(..., handleConflicts = false)`, i.e. an `INSERT` with
 * NO `ON CONFLICT` clause, and `upload` rethrows. If any of that changes, this
 * design loses its exclusion guarantee.
 *
 * The SHA-256 is the local, dependency-free `./sha256` rather than
 * `node:crypto`: this package builds against the platform-rig `default`
 * profile, which carries no `@types/node`. See that file's header for why it is
 * a deliberate copy of the traceability one instead of an import.
 *
 * @public
 */
export function commandExecutionId (command: string, idempotencyKey: string): Ref<CommandExecution> {
  // The separator keeps the concatenation injective: without it the pairs
  // ('ab', 'c') and ('a', 'bc') would hash identically.
  return sha256Hex(`${command} ${idempotencyKey}`).slice(0, COMMAND_EXECUTION_ID_LENGTH) as Ref<CommandExecution>
}

/**
 * Raised when another party holds a live (non-stale) claim on the same
 * `(command, idempotencyKey)`.
 *
 * 🔴 Deliberately NOT a silent success. Returning "ok" to the second caller
 * would hand it a result the first caller has not produced yet.
 *
 * @public
 */
export class CommandInProgressError extends Error {
  readonly code = 409

  constructor (
    readonly command: string,
    readonly idempotencyKey: string,
    readonly executionId: Ref<CommandExecution>
  ) {
    super(`Command '${command}' is already running for idempotency key '${idempotencyKey}'`)
    this.name = 'CommandInProgressError'
  }
}

/**
 * Raised when a preemption attempt lost the `$inc` compare-and-swap race, i.e.
 * a third party took the stale claim over first.
 *
 * @public
 */
export class CommandPreemptedError extends Error {
  readonly code = 409

  constructor (
    readonly command: string,
    readonly idempotencyKey: string,
    readonly executionId: Ref<CommandExecution>
  ) {
    super(`Command '${command}' claim for key '${idempotencyKey}' was taken over by another attempt`)
    this.name = 'CommandPreemptedError'
  }
}

/**
 * Outcome of a command run.
 *
 * @public
 */
export interface CommandOutcome<T = Record<string, any>> {
  executionId: Ref<CommandExecution>
  /** `true` when the result came from the ledger rather than a fresh run. */
  replayed: boolean
  /** `true` when this attempt took over an expired claim. */
  preempted: boolean
  result: T
}

/**
 * A command invocation.
 *
 * @public
 */
export interface CommandRequest {
  command: string
  idempotencyKey: string
  /** Overrides {@link DEFAULT_COMMAND_STALE_TIMEOUT_MS} for this command. */
  staleTimeoutMs?: number
}

/**
 * The command body.
 *
 * 🔴 Must be REENTRANT: every step queries before it writes. The platform gives
 * no multi-object atomicity. `PostgresAdapter.tx()` groups transactions by
 * domain and then by operation kind, so one logical command lands as several
 * unrelated database transactions. Reentrancy, plus stale-claim preemption, is
 * what replaces atomicity here.
 *
 * @public
 */
export type CommandBody<T = Record<string, any>> = () => Promise<T>

/**
 * Key under which the command middleware publishes itself on
 * `PipelineContext.contextVars`, so later command implementations (Task 9 / 15
 * / 18) can reach the claim machinery without another pipeline registration.
 *
 * @public
 */
export const commandRunnerContextVar = 'agentra.commandRunner'

/**
 * Deterministic `_id` for an object a command PRODUCES, derived from
 * `(command, idempotencyKey, role)` per Technical Spec §4.1.
 *
 * 🔴 This is what makes a command body reentrant. The body cannot rely on a
 * database transaction to make "create the Requirement" and "create the trace
 * edge" happen together (`PostgresAdapter.tx()` groups by domain and each group
 * lands as its own `BEGIN`/`COMMIT`), so after a partial success the replay has
 * to be able to ASK whether a given object already exists. With `generateId()`
 * that question is unanswerable; with this derivation the id is recomputed from
 * the request alone and every step becomes a `findOne`-then-write.
 *
 * `role` names the object's position in the command, e.g. `'requirement'`,
 * `'activity:lead'`. It must be stable forever: changing a role string for an
 * existing command re-points the lookup at an id that does not exist and the
 * replay creates a duplicate.
 *
 * 🔴 The encoding is LENGTH-PREFIXED, not merely separated. A bare separator is
 * injective only for two fields (as in {@link commandExecutionId}); with three
 * free-form strings, `('a', 'b c', 'd')` and `('a', 'b', 'c d')` would hash
 * identically and two different requests would fight over one `_id`.
 *
 * The result is 24 lowercase hex chars, the shape `isId()` validates at runtime.
 *
 * @public
 */
export function commandObjectId<T extends Doc = Doc> (command: string, idempotencyKey: string, role: string): Ref<T> {
  const encoded = `${command.length}:${command} ${idempotencyKey.length}:${idempotencyKey} ${role.length}:${role}`
  return sha256Hex(encoded).slice(0, COMMAND_EXECUTION_ID_LENGTH) as Ref<T>
}
