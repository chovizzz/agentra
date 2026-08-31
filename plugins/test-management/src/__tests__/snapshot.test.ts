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
import { SortingOrder, generateId, toFindResult, type Doc, type Ref, type TxOperations } from '@hcengineering/core'

import testManagement from '../plugin'
import {
  INITIAL_TEST_CASE_VERSION,
  TestCasePriority,
  TestCaseStatus,
  TestCaseType,
  type Build,
  type TestCase,
  type TestCaseSnapshot,
  type TestProject,
  type TestStep
} from '../types'
import {
  addTestStep,
  buildExternalKey,
  currentTestCaseVersion,
  ensureBuild,
  ensureTestCaseSnapshot,
  getLastStepRank,
  nextTestCaseVersion,
  registerTestCaseEdit
} from '../utils'

const SPACE = 'test-management:space:Project' as Ref<TestProject>
const CASE = 'test-management:case:1' as Ref<TestCase>

function testCase (extra: Partial<TestCase> = {}): TestCase {
  return {
    _id: CASE,
    _class: testManagement.class.TestCase,
    space: SPACE,
    attachedTo: 'suite' as any,
    attachedToClass: testManagement.class.TestSuite as any,
    collection: 'testCases',
    modifiedBy: 'system' as any,
    modifiedOn: 0,
    name: 'Login works',
    description: null,
    type: TestCaseType.Functional,
    priority: TestCasePriority.Medium,
    status: TestCaseStatus.Draft,
    assignee: 'nobody' as any,
    ...extra
  } as any
}

/**
 * A `TxOperations` stand-in.
 *
 * The one behaviour it must model faithfully is `apply().notMatch(...).commit()`:
 * the whole deduplication design rests on that precondition being evaluated
 * SERVER side against the table as it is at commit time, so the fake re-checks
 * `docs` at `commit()` rather than at `notMatch()`.
 */
class FakeOps {
  readonly created: Doc[] = []
  readonly updated: Array<{ doc: Doc, ops: Record<string, any> }> = []
  /** Runs just before a commit evaluates its preconditions — the race window. */
  onCommit: (() => void) | undefined

  constructor (readonly docs: Doc[] = []) {}

  async findAll (_class: Ref<any>, query: Record<string, any>, options?: any): Promise<any> {
    let matches = this.docs.filter(
      (doc) => doc._class === _class && Object.entries(query).every(([key, value]) => (doc as any)[key] === value)
    )
    if (options?.sort?.rank !== undefined) {
      matches = matches
        .slice()
        .sort((a, b) =>
          options.sort.rank === SortingOrder.Descending
            ? String((b as any).rank).localeCompare(String((a as any).rank))
            : String((a as any).rank).localeCompare(String((b as any).rank))
        )
    }
    if (options?.limit !== undefined && options.limit > 0) {
      matches = matches.slice(0, options.limit)
    }
    return toFindResult(matches as any)
  }

  async update (doc: Doc, ops: Record<string, any>): Promise<void> {
    this.updated.push({ doc, ops })
    Object.assign(doc, ops)
  }

  async addCollection (
    _class: Ref<any>,
    space: Ref<any>,
    attachedTo: Ref<any>,
    attachedToClass: Ref<any>,
    collection: string,
    attributes: Record<string, any>,
    id?: Ref<any>
  ): Promise<Ref<any>> {
    const _id = id ?? generateId()
    this.staged.push({ _id, _class, space, attachedTo, attachedToClass, collection, ...attributes } as any)
    return _id
  }

  async createDoc (
    _class: Ref<any>,
    space: Ref<any>,
    attributes: Record<string, any>,
    id?: Ref<any>
  ): Promise<Ref<any>> {
    const _id = id ?? generateId()
    this.staged.push({ _id, _class, space, ...attributes } as any)
    return _id
  }

  private staged: Doc[] = []
  private notMatches: Array<{ _class: Ref<any>, query: Record<string, any> }> = []

  apply (): FakeOps {
    this.staged = []
    this.notMatches = []
    return this
  }

  notMatch (_class: Ref<any>, query: Record<string, any>): FakeOps {
    this.notMatches.push({ _class, query })
    return this
  }

  async commit (): Promise<{ result: boolean }> {
    this.onCommit?.()
    const blocked = this.notMatches.some(({ _class, query }) =>
      this.docs.some(
        (doc) => doc._class === _class && Object.entries(query).every(([key, value]) => (doc as any)[key] === value)
      )
    )
    if (blocked) {
      this.staged = []
      return { result: false }
    }
    this.docs.push(...this.staged)
    this.created.push(...this.staged)
    this.staged = []
    return { result: true }
  }

  get ops (): TxOperations {
    return this as unknown as TxOperations
  }
}

describe('test case versioning', () => {
  it('treats a missing version as the initial one, so pre-migration cases still deduplicate', () => {
    expect(currentTestCaseVersion(testCase())).toBe(INITIAL_TEST_CASE_VERSION)
    expect(nextTestCaseVersion(testCase())).toBe(INITIAL_TEST_CASE_VERSION + 1)
    expect(nextTestCaseVersion(testCase({ version: 7 }))).toBe(8)
  })

  it('sends an approved case back to review when its structure is edited', async () => {
    const client = new FakeOps()
    const approved = testCase({ status: TestCaseStatus.Approved, version: 3 })
    await registerTestCaseEdit(client.ops, approved)

    expect(client.updated).toHaveLength(1)
    expect(client.updated[0].ops).toEqual({ version: 4, status: TestCaseStatus.FixReviewComments })
  })

  it('leaves a draft case in draft', async () => {
    const client = new FakeOps()
    await registerTestCaseEdit(client.ops, testCase({ version: 1 }))
    expect(client.updated[0].ops).toEqual({ version: 2 })
  })
})

describe('test steps', () => {
  function step (_id: string, rank: string): TestStep {
    return {
      _id: _id as Ref<TestStep>,
      _class: testManagement.class.TestStep,
      space: SPACE,
      attachedTo: CASE,
      attachedToClass: testManagement.class.TestCase,
      collection: 'steps',
      modifiedBy: 'system' as any,
      modifiedOn: 0,
      rank: rank as any,
      action: `do ${_id}`,
      expectedResult: `see ${_id}`
    } as any
  }

  it('finds the last rank of THIS case only', async () => {
    // The whole reason ranks are computed client side: a sibling case's steps
    // live in the same space, and `RANK_AUTO` would pick one of them.
    const other = { ...step('other', 'zzzz'), attachedTo: 'test-management:case:2' as Ref<TestCase> }
    const client = new FakeOps([step('a', 'aaaa'), step('b', 'bbbb'), other as any])
    expect(await getLastStepRank(client, CASE)).toBe('bbbb')
  })

  it('returns undefined for a case with no steps', async () => {
    const client = new FakeOps()
    expect(await getLastStepRank(client, CASE)).toBeUndefined()
  })

  it('appends new steps in creation order', async () => {
    const client = new FakeOps()
    const doc = testCase()
    await addTestStep(client.ops, doc, { action: 'first', expectedResult: 'ok' })
    await client.commit()
    await addTestStep(client.ops, doc, { action: 'second', expectedResult: 'ok' })
    await client.commit()

    const ranks = (client.docs as TestStep[]).map((s) => s.rank)
    expect(ranks).toHaveLength(2)
    expect(String(ranks[0]) < String(ranks[1])).toBe(true)
  })
})

describe('ensureTestCaseSnapshot', () => {
  function snapshot (version: number): TestCaseSnapshot {
    return {
      _id: `snap-${version}` as Ref<TestCaseSnapshot>,
      _class: testManagement.class.TestCaseSnapshot,
      space: SPACE,
      attachedTo: CASE,
      attachedToClass: testManagement.class.TestCase,
      collection: 'snapshots',
      modifiedBy: 'system' as any,
      modifiedOn: 0,
      version,
      name: 'Login works',
      description: null,
      type: TestCaseType.Functional,
      priority: TestCasePriority.Medium,
      steps: []
    } as any
  }

  it('creates one lazily on the first pin', async () => {
    const client = new FakeOps()
    const doc = testCase({ version: 2 })
    const id = await ensureTestCaseSnapshot(client.ops, doc)

    expect(client.created).toHaveLength(1)
    const created = client.created[0] as TestCaseSnapshot
    expect(created._id).toBe(id)
    expect(created.version).toBe(2)
    expect(created.attachedTo).toBe(CASE)
  })

  it('reuses the existing snapshot for the same (case, version)', async () => {
    const client = new FakeOps([snapshot(2)])
    const id = await ensureTestCaseSnapshot(client.ops, testCase({ version: 2 }))

    expect(id).toBe('snap-2')
    expect(client.created).toHaveLength(0)
  })

  it('creates a second snapshot only when the version moves', async () => {
    const client = new FakeOps([snapshot(2)])
    const id = await ensureTestCaseSnapshot(client.ops, testCase({ version: 3 }))

    expect(id).not.toBe('snap-2')
    expect(client.created).toHaveLength(1)
    expect(client.docs.filter((d) => d._class === testManagement.class.TestCaseSnapshot)).toHaveLength(2)
  })

  it('yields to the winner when two clients race the same pair', async () => {
    const client = new FakeOps()
    const doc = testCase({ version: 5 })
    // A competing client lands its snapshot after we looked and before we
    // committed. The `notMatch` precondition is what turns this into one
    // document instead of two.
    client.onCommit = () => {
      client.onCommit = undefined
      client.docs.push({ ...snapshot(5), _id: 'winner' as Ref<TestCaseSnapshot> })
    }

    const id = await ensureTestCaseSnapshot(client.ops, doc)

    expect(id).toBe('winner')
    expect(client.created).toHaveLength(0)
    expect(client.docs.filter((d) => d._class === testManagement.class.TestCaseSnapshot)).toHaveLength(1)
  })

  it('freezes the steps inline and shares — never copies — attachment blobs', async () => {
    const stepDoc = {
      _id: 'step-1' as Ref<TestStep>,
      _class: testManagement.class.TestStep,
      space: SPACE,
      attachedTo: CASE,
      attachedToClass: testManagement.class.TestCase,
      collection: 'steps',
      modifiedBy: 'system' as any,
      modifiedOn: 0,
      rank: 'aaaa' as any,
      action: '<p>click</p>',
      testData: '<p>user=a</p>',
      expectedResult: '<p>logged in</p>'
    } as any
    const file = {
      _id: 'att-1' as Ref<Attachment>,
      _class: attachment.class.Attachment,
      space: SPACE,
      attachedTo: CASE,
      attachedToClass: testManagement.class.TestCase,
      collection: 'attachments',
      modifiedBy: 'system' as any,
      modifiedOn: 0,
      name: 'screenshot.png',
      file: 'blob-1' as any,
      size: 10,
      type: 'image/png',
      lastModified: 42
    } as any

    const client = new FakeOps([stepDoc, file])
    await ensureTestCaseSnapshot(client.ops, testCase({ version: 1 }))

    const created = client.created[0] as TestCaseSnapshot
    expect(created.steps).toEqual([
      { action: '<p>click</p>', testData: '<p>user=a</p>', expectedResult: '<p>logged in</p>' }
    ])
    expect(created.attachmentsMeta).toEqual([
      { name: 'screenshot.png', file: 'blob-1', type: 'image/png', size: 10, lastModified: 42 }
    ])
  })
})

describe('Build identity', () => {
  it('keys on provider + pipeline, never on the commit', () => {
    expect(buildExternalKey('github', '1234')).toBe('github:1234')
    // Two CI runs of the SAME commit must be two builds.
    expect(buildExternalKey('github', '1234')).not.toBe(buildExternalKey('github', '1235'))
  })

  it('is idempotent on (space, externalKey)', async () => {
    const client = new FakeOps()
    const key = buildExternalKey('github', '99')

    const first = await ensureBuild(client.ops, SPACE, key, { name: 'nightly' } as any)
    const second = await ensureBuild(client.ops, SPACE, key, { name: 'nightly (retry)' } as any)

    expect(second).toBe(first)
    expect(client.docs.filter((d) => d._class === testManagement.class.Build)).toHaveLength(1)
  })

  it('scopes uniqueness to the project space', async () => {
    const client = new FakeOps()
    const key = buildExternalKey('github', '99')
    const a = await ensureBuild(client.ops, SPACE, key, { name: 'a' } as any)
    const b = await ensureBuild(client.ops, 'other' as Ref<TestProject>, key, { name: 'b' } as any)

    expect(a).not.toBe(b)
    expect(client.docs.filter((d) => d._class === testManagement.class.Build)).toHaveLength(2)
  })

  it('yields to the winner of a concurrent create', async () => {
    const client = new FakeOps()
    const key = buildExternalKey('github', '7')
    client.onCommit = () => {
      client.onCommit = undefined
      client.docs.push({
        _id: 'winner' as Ref<Build>,
        _class: testManagement.class.Build,
        space: SPACE,
        externalKey: key
      } as any)
    }

    expect(await ensureBuild(client.ops, SPACE, key, { name: 'x' } as any)).toBe('winner')
    expect(client.docs.filter((d) => d._class === testManagement.class.Build)).toHaveLength(1)
  })
})
