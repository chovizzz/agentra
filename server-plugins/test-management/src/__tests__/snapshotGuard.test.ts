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

import attachment, { type Attachment } from '@hcengineering/attachment'
import core, {
  TxFactory,
  toFindResult,
  type Class,
  type Doc,
  type MeasureContext,
  type Ref,
  type Space,
  type Tx
} from '@hcengineering/core'
import { ApplyTxMiddleware } from '@hcengineering/middleware'
import type { Middleware, PipelineContext } from '@hcengineering/server-core'
import testManagement, { type TestCase, type TestCaseSnapshot } from '@hcengineering/test-management'

import { SnapshotGuardError, SnapshotGuardMiddleware } from '../snapshotGuard'

const SPACE = 'test-management:space:Project' as Ref<Space>
const CASE = '000000000000000000000001' as Ref<TestCase>
const SNAPSHOT = '000000000000000000000002' as Ref<TestCaseSnapshot>
const ATTACHMENT = '000000000000000000000003' as Ref<Attachment>

const SNAPSHOT_SUBCLASS = 'test-management:class:TestCaseSnapshotV2' as Ref<Class<Doc>>

/**
 * `_class` values are compared through `Hierarchy` only, so a table of edges is
 * all the guard needs. `TxApplyIf` MUST be in it: `ApplyTxMiddleware` asks the
 * very same `isDerived` when deciding whether to unwrap.
 */
const derivedFrom: Record<string, string[]> = {
  [SNAPSHOT_SUBCLASS]: [testManagement.class.TestCaseSnapshot],
  [core.class.TxApplyIf]: [core.class.Tx]
}

const known = new Set<string>([
  testManagement.class.TestCaseSnapshot,
  testManagement.class.TestCase,
  attachment.class.Attachment,
  SNAPSHOT_SUBCLASS
])

const hierarchy = {
  hasClass: (_class: string) => known.has(_class),
  isDerived: (a: string, b: string) => a === b || (derivedFrom[a] ?? []).includes(b)
} as any

/** Equality, plus the one operator the guard actually issues. */
function matchesTerm (actual: unknown, expected: any): boolean {
  if (expected !== null && typeof expected === 'object' && Array.isArray(expected.$in)) {
    return expected.$in.includes(actual)
  }
  return actual === expected
}

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
        Object.entries(query).every(([key, value]) => matchesTerm((doc as any)[key], value))
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

/** The guard behind a real ApplyTxMiddleware, i.e. the production stacking. */
async function applyStack (docs: Doc[]): Promise<{ head: Middleware, sink: Recorder }> {
  const sink = new Recorder(docs)
  const ctx = context()
  const inner = (await SnapshotGuardMiddleware.create({} as any, ctx, sink as any)) as Middleware
  const head = await ApplyTxMiddleware.create({} as any, ctx, inner)
  return { head, sink }
}

const factory = new TxFactory(core.account.System, true)

function snapshot (extra: Partial<TestCaseSnapshot> = {}): Doc {
  return {
    _id: SNAPSHOT,
    _class: testManagement.class.TestCaseSnapshot,
    space: SPACE,
    modifiedBy: core.account.System,
    modifiedOn: 0,
    attachedTo: CASE,
    attachedToClass: testManagement.class.TestCase,
    collection: 'snapshots',
    version: 3,
    name: 'Login works',
    description: null,
    steps: [],
    ...extra
  } as any
}

function testCaseDoc (): Doc {
  return {
    _id: CASE,
    _class: testManagement.class.TestCase,
    space: SPACE,
    modifiedBy: core.account.System,
    modifiedOn: 0,
    name: 'Login works'
  } as any
}

function attachmentDoc (extra: Partial<Attachment> = {}): Doc {
  return {
    _id: ATTACHMENT,
    _class: attachment.class.Attachment,
    space: SPACE,
    modifiedBy: core.account.System,
    modifiedOn: 0,
    attachedTo: CASE,
    attachedToClass: testManagement.class.TestCase,
    collection: 'attachments',
    name: 'screenshot.png',
    file: 'blob-1',
    size: 10,
    type: 'image/png',
    lastModified: 0,
    ...extra
  } as any
}

const ctx: MeasureContext = {} as any

describe('snapshot immutability', () => {
  it('refuses an update', async () => {
    const { mw, sink } = await guard([snapshot(), testCaseDoc()])
    const tx = factory.createTxUpdateDoc(
      testManagement.class.TestCaseSnapshot as any,
      SPACE,
      SNAPSHOT as any,
      {
        name: 'tampered'
      } as any
    )

    await expect(mw.tx(ctx, [tx])).rejects.toThrow(SnapshotGuardError)
    // 🔴 The write must not reach the sink. A guard that logs and forwards is
    // not a guard.
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a mixin write', async () => {
    const { mw } = await guard([snapshot(), testCaseDoc()])
    const tx = factory.createTxMixin(
      SNAPSHOT as any,
      testManagement.class.TestCaseSnapshot as any,
      SPACE,
      'some:mixin' as any,
      { name: 'tampered' } as any
    )
    await expect(mw.tx(ctx, [tx])).rejects.toThrow(/immutable/)
  })

  it('refuses a targeted delete while the owning test case still exists', async () => {
    const { mw } = await guard([snapshot(), testCaseDoc()])
    const tx = factory.createTxRemoveDoc(testManagement.class.TestCaseSnapshot as any, SPACE, SNAPSHOT as any)

    await expect(mw.tx(ctx, [tx])).rejects.toMatchObject({ reason: 'snapshot-immutable' })
  })

  it('refuses through a subclass of TestCaseSnapshot', async () => {
    const { mw } = await guard([snapshot({ _class: SNAPSHOT_SUBCLASS as any }), testCaseDoc()])
    const tx = factory.createTxUpdateDoc(SNAPSHOT_SUBCLASS as any, SPACE, SNAPSHOT as any, { name: 'x' } as any)
    await expect(mw.tx(ctx, [tx])).rejects.toThrow(SnapshotGuardError)
  })

  it('refuses an update smuggled inside a TxApplyIf', async () => {
    // The stack already flattens this, but "no TxApplyIf reaches us" is a
    // property of the pipeline LIST, not of this class.
    const { mw, sink } = await guard([snapshot(), testCaseDoc()])
    const inner = factory.createTxUpdateDoc(
      testManagement.class.TestCaseSnapshot as any,
      SPACE,
      SNAPSHOT as any,
      {
        name: 'tampered'
      } as any
    )
    const wrapper = factory.createTxApplyIf(core.space.Tx, 'scope', [], [], [inner], undefined, true, [])

    await expect(mw.tx(ctx, [wrapper])).rejects.toThrow(SnapshotGuardError)
    expect(sink.written).toHaveLength(0)
  })

  it('refuses an update behind a real ApplyTxMiddleware', async () => {
    const { head, sink } = await applyStack([snapshot(), testCaseDoc()])
    const inner = factory.createTxUpdateDoc(
      testManagement.class.TestCaseSnapshot as any,
      SPACE,
      SNAPSHOT as any,
      {
        name: 'tampered'
      } as any
    )
    const wrapper = factory.createTxApplyIf(core.space.Tx, 'scope', [], [], [inner], undefined, true, [])

    await expect(head.tx(ctx, [wrapper])).rejects.toThrow(SnapshotGuardError)
    expect(sink.written).toHaveLength(0)
  })

  it('allows the create that brings a snapshot into existence', async () => {
    const { mw, sink } = await guard([testCaseDoc()])
    const tx = factory.createTxCreateDoc(testManagement.class.TestCaseSnapshot as any, SPACE, {
      attachedTo: CASE,
      version: 1
    } as any)

    await mw.tx(ctx, [tx])
    expect(sink.written).toHaveLength(1)
  })

  it('refuses a SECOND snapshot for the same (case, version)', async () => {
    // Immutability with no uniqueness is only half a guarantee: readers resolve
    // the pair with `limit: 1`, so a rival document silently decides history.
    const { mw, sink } = await guard([snapshot({ version: 3 }), testCaseDoc()])
    const tx = factory.createTxCreateDoc(testManagement.class.TestCaseSnapshot as any, SPACE, {
      attachedTo: CASE,
      version: 3
    } as any)

    await expect(mw.tx(ctx, [tx])).rejects.toMatchObject({ reason: 'snapshot-duplicate' })
    expect(sink.written).toHaveLength(0)
  })

  it('allows a snapshot of a different version of the same case', async () => {
    const { mw, sink } = await guard([snapshot({ version: 3 }), testCaseDoc()])
    const tx = factory.createTxCreateDoc(testManagement.class.TestCaseSnapshot as any, SPACE, {
      attachedTo: CASE,
      version: 4
    } as any)

    await mw.tx(ctx, [tx])
    expect(sink.written).toHaveLength(1)
  })

  it('allows a delete batched with the removal of its own test case', async () => {
    // Cascade deletion must keep working: a client removing a test case emits
    // the child removals alongside it.
    const { mw, sink } = await guard([snapshot(), testCaseDoc()])
    const removeSnapshot = factory.createTxRemoveDoc(
      testManagement.class.TestCaseSnapshot as any,
      SPACE,
      SNAPSHOT as any
    )
    const removeCase = factory.createTxRemoveDoc(testManagement.class.TestCase as any, SPACE, CASE as any)

    // Deliberately snapshot-first: batch order is not guaranteed.
    await mw.tx(ctx, [removeSnapshot, removeCase])
    expect(sink.written).toHaveLength(2)
  })

  it('allows the derived cascade that arrives after the case is already gone', async () => {
    // 🔴 MarkDerivedEntryMiddleware points `context.derived` BELOW itself, so
    // trigger-emitted collection removals re-enter this middleware. Without
    // this allowance a test case with snapshots could never be deleted.
    const { mw, sink } = await guard([snapshot()])
    const tx = factory.createTxRemoveDoc(testManagement.class.TestCaseSnapshot as any, SPACE, SNAPSHOT as any)

    await mw.tx(ctx, [tx])
    expect(sink.written).toHaveLength(1)
  })

  it('lets an unrelated document through untouched', async () => {
    const { mw, sink } = await guard([testCaseDoc()])
    const tx = factory.createTxUpdateDoc(
      testManagement.class.TestCase as any,
      SPACE,
      CASE as any,
      {
        name: 'renamed'
      } as any
    )

    await mw.tx(ctx, [tx])
    expect(sink.written).toHaveLength(1)
  })
})

describe('attachment reference protection', () => {
  it('refuses to delete an attachment a snapshot still points at', async () => {
    const { mw, sink } = await guard([
      snapshot({ attachmentsMeta: [{ name: 'screenshot.png', file: 'blob-1' as any, type: 'image/png', size: 10 }] }),
      testCaseDoc(),
      attachmentDoc()
    ])
    const tx = factory.createTxRemoveDoc(attachment.class.Attachment as any, SPACE, ATTACHMENT as any)

    await expect(mw.tx(ctx, [tx])).rejects.toMatchObject({ reason: 'attachment-referenced' })
    expect(sink.written).toHaveLength(0)
  })

  it('allows deleting an attachment no snapshot cites', async () => {
    const { mw, sink } = await guard([
      snapshot({ attachmentsMeta: [{ name: 'other.png', file: 'blob-9' as any, type: 'image/png', size: 1 }] }),
      testCaseDoc(),
      attachmentDoc()
    ])
    const tx = factory.createTxRemoveDoc(attachment.class.Attachment as any, SPACE, ATTACHMENT as any)

    await mw.tx(ctx, [tx])
    expect(sink.written).toHaveLength(1)
  })

  it('allows deleting a referenced attachment when the whole test case goes', async () => {
    const { mw, sink } = await guard([
      snapshot({ attachmentsMeta: [{ name: 'screenshot.png', file: 'blob-1' as any, type: 'image/png', size: 10 }] }),
      testCaseDoc(),
      attachmentDoc()
    ])
    const removeAttachment = factory.createTxRemoveDoc(attachment.class.Attachment as any, SPACE, ATTACHMENT as any)
    const removeCase = factory.createTxRemoveDoc(testManagement.class.TestCase as any, SPACE, CASE as any)

    await mw.tx(ctx, [removeAttachment, removeCase])
    expect(sink.written).toHaveLength(2)
  })

  it('refuses when a snapshot of a DIFFERENT test case in the space cites the blob', async () => {
    // Snapshots store a blob id, and nothing forces one attachment per blob.
    // A check narrowed to the attachment's own test case would miss this and
    // let `OnAttachmentDelete` destroy bytes another case's snapshot needs.
    const OTHER_CASE = '000000000000000000000009' as Ref<TestCase>
    const otherCase: Doc = { ...testCaseDoc(), _id: OTHER_CASE } as any
    const otherSnapshot = snapshot({
      _id: '00000000000000000000000a' as Ref<TestCaseSnapshot>,
      attachedTo: OTHER_CASE,
      attachmentsMeta: [{ name: 'shared.png', file: 'blob-1' as any, type: 'image/png', size: 10 }]
    })
    const { mw, sink } = await guard([otherSnapshot, otherCase, testCaseDoc(), attachmentDoc()])
    const tx = factory.createTxRemoveDoc(attachment.class.Attachment as any, SPACE, ATTACHMENT as any)

    await expect(mw.tx(ctx, [tx])).rejects.toMatchObject({ reason: 'attachment-referenced' })
    expect(sink.written).toHaveLength(0)
  })

  it('allows the delete when the only citing snapshot is an orphan', async () => {
    // The derived cascade removes the test case first and then walks its
    // children in no guaranteed order. If a still-present snapshot of an
    // already-deleted case could block the attachment removal, deleting a test
    // case would deadlock on its own evidence.
    const orphan = snapshot({
      attachedTo: 'gone' as Ref<TestCase>,
      attachmentsMeta: [{ name: 'screenshot.png', file: 'blob-1' as any, type: 'image/png', size: 10 }]
    })
    const { mw, sink } = await guard([orphan, testCaseDoc(), attachmentDoc()])
    const tx = factory.createTxRemoveDoc(attachment.class.Attachment as any, SPACE, ATTACHMENT as any)

    await mw.tx(ctx, [tx])
    expect(sink.written).toHaveLength(1)
  })

  it('ignores attachments that hang off something other than a test case', async () => {
    const { mw, sink } = await guard([
      attachmentDoc({ attachedToClass: 'some:other:Class' as any, attachedTo: 'elsewhere' as any })
    ])
    const tx = factory.createTxRemoveDoc(attachment.class.Attachment as any, SPACE, ATTACHMENT as any)

    await mw.tx(ctx, [tx])
    expect(sink.written).toHaveLength(1)
  })
})
