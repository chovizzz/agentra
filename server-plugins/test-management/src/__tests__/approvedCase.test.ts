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
import testManagement, {
  APPROVED_TEST_CASE_FROZEN_FIELDS,
  TestCasePriority,
  TestCaseStatus,
  TestCaseType,
  isTestCaseContentFrozen,
  type TestCase,
  type TestSuite
} from '@hcengineering/test-management'

import { readTestCaseFieldWrite, touchesFrozenTestCaseField } from '../approvedCase'
import { SnapshotGuardError, SnapshotGuardMiddleware } from '../snapshotGuard'

const SPACE = 'test-management:space:Project' as Ref<Space>
const SUITE = '000000000000000000000020' as Ref<TestSuite>
const CASE = '000000000000000000000021' as Ref<TestCase>
/** A project-local specialisation of `TestCase`, i.e. the subclass bypass. */
const CASE_SUBCLASS = 'test-management:class:TestCaseV2' as Ref<Class<Doc>>

const derivedFrom: Record<string, string[]> = {
  [CASE_SUBCLASS]: [testManagement.class.TestCase],
  [core.class.TxApplyIf]: [core.class.Tx]
}

const known = new Set<string>([testManagement.class.TestCase, testManagement.class.TestCaseSnapshot, CASE_SUBCLASS])

/**
 * 🔴 An EMPTY hierarchy makes `isDerived` return `false` for everything, and
 * every test below would then "pass" against a guard that checked nothing. This
 * table is what gives them teeth, and `hasClass` is what turns a forged
 * `objectClass` into a clean `false` instead of a silent walk of an empty chain.
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

async function guard (docs: Doc[]): Promise<{ mw: Middleware, sink: Recorder }> {
  const sink = new Recorder(docs)
  const mw = (await SnapshotGuardMiddleware.create({} as any, context(), sink as any)) as Middleware
  return { mw, sink }
}

/** The guard behind a real `ApplyTxMiddleware`, i.e. the production stacking. */
async function applyStack (docs: Doc[]): Promise<{ head: Middleware, sink: Recorder }> {
  const sink = new Recorder(docs)
  const ctx = context()
  const inner = (await SnapshotGuardMiddleware.create({} as any, ctx, sink as any)) as Middleware
  const head = await ApplyTxMiddleware.create({} as any, ctx, inner)
  return { head, sink }
}

const factory = new TxFactory(core.account.System, true)

function caseDoc (extra: Partial<TestCase> = {}, _class = testManagement.class.TestCase): Doc {
  return {
    _id: CASE,
    _class,
    space: SPACE,
    modifiedBy: core.account.System,
    modifiedOn: 0,
    attachedTo: SUITE,
    attachedToClass: testManagement.class.TestSuite,
    collection: 'testCases',
    name: 'Login works',
    description: null,
    type: TestCaseType.Functional,
    priority: TestCasePriority.Medium,
    status: TestCaseStatus.Approved,
    assignee: 'nobody',
    version: 3,
    ...extra
  } as any
}

// ⚠️ `TxCUD<Doc>`, not `Tx`. `createTxApplyIf` takes `TxCUD<Doc>[]`, and ts-jest
// erases the difference where `tsc` does not — the wider type compiles under
// jest and fails `_phase:validate`.
function update (operations: Record<string, any>, _class = testManagement.class.TestCase): TxCUD<Doc> {
  return factory.createTxUpdateDoc(_class as Ref<Class<Doc>>, SPACE, CASE as Ref<Doc>, operations as any)
}

async function run (docs: Doc[], txes: Tx[]): Promise<Recorder> {
  const { mw, sink } = await guard(docs)
  await mw.tx({} as any, txes)
  return sink
}

async function refusal (docs: Doc[], txes: Tx[]): Promise<SnapshotGuardError> {
  const { mw } = await guard(docs)
  try {
    await mw.tx({} as any, txes)
  } catch (err: any) {
    return err
  }
  throw new Error('expected the guard to refuse this transaction')
}

describe('QA-T019: an approved test case is read-only', () => {
  it('refuses a plain edit of every frozen field', async () => {
    for (const field of APPROVED_TEST_CASE_FROZEN_FIELDS) {
      const err = await refusal([caseDoc()], [update({ [field]: 'x' })])
      expect(err).toBeInstanceOf(SnapshotGuardError)
      expect(err.reason).toBe('approved-case-readonly')
      expect(err.message).toContain(`'${field}'`)
    }
  })

  it('allows the same edits once the case is out of Approved', async () => {
    for (const status of [
      TestCaseStatus.Draft,
      TestCaseStatus.ReadyForReview,
      TestCaseStatus.FixReviewComments,
      TestCaseStatus.Rejected
    ]) {
      const sink = await run([caseDoc({ status })], [update({ name: 'renamed' })])
      expect(sink.written).toHaveLength(1)
    }
  })

  it('lets the same transaction reopen the case and edit it', async () => {
    // The escape hatch, and the reason it is not a loophole: what lands is a
    // case that is no longer approved, which is exactly the state QA-T019 wants
    // an edited case to end up in.
    const sink = await run([caseDoc()], [update({ name: 'renamed', status: TestCaseStatus.FixReviewComments })])
    expect(sink.written).toHaveLength(1)
  })

  it('refuses an edit that re-states Approved in the same write', async () => {
    const err = await refusal([caseDoc()], [update({ name: 'renamed', status: TestCaseStatus.Approved })])
    expect(err.reason).toBe('approved-case-readonly')
  })

  it('refuses an edit whose status write cannot be evaluated', async () => {
    // `$inc` on the status has no answer to "is this still Approved", and the
    // safe answer to an unanswerable question is no.
    const err = await refusal([caseDoc()], [update({ name: 'renamed', $inc: { status: 1 } })])
    expect(err.reason).toBe('approved-case-readonly')
    expect(err.message).toContain("'status'")
    expect(err.message).toContain('$inc')
  })

  it('refuses an edit whose status is not a status', async () => {
    // 🔴 Found by fact-checking, not by the first draft: `status: null` (and
    // `99`, and the STRING `'Draft'`) all compare unequal to `Approved`, so
    // without this the gate was defeated by writing garbage instead of by
    // leaving the state — and the case landed with no position in the ladder.
    for (const status of [null, undefined, 99, -1, 'Draft', {}]) {
      const err = await refusal([caseDoc()], [update({ name: 'renamed', status })])
      expect(err.reason).toBe('approved-case-readonly')
      expect(err.message).toContain("'status'")
    }
  })

  it('refuses an edit that strips the status instead of moving it', async () => {
    // A case with no status has no position in the review ladder, so the next
    // write would be judged against nothing. That is laundering, not reopening.
    const err = await refusal([caseDoc()], [update({ name: 'renamed', $unset: { status: '' } })])
    expect(err.reason).toBe('approved-case-readonly')
    expect(err.message).toContain("'status'")
  })
})

describe('QA-T019 bypass paths', () => {
  it('refuses an operator write to a frozen field', async () => {
    for (const ops of [
      { $unset: { preconditions: '' } },
      { $push: { name: 'x' } },
      { $rename: { name: 'scratch' } },
      { $rename: { scratch: 'name' } }
    ]) {
      const err = await refusal([caseDoc()], [update(ops)])
      expect(err.reason).toBe('approved-case-readonly')
    }
  })

  it('checks $rename in BOTH directions', async () => {
    // Carrying a frozen field away, and overwriting a frozen field with another
    // one. A guard that only walked the operator's KEYS would catch the first
    // and wave the second through.
    expect(readTestCaseFieldWrite({ $rename: { name: 'scratch' } }, 'name')).toEqual({
      kind: 'opaque',
      operator: '$rename'
    })
    expect(readTestCaseFieldWrite({ $rename: { scratch: 'name' } }, 'name')).toEqual({
      kind: 'opaque',
      operator: '$rename'
    })
    // ...and does not fire on an unrelated rename.
    expect(readTestCaseFieldWrite({ $rename: { a: 'b' } }, 'name')).toEqual({ kind: 'untouched' })
  })

  it('follows a write nested inside a TxApplyIf', async () => {
    const inner = update({ name: 'renamed' })
    const applyIf = factory.createTxApplyIf(SPACE, 'scope', [], [], [inner], undefined as any)
    const err = await refusal([caseDoc()], [applyIf])
    expect(err.reason).toBe('approved-case-readonly')
  })

  it('still refuses behind a real ApplyTxMiddleware, which flattens the wrapper', async () => {
    // ⚠️ The production stacking unwraps the `TxApplyIf` above this guard, so
    // the recursion above is belt AND braces — both have to hold, because which
    // one fires depends on a middleware ORDER that lives in another file.
    const { head } = await applyStack([caseDoc()])
    const inner = update({ priority: TestCasePriority.High })
    const applyIf = factory.createTxApplyIf(SPACE, 'scope', [], [], [inner], undefined as any)
    await expect(head.tx({} as any, [applyIf])).rejects.toThrow(/approved test case/)
  })

  it('covers subclasses of TestCase', async () => {
    const err = await refusal([caseDoc({}, CASE_SUBCLASS as any)], [update({ name: 'renamed' }, CASE_SUBCLASS as any)])
    expect(err.reason).toBe('approved-case-readonly')
  })

  it('ignores an unknown objectClass rather than trusting isDerived', async () => {
    // An unrecognised classifier makes `isDerived` walk an empty ancestor chain
    // and answer `false`; `hasClass` is what keeps that from being load bearing.
    const sink = await run([caseDoc()], [update({ name: 'renamed' }, 'test-management:class:Forged' as any)])
    expect(sink.written).toHaveLength(1)
  })
})

describe('QA-T019 does not catch the platform’s own writes', () => {
  it('lets VersioningMiddleware write readonly / isLatest', async () => {
    const sink = await run([caseDoc()], [update({ readonly: true, isLatest: false })])
    expect(sink.written).toHaveLength(1)
  })

  it('lets registerTestCaseEdit bump the version and send the case back to review', async () => {
    const sink = await run([caseDoc()], [update({ version: 4, status: TestCaseStatus.FixReviewComments })])
    expect(sink.written).toHaveLength(1)
  })

  it('lets collection counters through, so comments and attachments keep landing', async () => {
    const sink = await run([caseDoc()], [update({ $inc: { comments: 1 } }), update({ $inc: { attachments: 1 } })])
    expect(sink.written).toHaveLength(2)
  })

  it('never reads the document for a transaction that names no frozen field', async () => {
    // The cheap gate. If this regressed, every unrelated write on every test
    // case would pay for a lookup.
    expect(touchesFrozenTestCaseField({ version: 4 })).toBe(false)
    expect(touchesFrozenTestCaseField({ $inc: { comments: 1 } })).toBe(false)
    expect(touchesFrozenTestCaseField({ readonly: true, isLatest: false })).toBe(false)
    expect(touchesFrozenTestCaseField({ name: 'x' })).toBe(true)
  })

  it('does not refuse an update addressed at a case that is not there', async () => {
    // No row is written, and refusing would be a false negative for the
    // legitimate create-then-update batch whose create has not landed yet.
    const sink = await run([], [update({ name: 'renamed' })])
    expect(sink.written).toHaveLength(1)
  })
})

describe('client rules never exceed the server', () => {
  /**
   * 🔴 THE FAILURE THIS EXISTS TO CATCH is a control the panel offers and the
   * pipeline refuses — "the button works but the save errors". Both sides read
   * `APPROVED_TEST_CASE_FROZEN_FIELDS` and `isTestCaseContentFrozen` from
   * `@hcengineering/test-management`, and these assertions prove the server
   * really is decided by them rather than by a second, drifting list.
   */
  const clientWouldAllow = (doc: Pick<TestCase, 'status'>, field: string): boolean =>
    !isTestCaseContentFrozen(doc) || !APPROVED_TEST_CASE_FROZEN_FIELDS.includes(field)

  // The frozen list plus the three the panel and the list viewlets keep live.
  const probes = [...APPROVED_TEST_CASE_FROZEN_FIELDS, 'status', 'assignee', 'version']

  it('accepts every write the panel leaves enabled', async () => {
    for (const status of [
      TestCaseStatus.Draft,
      TestCaseStatus.ReadyForReview,
      TestCaseStatus.FixReviewComments,
      TestCaseStatus.Approved,
      TestCaseStatus.Rejected
    ]) {
      for (const field of probes) {
        if (!clientWouldAllow({ status }, field)) continue
        // `status` is the one field whose value must stay a legal status; every
        // other probe is a plain scalar as far as this guard is concerned.
        const value = field === 'status' ? TestCaseStatus.Draft : 'x'
        const sink = await run([caseDoc({ status })], [update({ [field]: value })])
        expect(sink.written).toHaveLength(1)
      }
    }
  })

  it('refuses every write the panel disables, so neither side is decorative', async () => {
    for (const field of probes) {
      if (clientWouldAllow({ status: TestCaseStatus.Approved }, field)) continue
      const err = await refusal([caseDoc()], [update({ [field]: 'x' })])
      expect(err.reason).toBe('approved-case-readonly')
    }
  })

  it('leaves the inline list-view editors alone', () => {
    // `status` and `assignee` are rendered as inline editors by the list and
    // table viewlets in `models/test-management`, which the test case panel
    // cannot switch off. Freezing either would be a control that clicks and a
    // save that fails.
    expect(APPROVED_TEST_CASE_FROZEN_FIELDS.includes('assignee')).toBe(false)
  })

  it('keeps status editable in every state, so the gate is never a dead end', () => {
    // The panel greys the attribute bar out while approved and renders a live
    // status control next to the banner precisely because of this.
    expect(APPROVED_TEST_CASE_FROZEN_FIELDS.includes('status')).toBe(false)
  })
})
