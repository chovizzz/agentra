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
  TxFactory,
  toFindResult,
  type Class,
  type Doc,
  type MeasureContext,
  type Ref,
  type Space,
  type Tx,
  type TxCUD
} from '@hcengineering/core'
import { ApplyTxMiddleware } from '@hcengineering/middleware'
import type { Middleware, PipelineContext } from '@hcengineering/server-core'
import testManagement, { TestRunStatus, type TestResult, type TestRun } from '@hcengineering/test-management'

import { BlockedGuardError, BlockedReasonGuardMiddleware } from '../blockedGuard'

const SPACE = 'test-management:space:Project' as Ref<Space>
const RUN = '000000000000000000000010' as Ref<TestRun>
const RESULT = '000000000000000000000011' as Ref<TestResult>
const RESULT_SUBCLASS = 'test-management:class:TestResultV2' as Ref<Class<Doc>>

const derivedFrom: Record<string, string[]> = {
  [RESULT_SUBCLASS]: [testManagement.class.TestResult],
  [core.class.TxApplyIf]: [core.class.Tx]
}

const known = new Set<string>([testManagement.class.TestResult, RESULT_SUBCLASS])

/**
 * 🔴 An EMPTY hierarchy would make `isDerived` return false for everything and
 * every one of these tests would "pass" while the guard checked nothing. The
 * table below is what makes them mean something — and `hasClass` is what makes
 * an unknown class a clean `false` rather than a silent walk of an empty chain.
 */
const hierarchy = {
  hasClass: (_class: string) => known.has(_class),
  isDerived: (a: string, b: string) => a === b || (derivedFrom[a] ?? []).includes(b)
} as any

class Recorder implements Partial<Middleware> {
  readonly written: Tx[] = []
  constructor (readonly docs: Doc[]) {}

  async tx (_ctx: MeasureContext, txes: Tx[]): Promise<any> {
    this.written.push(...txes)
    return {}
  }

  async findAll (_ctx: MeasureContext, _class: Ref<Class<Doc>>, query: Record<string, any>): Promise<any> {
    const matches = this.docs.filter(
      (doc) =>
        (doc._class === _class || (derivedFrom[doc._class] ?? []).includes(_class)) &&
        Object.entries(query).every(([key, value]) => (doc as any)[key] === value)
    )
    return toFindResult(matches as any)
  }
}

function context (): PipelineContext {
  return { hierarchy, contextVars: {} } as any
}

async function guard (docs: Doc[] = []): Promise<{ mw: Middleware, sink: Recorder }> {
  const sink = new Recorder(docs)
  const mw = (await BlockedReasonGuardMiddleware.create({} as any, context(), sink as any)) as Middleware
  return { mw, sink }
}

/** The guard behind a real ApplyTxMiddleware, i.e. the production stacking. */
async function applyStack (docs: Doc[]): Promise<{ head: Middleware, sink: Recorder }> {
  const sink = new Recorder(docs)
  const ctx = context()
  const inner = (await BlockedReasonGuardMiddleware.create({} as any, ctx, sink as any)) as Middleware
  const head = await ApplyTxMiddleware.create({} as any, ctx, inner)
  return { head, sink }
}

const factory = new TxFactory(core.account.System, true)

function resultDoc (extra: Partial<TestResult> = {}): Doc {
  return {
    _id: RESULT,
    _class: testManagement.class.TestResult,
    space: SPACE,
    modifiedBy: core.account.System,
    modifiedOn: 0,
    attachedTo: RUN,
    attachedToClass: testManagement.class.TestRun,
    collection: 'results',
    name: 'Login works',
    testCase: '000000000000000000000012' as any,
    description: null,
    ...extra
  } as any
}

// ⚠️ `TxCUD<Doc>`, not `Tx`. `createTxApplyIf` takes `TxCUD<Doc>[]`, and
// ts-jest is happy to erase the difference where tsc is not — the wider type
// compiles under jest and fails `_phase:validate`.
function create (attributes: Partial<TestResult>): TxCUD<Doc> {
  return factory.createTxCreateDoc(testManagement.class.TestResult, SPACE, attributes as any, RESULT)
}

function update (operations: Record<string, any>, _class = testManagement.class.TestResult): TxCUD<Doc> {
  return factory.createTxUpdateDoc(_class as any, SPACE, RESULT, operations as any)
}

describe('BlockedReasonGuardMiddleware', () => {
  it('refuses a Blocked result created with no reason', async () => {
    const { mw, sink } = await guard()
    await expect(
      mw.tx({} as any, [create({ name: 'Login works', status: TestRunStatus.Blocked })])
    ).rejects.toMatchObject({ reason: 'blocked-requires-reason' })
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a whitespace-only reason', async () => {
    const { mw } = await guard()
    await expect(
      mw.tx({} as any, [create({ status: TestRunStatus.Blocked, blockedReason: '   ' })])
    ).rejects.toBeInstanceOf(BlockedGuardError)
  })

  it('accepts a Blocked result that states why', async () => {
    const { mw, sink } = await guard()
    await mw.tx({} as any, [create({ status: TestRunStatus.Blocked, blockedReason: 'staging is down' })])
    expect(sink.written).toHaveLength(1)
  })

  it('leaves every other status alone', async () => {
    const { mw, sink } = await guard()
    for (const status of [TestRunStatus.Untested, TestRunStatus.Passed, TestRunStatus.Failed, TestRunStatus.Skipped]) {
      await mw.tx({} as any, [create({ status })])
    }
    expect(sink.written).toHaveLength(4)
  })

  it('refuses an update that moves a result to Blocked with no reason', async () => {
    const { mw, sink } = await guard([resultDoc({ status: TestRunStatus.Untested })])
    await expect(mw.tx({} as any, [update({ status: TestRunStatus.Blocked })])).rejects.toMatchObject({
      reason: 'blocked-requires-reason'
    })
    expect(sink.written).toHaveLength(0)
  })

  it('accepts the update when the same transaction supplies the reason', async () => {
    const { mw, sink } = await guard([resultDoc({ status: TestRunStatus.Untested })])
    await mw.tx({} as any, [update({ status: TestRunStatus.Blocked, blockedReason: 'no test data' })])
    expect(sink.written).toHaveLength(1)
  })

  it('accepts the update when the result already carries a reason', async () => {
    const { mw, sink } = await guard([resultDoc({ blockedReason: 'flaky env' })])
    await mw.tx({} as any, [update({ status: TestRunStatus.Blocked })])
    expect(sink.written).toHaveLength(1)
  })

  it('refuses CLEARING the reason out from under a blocked result', async () => {
    // 🔴 The second-write path. Without this the rule is enforced once and then
    // trivially undone, leaving exactly the record it forbids.
    const { mw } = await guard([resultDoc({ status: TestRunStatus.Blocked, blockedReason: 'flaky env' })])
    await expect(mw.tx({} as any, [update({ blockedReason: '' })])).rejects.toMatchObject({
      reason: 'blocked-requires-reason'
    })
    await expect(mw.tx({} as any, [update({ $unset: { blockedReason: '' } })])).rejects.toMatchObject({
      reason: 'blocked-requires-reason'
    })
  })

  it('refuses an operator write it cannot evaluate', async () => {
    const { mw } = await guard([resultDoc({ status: TestRunStatus.Blocked, blockedReason: 'x' })])
    await expect(mw.tx({} as any, [update({ $push: { blockedReason: 'y' } })])).rejects.toMatchObject({
      reason: 'opaque-operation'
    })
  })

  it('lets a blocked result leave Blocked without a reason', async () => {
    const { mw, sink } = await guard([resultDoc({ status: TestRunStatus.Blocked, blockedReason: 'flaky env' })])
    await mw.tx({} as any, [update({ status: TestRunStatus.Passed, blockedReason: '' })])
    expect(sink.written).toHaveLength(1)
  })

  it('covers a subclass of TestResult', async () => {
    const { mw } = await guard([resultDoc({ _class: RESULT_SUBCLASS } as any)])
    await expect(
      mw.tx({} as any, [update({ status: TestRunStatus.Blocked }, RESULT_SUBCLASS as any)])
    ).rejects.toMatchObject({ reason: 'blocked-requires-reason' })
  })

  it('sees through a TxApplyIf, both wrapped and unwrapped', async () => {
    // The guard descends into `TxApplyIf.txes` itself, AND the production stack
    // has already flattened them by the time it runs. Both must refuse.
    const { mw } = await guard()
    const wrapped = factory.createTxApplyIf(
      SPACE,
      'scope',
      [],
      [],
      [create({ status: TestRunStatus.Blocked })],
      'blocked-test'
    )
    await expect(mw.tx({} as any, [wrapped])).rejects.toMatchObject({ reason: 'blocked-requires-reason' })

    const { head, sink } = await applyStack([])
    await expect(
      head.tx({} as any, [
        factory.createTxApplyIf(SPACE, 'scope', [], [], [create({ status: TestRunStatus.Blocked })], 'blocked-test')
      ])
    ).rejects.toMatchObject({ reason: 'blocked-requires-reason' })
    expect(sink.written).toHaveLength(0)
  })

  it('ignores an update whose target does not exist yet', async () => {
    // A create-then-update batch: refusing here would be a false negative.
    const { mw, sink } = await guard([])
    await mw.tx({} as any, [update({ status: TestRunStatus.Blocked })])
    expect(sink.written).toHaveLength(1)
  })

  it('ignores classes that are not test results', async () => {
    const { mw, sink } = await guard([])
    await mw.tx({} as any, [
      factory.createTxCreateDoc('some:other:Class' as any, SPACE, { status: TestRunStatus.Blocked } as any)
    ])
    expect(sink.written).toHaveLength(1)
  })
})
