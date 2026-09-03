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

import activity, { type ActivityInfoMessage } from '@hcengineering/activity'
import core, {
  TxOperations,
  TxProcessor,
  toFindResult,
  type Client,
  type Doc,
  type Hierarchy,
  type MeasureContext,
  type ModelDb,
  type Ref,
  type SessionData,
  type Tx,
  type TxApplyIf,
  type TxCreateDoc,
  type TxMixin,
  type TxResult,
  type TxUpdateDoc
} from '@hcengineering/core'
import { commandObjectId } from '@hcengineering/server-agentra-core'
import type { Middleware, PipelineContext, TxMiddlewareResult } from '@hcengineering/server-core'

import { CommandMiddleware } from '../commandMiddleware'
import {
  COMPLETE_CYCLE_LOCK,
  CYCLE_CLASS,
  CYCLE_ISSUE_KEY,
  CYCLE_ISSUE_MIXIN,
  CompleteCycleError,
  TRACKER_ISSUE_CLASS,
  TRACKER_ISSUE_STATUS_CLASS,
  completeCycle,
  completeCycleRoles,
  snapshotRecordId,
  type CompleteCycleInput
} from '../commands/completeCycle'
import { getCommandRunner, type CommandRunner } from '../commands/convertLeadToRequirement'

const SPACE = 'project-1' as Ref<any>
const OTHER_SPACE = 'project-2' as Ref<any>
const CYCLE = 'ccccccccccccccccccccccc1' as Ref<Doc>
const NEXT_CYCLE = 'ccccccccccccccccccccccc2' as Ref<Doc>
const KEY = 'cycle:complete-cycle:v1:ccccccccccccccccccccccc1'

const STATUS_TODO = 'status-todo' as Ref<any>
const STATUS_DONE = 'status-done' as Ref<any>
const STATUS_CANCELLED = 'status-cancelled' as Ref<any>

/**
 * One store shared by the idempotency ledger and the domain objects.
 *
 * ⚠️ EXTENDED BEYOND THE `convertLeadToRequirement` HARNESS in two ways, both
 * of which the cycle command depends on and neither of which the lead one
 * exercises:
 *
 *  1. `TxMixin` is applied, and applied the way the platform stores a mixin —
 *     NESTED under the mixin id. A harness that flattened it would make
 *     `CYCLE_ISSUE_KEY` queries pass for the wrong reason.
 *  2. queries understand a dotted key and `$in`. `{ 'cycle:mixin:CycleIssue.cycle': x }`
 *     is exactly the shape `makeFilterQuery` builds, and it is the ONLY way to
 *     find the issues in a cycle.
 */
class MemoryDb {
  readonly docs = new Map<Ref<Doc>, Doc>()
  /** Ids the security filter hides from `find`, so permission tests are real. */
  readonly hidden = new Set<Ref<Doc>>()

  private static read (doc: any, key: string): any {
    if (!key.includes('.')) return doc[key]
    return key.split('.').reduce((acc: any, part: string) => (acc == null ? undefined : acc[part]), doc)
  }

  private static matches (doc: any, query: Record<string, any>): boolean {
    return Object.entries(query).every(([key, expected]) => {
      const actual = MemoryDb.read(doc, key)
      if (expected != null && typeof expected === 'object' && '$in' in expected) {
        return (expected.$in as any[]).includes(actual)
      }
      return actual === expected
    })
  }

  find (_class: Ref<any>, query: Record<string, any>): Doc[] {
    const out: Doc[] = []
    for (const doc of this.docs.values()) {
      if (this.hidden.has(doc._id)) continue
      if (_class !== core.class.Doc && doc._class !== _class) continue
      if (MemoryDb.matches(doc, query)) out.push({ ...doc })
    }
    return out
  }

  apply (tx: Tx): void {
    if (tx._class === core.class.TxCreateDoc) {
      const create = tx as TxCreateDoc<Doc>
      if (this.docs.has(create.objectId)) {
        const err: any = new Error('duplicate key value violates unique constraint')
        err.code = '23505'
        throw err
      }
      this.docs.set(create.objectId, TxProcessor.createDoc2Doc(create))
    } else if (tx._class === core.class.TxUpdateDoc) {
      const update = tx as TxUpdateDoc<Doc>
      const doc = this.docs.get(update.objectId)
      if (doc !== undefined) {
        TxProcessor.applyUpdate(doc, { ...update.operations } as any)
      }
    } else if (tx._class === core.class.TxMixin) {
      const mixin = tx as TxMixin<Doc, Doc>
      const doc = this.docs.get(mixin.objectId) as any
      if (doc !== undefined) {
        doc[mixin.mixin] = { ...(doc[mixin.mixin] ?? {}), ...(mixin.attributes as any) }
      }
    }
  }
}

/** Stands in for everything under `CommandMiddleware`, ledger side only. */
class LedgerAdapter implements Middleware {
  constructor (readonly db: MemoryDb) {}

  async tx (ctx: MeasureContext<SessionData>, txes: Tx[]): Promise<TxMiddlewareResult> {
    const results: any[] = []
    for (const tx of txes) {
      this.db.apply(tx)
      if (tx._class === core.class.TxUpdateDoc && (tx as TxUpdateDoc<Doc>).retrieve === true) {
        results.push({ object: { ...(this.db.docs.get((tx as TxUpdateDoc<Doc>).objectId) as Doc) } })
      }
    }
    return results.length === 1 ? results[0] : results
  }

  async findAll (ctx: MeasureContext<SessionData>, _class: Ref<any>, query: any): Promise<any> {
    return this.db.find(_class, query)
  }

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

class FakeClient implements Client {
  /** Lets a test make `ApplyTxMiddleware` REJECT a step the way the real one does. */
  applyOutcome: (tx: TxApplyIf) => boolean = () => true
  readonly seen: Tx[] = []

  constructor (readonly db: MemoryDb) {}

  getHierarchy (): Hierarchy {
    return {
      isDerived: (_class: Ref<any>, from: Ref<any>) => from === core.class.Doc,
      findDomain: () => undefined
    } as unknown as Hierarchy
  }

  getModel (): ModelDb {
    return {} as unknown as ModelDb
  }

  async findAll<T extends Doc>(_class: Ref<any>, query: any): Promise<any> {
    return toFindResult(this.db.find(_class, query) as T[])
  }

  async findOne<T extends Doc>(_class: Ref<any>, query: any): Promise<T | undefined> {
    return this.db.find(_class, query)[0] as T | undefined
  }

  async searchFulltext (): Promise<any> {
    return { docs: [], total: 0 }
  }

  async domainRequest (): Promise<any> {
    return { domain: '', value: undefined }
  }

  async tx (tx: Tx): Promise<TxResult> {
    this.seen.push(tx)
    if (tx._class === core.class.TxApplyIf) {
      const applyIf = tx as TxApplyIf
      // Mirror `ApplyTxMiddleware.tx`: match/notMatch are evaluated ONLY when a
      // scope is present; with a null scope the middleware hard-codes passed.
      const matched =
        applyIf.scope == null ||
        ((applyIf.match ?? []).every(({ _class, query }) => this.db.find(_class, query).length > 0) &&
          (applyIf.notMatch ?? []).every(({ _class, query }) => this.db.find(_class, query).length === 0))
      const success = matched && this.applyOutcome(applyIf)
      if (success) {
        for (const inner of applyIf.txes) {
          this.db.apply(inner)
        }
      }
      return { success, derived: [], serverTime: 0 } as any
    }
    this.db.apply(tx)
    return {}
  }

  async close (): Promise<void> {}
}

function makeCtx (): MeasureContext<SessionData> {
  const ctx: any = {
    contextData: { account: { primarySocialId: core.account.System } },
    info: () => {},
    warn: () => {},
    error: () => {},
    measure: () => {},
    with: async (_n: string, _p: any, op: any) => op(ctx),
    withSync: (_n: string, _p: any, op: any) => op(ctx),
    newChild: () => ctx,
    end: () => {}
  }
  return ctx
}

interface Harness {
  ctx: MeasureContext<SessionData>
  db: MemoryDb
  client: TxOperations
  fake: FakeClient
  runner: CommandRunner
}

function putCycle (db: MemoryDb, _id: Ref<Doc>, status: string, sequence: number, space = SPACE): void {
  db.docs.set(_id, {
    _id,
    _class: CYCLE_CLASS,
    space,
    modifiedBy: core.account.System,
    modifiedOn: 0,
    name: `Cycle ${sequence}`,
    status,
    startDate: sequence * 1000,
    endDate: sequence * 1000,
    sequence
  } as unknown as Doc)
}

function putIssue (db: MemoryDb, _id: string, status: Ref<any>, cycle: Ref<Doc> | null = CYCLE): void {
  db.docs.set(
    _id as Ref<Doc>,
    {
      _id: _id as Ref<Doc>,
      _class: TRACKER_ISSUE_CLASS,
      space: SPACE,
      modifiedBy: core.account.System,
      modifiedOn: 0,
      status,
      [CYCLE_ISSUE_MIXIN as string]: { cycle }
    } as unknown as Doc
  )
}

function issueCycle (db: MemoryDb, _id: string): Ref<Doc> | null | undefined {
  return (db.docs.get(_id as Ref<Doc>) as any)?.[CYCLE_ISSUE_MIXIN as string]?.cycle
}

async function makeHarness (cycleStatus = 'active'): Promise<Harness> {
  const db = new MemoryDb()
  const ctx = makeCtx()
  const context = { contextVars: {} } as unknown as PipelineContext
  await CommandMiddleware.create(ctx, context, new LedgerAdapter(db))
  const runner = getCommandRunner(context)

  const fake = new FakeClient(db)
  const client = new TxOperations(fake, core.account.System)

  // 🔴 Statuses are classified by CATEGORY, never by name: a project type may
  // rename them freely, and only `Status.category` survives that.
  for (const [_id, category] of [
    [STATUS_TODO, 'task:statusCategory:ToDo'],
    [STATUS_DONE, 'task:statusCategory:Won'],
    [STATUS_CANCELLED, 'task:statusCategory:Lost']
  ] as Array<[Ref<any>, string]>) {
    db.docs.set(_id, {
      _id,
      _class: TRACKER_ISSUE_STATUS_CLASS,
      space: core.space.Model,
      modifiedBy: core.account.System,
      modifiedOn: 0,
      category
    } as unknown as Doc)
  }

  putCycle(db, CYCLE, cycleStatus, 1)
  putCycle(db, NEXT_CYCLE, 'planned', 2)

  return { ctx, db, client, fake, runner }
}

function snapshotId (): Ref<ActivityInfoMessage> {
  return commandObjectId<ActivityInfoMessage>(COMPLETE_CYCLE_LOCK, CYCLE, completeCycleRoles.snapshot)
}

async function run (h: Harness, input: Partial<CompleteCycleInput> = {}): Promise<any> {
  return await completeCycle(
    { ctx: h.ctx, client: h.client, runner: h.runner },
    { cycle: CYCLE, idempotencyKey: KEY, rolloverPolicy: 'keep', ...input }
  )
}

describe('completeCycle: the happy path', () => {
  it('closes the cycle and records a snapshot in its Activity', async () => {
    const h = await makeHarness()
    putIssue(h.db, 'i1', STATUS_TODO)
    putIssue(h.db, 'i2', STATUS_DONE)
    putIssue(h.db, 'i3', STATUS_CANCELLED)

    const outcome = await run(h)

    expect(outcome.replayed).toBe(false)
    expect(outcome.result.alreadyCompleted).toBe(false)
    // `Won` AND `Lost` both count as finished; only the ToDo issue is open.
    expect(outcome.result.snapshot).toEqual({ total: 3, done: 2, open: 1, rolledOver: 0 })
    expect((h.db.docs.get(CYCLE) as any).status).toBe('completed')

    // 🔴 §3.4 forbids a stored velocity/rollover field, so the snapshot's home
    // is the Activity timeline it says those numbers come from.
    const record = h.db.docs.get(snapshotId()) as ActivityInfoMessage
    expect(record).toBeDefined()
    expect(record.props).toMatchObject({ total: 3, done: 2, open: 1, rolledOver: 0, rolloverPolicy: 'keep' })
    expect((record as any).attachedTo).toBe(CYCLE)
  })

  it('leaves issues alone under `keep`', async () => {
    const h = await makeHarness()
    putIssue(h.db, 'i1', STATUS_TODO)
    await run(h, { rolloverPolicy: 'keep' })
    expect(issueCycle(h.db, 'i1')).toBe(CYCLE)
  })

  it('completes an empty cycle without inventing numbers', async () => {
    const h = await makeHarness()
    const outcome = await run(h)
    expect(outcome.result.snapshot).toEqual({ total: 0, done: 0, open: 0, rolledOver: 0 })
    expect((h.db.docs.get(CYCLE) as any).status).toBe('completed')
  })

  it('can complete a cycle that never started', async () => {
    // `planned -> completed` is legal in `cycleTransitions`; a sprint that was
    // cancelled as an idea still has to be closable.
    const h = await makeHarness('planned')
    await run(h)
    expect((h.db.docs.get(CYCLE) as any).status).toBe('completed')
  })
})

describe('completeCycle: rollover', () => {
  it('sends open issues to the backlog and leaves finished ones in the cycle', async () => {
    const h = await makeHarness()
    putIssue(h.db, 'open1', STATUS_TODO)
    putIssue(h.db, 'open2', STATUS_TODO)
    putIssue(h.db, 'done1', STATUS_DONE)

    const outcome = await run(h, { rolloverPolicy: 'backlog' })

    expect(outcome.result.snapshot).toEqual({ total: 3, done: 1, open: 2, rolledOver: 2 })
    expect(issueCycle(h.db, 'open1')).toBeNull()
    expect(issueCycle(h.db, 'open2')).toBeNull()
    // 🔴 A finished issue KEEPS its membership: the cycle's roster is the
    // record of what was actually delivered in it.
    expect(issueCycle(h.db, 'done1')).toBe(CYCLE)
  })

  it('moves open issues into the named target', async () => {
    const h = await makeHarness()
    putIssue(h.db, 'open1', STATUS_TODO)
    putIssue(h.db, 'done1', STATUS_DONE)

    const outcome = await run(h, { rolloverPolicy: 'move', rolloverTarget: NEXT_CYCLE })

    expect(outcome.result.rolloverTarget).toBe(NEXT_CYCLE)
    expect(outcome.result.snapshot).toEqual({ total: 2, done: 1, open: 1, rolledOver: 1 })
    expect(issueCycle(h.db, 'open1')).toBe(NEXT_CYCLE)
    expect(issueCycle(h.db, 'done1')).toBe(CYCLE)
  })

  it('never touches an issue that belongs to another cycle', async () => {
    const h = await makeHarness()
    putIssue(h.db, 'mine', STATUS_TODO)
    putIssue(h.db, 'theirs', STATUS_TODO, NEXT_CYCLE)

    const outcome = await run(h, { rolloverPolicy: 'backlog' })

    expect(outcome.result.snapshot.total).toBe(1)
    expect(issueCycle(h.db, 'theirs')).toBe(NEXT_CYCLE)
  })

  it('counts an issue whose status document is missing as OPEN', async () => {
    // 🔴 Guessing "done" would silently drop it from the rollover, which is the
    // one direction this command must never fail in.
    const h = await makeHarness()
    putIssue(h.db, 'orphan', 'status-that-does-not-exist' as Ref<any>)
    const outcome = await run(h, { rolloverPolicy: 'backlog' })
    expect(outcome.result.snapshot).toEqual({ total: 1, done: 0, open: 1, rolledOver: 1 })
    expect(issueCycle(h.db, 'orphan')).toBeNull()
  })
})

describe('completeCycle: refusals', () => {
  async function expectRefusal (input: Partial<CompleteCycleInput>, reason: string, status = 'active'): Promise<void> {
    const h = await makeHarness(status)
    putIssue(h.db, 'i1', STATUS_TODO)
    await expect(run(h, input)).rejects.toMatchObject({ reason, code: 400 })
    // 🔴 NOTHING IS WRITTEN. Validation runs before the rollover precisely so a
    // refused completion cannot leave an OPEN cycle that has been emptied.
    expect((h.db.docs.get(CYCLE) as any).status).toBe(status)
    expect(issueCycle(h.db, 'i1')).toBe(CYCLE)
    expect(h.db.docs.get(snapshotId())).toBeUndefined()
  }

  it('refuses a cycle that does not exist', async () => {
    const h = await makeHarness()
    h.db.docs.delete(CYCLE)
    await expect(run(h)).rejects.toBeInstanceOf(CompleteCycleError)
  })

  it('refuses a cancelled cycle — `cancelled` is terminal', async () => {
    await expectRefusal({}, 'illegal-transition', 'cancelled')
  })

  it('refuses `move` with no target rather than quietly downgrading to `keep`', async () => {
    // Silently keeping the issues would report a rollover that never happened.
    await expectRefusal({ rolloverPolicy: 'move' }, 'rollover-target-required')
  })

  it('refuses a target that does not exist', async () => {
    await expectRefusal({ rolloverPolicy: 'move', rolloverTarget: 'nope' as Ref<Doc> }, 'rollover-target-invalid')
  })

  it('refuses rolling a cycle into itself', async () => {
    await expectRefusal({ rolloverPolicy: 'move', rolloverTarget: CYCLE }, 'rollover-target-invalid')
  })

  it('refuses a target in another project', async () => {
    const h = await makeHarness()
    putCycle(h.db, 'foreign' as Ref<Doc>, 'planned', 5, OTHER_SPACE)
    await expect(run(h, { rolloverPolicy: 'move', rolloverTarget: 'foreign' as Ref<Doc> })).rejects.toMatchObject({
      reason: 'rollover-target-invalid'
    })
  })

  it('refuses a target that is itself closed — that hides the work, it does not reschedule it', async () => {
    const h = await makeHarness()
    putCycle(h.db, 'closed' as Ref<Doc>, 'completed', 9)
    await expect(run(h, { rolloverPolicy: 'move', rolloverTarget: 'closed' as Ref<Doc> })).rejects.toMatchObject({
      reason: 'rollover-target-invalid'
    })
  })
})

describe('completeCycle: idempotency and re-entrancy', () => {
  it('replays the stored result for the same key without writing again', async () => {
    const h = await makeHarness()
    putIssue(h.db, 'open1', STATUS_TODO)

    const first = await run(h, { rolloverPolicy: 'backlog' })
    const before = h.db.docs.size
    const second = await run(h, { rolloverPolicy: 'backlog' })

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.result.snapshot).toEqual(first.result.snapshot)
    expect(h.db.docs.size).toBe(before)
    expect(h.db.find(activity.class.ActivityInfoMessage, {})).toHaveLength(1)
  })

  it('converges on ONE snapshot even for a second, different idempotency key', async () => {
    // 🔴 What the INNER claim buys. The ledger only excludes on
    // `(command, idempotencyKey)`, and the key is caller supplied; the inner
    // claim keyed on the CYCLE is what stops a second key running the body.
    const h = await makeHarness()
    putIssue(h.db, 'open1', STATUS_TODO)

    const first = await run(h, { rolloverPolicy: 'move', rolloverTarget: NEXT_CYCLE })
    const second = await run(h, { idempotencyKey: 'a-different-key', rolloverPolicy: 'keep' })

    expect(second.result.alreadyCompleted).toBe(true)
    expect(second.result.snapshot).toEqual(first.result.snapshot)
    expect(h.db.find(activity.class.ActivityInfoMessage, {})).toHaveLength(1)
    // The second caller's `keep` did NOT drag the issue back.
    expect(issueCycle(h.db, 'open1')).toBe(NEXT_CYCLE)
  })

  it('RE-ENTERS after a partial run and reports the SAME numbers', async () => {
    // 🔴 The point of writing the snapshot BEFORE the rollover. The first pass
    // moves the issues and then dies on the status write; by the time the
    // second pass runs the cycle is EMPTY, so a body that recomputed its counts
    // would report `total: 0` for a cycle that closed with two issues in it.
    const h = await makeHarness()
    putIssue(h.db, 'open1', STATUS_TODO)
    putIssue(h.db, 'done1', STATUS_DONE)

    h.fake.applyOutcome = (tx) => !String((tx as any).measureName ?? '').includes('cycle-status')
    await expect(run(h, { rolloverPolicy: 'move', rolloverTarget: NEXT_CYCLE })).rejects.toThrow()

    // The rollover landed; the status did not.
    expect(issueCycle(h.db, 'open1')).toBe(NEXT_CYCLE)
    expect((h.db.docs.get(CYCLE) as any).status).toBe('active')

    h.fake.applyOutcome = () => true
    const outcome = await run(h, { rolloverPolicy: 'move', rolloverTarget: NEXT_CYCLE })

    expect((h.db.docs.get(CYCLE) as any).status).toBe('completed')
    expect(outcome.result.snapshot).toEqual({ total: 2, done: 1, open: 1, rolledOver: 1 })
    // 🔴 Still exactly one snapshot record: the derived `_id` is what makes the
    // second pass find the first pass's record instead of writing a second.
    expect(h.db.find(activity.class.ActivityInfoMessage, {})).toHaveLength(1)
  })

  it('does not roll an already-rolled issue a second time', async () => {
    // §4: "rollover 按 Issue 逐个判定，已滚动的不重复滚动". The roster query only
    // returns issues still pointing at THIS cycle.
    const h = await makeHarness()
    putIssue(h.db, 'moved', STATUS_TODO, NEXT_CYCLE)
    putIssue(h.db, 'staying', STATUS_TODO)

    const outcome = await run(h, { rolloverPolicy: 'backlog' })

    expect(outcome.result.snapshot.total).toBe(1)
    expect(issueCycle(h.db, 'moved')).toBe(NEXT_CYCLE)
    expect(issueCycle(h.db, 'staying')).toBeNull()
  })

  it('finishes a completion whose status landed but whose rollover did not', async () => {
    // The mirror image of the crash above: `alreadyCompleted` must not mean
    // "stop", it means "the status half is done".
    const h = await makeHarness()
    putIssue(h.db, 'open1', STATUS_TODO)
    ;(h.db.docs.get(CYCLE) as any).status = 'completed'

    const outcome = await run(h, { rolloverPolicy: 'backlog' })

    expect(outcome.result.alreadyCompleted).toBe(true)
    expect(issueCycle(h.db, 'open1')).toBeNull()
  })

  it('every rollover write is a compare-and-swap, so a re-filed issue is never dragged along', async () => {
    // 🔴 `assertCommitted` is what surfaces the refusal. Failing loudly and
    // converging on the retry is the only outcome that cannot lose an issue.
    const h = await makeHarness()
    putIssue(h.db, 'open1', STATUS_TODO)
    h.fake.applyOutcome = (tx) => !String((tx as any).measureName ?? '').includes('rollover')

    await expect(run(h, { rolloverPolicy: 'backlog' })).rejects.toThrow()
    expect(issueCycle(h.db, 'open1')).toBe(CYCLE)
    expect((h.db.docs.get(CYCLE) as any).status).toBe('active')
  })
})

describe('completeCycle: the wire constants', () => {
  it('spell the ids the cycle model actually registers', () => {
    // 🔴 These are copies, not imports (this package cannot depend on
    // `@hcengineering/cycle` without rewriting the lockfile). Pinning the
    // literals is the most a package that cannot import them can do.
    expect(CYCLE_CLASS).toBe('cycle:class:Cycle')
    expect(CYCLE_ISSUE_MIXIN).toBe('cycle:mixin:CycleIssue')
    expect(TRACKER_ISSUE_CLASS).toBe('tracker:class:Issue')
    expect(TRACKER_ISSUE_STATUS_CLASS).toBe('tracker:class:IssueStatus')
  })

  it('queries the mixin attribute under its NESTED key', () => {
    // A bare `{ cycle: ... }` query would match nothing at all — silently,
    // because `DocumentQuery` is not type checked against a mixin.
    expect(CYCLE_ISSUE_KEY).toBe('cycle:mixin:CycleIssue.cycle')
  })
})

describe('completeCycle: the rollover plan is pinned, and the target is checked on every write', () => {
  it("replays the FIRST pass's target, not the retry's", async () => {
    // 🔴 `CommandRunner` treats a `failed` row as retryable, so a crashed
    // attempt can legitimately be retried with different arguments. Honouring
    // them would split this cycle's leftovers across two destinations with
    // nothing recording that it happened.
    const h = await makeHarness()
    putCycle(h.db, 'other-target' as Ref<Doc>, 'planned', 3)
    putIssue(h.db, 'open1', STATUS_TODO)
    putIssue(h.db, 'open2', STATUS_TODO)

    // First pass moves the issues into NEXT_CYCLE, then dies on the status CAS.
    h.fake.applyOutcome = (tx) => !String((tx as any).measureName ?? '').includes('cycle-status')
    await expect(run(h, { rolloverPolicy: 'move', rolloverTarget: NEXT_CYCLE })).rejects.toThrow()
    expect(issueCycle(h.db, 'open1')).toBe(NEXT_CYCLE)

    // A retry asks for a DIFFERENT target. The pinned plan wins.
    h.fake.applyOutcome = () => true
    const outcome = await run(h, { rolloverPolicy: 'move', rolloverTarget: 'other-target' as Ref<Doc> })

    expect(outcome.result.rolloverTarget).toBe(NEXT_CYCLE)
    expect(issueCycle(h.db, 'open1')).toBe(NEXT_CYCLE)
    expect(issueCycle(h.db, 'open2')).toBe(NEXT_CYCLE)
    expect(h.db.docs.get('other-target' as Ref<Doc>)).toBeDefined()
  })

  it('replays a pinned `backlog` even when the retry asks to keep', async () => {
    const h = await makeHarness()
    putIssue(h.db, 'open1', STATUS_TODO)

    h.fake.applyOutcome = (tx) => !String((tx as any).measureName ?? '').includes('cycle-status')
    await expect(run(h, { rolloverPolicy: 'backlog' })).rejects.toThrow()
    h.fake.applyOutcome = () => true
    const outcome = await run(h, { rolloverPolicy: 'keep' })

    expect(outcome.result.rolloverPolicy).toBe('backlog')
    expect(issueCycle(h.db, 'open1')).toBeNull()
  })

  it('persists the plan on the snapshot record', async () => {
    const h = await makeHarness()
    putIssue(h.db, 'open1', STATUS_TODO)
    await run(h, { rolloverPolicy: 'move', rolloverTarget: NEXT_CYCLE })
    const record = h.db.docs.get(snapshotRecordId(CYCLE)) as any
    expect(record.props).toMatchObject({ rolloverPolicy: 'move', rolloverTarget: NEXT_CYCLE })
  })

  it('refuses rather than writing a dangling ref when the target dies mid-rollover', async () => {
    // 🔴 THE PATH CODEX FOUND. `resolveRolloverTarget` runs before the roster is
    // read; a cycle can be deleted in between. Without the per-write match the
    // issue would be stamped with a `Ref` to a cycle that no longer exists —
    // in neither the old cycle, nor a live target, nor the backlog.
    const h = await makeHarness()
    putIssue(h.db, 'open1', STATUS_TODO)
    let deleted = false
    const realFind = h.db.find.bind(h.db)
    jest.spyOn(h.db, 'find').mockImplementation((_class: any, query: any) => {
      // Delete the target exactly once, after it has been validated and just
      // before the first rollover write is verified.
      if (!deleted && _class === TRACKER_ISSUE_CLASS && query[CYCLE_ISSUE_KEY] === CYCLE) {
        deleted = true
        const res = realFind(_class, query)
        h.db.docs.delete(NEXT_CYCLE)
        return res
      }
      return realFind(_class, query)
    })

    await expect(run(h, { rolloverPolicy: 'move', rolloverTarget: NEXT_CYCLE })).rejects.toThrow()
    expect(issueCycle(h.db, 'open1')).toBe(CYCLE)
    expect((h.db.docs.get(CYCLE) as any).status).toBe('active')
    jest.restoreAllMocks()
  })

  it('refuses when the target went terminal after validation', async () => {
    const h = await makeHarness()
    putIssue(h.db, 'open1', STATUS_TODO)
    let closed = false
    const realFind = h.db.find.bind(h.db)
    jest.spyOn(h.db, 'find').mockImplementation((_class: any, query: any) => {
      if (!closed && _class === TRACKER_ISSUE_CLASS && query[CYCLE_ISSUE_KEY] === CYCLE) {
        closed = true
        const res = realFind(_class, query)
        ;(h.db.docs.get(NEXT_CYCLE) as any).status = 'cancelled'
        return res
      }
      return realFind(_class, query)
    })

    await expect(run(h, { rolloverPolicy: 'move', rolloverTarget: NEXT_CYCLE })).rejects.toThrow()
    expect(issueCycle(h.db, 'open1')).toBe(CYCLE)
    jest.restoreAllMocks()
  })

  it('adds no target guard when the policy is `backlog`', async () => {
    // The destination is `null`; there is nothing to check, and a spurious
    // match clause would make every backlog rollover fail.
    const h = await makeHarness()
    putIssue(h.db, 'open1', STATUS_TODO)
    h.db.docs.delete(NEXT_CYCLE)
    await run(h, { rolloverPolicy: 'backlog' })
    expect(issueCycle(h.db, 'open1')).toBeNull()
  })
})

describe('completeCycle: the ledger replay must not answer a caller who cannot read the cycle', () => {
  it('refuses a replay to a caller who may not read the cycle', async () => {
    // 🔴 THE REPLAY NEVER ENTERS THE BODY. `CommandMiddleware.resume` returns a
    // `succeeded` row's stored result verbatim, and BOTH claims are keyed on
    // caller-supplied data — the outer key is a pure function of the cycle id,
    // the inner one IS the cycle id. Without a check outside the runner, anyone
    // naming a completed cycle would be handed the stored snapshot: how many
    // issues it held, how many were done, where the leftovers went, and the
    // fact that the cycle exists at all.
    const h = await makeHarness()
    putIssue(h.db, 'i1', STATUS_TODO)
    const first = await run(h)
    expect(first.result.snapshot).toBeDefined()

    h.db.hidden.add(CYCLE)

    // Same key — the outer ledger row would replay …
    await expect(run(h)).rejects.toThrow(/does not exist/)

    // … and a DIFFERENT key, which would still replay the inner cycle claim.
    await expect(run(h, { idempotencyKey: 'attacker' })).rejects.toThrow(/does not exist/)
  })

  it('still replays normally for a caller who CAN read the cycle', async () => {
    // The guard must not break the legitimate replay it sits in front of.
    const h = await makeHarness()
    putIssue(h.db, 'i1', STATUS_TODO)
    const first = await run(h)
    const again = await run(h)

    expect(again.replayed).toBe(true)
    expect(again.result.snapshot).toEqual(first.result.snapshot)
  })
})
