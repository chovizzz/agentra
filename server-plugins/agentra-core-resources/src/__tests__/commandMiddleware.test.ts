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
  TxProcessor,
  type CommitResult,
  type Doc,
  type MeasureContext,
  type Ref,
  type SessionData,
  type Tx,
  type TxCreateDoc,
  type TxUpdateDoc
} from '@hcengineering/core'
import serverAgentraCore, {
  CommandInProgressError,
  CommandPreemptedError,
  COMMAND_EXECUTION_ID_LENGTH,
  commandExecutionId,
  commandRunnerContextVar,
  type CommandExecution
} from '@hcengineering/server-agentra-core'
import type { Middleware, PipelineContext, TxMiddlewareResult } from '@hcengineering/server-core'

import { assertCommitted, CommandMiddleware, isDuplicateKeyError } from '../commandMiddleware'

/**
 * Stand-in for everything below `CommandMiddleware` in the pipeline, down to
 * and including the Postgres adapter.
 *
 * The behaviours it reproduces are exactly the ones the design leans on, and
 * each is anchored to the code it imitates:
 *
 * - `TxCreateDoc` on an existing `_id` throws a `23505` error object with no
 *   `ON CONFLICT` fallback — `PostgresAdapter.tx()` -> `insert()` ->
 *   `upload(..., handleConflicts = false)`, which rethrows;
 * - an operator-only `TxUpdateDoc` is serialized and, with `retrieve: true`,
 *   returns the POST-update document — `PostgresAdapterBase.txUpdateDoc`, which
 *   runs `mgr.write` + `findDoc(..., forUpdate = true)` and returns
 *   `{ object: doc }`;
 * - a `TxUpdateDoc` whose operations are not all `$`-prefixed takes the plain
 *   merge path (`isOperator` requires EVERY key to start with `$`).
 */
class FakeAdapter implements Middleware {
  readonly docs = new Map<Ref<Doc>, CommandExecution>()
  readonly txLog: Tx[] = []
  /** Runs while an operator update holds the simulated row lock. */
  onRowLocked?: (doc: CommandExecution) => void

  async tx (ctx: MeasureContext<SessionData>, txes: Tx[]): Promise<TxMiddlewareResult> {
    const results: any[] = []
    for (const tx of txes) {
      this.txLog.push(tx)
      if (tx._class === core.class.TxCreateDoc) {
        const create = tx as TxCreateDoc<CommandExecution>
        if (this.docs.has(create.objectId)) {
          // Shape of a postgres.js SQLSTATE error.
          const err: any = new Error('duplicate key value violates unique constraint "agentra_core_pkey"')
          err.code = '23505'
          throw err
        }
        this.docs.set(create.objectId, TxProcessor.createDoc2Doc(create))
      } else if (tx._class === core.class.TxUpdateDoc) {
        const update = tx as TxUpdateDoc<CommandExecution>
        const doc = this.docs.get(update.objectId)
        if (doc === undefined) {
          continue
        }
        this.onRowLocked?.(doc)
        const stored = this.docs.get(update.objectId) as CommandExecution
        TxProcessor.applyUpdate(stored, { ...update.operations })
        if (update.retrieve === true) {
          results.push({ object: { ...stored } })
        }
      }
    }
    return results.length === 1 ? results[0] : results
  }

  async findAll (ctx: MeasureContext<SessionData>, _class: Ref<any>, query: any): Promise<any> {
    const found = this.docs.get(query._id)
    return found !== undefined ? [{ ...found }] : []
  }

  // Unused surface.
  async findAllRaw (): Promise<any> {
    return []
  }

  async loadModel (): Promise<any> {
    return []
  }

  async groupBy (): Promise<any> {
    return new Map()
  }

  async searchFulltext (): Promise<any> {
    return { docs: [], total: 0 }
  }

  async handleBroadcast (): Promise<void> {}

  async close (): Promise<void> {}

  async domainRequest (): Promise<any> {
    return { domain: '', value: undefined }
  }

  async closeSession (): Promise<void> {}
}

function makeCtx (): MeasureContext<SessionData> {
  const ctx: any = {
    contextData: { account: { primarySocialId: core.account.System } },
    info: () => {},
    warn: () => {},
    error: () => {},
    with: (name: string, params: any, op: any) => op(ctx)
  }
  return ctx as MeasureContext<SessionData>
}

async function makeMiddleware (
  adapter: FakeAdapter
): Promise<{ middleware: CommandMiddleware, context: PipelineContext }> {
  const context = { contextVars: {} } as unknown as PipelineContext
  const middleware = (await CommandMiddleware.create(makeCtx(), context, adapter)) as CommandMiddleware
  return { middleware, context }
}

/** Plant a ledger row directly, as a crashed or concurrent attempt would leave it. */
function seed (adapter: FakeAdapter, execution: Partial<CommandExecution> & { _id: Ref<CommandExecution> }): void {
  const row: CommandExecution = {
    _class: serverAgentraCore.class.CommandExecution,
    space: core.space.Workspace,
    modifiedBy: core.account.System,
    modifiedOn: Date.now(),
    command: 'ConvertLeadToRequirement',
    idempotencyKey: 'key-1',
    attemptId: 'someone-else',
    status: 'running',
    startedOn: Date.now(),
    epoch: 0,
    ...execution
  }
  adapter.docs.set(execution._id, row)
}

const request = { command: 'ConvertLeadToRequirement', idempotencyKey: 'key-1' }

describe('commandExecutionId', () => {
  it('is deterministic', () => {
    expect(commandExecutionId('Cmd', 'k')).toEqual(commandExecutionId('Cmd', 'k'))
  })

  it('produces exactly 24 lowercase hex chars, as isId() demands', () => {
    for (const [command, key] of [
      ['ConvertLeadToRequirement', 'key-1'],
      ['', ''],
      ['CompleteCycle', 'ключ-Ω-😀'],
      ['ReleaseProductVersion', 'x'.repeat(4096)]
    ]) {
      const id = commandExecutionId(command, key)
      expect(id).toHaveLength(COMMAND_EXECUTION_ID_LENGTH)
      // The very regex from foundations/core/.../utils.ts#isId.
      expect(/^[0-9a-f]{24,24}$/.test(id)).toBe(true)
    }
  })

  it('separates its inputs so distinct pairs cannot collide by concatenation', () => {
    expect(commandExecutionId('ab', 'c')).not.toEqual(commandExecutionId('a', 'bc'))
  })

  it('matches the reference SHA-256 of the separated input', () => {
    // `printf 'Cmd k' | shasum -a 256` ->
    // a4f8c0b682cfce9731404b715497db6df334564dd6a583d6d5721f38f8147c27
    // This pins the in-package SHA-256 (a deliberate copy of the traceability
    // one) against a real implementation, so a transcription slip in the copy
    // cannot silently change every derived id.
    expect(commandExecutionId('Cmd', 'k')).toEqual('a4f8c0b682cfce9731404b71')
  })
})

describe('CommandMiddleware claim', () => {
  it('publishes itself on contextVars for later command implementations', async () => {
    const adapter = new FakeAdapter()
    const { middleware, context } = await makeMiddleware(adapter)
    expect(context.contextVars[commandRunnerContextVar]).toBe(middleware)
  })

  it('claims with the derived _id and runs the body once', async () => {
    const adapter = new FakeAdapter()
    const { middleware } = await makeMiddleware(adapter)
    const body = jest.fn(async () => ({ requirement: 'r1' }))

    const outcome = await middleware.run(makeCtx(), request, body)

    expect(body).toHaveBeenCalledTimes(1)
    expect(outcome.replayed).toBe(false)
    expect(outcome.preempted).toBe(false)
    expect(outcome.executionId).toEqual(commandExecutionId(request.command, request.idempotencyKey))
    const stored = adapter.docs.get(outcome.executionId) as CommandExecution
    expect(stored.status).toBe('succeeded')
    expect(stored.result).toEqual({ requirement: 'r1' })
    expect(stored.epoch).toBe(0)
    expect(stored.finishedOn).toBeDefined()
  })

  it('rejects direct client modification of the ledger', async () => {
    const adapter = new FakeAdapter()
    const { middleware } = await makeMiddleware(adapter)
    const forged: any = {
      _class: core.class.TxCreateDoc,
      objectClass: serverAgentraCore.class.CommandExecution,
      objectId: commandExecutionId('X', 'y'),
      attributes: { status: 'succeeded' }
    }
    await expect(middleware.tx(makeCtx(), [forged])).rejects.toThrow(
      'Direct modifications of Agentra command executions are not allowed.'
    )
    expect(adapter.txLog).toHaveLength(0)
  })
})

describe('CommandMiddleware concurrency', () => {
  it('throws a 409 instead of silently succeeding when the primary key is already taken', async () => {
    const adapter = new FakeAdapter()
    const { middleware } = await makeMiddleware(adapter)
    const executionId = commandExecutionId(request.command, request.idempotencyKey)

    // First party is mid-flight: fresh `running` row already in the table.
    seed(adapter, { _id: executionId, startedOn: Date.now() })

    const body = jest.fn(async () => ({ requirement: 'r1' }))
    await expect(middleware.run(makeCtx(), request, body)).rejects.toBeInstanceOf(CommandInProgressError)
    expect(body).not.toHaveBeenCalled()
  })

  it('turns a lost INSERT race into the same 409, never a success', async () => {
    const adapter = new FakeAdapter()
    const { middleware } = await makeMiddleware(adapter)
    const executionId = commandExecutionId(request.command, request.idempotencyKey)
    const body = jest.fn(async () => ({ requirement: 'r1' }))

    // The row appears between our probe and our INSERT: findAll sees nothing,
    // then the INSERT hits 23505. That is the real race this design turns on.
    const originalFindAll = adapter.findAll.bind(adapter)
    let probed = false
    adapter.findAll = async (ctx: any, _class: any, query: any) => {
      if (!probed) {
        probed = true
        seed(adapter, { _id: executionId, startedOn: Date.now() })
        return []
      }
      return await originalFindAll(ctx, _class, query)
    }

    await expect(middleware.run(makeCtx(), request, body)).rejects.toBeInstanceOf(CommandInProgressError)
    expect(body).not.toHaveBeenCalled()
    expect(adapter.txLog.filter((t) => t._class === core.class.TxCreateDoc)).toHaveLength(1)
  })

  it('does not run the body when the insert was silently dropped, as Mongo drops it', async () => {
    const adapter = new FakeAdapter()
    const { middleware } = await makeMiddleware(adapter)
    const executionId = commandExecutionId(request.command, request.idempotencyKey)

    // `MongoAdapter.tx()` catches its bulkWrite failure and only logs, so the
    // losing writer returns normally with nothing written. Reproduce exactly
    // that: swallow the collision instead of throwing.
    const originalTx = adapter.tx.bind(adapter)
    adapter.tx = async (ctx: any, txes: any) => {
      try {
        return await originalTx(ctx, txes)
      } catch (err: any) {
        if (isDuplicateKeyError(err)) {
          return []
        }
        throw err
      }
    }

    let probed = false
    const originalFindAll = adapter.findAll.bind(adapter)
    adapter.findAll = async (ctx: any, _class: any, query: any) => {
      if (!probed) {
        probed = true
        seed(adapter, { _id: executionId, startedOn: Date.now() })
        return []
      }
      return await originalFindAll(ctx, _class, query)
    }

    const body = jest.fn(async () => ({ requirement: 'r1' }))
    // The attemptId on the row is the other party's, so we must not proceed.
    await expect(middleware.run(makeCtx(), request, body)).rejects.toBeInstanceOf(CommandInProgressError)
    expect(body).not.toHaveBeenCalled()
  })

  it('recognises a wrapped 23505', () => {
    const inner: any = new Error('nope')
    inner.code = '23505'
    expect(isDuplicateKeyError(new Error('outer', { cause: inner }))).toBe(true)
    expect(isDuplicateKeyError(new Error('duplicate key value violates unique constraint "x"'))).toBe(true)
    const other: any = new Error('serialization failure')
    other.code = '40001'
    expect(isDuplicateKeyError(other)).toBe(false)
    expect(isDuplicateKeyError(undefined)).toBe(false)
  })
})

describe('CommandMiddleware replay', () => {
  it('returns the stored result and does not re-run the body', async () => {
    const adapter = new FakeAdapter()
    const { middleware } = await makeMiddleware(adapter)
    const executionId = commandExecutionId(request.command, request.idempotencyKey)
    seed(adapter, {
      _id: executionId,
      status: 'succeeded',
      result: { requirement: 'r1' },
      finishedOn: Date.now(),
      epoch: 3
    })

    const body = jest.fn(async () => ({ requirement: 'SHOULD-NOT-HAPPEN' }))
    const outcome = await middleware.run(makeCtx(), request, body)

    expect(body).not.toHaveBeenCalled()
    expect(outcome.replayed).toBe(true)
    expect(outcome.result).toEqual({ requirement: 'r1' })
    // Nothing was written: a replay must not touch the ledger.
    expect(adapter.txLog).toHaveLength(0)
    expect((adapter.docs.get(executionId) as CommandExecution).epoch).toBe(3)
  })
})

describe('CommandMiddleware stale-claim preemption', () => {
  const staleRequest = { ...request, staleTimeoutMs: 1000 }

  it('takes over an expired running claim and increments epoch atomically', async () => {
    const adapter = new FakeAdapter()
    const { middleware } = await makeMiddleware(adapter)
    const executionId = commandExecutionId(request.command, request.idempotencyKey)
    seed(adapter, { _id: executionId, status: 'running', startedOn: Date.now() - 60_000, epoch: 1 })

    const body = jest.fn(async () => ({ requirement: 'r1' }))
    const outcome = await middleware.run(makeCtx(), staleRequest, body)

    expect(body).toHaveBeenCalledTimes(1)
    expect(outcome.preempted).toBe(true)
    const stored = adapter.docs.get(executionId) as CommandExecution
    expect(stored.epoch).toBe(2)
    expect(stored.status).toBe('succeeded')
    expect(stored.result).toEqual({ requirement: 'r1' })

    // The takeover must be operator-only, or it leaves the FOR UPDATE path.
    const inc = adapter.txLog.find(
      (t) => t._class === core.class.TxUpdateDoc && (t as TxUpdateDoc<CommandExecution>).operations.$inc !== undefined
    ) as TxUpdateDoc<CommandExecution>
    expect(inc).toBeDefined()
    expect(Object.keys(inc.operations).every((k) => k.startsWith('$'))).toBe(true)
    expect(inc.retrieve).toBe(true)
  })

  it('retries a failed execution', async () => {
    const adapter = new FakeAdapter()
    const { middleware } = await makeMiddleware(adapter)
    const executionId = commandExecutionId(request.command, request.idempotencyKey)
    seed(adapter, { _id: executionId, status: 'failed', error: 'boom', epoch: 0 })

    const body = jest.fn(async () => ({ requirement: 'r1' }))
    const outcome = await middleware.run(makeCtx(), request, body)

    expect(body).toHaveBeenCalledTimes(1)
    expect(outcome.result).toEqual({ requirement: 'r1' })
    expect((adapter.docs.get(executionId) as CommandExecution).status).toBe('succeeded')
  })

  it('loses the CAS when a third party grabs the stale claim first', async () => {
    const adapter = new FakeAdapter()
    const { middleware } = await makeMiddleware(adapter)
    const executionId = commandExecutionId(request.command, request.idempotencyKey)
    seed(adapter, { _id: executionId, status: 'running', startedOn: Date.now() - 60_000, epoch: 1 })

    // While we hold the row lock, someone else's increment has already landed:
    // we read epoch 1 but the row is at 2, so our $inc returns 3, not 2.
    adapter.onRowLocked = (doc) => {
      adapter.onRowLocked = undefined
      doc.epoch += 1
    }

    const body = jest.fn(async () => ({ requirement: 'r1' }))
    await expect(middleware.run(makeCtx(), staleRequest, body)).rejects.toBeInstanceOf(CommandPreemptedError)
    expect(body).not.toHaveBeenCalled()
  })

  it('discards its outcome if it was preempted while the body ran', async () => {
    const adapter = new FakeAdapter()
    const { middleware } = await makeMiddleware(adapter)
    const executionId = commandExecutionId(request.command, request.idempotencyKey)

    const body = jest.fn(async () => {
      // A newer attempt takes over mid-flight.
      const doc = adapter.docs.get(executionId) as CommandExecution
      doc.epoch = 7
      doc.status = 'running'
      return { requirement: 'stale' }
    })

    const outcome = await middleware.run(makeCtx(), request, body)
    expect(outcome.result).toEqual({ requirement: 'stale' })
    const stored = adapter.docs.get(executionId) as CommandExecution
    // Not marked succeeded: the newer attempt owns the row now.
    expect(stored.status).toBe('running')
    expect(stored.result).toBeUndefined()
  })
})

describe('CommandMiddleware failure recording', () => {
  it('records failed and rethrows when the body throws', async () => {
    const adapter = new FakeAdapter()
    const { middleware } = await makeMiddleware(adapter)
    const executionId = commandExecutionId(request.command, request.idempotencyKey)

    await expect(
      middleware.run(makeCtx(), request, async () => {
        throw new Error('lead already converted elsewhere')
      })
    ).rejects.toThrow('lead already converted elsewhere')

    const stored = adapter.docs.get(executionId) as CommandExecution
    expect(stored.status).toBe('failed')
    expect(stored.error).toBe('lead already converted elsewhere')
    expect(stored.result).toBeUndefined()
  })

  it('does NOT mark succeeded when apply.commit() reports { result: false }', async () => {
    const adapter = new FakeAdapter()
    const { middleware } = await makeMiddleware(adapter)
    const executionId = commandExecutionId(request.command, request.idempotencyKey)

    // ApplyTxMiddleware signals a rejected TxApplyIf by RETURNING a failure,
    // never by throwing. A body that ignores it would bank a phantom result.
    const rejected: CommitResult = { result: false, time: 0, serverTime: 0 }

    await expect(
      middleware.run(makeCtx(), request, async () => {
        assertCommitted(rejected, 'create requirement')
        return { requirement: 'never-written' }
      })
    ).rejects.toThrow('TxApplyIf was rejected')

    const stored = adapter.docs.get(executionId) as CommandExecution
    expect(stored.status).toBe('failed')
    expect(stored.result).toBeUndefined()
  })

  it('keeps the BODY error when the failed mark cannot be written, and logs the gap', async () => {
    // 🔴 The `failed` mark is a compensating write. Unguarded, a `finish` that
    // throws propagates INSTEAD of the body error, so the caller learns about
    // the bookkeeping and never about what actually went wrong — and it is the
    // second failure of the same outage, so it is always the less informative
    // of the two.
    const adapter = new FakeAdapter()
    const { middleware } = await makeMiddleware(adapter)
    const executionId = commandExecutionId(request.command, request.idempotencyKey)

    const logged: Array<{ message: string, params: any }> = []
    const ctx: any = {
      contextData: { account: { primarySocialId: core.account.System } },
      info: () => {},
      warn: () => {},
      error: (message: string, params: any) => logged.push({ message, params }),
      with: (name: string, params: any, op: any) => op(ctx)
    }

    // The ledger row is claimed; only the terminal update is refused, which is
    // what an adapter that dies mid-command looks like from here.
    const originalTx = adapter.tx.bind(adapter)
    ;(adapter as any).tx = async (c: any, txes: Tx[]) => {
      if (txes.some((tx) => tx._class === core.class.TxUpdateDoc)) {
        throw new Error('connection terminated')
      }
      return await originalTx(c, txes)
    }

    await expect(
      middleware.run(ctx, request, async () => {
        throw new Error('lead already converted elsewhere')
      })
    ).rejects.toThrow('lead already converted elsewhere')

    // ⚠️ NOT SWALLOWED: the row is left `running` with nobody working on it,
    // which is a real inconsistency, so it must be findable in the logs.
    expect(logged.length).toBe(1)
    expect(logged[0].params).toMatchObject({
      command: request.command,
      idempotencyKey: request.idempotencyKey,
      executionId,
      epoch: 0,
      bodyError: 'lead already converted elsewhere',
      finishError: 'connection terminated'
    })
    expect(typeof logged[0].params.staleTimeoutMs).toBe('number')

    const stored = adapter.docs.get(executionId) as CommandExecution
    expect(stored.status).toBe('running')
  })

  it('accepts a committed apply', () => {
    expect(() => {
      assertCommitted({ result: true, time: 1, serverTime: 1 }, 'create requirement')
    }).not.toThrow()
  })
})
