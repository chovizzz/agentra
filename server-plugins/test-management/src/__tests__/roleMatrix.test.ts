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
  AccountRole,
  TxFactory,
  systemAccountUuid,
  toFindResult,
  type Account,
  type AccountUuid,
  type Class,
  type Doc,
  type MeasureContext,
  type PersonId,
  type Ref,
  type SessionData,
  type Space,
  type Tx,
  type TxCUD
} from '@hcengineering/core'
import { ApplyTxMiddleware } from '@hcengineering/middleware'
import type { Middleware, PipelineContext } from '@hcengineering/server-core'
import testManagement, { TestCaseStatus, type TestCase } from '@hcengineering/test-management'

import { SnapshotGuardError, SnapshotGuardMiddleware, TEST_ASSET_CLASSES } from '../snapshotGuard'
import {
  TEST_ASSET_PLATFORM_MANAGED_FIELDS,
  TestAssetPermissionError,
  collectWrittenFields,
  holdsSpacePermission,
  isPlatformManagedTestAssetUpdate
} from '../roleMatrix'

const SPACE = '000000000000000000000010' as Ref<Space>
const OTHER_SPACE = '000000000000000000000011' as Ref<Space>
const CASE = '000000000000000000000001' as Ref<TestCase>
const RUN = '000000000000000000000004' as Ref<Doc>
const RESULT = '000000000000000000000005' as Ref<Doc>

const SPACE_TYPE = 'testManagement:spaceType:DefaultProject' as Ref<any>
const ROLE_QA = 'testManagement:role:QA' as Ref<any>
const ROLE_DEVELOPER = 'testManagement:role:Developer' as Ref<any>
const ROLE_PM = 'testManagement:role:ProjectManager' as Ref<any>
const TYPE_DATA = testManagement.mixin.DefaultProjectTypeData

/**
 * A subclass of a guarded class, so the matrix is proved to travel down the
 * hierarchy rather than matching one `_class` string.
 */
const RESULT_SUBCLASS = 'test-management:class:TestResultV2' as Ref<Class<Doc>>

const derivedFrom: Record<string, string[]> = {
  [RESULT_SUBCLASS]: [testManagement.class.TestResult],
  [testManagement.class.TestProject]: [core.class.TypedSpace, core.class.Space],
  [core.class.TxApplyIf]: [core.class.Tx]
}

const known = new Set<string>([
  testManagement.class.TestCase,
  testManagement.class.TestResult,
  testManagement.class.TestRun,
  testManagement.class.TestSuite,
  testManagement.class.TestPlan,
  testManagement.class.TestCaseSnapshot,
  testManagement.class.TestProject,
  RESULT_SUBCLASS
])

const hierarchy = {
  hasClass: (_class: string) => known.has(_class),
  isDerived: (a: string, b: string) => a === b || (derivedFrom[a] ?? []).includes(b),
  /** `Hierarchy.as` surfaces the mixin payload merged over the document. */
  as: (doc: any, mixin: string) => ({ ...doc, ...(doc?.[mixin] ?? {}) })
} as any

const QA_ACCOUNT = 'qa-account' as AccountUuid
const DEV_ACCOUNT = 'dev-account' as AccountUuid
const PM_ACCOUNT = 'pm-account' as AccountUuid

function account (uuid: AccountUuid, role: AccountRole = AccountRole.User): Account {
  return {
    uuid,
    role,
    primarySocialId: `social-${uuid}` as PersonId,
    socialIds: [`social-${uuid}` as PersonId],
    fullSocialIds: []
  }
}

/**
 * The seat assignment §6.1 describes: QA holds `ManageTestAssets`, Developer
 * and PM hold a seat and nothing else.
 */
function projectSpace (extra: Record<string, any> = {}): Doc {
  return {
    _id: SPACE,
    _class: testManagement.class.TestProject,
    space: core.space.Space,
    modifiedBy: core.account.System,
    modifiedOn: 0,
    type: SPACE_TYPE,
    [TYPE_DATA]: {
      [ROLE_QA]: [QA_ACCOUNT],
      [ROLE_DEVELOPER]: [DEV_ACCOUNT],
      [ROLE_PM]: [PM_ACCOUNT]
    },
    ...extra
  } as any
}

const modelDocs: any[] = [
  { _id: SPACE_TYPE, _class: core.class.SpaceType, targetClass: TYPE_DATA },
  {
    _id: ROLE_QA,
    _class: core.class.Role,
    attachedTo: SPACE_TYPE,
    permissions: [testManagement.permission.ManageTestAssets]
  },
  { _id: ROLE_DEVELOPER, _class: core.class.Role, attachedTo: SPACE_TYPE, permissions: [] },
  { _id: ROLE_PM, _class: core.class.Role, attachedTo: SPACE_TYPE, permissions: [] }
]

const modelDb = {
  findAllSync: (_class: string, query: Record<string, any>) =>
    modelDocs.filter(
      (doc) => doc._class === _class && Object.entries(query).every(([key, value]) => doc[key] === value)
    )
} as any

function matchesTerm (actual: unknown, expected: any): boolean {
  if (expected !== null && typeof expected === 'object' && Array.isArray(expected.$in)) {
    return expected.$in.includes(actual)
  }
  return actual === expected
}

class Recorder implements Partial<Middleware> {
  readonly written: Tx[] = []
  readonly queries: Array<Ref<Class<Doc>>> = []
  constructor (readonly docs: Doc[]) {}

  async tx (_ctx: MeasureContext, txes: Tx[]): Promise<any> {
    this.written.push(...txes)
    return {}
  }

  async findAll (_ctx: MeasureContext, _class: Ref<Class<Doc>>, query: Record<string, any>): Promise<any> {
    this.queries.push(_class)
    const matches = this.docs.filter(
      (doc) =>
        (doc._class === _class || (derivedFrom[doc._class] ?? []).includes(_class)) &&
        Object.entries(query).every(([key, value]) => matchesTerm((doc as any)[key], value))
    )
    return toFindResult(matches as any)
  }
}

function pipelineContext (): PipelineContext {
  return { hierarchy, modelDb, contextVars: {} } as any
}

/** A ctx carrying a real `SessionData`, which is what the role gate reads. */
function session (acc: Account | undefined, extra: Partial<SessionData> = {}): MeasureContext {
  return {
    contextData: {
      account: acc,
      contextCache: new Map<string, any>(),
      ...extra
    }
  } as any
}

async function guard (docs: Doc[]): Promise<{ mw: Middleware, sink: Recorder }> {
  const sink = new Recorder(docs)
  const mw = (await SnapshotGuardMiddleware.create({} as any, pipelineContext(), sink as any)) as Middleware
  return { mw, sink }
}

async function applyStack (docs: Doc[]): Promise<{ head: Middleware, sink: Recorder }> {
  const sink = new Recorder(docs)
  const ctx = pipelineContext()
  const inner = (await SnapshotGuardMiddleware.create({} as any, ctx, sink as any)) as Middleware
  const head = await ApplyTxMiddleware.create({} as any, ctx, inner)
  return { head, sink }
}

const factory = new TxFactory(core.account.System, true)

function testCaseDoc (status: TestCaseStatus = TestCaseStatus.Draft): Doc {
  return {
    _id: CASE,
    _class: testManagement.class.TestCase,
    space: SPACE,
    modifiedBy: core.account.System,
    modifiedOn: 0,
    name: 'Login works',
    status
  } as any
}

function updateCase (ops: Record<string, any>): TxCUD<Doc> {
  return factory.createTxUpdateDoc(testManagement.class.TestCase as any, SPACE, CASE as any, ops as any)
}

// ---------------------------------------------------------------------------
// The matrix itself
// ---------------------------------------------------------------------------

describe('QA-T019 role matrix — Technical Spec §6.1 `Test assets/results`', () => {
  it('lets QA write a test case (CRUD)', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    await mw.tx(session(account(QA_ACCOUNT)), [updateCase({ name: 'renamed' })])
    expect(sink.written).toHaveLength(1)
  })

  it.each([
    ['Developer', DEV_ACCOUNT],
    ['PM', PM_ACCOUNT]
  ])('refuses a %s write (read-only column)', async (_name, uuid) => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    await expect(mw.tx(session(account(uuid)), [updateCase({ name: 'renamed' })])).rejects.toThrow(
      TestAssetPermissionError
    )
    // 🔴 A guard that logs and forwards is not a guard.
    expect(sink.written).toHaveLength(0)
  })

  it('refuses an account holding no seat at all', async () => {
    const { mw } = await guard([projectSpace(), testCaseDoc()])
    await expect(mw.tx(session(account('stranger' as AccountUuid)), [updateCase({ name: 'renamed' })])).rejects.toThrow(
      TestAssetPermissionError
    )
  })

  it('lets a workspace Maintainer write (the Admin column)', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    await mw.tx(session(account('admin-account' as AccountUuid, AccountRole.Maintainer)), [
      updateCase({ name: 'renamed' })
    ])
    expect(sink.written).toHaveLength(1)
  })

  it.each([
    ['Owner', AccountRole.Owner],
    ['Admin', AccountRole.Admin]
  ])('lets a workspace %s write', async (_name, role) => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    await mw.tx(session(account('admin-account' as AccountUuid, role)), [updateCase({ name: 'renamed' })])
    expect(sink.written).toHaveLength(1)
  })

  it('lets the system account write', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    await mw.tx(session(account(systemAccountUuid, AccountRole.User)), [updateCase({ name: 'renamed' })])
    expect(sink.written).toHaveLength(1)
  })

  it('lets an admin-mode session write', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    await mw.tx(session(account(DEV_ACCOUNT), { admin: true }), [updateCase({ name: 'renamed' })])
    expect(sink.written).toHaveLength(1)
  })

  it('refuses a session that carries no account', async () => {
    const { mw } = await guard([projectSpace(), testCaseDoc()])
    await expect(mw.tx(session(undefined), [updateCase({ name: 'renamed' })])).rejects.toThrow(TestAssetPermissionError)
  })

  /**
   * ⚠️ The documented fail-open: a context with no `SessionData` is not a
   * caller. Pinned so that a future change to that branch is a test failure
   * rather than a silent widening.
   */
  it('passes a context with no SessionData at all', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    await mw.tx({} as any, [updateCase({ name: 'renamed' })])
    expect(sink.written).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// "Read, and create defects from failures"
// ---------------------------------------------------------------------------

describe('QA-T019 — what a Developer may still do', () => {
  it('does not touch a write to a class outside the test asset list', async () => {
    const { mw, sink } = await guard([projectSpace()])
    // A tracker Issue is how "create a defect from a failure" lands. It is not
    // a test asset, so the matrix has nothing to say about it.
    const tx = factory.createTxUpdateDoc(
      'tracker:class:Issue' as any,
      SPACE,
      'issue-1' as any,
      {
        title: 'Login fails'
      } as any
    )
    await mw.tx(session(account(DEV_ACCOUNT)), [tx])
    expect(sink.written).toHaveLength(1)
  })

  it('never reads the space for a class it does not guard', async () => {
    const { mw, sink } = await guard([projectSpace()])
    const tx = factory.createTxUpdateDoc(
      'tracker:class:Issue' as any,
      SPACE,
      'issue-1' as any,
      {
        title: 'Login fails'
      } as any
    )
    await mw.tx(session(account(DEV_ACCOUNT)), [tx])
    expect(sink.queries).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Bypass paths
// ---------------------------------------------------------------------------

describe('QA-T019 role matrix — bypass paths', () => {
  it.each([
    ['$set', { $set: { name: 'renamed' } }],
    ['$unset', { $unset: { name: '' } }],
    ['$rename away', { $rename: { name: 'scratch' } }],
    ['$rename onto', { $rename: { scratch: 'name' } }],
    ['$inc', { $inc: { version: 1 } }],
    ['$push', { $push: { relations: 'x' } }]
  ])('refuses a Developer write through %s', async (_name, ops) => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    await expect(mw.tx(session(account(DEV_ACCOUNT)), [updateCase(ops)])).rejects.toThrow(TestAssetPermissionError)
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a Developer create', async () => {
    const { mw, sink } = await guard([projectSpace()])
    const tx = factory.createTxCreateDoc(
      testManagement.class.TestResult as any,
      SPACE,
      { name: 'run 1' } as any,
      RESULT as any
    )
    await expect(mw.tx(session(account(DEV_ACCOUNT)), [tx])).rejects.toThrow(TestAssetPermissionError)
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a Developer remove', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    const tx = factory.createTxRemoveDoc(testManagement.class.TestRun as any, SPACE, RUN as any)
    await expect(mw.tx(session(account(DEV_ACCOUNT)), [tx])).rejects.toThrow(TestAssetPermissionError)
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a Developer mixin write', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    const tx = factory.createTxMixin(
      CASE as any,
      testManagement.class.TestCase as any,
      SPACE,
      testManagement.mixin.TestCaseTypeData as any,
      { foo: 1 } as any
    )
    await expect(mw.tx(session(account(DEV_ACCOUNT)), [tx])).rejects.toThrow(TestAssetPermissionError)
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a Developer write on a SUBCLASS of a guarded class', async () => {
    const { mw, sink } = await guard([projectSpace()])
    const tx = factory.createTxUpdateDoc(RESULT_SUBCLASS as any, SPACE, RESULT as any, { name: 'x' } as any)
    await expect(mw.tx(session(account(DEV_ACCOUNT)), [tx])).rejects.toThrow(TestAssetPermissionError)
    expect(sink.written).toHaveLength(0)
  })

  /**
   * 🔴 THE SMUGGLING PATH. `ApplyTxMiddleware` unwraps a `TxApplyIf` above this
   * guard, but the guard also walks into `txes` itself — losing either would
   * make a wrapper the whole bypass.
   */
  it('refuses a Developer write hidden inside a TxApplyIf', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    const apply = factory.createTxApplyIf(SPACE, 'scope', [], [], [updateCase({ name: 'renamed' })], undefined)
    await expect(mw.tx(session(account(DEV_ACCOUNT)), [apply])).rejects.toThrow(TestAssetPermissionError)
    expect(sink.written).toHaveLength(0)
  })

  it('refuses it through a real ApplyTxMiddleware in front', async () => {
    const { head, sink } = await applyStack([projectSpace(), testCaseDoc()])
    const apply = factory.createTxApplyIf(SPACE, 'scope', [], [], [updateCase({ name: 'renamed' })], undefined)
    await expect(head.tx(session(account(DEV_ACCOUNT)), [apply])).rejects.toThrow(TestAssetPermissionError)
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a nested TxApplyIf', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    const inner = factory.createTxApplyIf(SPACE, 'inner', [], [], [updateCase({ name: 'renamed' })], undefined)
    const outer = factory.createTxApplyIf(SPACE, 'outer', [], [], [inner as any], undefined)
    await expect(mw.tx(session(account(DEV_ACCOUNT)), [outer])).rejects.toThrow(TestAssetPermissionError)
    expect(sink.written).toHaveLength(0)
  })

  /**
   * 🔴 THE PERMISSION IS PER SPACE. Holding QA in one project must not carry
   * into another; the space named by the transaction is the one that decides.
   */
  it('refuses QA in a space where QA holds no seat', async () => {
    const other = projectSpace({ _id: OTHER_SPACE, [TYPE_DATA]: {} })
    const { mw } = await guard([other])
    const tx = factory.createTxUpdateDoc(
      testManagement.class.TestCase as any,
      OTHER_SPACE,
      CASE as any,
      {
        name: 'renamed'
      } as any
    )
    await expect(mw.tx(session(account(QA_ACCOUNT)), [tx])).rejects.toThrow(TestAssetPermissionError)
  })

  /**
   * ⚠️ `provideFindAll` reads AS THE CALLER, so an invisible space comes back
   * empty. For a WRITE gate that has to mean "no", never "probably fine".
   */
  it('refuses when the space is not visible to the caller', async () => {
    const { mw } = await guard([testCaseDoc()])
    await expect(mw.tx(session(account(QA_ACCOUNT)), [updateCase({ name: 'renamed' })])).rejects.toThrow(
      TestAssetPermissionError
    )
  })

  it('reads the space once per request even for a batch', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    const ctx = session(account(QA_ACCOUNT))
    await mw.tx(ctx, [updateCase({ name: 'a' }), updateCase({ name: 'b' }), updateCase({ name: 'c' })])
    expect(sink.queries.filter((q) => q === core.class.Space)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Platform-owned writes must survive
// ---------------------------------------------------------------------------

describe('QA-T019 role matrix — the platform writes through it', () => {
  it.each([
    ['VersioningMiddleware demotion', { readonly: true, isLatest: false }],
    ['a comment counter', { $inc: { comments: 1 } }],
    ['an attachment counter', { $inc: { attachments: 1 } }],
    ['a counter going back down', { $inc: { comments: -1 } }]
  ])('lets %s through for a read-only role', async (_name, ops) => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    await mw.tx(session(account(DEV_ACCOUNT)), [updateCase(ops)])
    expect(sink.written).toHaveLength(1)
  })

  /**
   * `TriggersMiddleware.updateCollection` emits a `TxMixin` instead of a
   * `TxUpdateDoc` when the attached document's `_class` is a mixin
   * (`foundations/server/packages/middleware/src/triggers.ts:283`), so the
   * counter has to survive in that shape too.
   */
  it('lets a counter arriving as a TxMixin through', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    const tx = factory.createTxMixin(
      CASE as any,
      testManagement.class.TestCase as any,
      SPACE,
      testManagement.mixin.TestCaseTypeData as any,
      { comments: 1 } as any
    )
    await mw.tx(session(account(DEV_ACCOUNT)), [tx])
    expect(sink.written).toHaveLength(1)
  })

  it('still refuses a TxMixin writing a non-allowlisted field', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    const tx = factory.createTxMixin(
      CASE as any,
      testManagement.class.TestCase as any,
      SPACE,
      testManagement.mixin.TestCaseTypeData as any,
      { comments: 1, name: 'renamed' } as any
    )
    await expect(mw.tx(session(account(DEV_ACCOUNT)), [tx])).rejects.toThrow(TestAssetPermissionError)
    expect(sink.written).toHaveLength(0)
  })

  it('never reads the space for a platform-managed update', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    await mw.tx(session(account(DEV_ACCOUNT)), [updateCase({ $inc: { comments: 1 } })])
    expect(sink.queries.filter((q) => q === core.class.Space)).toHaveLength(0)
  })

  /**
   * 🔴 A MIXED UPDATE IS NOT PLATFORM MANAGED, or the allowlist would be the
   * bypass: append `readonly: true` to any edit and walk through.
   */
  it('refuses a content edit smuggled alongside a platform field', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc()])
    await expect(
      mw.tx(session(account(DEV_ACCOUNT)), [updateCase({ readonly: true, name: 'renamed' })])
    ).rejects.toThrow(TestAssetPermissionError)
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a rename ONTO a platform-managed field', async () => {
    const { mw } = await guard([projectSpace(), testCaseDoc()])
    await expect(mw.tx(session(account(DEV_ACCOUNT)), [updateCase({ $rename: { name: 'readonly' } })])).rejects.toThrow(
      TestAssetPermissionError
    )
  })

  it('lets a create or remove of a non-asset child through', async () => {
    const { mw, sink } = await guard([projectSpace()])
    const tx = factory.createTxCreateDoc('chunter:class:ChatMessage' as any, SPACE, {
      message: 'looks wrong to me'
    } as any)
    await mw.tx(session(account(DEV_ACCOUNT)), [tx])
    expect(sink.written).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Stacking with the approved-case state gate
// ---------------------------------------------------------------------------

describe('QA-T019 — role gate AND state gate', () => {
  it('refuses QA on an approved case (state gate still bites)', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc(TestCaseStatus.Approved)])
    await expect(mw.tx(session(account(QA_ACCOUNT)), [updateCase({ name: 'renamed' })])).rejects.toThrow(
      SnapshotGuardError
    )
    expect(sink.written).toHaveLength(0)
  })

  it('reports the approved-case reason for QA, not a permission error', async () => {
    const { mw } = await guard([projectSpace(), testCaseDoc(TestCaseStatus.Approved)])
    await expect(mw.tx(session(account(QA_ACCOUNT)), [updateCase({ name: 'renamed' })])).rejects.toMatchObject({
      reason: 'approved-case-readonly'
    })
  })

  /**
   * 🔴 IDENTITY BEFORE STATE. A Developer aiming at an approved case is told
   * they may not write test assets — not "send it back to review", which would
   * be a dead end for them.
   */
  it('reports the role reason for a Developer on an approved case', async () => {
    const { mw } = await guard([projectSpace(), testCaseDoc(TestCaseStatus.Approved)])
    await expect(mw.tx(session(account(DEV_ACCOUNT)), [updateCase({ name: 'renamed' })])).rejects.toMatchObject({
      reason: 'test-assets-readonly'
    })
  })

  it('refuses a Developer on a DRAFT case too — the role gate is independent', async () => {
    const { mw } = await guard([projectSpace(), testCaseDoc(TestCaseStatus.Draft)])
    await expect(mw.tx(session(account(DEV_ACCOUNT)), [updateCase({ name: 'renamed' })])).rejects.toMatchObject({
      reason: 'test-assets-readonly'
    })
  })

  it('lets QA reopen and edit an approved case in one transaction', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc(TestCaseStatus.Approved)])
    await mw.tx(session(account(QA_ACCOUNT)), [
      updateCase({ name: 'renamed', status: TestCaseStatus.FixReviewComments })
    ])
    expect(sink.written).toHaveLength(1)
  })

  it('does NOT let a Developer reopen and edit in one transaction', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc(TestCaseStatus.Approved)])
    await expect(
      mw.tx(session(account(DEV_ACCOUNT)), [updateCase({ name: 'renamed', status: TestCaseStatus.FixReviewComments })])
    ).rejects.toThrow(TestAssetPermissionError)
    expect(sink.written).toHaveLength(0)
  })

  it('lets a comment counter through on an APPROVED case for a Developer', async () => {
    // Both gates have to say yes: the allowlist for the role gate, and
    // `touchesFrozenTestCaseField` for the state gate.
    const { mw, sink } = await guard([projectSpace(), testCaseDoc(TestCaseStatus.Approved)])
    await mw.tx(session(account(DEV_ACCOUNT)), [updateCase({ $inc: { comments: 1 } })])
    expect(sink.written).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('collectWrittenFields', () => {
  it('reports a plain field', () => {
    expect(collectWrittenFields({ name: 'x' })).toEqual(['name'])
  })

  it('reports an operator payload key', () => {
    expect(collectWrittenFields({ $set: { name: 'x' } })).toEqual(['name'])
  })

  it('reports BOTH sides of a $rename', () => {
    expect(collectWrittenFields({ $rename: { name: 'scratch' } }).sort()).toEqual(['name', 'scratch'])
  })

  it('does not treat a non-$rename VALUE as a field name', () => {
    expect(collectWrittenFields({ $set: { name: 'readonly' } })).toEqual(['name'])
  })

  it('reports an operator with a non-object payload under its own key', () => {
    expect(collectWrittenFields({ $set: 'nonsense' })).toEqual(['$set'])
  })

  it('reports nothing for an empty update', () => {
    expect(collectWrittenFields({})).toEqual([])
  })
})

describe('isPlatformManagedTestAssetUpdate', () => {
  it.each(TEST_ASSET_PLATFORM_MANAGED_FIELDS.map((f) => [f]))('accepts %s alone', (field) => {
    expect(isPlatformManagedTestAssetUpdate({ [field]: 1 })).toBe(true)
  })

  it('accepts an empty update', () => {
    expect(isPlatformManagedTestAssetUpdate({})).toBe(true)
  })

  it('rejects a mixed update', () => {
    expect(isPlatformManagedTestAssetUpdate({ readonly: true, name: 'x' })).toBe(false)
  })

  it('rejects a rename onto a managed field', () => {
    expect(isPlatformManagedTestAssetUpdate({ $rename: { name: 'readonly' } })).toBe(false)
  })

  it('rejects an opaque operator payload', () => {
    expect(isPlatformManagedTestAssetUpdate({ $set: 'nonsense' })).toBe(false)
  })
})

describe('holdsSpacePermission', () => {
  const perm = testManagement.permission.ManageTestAssets

  it('finds the grant through the role that carries it', () => {
    expect(
      holdsSpacePermission(
        [{ _id: ROLE_QA, permissions: [perm] }] as any,
        { [ROLE_QA]: [QA_ACCOUNT] } as any,
        perm,
        QA_ACCOUNT
      )
    ).toBe(true)
  })

  it('ignores a role the account is not seated in', () => {
    expect(
      holdsSpacePermission(
        [{ _id: ROLE_QA, permissions: [perm] }] as any,
        { [ROLE_QA]: [QA_ACCOUNT] } as any,
        perm,
        DEV_ACCOUNT
      )
    ).toBe(false)
  })

  it('ignores a seat in a role without the permission', () => {
    expect(
      holdsSpacePermission(
        [{ _id: ROLE_DEVELOPER, permissions: [] }] as any,
        { [ROLE_DEVELOPER]: [DEV_ACCOUNT] } as any,
        perm,
        DEV_ACCOUNT
      )
    ).toBe(false)
  })

  it('survives a role doc with no permissions array', () => {
    expect(holdsSpacePermission([{ _id: ROLE_QA }] as any, { [ROLE_QA]: [QA_ACCOUNT] } as any, perm, QA_ACCOUNT)).toBe(
      false
    )
  })

  it('survives a missing assignment entry', () => {
    expect(holdsSpacePermission([{ _id: ROLE_QA, permissions: [perm] }] as any, {} as any, perm, QA_ACCOUNT)).toBe(
      false
    )
  })
})

describe('TEST_ASSET_CLASSES', () => {
  /**
   * ⚠️ `TestProject` must NOT be in here: it is the space, and guarding it
   * would refuse the membership edit that grants the QA role in the first
   * place.
   */
  it('covers every asset class and not the space', () => {
    expect(TEST_ASSET_CLASSES).toContain(testManagement.class.TestCase)
    expect(TEST_ASSET_CLASSES).toContain(testManagement.class.TestResult)
    expect(TEST_ASSET_CLASSES).toContain(testManagement.class.TestRun)
    expect(TEST_ASSET_CLASSES).toContain(testManagement.class.TestPlan)
    expect(TEST_ASSET_CLASSES).toContain(testManagement.class.TestPlanItem)
    expect(TEST_ASSET_CLASSES).toContain(testManagement.class.TestSuite)
    expect(TEST_ASSET_CLASSES).toContain(testManagement.class.TestStep)
    expect(TEST_ASSET_CLASSES).toContain(testManagement.class.TestCaseSnapshot)
    expect(TEST_ASSET_CLASSES).toContain(testManagement.class.TestEnvironment)
    expect(TEST_ASSET_CLASSES).toContain(testManagement.class.Build)
    expect(TEST_ASSET_CLASSES).not.toContain(testManagement.class.TestProject as any)
  })
})

describe('who may change WHO HOLDS A ROLE on a test project', () => {
  // 🔴 THE ROOT OF THE WHOLE MATRIX. `SpacePermissionsMiddleware` returns true
  // unconditionally when the write's target IS a space
  // (`foundations/server/packages/middleware/src/spacePermissions.ts:201`), and
  // a `TestProject` is not a restricted space — so without this rule any member
  // could put themself in the QA role and then pass the asset gate honestly.
  function assignRoles (uuid: AccountUuid): Tx {
    return factory.createTxMixin(SPACE as any, testManagement.class.TestProject as any, core.space.Space, TYPE_DATA, {
      [ROLE_QA]: [uuid]
    } as any)
  }

  function assignRolesViaUpdate (uuid: AccountUuid): Tx {
    // The same write in its stored shape: a mixin attribute lives under
    // `<mixinId>.<key>`, so a plain update reaches it without ever naming a
    // mixin transaction.
    return factory.createTxUpdateDoc(
      testManagement.class.TestProject as any,
      core.space.Space,
      SPACE as any,
      {
        [`${TYPE_DATA}.${ROLE_QA}`]: [uuid]
      } as any
    )
  }

  it('refuses a plain member promoting themself to QA', async () => {
    const { mw, sink } = await guard([projectSpace({ owners: ['someone-else' as AccountUuid] })])
    await expect(mw.tx(session(account(DEV_ACCOUNT)), [assignRoles(DEV_ACCOUNT)])).rejects.toThrow(/owner/)
    expect(sink.written).toHaveLength(0)
  })

  it('refuses the same promotion written as a dotted update', async () => {
    const { mw, sink } = await guard([projectSpace({ owners: ['someone-else' as AccountUuid] })])
    await expect(mw.tx(session(account(DEV_ACCOUNT)), [assignRolesViaUpdate(DEV_ACCOUNT)])).rejects.toThrow(/owner/)
    expect(sink.written).toHaveLength(0)
  })

  it('refuses it smuggled inside a TxApplyIf', async () => {
    const { head, sink } = await applyStack([projectSpace({ owners: ['someone-else' as AccountUuid] })])
    const wrapped = factory.createTxApplyIf(
      core.space.Space,
      undefined,
      [],
      [],
      [assignRoles(DEV_ACCOUNT)] as any,
      undefined
    )
    await expect(head.tx(session(account(DEV_ACCOUNT)), [wrapped])).rejects.toThrow(/owner/)
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a QA seat-holder from re-staffing the project', async () => {
    // Holding `ManageTestAssets` is authority over the ASSETS, not over who
    // else gets it. Otherwise the first QA could quietly hand the role out.
    const { mw } = await guard([projectSpace({ owners: ['someone-else' as AccountUuid] })])
    await expect(mw.tx(session(account(QA_ACCOUNT)), [assignRoles(DEV_ACCOUNT)])).rejects.toThrow(/owner/)
  })

  it('lets an OWNER staff the project', async () => {
    const { mw, sink } = await guard([projectSpace({ owners: [DEV_ACCOUNT] })])
    await mw.tx(session(account(DEV_ACCOUNT)), [assignRoles(DEV_ACCOUNT)])
    expect(sink.written).toHaveLength(1)
  })

  it('lets Maintainer and system through', async () => {
    const { mw } = await guard([projectSpace({ owners: ['someone-else' as AccountUuid] })])
    await mw.tx(session(account(DEV_ACCOUNT, AccountRole.Maintainer)), [assignRoles(DEV_ACCOUNT)])
    await mw.tx(session(account(DEV_ACCOUNT), { admin: true } as any), [assignRoles(DEV_ACCOUNT)])
  })

  it('does not stand in the way of creating a project', async () => {
    // `CreateProject.svelte` stamps the roles onto a space that already exists
    // and whose `owners` defaults to the creator. A mixin aimed at a space that
    // is not there yet writes nothing, so it is allowed rather than treated as
    // an attack.
    const { mw, sink } = await guard([])
    await mw.tx(session(account(DEV_ACCOUNT)), [assignRoles(DEV_ACCOUNT)])
    expect(sink.written).toHaveLength(1)
  })

  it('leaves ordinary project edits alone', async () => {
    const { mw, sink } = await guard([projectSpace({ owners: ['someone-else' as AccountUuid] })])
    const rename = factory.createTxUpdateDoc(
      testManagement.class.TestProject as any,
      core.space.Space,
      SPACE as any,
      { name: 'renamed' } as any
    )
    await mw.tx(session(account(DEV_ACCOUNT)), [rename])
    expect(sink.written).toHaveLength(1)
  })
})

describe("a space owner manages that space's test assets", () => {
  it('lets an owner who holds no role write a test case', async () => {
    // 🔴 WHY. `TriggersMiddleware` runs the cascade AFTER the space removal has
    // landed, so an owner who can delete the project but not its contents
    // leaves a deleted project with live test cases behind it.
    const { mw, sink } = await guard([projectSpace({ owners: [DEV_ACCOUNT] }), testCaseDoc()])
    await mw.tx(session(account(DEV_ACCOUNT)), [updateCase({ name: 'renamed' })])
    expect(sink.written).toHaveLength(1)
  })

  it('still refuses a non-owner with no role', async () => {
    const { mw, sink } = await guard([projectSpace({ owners: ['someone-else' as AccountUuid] }), testCaseDoc()])
    await expect(mw.tx(session(account(DEV_ACCOUNT)), [updateCase({ name: 'renamed' })])).rejects.toThrow()
    expect(sink.written).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The collaborator shape: a SYSTEM session writing on behalf of a real user
// ---------------------------------------------------------------------------

/**
 * 🔴 WHAT THIS PINS, and why it is not covered by the tests above.
 *
 * `TestCase.description` is a `MarkupBlobRef`: the prose is edited through the
 * `collaborator` service, and the blob ref on the document is rewritten by
 * `server/collaborator/src/storage/platform.ts:260` —
 * `client.diffUpdate(current, { [objectAttr]: blobId })`. That IS a
 * `TxUpdateDoc` on the `TestCase` naming the frozen `description` field, so the
 * guard sees it. (An earlier comment in `snapshotGuard.ts` claimed collaborator
 * never emits one — it does; the note has been corrected.)
 *
 * 🔴 THE IDENTITY IS THE THING. `simpleClientFactory`
 * (`server/collaborator/src/platform.ts:71-76`) opens the platform connection
 * with `generateToken(systemAccountUuid, ...)` while `getTxOperations`
 * (`:43-53`) resolves the ORIGINAL user's token to a social id for
 * `modifiedBy`. So the write arrives as `SessionData.account.uuid ===
 * systemAccountUuid` with a USER's `modifiedBy` — the one shape where the role
 * gate's system escape applies but the edit is a person's, not the platform's.
 *
 * The state gate must therefore NOT have a system escape of its own, and
 * {@link SnapshotGuardMiddleware.validateTestCaseUpdate} deliberately has none:
 * it reads neither `contextData`, nor `account`, nor `admin`. These tests pin
 * that, because adding a system escape there "for symmetry with the role gate"
 * is exactly the plausible-looking change that would reopen the hole.
 *
 * ⚠️ RESIDUAL, deliberately NOT tested here because it is not in this package:
 * `saveDocument` persists the ydoc to collaborator's own storage BEFORE it
 * attempts the platform write, and `loadDocument` prefers that ydoc over the
 * blob ref. A refused platform write therefore leaves `TestCase.description`
 * pointing at the OLD blob (the document is frozen) while the collaborative
 * editor keeps serving the NEW text. Closing that needs a change in
 * `server/collaborator`.
 */
describe('QA-T019 — collaborator writes description under a system session', () => {
  /** `modifiedBy` as collaborator actually stamps it: the USER's social id. */
  const onBehalfOfUser = new TxFactory(`social-${QA_ACCOUNT}` as PersonId, true)

  function collabUpdate (ops: Record<string, any>): TxCUD<Doc> {
    return onBehalfOfUser.createTxUpdateDoc(testManagement.class.TestCase as any, SPACE, CASE as any, ops as any)
  }

  const systemSession = (): MeasureContext => session(account(systemAccountUuid, AccountRole.User))

  it('refuses the description blob ref on an APPROVED case', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc(TestCaseStatus.Approved)])
    await expect(mw.tx(systemSession(), [collabUpdate({ description: 'blob-2' })])).rejects.toMatchObject({
      reason: 'approved-case-readonly'
    })
    expect(sink.written).toHaveLength(0)
  })

  it('names the field in the refusal, so the log says which one', async () => {
    const { mw } = await guard([projectSpace(), testCaseDoc(TestCaseStatus.Approved)])
    await expect(mw.tx(systemSession(), [collabUpdate({ description: 'blob-2' })])).rejects.toThrow(/'description'/)
  })

  it('refuses it through an operator too', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc(TestCaseStatus.Approved)])
    await expect(mw.tx(systemSession(), [collabUpdate({ $set: { description: 'blob-2' } })])).rejects.toMatchObject({
      reason: 'approved-case-readonly'
    })
    expect(sink.written).toHaveLength(0)
  })

  // ⚠️ THE ESCAPE HATCHES. A guard with no way out turns Approved into a dead
  // end, so each of these MUST stay open.

  it('lets the same write through on a DRAFT case', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc(TestCaseStatus.Draft)])
    await mw.tx(systemSession(), [collabUpdate({ description: 'blob-2' })])
    expect(sink.written).toHaveLength(1)
  })

  it('lets it through once the case has been sent back to review', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc(TestCaseStatus.FixReviewComments)])
    await mw.tx(systemSession(), [collabUpdate({ description: 'blob-2' })])
    expect(sink.written).toHaveLength(1)
  })

  it('still lets a collection counter through on an APPROVED case', async () => {
    const { mw, sink } = await guard([projectSpace(), testCaseDoc(TestCaseStatus.Approved)])
    await mw.tx(systemSession(), [collabUpdate({ $inc: { comments: 1 } })])
    expect(sink.written).toHaveLength(1)
  })

  /**
   * 🔴 COLLABORATOR MUST KEEP WORKING FOR EVERYTHING ELSE. The same service
   * writes a blob ref for every collaborative attribute in the workspace —
   * documents, chat, cards. The guard only knows `TestCase`, so a write to any
   * other class passes untouched under the very same system session.
   */
  it('leaves a non-test-management document alone', async () => {
    const { mw, sink } = await guard([projectSpace()])
    const tx = onBehalfOfUser.createTxUpdateDoc(
      'document:class:Document' as any,
      SPACE,
      'doc-1' as any,
      {
        content: 'blob-2'
      } as any
    )
    await mw.tx(systemSession(), [tx])
    expect(sink.written).toHaveLength(1)
  })
})
