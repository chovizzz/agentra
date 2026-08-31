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

import activity, { type DocUpdateMessage } from '@hcengineering/activity'
import { type MarkupBlobRef, type Ref } from '@hcengineering/core'
import products from '@hcengineering/products'
import requirements, { type Requirement } from '@hcengineering/requirements'
import task, { type TaskType } from '@hcengineering/task'
import testManagement, {
  TestRunStatus,
  type Build,
  type TestCase,
  type TestCaseSnapshot,
  type TestEnvironment,
  type TestResult,
  type TestRun
} from '@hcengineering/test-management'
import traceability, { traceLinkId, type TraceLink } from '@hcengineering/traceability'
import tracker, { type Issue, type Project } from '@hcengineering/tracker'

import { CREATE_DEFECT_TARGET, CreateDefectError, createDefect, createDefectRoles } from '../commands/createDefect'
import { commandObjectId } from '@hcengineering/server-agentra-core'
import { makeHarness, seed, type Harness } from './harness'

const PROJECT = 'aaaaaaaaaaaaaaaaaaaaaap1' as Ref<Project>
const TASK_TYPE = 'aaaaaaaaaaaaaaaaaaaaaat1' as Ref<TaskType>
const RUN = 'aaaaaaaaaaaaaaaaaaaaaau1' as Ref<TestRun>
const RESULT = 'aaaaaaaaaaaaaaaaaaaaaae1' as Ref<TestResult>
const CASE = 'aaaaaaaaaaaaaaaaaaaaaac1' as Ref<TestCase>
const SNAPSHOT = 'aaaaaaaaaaaaaaaaaaaaaas1' as Ref<TestCaseSnapshot>
const BUILD = 'aaaaaaaaaaaaaaaaaaaaaab1' as Ref<Build>
const ENVIRONMENT = 'aaaaaaaaaaaaaaaaaaaaaan1' as Ref<TestEnvironment>
const REQ = 'aaaaaaaaaaaaaaaaaaaaaar1' as Ref<Requirement>
const PRODUCT_VERSION = 'aaaaaaaaaaaaaaaaaaaaaav1' as Ref<any>

const SPACE = 'test-project' as Ref<any>

interface DefectHarness extends Harness {
  bodies: Map<string, string>
  writeBody: (blob: MarkupBlobRef, markup: string) => Promise<void>
}

async function harness (): Promise<DefectHarness> {
  const h = await makeHarness()
  const bodies = new Map<string, string>()

  seed<Project>(h.db, {
    _id: PROJECT,
    _class: tracker.class.Project,
    identifier: 'BUG',
    sequence: 41,
    type: 'project-type' as Ref<any>
  } as any)
  seed<TaskType>(h.db, {
    _id: TASK_TYPE,
    _class: task.class.TaskType,
    parent: 'project-type' as Ref<any>,
    ofClass: tracker.class.Issue,
    statuses: ['status-backlog' as Ref<any>]
  } as any)

  seed<TestCase>(h.db, {
    _id: CASE,
    _class: testManagement.class.TestCase,
    space: SPACE,
    name: 'SSO login works',
    version: 3
  } as any)
  seed<TestCaseSnapshot>(h.db, {
    _id: SNAPSHOT,
    _class: testManagement.class.TestCaseSnapshot,
    space: SPACE,
    attachedTo: CASE,
    version: 2,
    name: 'SSO login works',
    steps: [{ action: 'Open /login', testData: 'user@acme', expectedResult: 'The IdP page appears' }]
  } as any)
  seed(h.db, {
    _id: PRODUCT_VERSION,
    _class: products.class.ProductVersion,
    major: 2,
    minor: 4,
    patch: 1,
    codename: 'lynx'
  } as any)
  seed<Build>(h.db, { _id: BUILD, _class: testManagement.class.Build, space: SPACE, name: 'ci:4711' } as any)
  seed<TestEnvironment>(h.db, {
    _id: ENVIRONMENT,
    _class: testManagement.class.TestEnvironment,
    space: SPACE,
    name: 'staging-eu'
  } as any)
  seed<TestRun>(h.db, {
    _id: RUN,
    _class: testManagement.class.TestRun,
    space: SPACE,
    name: 'Regression 2026-08',
    build: BUILD,
    environment: ENVIRONMENT,
    productVersion: PRODUCT_VERSION,
    startedOn: 1756000000000,
    finishedOn: 1756003600000
  } as any)
  seed<TestResult>(h.db, {
    _id: RESULT,
    _class: testManagement.class.TestResult,
    space: SPACE,
    attachedTo: RUN,
    name: 'SSO login works',
    testCase: CASE,
    snapshot: SNAPSHOT,
    status: TestRunStatus.Failed
  } as any)
  seed<Requirement>(h.db, {
    _id: REQ,
    _class: requirements.masterTag.Requirement as Ref<any>,
    space: requirements.space.Requirements as Ref<any>,
    title: 'Single sign-on',
    status: 'Approved'
  } as any)

  return {
    ...h,
    bodies,
    writeBody: async (blob, markup) => {
      bodies.set(blob, markup)
    }
  }
}

function bugIdFor (target: Ref<any>): Ref<Issue> {
  return commandObjectId<Issue>(CREATE_DEFECT_TARGET, target, createDefectRoles.issue)
}

describe('createDefect', () => {
  it('raises a bug from a failed result, with the run context and a defect-of edge', async () => {
    const h = await harness()
    const outcome = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      {
        target: RESULT,
        targetClass: testManagement.class.TestResult,
        project: PROJECT,
        actual: 'A 500 page appeared',
        idempotencyKey: 'defect-key-1'
      }
    )

    expect(outcome.result.alreadyReported).toBe(false)
    const bugId = bugIdFor(RESULT)
    expect(outcome.result.bug).toBe(bugId)

    const issue = h.db.docs.get(bugId) as Issue
    expect(issue).toBeDefined()
    expect(issue.space).toBe(PROJECT)
    // The sequence bump is what supplies the number and the identifier.
    expect(issue.number).toBe(42)
    expect(issue.identifier).toBe('BUG-42')
    expect((h.db.docs.get(PROJECT) as Project).sequence).toBe(42)

    const body = h.bodies.get(issue.description as string) as string
    expect(body).toBeDefined()
    // 🔴 The evidence the whole feature exists for.
    expect(body).toContain('Open /login')
    expect(body).toContain('The IdP page appears')
    expect(body).toContain('A 500 page appeared')
    expect(body).toContain('ci:4711')
    expect(body).toContain('staging-eu')
    expect(body).toContain('Regression 2026-08')
    // The version STRING, not the ref: ProductVersion has no `name`.
    expect(body).toContain('2.4.1 (lynx)')
    // 🔴 The SNAPSHOT, not the live case: v2 is what the run was judged against
    // even though the case is now at v3.
    expect(body).toContain('v2 (snapshot)')
    expect(body).not.toContain('v3')

    const linkId = traceLinkId('defect-of', bugId, RESULT)
    const link = h.db.docs.get(linkId) as TraceLink
    expect(link.docA).toBe(bugId)
    expect(link.docB).toBe(RESULT)
    expect(link.kind).toBe('defect-of')

    const messages = h.db.find(activity.class.DocUpdateMessage, {}) as DocUpdateMessage[]
    expect(messages.map((m) => m.attachedTo).sort()).toEqual([bugId, RESULT].sort())
  })

  it('opens the EXISTING bug instead of raising a second one', async () => {
    const h = await harness()
    const first = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'k1' }
    )
    const second = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'k2' }
    )

    expect(second.result.bug).toBe(first.result.bug)
    expect(second.result.alreadyReported).toBe(true)
    expect(h.db.find(tracker.class.Issue, {}).length).toBe(1)
    expect(h.db.find(traceability.class.TraceLink, {}).length).toBe(1)
    // 🔴 The sequence must NOT advance again — that is the observable proof the
    // second call did not build an issue and throw it away.
    expect((h.db.docs.get(PROJECT) as Project).sequence).toBe(42)
  })

  it('is idempotent under the same key', async () => {
    const h = await harness()
    const first = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'same' }
    )
    const second = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'same' }
    )
    expect(second.replayed).toBe(true)
    expect(second.result.bug).toBe(first.result.bug)
    expect(h.db.find(tracker.class.Issue, {}).length).toBe(1)
  })

  it('raises a defect against a TEST CASE', async () => {
    const h = await harness()
    const outcome = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      { target: CASE, targetClass: testManagement.class.TestCase, project: PROJECT, idempotencyKey: 'case-key' }
    )
    const bug = outcome.result.bug as Ref<Issue>
    const link = h.db.docs.get(traceLinkId('defect-of', bug, CASE)) as TraceLink
    expect(link.kind).toBe('defect-of')
    expect(link.targetClass).toBe(testManagement.class.TestCase)
    const issue = h.db.docs.get(bug) as Issue
    expect(issue.title).toBe('[TestCase] SSO login works')
    const body = h.bodies.get(issue.description as string) as string
    expect(body).toContain('Open /login')
  })

  it('raises a defect against a REQUIREMENT', async () => {
    const h = await harness()
    const outcome = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      {
        target: REQ,
        targetClass: requirements.masterTag.Requirement as Ref<any>,
        project: PROJECT,
        idempotencyKey: 'req-key'
      }
    )
    const bug = outcome.result.bug as Ref<Issue>
    const link = h.db.docs.get(traceLinkId('defect-of', bug, REQ)) as TraceLink
    expect(link.kind).toBe('defect-of')
    expect(link.targetClass).toBe(requirements.masterTag.Requirement)
    const body = h.bodies.get((h.db.docs.get(bug) as Issue).description as string) as string
    expect(body).toContain('Single sign-on')
  })

  it('reads the incremented sequence in the MONGO shape too', async () => {
    // 🔴 The two adapters disagree: Postgres returns `{ object: doc }`, Mongo
    // returns the document itself. Reading only the Postgres shape means every
    // Mongo deployment silently falls into the fallback.
    const h = await harness()
    const original = h.fake.tx.bind(h.fake)
    ;(h.fake as any).tx = async (tx: any) => {
      const result: any = await original(tx)
      // Unwrap `{ object: doc }` into the bare document, as Mongo does.
      return result?.object !== undefined ? result.object : result
    }
    const outcome = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'mongo' }
    )
    const issue = h.db.docs.get(outcome.result.bug as Ref<Issue>) as Issue
    expect(issue.number).toBe(42)
    expect(issue.identifier).toBe('BUG-42')
  })

  it('REFUSES rather than guessing a number when no sequence comes back', async () => {
    // The fallback this replaces — `project.sequence + 1` off the pre-bump read
    // — gives two concurrent defects the same identifier, and nothing collides
    // to stop them because the Issue `_id`s are derived from different targets.
    const h = await harness()
    const original = h.fake.tx.bind(h.fake)
    ;(h.fake as any).tx = async (tx: any) => {
      await original(tx)
      return {}
    }
    await expect(
      createDefect(
        { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
        { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'no-seq' }
      )
    ).rejects.toMatchObject({ reason: 'sequence-unavailable' })
    expect(h.db.find(tracker.class.Issue, {}).length).toBe(0)
  })

  it('does NOT hand back the ref of a defect the caller may not read', async () => {
    // 🔴 The `defect-of` edge read is NOT permission filtered: TraceLink lives
    // in `core.space.Workspace`, so every member can read every edge. Only a
    // re-read of the Issue through the caller's client can decide what may be
    // disclosed.
    const h = await harness()
    // A defect raised elsewhere: its `_id` is NOT this command's derived id, so
    // it reads as `foreign`.
    const otherBug = 'aaaaaaaaaaaaaaaaaaaaaaz1' as Ref<Issue>
    seed<Issue>(h.db, { _id: otherBug, _class: tracker.class.Issue, space: PROJECT, title: 'hidden bug' } as any)
    seed<TraceLink>(h.db, {
      _id: traceLinkId('defect-of', otherBug, RESULT),
      _class: traceability.class.TraceLink,
      docA: otherBug,
      sourceClass: tracker.class.Issue,
      docB: RESULT,
      targetClass: testManagement.class.TestResult,
      kind: 'defect-of',
      sourceBaseId: otherBug,
      targetBaseId: RESULT,
      state: 'active'
    } as any)
    h.db.hidden.add(otherBug)

    const outcome = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'restricted' }
    )
    expect(outcome.result.alreadyReported).toBe(true)
    expect(outcome.result.restricted).toBe(true)
    // No id to follow, and no second defect built either.
    expect(outcome.result.bug).toBeUndefined()
    expect(outcome.result.traceLink).toBeUndefined()
    expect(h.db.docs.get(bugIdFor(RESULT))).toBeUndefined()
  })

  it('DOES hand back the ref when the existing defect is readable', async () => {
    const h = await harness()
    const otherBug = 'aaaaaaaaaaaaaaaaaaaaaaz1' as Ref<Issue>
    seed<Issue>(h.db, { _id: otherBug, _class: tracker.class.Issue, space: PROJECT, title: 'visible bug' } as any)
    seed<TraceLink>(h.db, {
      _id: traceLinkId('defect-of', otherBug, RESULT),
      _class: traceability.class.TraceLink,
      docA: otherBug,
      sourceClass: tracker.class.Issue,
      docB: RESULT,
      targetClass: testManagement.class.TestResult,
      kind: 'defect-of',
      sourceBaseId: otherBug,
      targetBaseId: RESULT,
      state: 'active'
    } as any)

    const outcome = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'visible' }
    )
    expect(outcome.result.bug).toBe(otherBug)
    expect(outcome.result.restricted).toBe(false)
    expect(h.db.docs.get(bugIdFor(RESULT))).toBeUndefined()
  })

  it('does NOT leak the bug ref through a LEDGER REPLAY to an unauthorised caller', async () => {
    // 🔴 THE REPLAY BYPASSES THE BODY. `CommandMiddleware.resume` returns a
    // `succeeded` row's stored result without re-running anything, and both
    // claims are keyed on the target — so once an authorised user files the
    // defect, an unauthorised one calling on the same target would otherwise be
    // handed that user's stored `bug` Ref.
    const h = await harness()
    const first = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'author' }
    )
    const bugId = first.result.bug as Ref<Issue>
    expect(bugId).toBeDefined()

    // The second caller may not read the Issue.
    h.db.hidden.add(bugId)

    // Same outer key (outer ledger replay) …
    const sameKey = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'author' }
    )
    expect(sameKey.replayed).toBe(true)
    expect(sameKey.result.bug).toBeUndefined()
    expect(sameKey.result.traceLink).toBeUndefined()
    expect(sameKey.result.restricted).toBe(true)

    // … and a DIFFERENT outer key, which still replays the inner target claim.
    const otherKey = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'attacker' }
    )
    expect(otherKey.result.bug).toBeUndefined()
    expect(otherKey.result.restricted).toBe(true)

    // No second issue was built on either path.
    expect(h.db.docs.size).toBe(new Set([...h.db.docs.keys()]).size)
    expect([...h.db.docs.values()].filter((d) => d._class === tracker.class.Issue)).toHaveLength(1)
  })

  it('still hands the ref back to a caller who CAN read the bug', async () => {
    const h = await harness()
    const first = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'author' }
    )
    const again = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'author' }
    )
    expect(again.result.bug).toBe(first.result.bug)
    expect(again.result.restricted).toBe(false)
  })

  it('refuses to file a defect when the project has no issue status', async () => {
    // 🔴 An Issue written with `status: undefined` renders as a blank column in
    // every board and is invisible to every status filter.
    const h = await harness()
    const taskType = h.db.docs.get(TASK_TYPE) as TaskType
    ;(taskType as any).statuses = []
    await expect(
      createDefect(
        { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
        { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'no-status' }
      )
    ).rejects.toMatchObject({ reason: 'task-type-not-found' })
    expect(h.db.find(tracker.class.Issue, {}).length).toBe(0)
  })

  it('leaves NO orphan body blob behind when the defect is refused', async () => {
    // 🔴 The blob key is derived from `issueId` and nothing else ever reclaims
    // it. A refusal raised after the bytes had landed would strand them in the
    // object store forever: no Issue is created to point at them, and no replay
    // of this command reaches the write again once the refusal is permanent.
    // The write is therefore ordered AFTER every refusal, which removes the
    // orphan outright rather than adding a cleanup that could itself fail.
    const noStatus = await harness()
    const taskType = noStatus.db.docs.get(TASK_TYPE) as TaskType
    ;(taskType as any).statuses = []
    await expect(
      createDefect(
        { ctx: noStatus.ctx, client: noStatus.client, runner: noStatus.runner, writeBody: noStatus.writeBody },
        { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'orphan-1' }
      )
    ).rejects.toMatchObject({ reason: 'task-type-not-found' })
    expect(noStatus.bodies.size).toBe(0)

    // The same for the second refusal that used to sit after the write.
    const noSequence = await harness()
    const original = noSequence.fake.tx.bind(noSequence.fake)
    ;(noSequence.fake as any).tx = async (tx: any) => {
      await original(tx)
      return {}
    }
    await expect(
      createDefect(
        { ctx: noSequence.ctx, client: noSequence.client, runner: noSequence.runner, writeBody: noSequence.writeBody },
        { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'orphan-2' }
      )
    ).rejects.toMatchObject({ reason: 'sequence-unavailable' })
    expect(noSequence.bodies.size).toBe(0)
  })

  it('still writes the body BEFORE the Issue that references it', async () => {
    // The other half of the ordering: the create must never publish a
    // `description` ref to bytes that are not there yet.
    const h = await harness()
    const seen: string[] = []
    const bodies = h.bodies
    const writeBody = async (blob: MarkupBlobRef, markup: string): Promise<void> => {
      seen.push('blob')
      bodies.set(blob, markup)
    }
    // ⚠️ The Issue create is wrapped in a `TxApplyIf`, so `tx.objectClass` is
    // the apply's, not the Issue's — the inner tx has to be looked for.
    const originalTx = h.fake.tx.bind(h.fake)
    ;(h.fake as any).tx = async (tx: any) => {
      if (JSON.stringify(tx ?? null)?.includes(tracker.class.Issue)) {
        seen.push('issue')
      }
      return await originalTx(tx)
    }
    const outcome = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody },
      { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'order' }
    )
    expect(outcome.result.bug).toBeDefined()
    expect(seen.indexOf('blob')).toBeGreaterThan(-1)
    expect(seen.indexOf('blob')).toBeLessThan(seen.indexOf('issue'))
  })

  it('refuses a target class the defect-of row does not allow', async () => {
    const h = await harness()
    await expect(
      createDefect(
        { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
        { target: PROJECT, targetClass: tracker.class.Project, project: PROJECT, idempotencyKey: 'bad' }
      )
    ).rejects.toBeInstanceOf(CreateDefectError)
    expect(h.db.find(tracker.class.Issue, {}).length).toBe(0)
  })

  it('refuses a target the caller may not read, and writes nothing', async () => {
    const h = await harness()
    h.db.hidden.add(RESULT)
    await expect(
      createDefect(
        { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
        { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'hidden' }
      )
    ).rejects.toMatchObject({ reason: 'target-not-found' })
    expect(h.db.find(tracker.class.Issue, {}).length).toBe(0)
    expect((h.db.docs.get(PROJECT) as Project).sequence).toBe(41)
  })

  it('re-enters cleanly after a partial run (issue written, edge not)', async () => {
    const h = await harness()
    const bugId = bugIdFor(RESULT)
    seed<Issue>(h.db, {
      _id: bugId,
      _class: tracker.class.Issue,
      space: PROJECT,
      title: '[TestResult] SSO login works',
      number: 42,
      identifier: 'BUG-42'
    } as any)

    const outcome = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner, writeBody: h.writeBody },
      { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'resume' }
    )
    expect(outcome.result.bug).toBe(bugId)
    expect(h.db.find(tracker.class.Issue, {}).length).toBe(1)
    expect(h.db.find(traceability.class.TraceLink, {}).length).toBe(1)
    // 🔴 The sequence was NOT bumped a second time: the derived-id existence
    // check short-circuits before the `$inc`.
    expect((h.db.docs.get(PROJECT) as Project).sequence).toBe(41)
  })

  it('still files the defect when there is no blob storage', async () => {
    const h = await harness()
    const outcome = await createDefect(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { target: RESULT, targetClass: testManagement.class.TestResult, project: PROJECT, idempotencyKey: 'no-storage' }
    )
    const issue = h.db.docs.get(outcome.result.bug as Ref<Issue>) as Issue
    // A dangling ref would be worse than no description at all.
    expect(issue.description).toBeNull()
    expect(h.db.find(traceability.class.TraceLink, {}).length).toBe(1)
  })
})
