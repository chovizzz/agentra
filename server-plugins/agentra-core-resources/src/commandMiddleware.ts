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

import core, {
  generateId,
  TxFactory,
  TxProcessor,
  type CommitResult,
  type Doc,
  type MeasureContext,
  type Ref,
  type SessionData,
  type Tx,
  type TxCUD,
  type TxResult,
  type TxUpdateDoc
} from '@hcengineering/core'
import serverAgentraCore, {
  CommandInProgressError,
  CommandPreemptedError,
  commandExecutionId,
  commandRunnerContextVar,
  DEFAULT_COMMAND_STALE_TIMEOUT_MS,
  type CommandBody,
  type CommandExecution,
  type CommandOutcome,
  type CommandRequest
} from '@hcengineering/server-agentra-core'
import {
  BaseMiddleware,
  type Middleware,
  type PipelineContext,
  type TxMiddlewareResult
} from '@hcengineering/server-core'

import { ArchivableGuard } from './deleteGuard'
import { TraceLinkGuard } from './traceLinkGuard'

/**
 * Postgres `unique_violation`. Raised by the primary key on
 * `("workspaceId", _id)` when a second party derives the same
 * `CommandExecution._id`.
 *
 * 🔴 This is the entire exclusion mechanism. It works because
 * `PostgresAdapter.tx()` sends `TxCreateDoc` through `insert()`, which calls
 * `upload(..., handleConflicts = false)` and therefore emits a bare `INSERT`
 * with no `ON CONFLICT` clause; because `upload` logs and RETHROWS; and because
 * `23505` is absent from `ConnectionMgr.isRetryableError` (which only retries
 * `40001`, `55P03` and connection loss), so the failure is not silently
 * swallowed by a retry.
 */
const PG_UNIQUE_VIOLATION = '23505'

/**
 * `postgres.js` surfaces the SQLSTATE on `err.code`, but the error may arrive
 * wrapped (`ctx.with`, `Promise.all`, adapter re-throws), so walk `cause` too
 * and keep a message-level fallback for adapters that do not preserve `code`.
 */
export function isDuplicateKeyError (err: unknown): boolean {
  let current: any = err
  for (let depth = 0; current != null && depth < 8; depth++) {
    if (current.code === PG_UNIQUE_VIOLATION) {
      return true
    }
    const message: string = typeof current.message === 'string' ? current.message : ''
    if (message.includes('duplicate key value violates unique constraint')) {
      return true
    }
    current = current.cause
  }
  return false
}

/**
 * Assert that an `ApplyOperations.commit()` actually landed.
 *
 * 🔴 `ApplyTxMiddleware` reports a rejected `TxApplyIf` by pushing
 * `{ success: false }` into its result array and logging a warning. Nothing
 * throws. A command body that ignores the return value therefore records a
 * `succeeded` execution over writes that never happened, and the idempotency
 * ledger then replays that phantom result forever.
 *
 * @public
 */
export function assertCommitted (result: CommitResult, what: string): void {
  if (!result.result) {
    throw new Error(`Command step '${what}' failed to commit: TxApplyIf was rejected`)
  }
}

/**
 * Idempotent-command middleware.
 *
 * Two jobs:
 *
 * 1. Veto direct client edits of the ledger (same shape as `RatingMiddleware`).
 *    A middleware is the only vetoing extension point in this pipeline:
 *    `TriggersMiddleware.processDerived` runs AFTER `provideTx` and swallows
 *    trigger exceptions, so a trigger cannot refuse a write.
 * 2. Publish itself on `PipelineContext.contextVars` so concrete commands can
 *    claim, replay and preempt without a second pipeline registration.
 *
 * @public
 */
export class CommandMiddleware extends BaseMiddleware implements Middleware {
  /**
   * SYS-005's two write rules, HOSTED HERE rather than registered as their own
   * middleware.
   *
   * ⚠️ This slot is already exactly where they belong — AFTER
   * `ApplyTxMiddleware` (so a `TxApplyIf` is flattened) and BEFORE
   * `TxMiddleware` (so a refused write never reaches the transaction domain) —
   * so a second `pipeline.ts` entry would have bought nothing but another line
   * to keep in sync. The rules themselves live in `./deleteGuard` and are
   * testable without a pipeline.
   *
   * 🔴 The guard reads through `provideFindAll`, i.e. BELOW this middleware and
   * therefore below `SpaceSecurityMiddleware` / `PrivateMiddleware` /
   * `FindSecurityMiddleware`. That is required, not incidental: a guard that
   * could only see what the CALLER may read would approve a write precisely
   * when the caller cannot see the evidence against it.
   */
  private readonly archivable = new ArchivableGuard({
    hierarchy: this.context.hierarchy,
    findAll: async (ctx, _class, query, options) =>
      await this.provideFindAll(ctx, _class as any, query as any, options as any)
  })

  /**
   * The `TraceLink` write rules, hosted in the same slot and for the same
   * reasons as {@link archivable}.
   *
   * ⚠️ NO READER. Every rule is decided from the transaction alone, so unlike
   * the archive rules this guard issues no query at all.
   */
  private readonly traceLinks = new TraceLinkGuard(this.context.hierarchy)

  private constructor (context: PipelineContext, next?: Middleware) {
    super(context, next)
  }

  static async create (ctx: MeasureContext, context: PipelineContext, next?: Middleware): Promise<Middleware> {
    const middleware = new CommandMiddleware(context, next)
    context.contextVars[commandRunnerContextVar] = middleware
    return middleware
  }

  async tx (ctx: MeasureContext<SessionData>, txes: Tx[]): Promise<TxMiddlewareResult> {
    await this.archivable.validate(ctx, txes)
    this.traceLinks.validate(txes)
    for (const tx of txes) {
      if (!TxProcessor.isExtendsCUD(tx._class)) {
        continue
      }
      const cud = tx as TxCUD<Doc>
      if (cud.objectClass !== serverAgentraCore.class.CommandExecution) {
        continue
      }
      // Only this middleware writes the ledger, and it does so via `provideTx`
      // (i.e. into `next`), never back through its own `tx()`. So anything
      // arriving here is either a client forging an idempotency record or a
      // plugin bypassing the runner; both break replay correctness.
      throw new Error('Direct modifications of Agentra command executions are not allowed.')
    }
    return await this.provideTx(ctx, txes)
  }

  /**
   * Run `body` at most once per `(command, idempotencyKey)`.
   *
   * Three claim outcomes, in the order they are decided:
   *
   * - no row, or the row is ours to create -> claim it and run;
   * - row is `succeeded` -> replay the stored result, do NOT run the body;
   * - row is `running` and fresh -> throw {@link CommandInProgressError} (409).
   *   Never a silent success: the result does not exist yet;
   * - row is `running` past the stale timeout, or `failed` -> preempt via an
   *   atomic `$inc` on `epoch`, and run only if we won the CAS.
   */
  async run<T extends Record<string, any>>(
    ctx: MeasureContext<SessionData>,
    request: CommandRequest,
    body: CommandBody<T>
  ): Promise<CommandOutcome<T>> {
    const executionId = commandExecutionId(request.command, request.idempotencyKey)
    const staleTimeoutMs = request.staleTimeoutMs ?? DEFAULT_COMMAND_STALE_TIMEOUT_MS

    const existing = await this.findExecution(ctx, executionId)
    if (existing !== undefined) {
      return await this.resume(ctx, request, body, existing, staleTimeoutMs)
    }

    const attemptId = generateId()
    try {
      await this.claim(ctx, request, executionId, attemptId)
    } catch (err: any) {
      if (!isDuplicateKeyError(err)) {
        throw err
      }
      // Lost the insert race loudly (Postgres). Re-read and take whichever
      // branch the winner's row dictates; there is always a row at this point.
      const winner = await this.findExecution(ctx, executionId)
      if (winner === undefined) {
        throw err
      }
      return await this.resume(ctx, request, body, winner, staleTimeoutMs)
    }

    // 🔴 Do NOT assume a non-throwing insert means we own the claim. Only the
    // Postgres adapter reports a duplicate `_id`; `MongoAdapter.tx()` catches
    // its `bulkWrite` failure and merely logs it, so a losing writer returns
    // normally with nothing written. Read the row back and check whose token
    // is on it before running anything.
    const claimed = await this.findExecution(ctx, executionId)
    if (claimed === undefined) {
      throw new Error(`Command '${request.command}' claim vanished immediately after being written`)
    }
    if (claimed.attemptId !== attemptId) {
      return await this.resume(ctx, request, body, claimed, staleTimeoutMs)
    }

    return await this.execute(ctx, request, body, executionId, claimed.epoch, false, false)
  }

  /** Decide what to do about an existing ledger row. */
  private async resume<T extends Record<string, any>>(
    ctx: MeasureContext<SessionData>,
    request: CommandRequest,
    body: CommandBody<T>,
    existing: CommandExecution,
    staleTimeoutMs: number
  ): Promise<CommandOutcome<T>> {
    if (existing.status === 'succeeded') {
      return {
        executionId: existing._id,
        replayed: true,
        preempted: false,
        result: (existing.result ?? {}) as T
      }
    }

    const stale = Date.now() - existing.startedOn >= staleTimeoutMs
    if (existing.status === 'running' && !stale) {
      throw new CommandInProgressError(request.command, request.idempotencyKey, existing._id)
    }

    // `failed` is always retryable, `running` only once it has gone stale.
    const epoch = await this.preempt(ctx, request, existing)
    return await this.execute(ctx, request, body, existing._id, epoch, true, existing.status === 'failed')
  }

  /**
   * Take over a claim.
   *
   * 🔴 The `$inc` tx must stay OPERATOR-ONLY. `isOperator()` requires EVERY key
   * to start with `$`; mixing in a plain `status` field would demote the update
   * to the bulk `updateDoc` path, which uses neither `mgr.write` (BEGIN/COMMIT)
   * nor `SELECT ... FOR UPDATE` and would destroy the mutual exclusion. The
   * plain fields are therefore written separately, by the CAS winner only.
   *
   * This is the same shape `IdentifierMiddleware.generateIdentifier` uses to
   * allocate sequence numbers.
   */
  private async preempt (
    ctx: MeasureContext<SessionData>,
    request: CommandRequest,
    existing: CommandExecution
  ): Promise<number> {
    const factory = this.txFactory(ctx)
    const incTx = factory.createTxUpdateDoc<CommandExecution>(
      serverAgentraCore.class.CommandExecution,
      existing.space,
      existing._id,
      { $inc: { epoch: 1 } },
      true
    )
    const incResult = await this.provideTx(ctx, [incTx])
    const updated = retrievedDoc<CommandExecution>(incResult)
    if (updated === undefined) {
      throw new CommandPreemptedError(request.command, request.idempotencyKey, existing._id)
    }
    // Serialized by the row lock: whoever read `existing.epoch` and got back
    // exactly `existing.epoch + 1` is the single winner. A concurrent preemptor
    // that read the same value sees a larger number and backs off.
    if (updated.epoch !== existing.epoch + 1) {
      throw new CommandPreemptedError(request.command, request.idempotencyKey, existing._id)
    }

    // ⚠️ ACCEPTED WINDOW. `startedOn` cannot ride along on the `$inc` tx —
    // `isOperator()` demands every key be `$`-prefixed and there is no `$set`
    // operator in this codebase (only $push/$pull/$update/$inc/$unset/$rename).
    // So between the increment committing and this write landing, a third party
    // still reads the OLD `startedOn` and may preempt again. The cost is a
    // duplicated run of a body that is required to be reentrant anyway, and the
    // loser's outcome is discarded by the epoch guard in `finish`; it is never
    // a lost or double-counted write.
    await this.provideTx(ctx, [
      factory.createTxUpdateDoc<CommandExecution>(
        serverAgentraCore.class.CommandExecution,
        existing.space,
        existing._id,
        { status: 'running', startedOn: Date.now(), attemptId: generateId() }
      )
    ])
    return updated.epoch
  }

  /**
   * Insert the ledger row with a derived `_id`. Throws `23505` if taken (on
   * Postgres); the caller must still verify `attemptId` afterwards, because not
   * every adapter reports the collision.
   */
  private async claim (
    ctx: MeasureContext<SessionData>,
    request: CommandRequest,
    executionId: Ref<CommandExecution>,
    attemptId: string
  ): Promise<void> {
    const createTx = this.txFactory(ctx).createTxCreateDoc<CommandExecution>(
      serverAgentraCore.class.CommandExecution,
      core.space.Workspace,
      {
        command: request.command,
        idempotencyKey: request.idempotencyKey,
        attemptId,
        status: 'running',
        startedOn: Date.now(),
        epoch: 0
      },
      executionId
    )
    await this.provideTx(ctx, [createTx])
  }

  /** Run the body under a held claim and record the outcome. */
  private async execute<T extends Record<string, any>>(
    ctx: MeasureContext<SessionData>,
    request: CommandRequest,
    body: CommandBody<T>,
    executionId: Ref<CommandExecution>,
    epoch: number,
    preempted: boolean,
    retriedAfterFailure: boolean
  ): Promise<CommandOutcome<T>> {
    let result: T
    try {
      result = await body()
    } catch (err: any) {
      // 🔴 THE `failed` MARK IS A COMPENSATING WRITE, AND IT MAY NOT HIJACK THE
      // ERROR. Unguarded, a `finish` that throws (adapter down, connection lost
      // — exactly the conditions under which bodies fail in the first place)
      // propagates INSTEAD of `err`, so the caller is told about the bookkeeping
      // and never about what actually went wrong. Worse, it is the second
      // failure of the same outage, so the message is always the less
      // informative of the two.
      //
      // ⚠️ NOT SWALLOWED EITHER. Losing this write leaves the ledger row
      // `running` with a body that has already given up, and nothing retries
      // that command until the stale timeout elapses and a later caller
      // preempts the epoch. That is a real, invisible inconsistency, so it is
      // logged with everything needed to find it — the row, the epoch, the
      // command and the key that addresses it, both errors kept apart.
      try {
        await this.finish(ctx, executionId, epoch, {
          status: 'failed',
          error: err?.message ?? String(err)
        })
      } catch (finishErr: any) {
        ctx.error('agentra command failure could not be recorded; ledger row left running', {
          command: request.command,
          idempotencyKey: request.idempotencyKey,
          executionId,
          epoch,
          staleTimeoutMs: request.staleTimeoutMs ?? DEFAULT_COMMAND_STALE_TIMEOUT_MS,
          bodyError: err?.message ?? String(err),
          finishError: finishErr?.message ?? String(finishErr)
        })
      }
      throw err
    }

    await this.finish(ctx, executionId, epoch, { status: 'succeeded', result })
    ctx.info('agentra command completed', {
      command: request.command,
      executionId,
      epoch,
      preempted,
      retriedAfterFailure
    })
    return { executionId, replayed: false, preempted, result }
  }

  /**
   * Write the terminal state, but only while we still hold the claim.
   *
   * Without the epoch guard a body that overran the stale timeout would
   * overwrite the newer attempt's row and hand every future caller a result
   * that does not match the writes actually in the database.
   */
  private async finish (
    ctx: MeasureContext<SessionData>,
    executionId: Ref<CommandExecution>,
    epoch: number,
    operations: Pick<CommandExecution, 'status'> & Partial<Pick<CommandExecution, 'result' | 'error'>>
  ): Promise<void> {
    const current = await this.findExecution(ctx, executionId)
    if (current === undefined) {
      ctx.warn('agentra command execution vanished before completion', { executionId })
      return
    }
    if (current.epoch !== epoch) {
      ctx.warn('agentra command claim was preempted, discarding outcome', {
        executionId,
        heldEpoch: epoch,
        currentEpoch: current.epoch
      })
      return
    }
    await this.provideTx(ctx, [
      this.txFactory(ctx).createTxUpdateDoc<CommandExecution>(
        serverAgentraCore.class.CommandExecution,
        current.space,
        executionId,
        { ...operations, finishedOn: Date.now() }
      )
    ])
  }

  /**
   * 🔴 `provideFindAll` from inside a middleware bypasses space security (the
   * `isTriggerCtx` branch in the Postgres adapter), so this is a GLOBAL view.
   * It is safe here because the ledger row is addressed by a derived `_id` and
   * is never echoed to a client unfiltered; any caller that surfaces
   * `CommandExecution.result` must re-check the caller's permissions first.
   */
  private async findExecution (
    ctx: MeasureContext<SessionData>,
    executionId: Ref<CommandExecution>
  ): Promise<CommandExecution | undefined> {
    const found = await this.provideFindAll<CommandExecution>(
      ctx,
      serverAgentraCore.class.CommandExecution,
      { _id: executionId },
      { limit: 1 }
    )
    return found[0]
  }

  private txFactory (ctx: MeasureContext<SessionData>): TxFactory {
    return new TxFactory(ctx.contextData?.account?.primarySocialId ?? core.account.System, true)
  }
}

/**
 * Pull the document back out of a `retrieve: true` update result.
 *
 * `Middleware.tx` returns `TxMiddlewareResult`, which is either a single
 * `TxResult` or an array of them depending on how many transactions the lower
 * middlewares chose to group, so both shapes have to be handled.
 */
function retrievedDoc<T extends Doc> (result: TxMiddlewareResult): T | undefined {
  const candidates: TxResult[] = Array.isArray(result) ? result : [result]
  for (const candidate of candidates) {
    const object = (candidate as any)?.object
    if (object !== undefined) {
      return object as T
    }
  }
  return undefined
}

/** Narrow a tx to an update of the ledger. Exported for tests. */
export function isCommandExecutionUpdate (tx: Tx): tx is TxUpdateDoc<CommandExecution> {
  return (
    tx._class === core.class.TxUpdateDoc &&
    (tx as TxUpdateDoc<Doc>).objectClass === serverAgentraCore.class.CommandExecution
  )
}

// TODO(V1.1): outbox / dead-letter / reconciliation. V1 relies on stale-claim
// preemption plus reentrant bodies, and emits domain events over the platform's
// existing Tx stream rather than a private delivery channel.

// ⚠️ ADAPTER SCOPE. The primary-key collision that makes a claim exclusive is a
// POSTGRES property. `MongoAdapter.tx()` swallows its `bulkWrite` error, and the
// in-memory adapter enforces nothing, so on those backends the `attemptId`
// re-read above is the only thing standing between two callers and a double
// run. Agentra targets Postgres; if that ever changes, this needs a real
// conditional write, not a bigger comment.
//
// ⚠️ KNOWN BYPASS, deliberately not defended against.
// `LowLevelMiddleware` publishes `context.lowLevelStorage.upload()`, which calls
// the adapter's `upload()` with the DEFAULT `handleConflicts = true` and so
// emits `ON CONFLICT ... DO UPDATE` — a raw upsert that would overwrite a live
// claim without a 23505. That path is reachable only from migrations, backup /
// restore and `dev/tool`, i.e. operator tooling that already runs with full
// database authority; no client session can reach it. Anything running there
// must not touch the ledger while a transactor is serving the workspace.
