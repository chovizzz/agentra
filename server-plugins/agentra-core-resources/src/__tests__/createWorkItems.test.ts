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
import { toFindResult, type Ref } from '@hcengineering/core'
import requirements, { type Requirement } from '@hcengineering/requirements'
import task, { type TaskType } from '@hcengineering/task'
import traceability, { traceLinkId, type TraceLink } from '@hcengineering/traceability'
import tracker, { IssuePriority, type Issue, type Project } from '@hcengineering/tracker'
import serverAgentraCore, { commandObjectId, type CommandExecution } from '@hcengineering/server-agentra-core'

import {
  CREATE_WORK_ITEMS,
  CreateWorkItemsError,
  createWorkItems,
  createWorkItemsCommandNamespace,
  createWorkItemsPartialWrite,
  createWorkItemsRoles,
  createWorkItemsScope,
  type CreateWorkItemsReason
} from '../commands/createWorkItems'
import {
  LINK_IMPLEMENTS_PAIR,
  LinkImplementsError,
  linkImplements,
  linkImplementsPairKey
} from '../commands/linkImplements'
import { toCommandResult } from '../commandRequest'
import { makeHarness, seed, type Harness } from './harness'

const REQ_ID = 'bbbbbbbbbbbbbbbbbbbbbr01' as Ref<Requirement>
const OTHER_REQ_ID = 'bbbbbbbbbbbbbbbbbbbbbr02' as Ref<Requirement>
const PROJECT = 'bbbbbbbbbbbbbbbbbbbbbp01' as Ref<Project>
const PROJECT_TYPE = 'bbbbbbbbbbbbbbbbbbbbbt01' as Ref<any>
const TASK_TYPE = 'bbbbbbbbbbbbbbbbbbbbbk01' as Ref<TaskType>
const STATUS = 'bbbbbbbbbbbbbbbbbbbbbs01' as Ref<any>

/** The key the client derives — a pure function of the requirement and the batch. */
function clientKey (requirement: Ref<Requirement> = REQ_ID, batch = 'b1'): string {
  return `traceability:create-work-items:v1:${requirement}:${batch}`
}

async function harness (opts: { isLatest?: boolean, defaultStatus?: boolean } = {}): Promise<Harness> {
  const h = await makeHarness()
  for (const _id of [REQ_ID, OTHER_REQ_ID]) {
    seed<Requirement>(h.db, {
      _id,
      _class: requirements.masterTag.Requirement as Ref<any>,
      space: requirements.space.Requirements as Ref<any>,
      title: 'Single sign-on',
      status: 'Approved',
      ...(opts.isLatest !== undefined ? { isLatest: opts.isLatest } : {})
    } as any)
  }
  seed<Project>(h.db, {
    _id: PROJECT,
    _class: tracker.class.Project,
    identifier: 'AGE',
    sequence: 0,
    type: PROJECT_TYPE,
    ...(opts.defaultStatus === false ? {} : { defaultIssueStatus: STATUS })
  } as any)
  seed<TaskType>(h.db, {
    _id: TASK_TYPE,
    _class: task.class.TaskType,
    parent: PROJECT_TYPE,
    ofClass: tracker.class.Issue,
    statuses: [STATUS]
  } as any)
  return h
}

function issues (h: Harness): Issue[] {
  return h.db.find(tracker.class.Issue, {}) as Issue[]
}

function edges (h: Harness): TraceLink[] {
  return h.db.find(traceability.class.TraceLink, {}) as TraceLink[]
}

const twoItems = [{ title: 'Wire the callback' }, { title: 'Add the session cookie' }]

describe('createWorkItems', () => {
  it('creates one issue per draft, each with an implements edge and activity on both ends', async () => {
    const h = await harness()
    const outcome = await createWorkItems(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { requirement: REQ_ID, project: PROJECT, items: twoItems, idempotencyKey: clientKey() }
    )

    expect(outcome.replayed).toBe(false)
    expect(outcome.result.workItems.length).toBe(2)
    expect(outcome.result.workItems.every((it) => it.created)).toBe(true)

    const created = issues(h)
    expect(created.length).toBe(2)
    expect(created.map((it) => it.title).sort()).toEqual(['Add the session cookie', 'Wire the callback'])
    // Identifiers come off the project sequence, one bump each, never guessed.
    expect(created.map((it) => it.identifier).sort()).toEqual(['AGE-1', 'AGE-2'])
    expect(created.every((it) => it.kind === TASK_TYPE)).toBe(true)
    expect(created.every((it) => it.status === STATUS)).toBe(true)
    expect(created.every((it) => it.priority === IssuePriority.Medium)).toBe(true)

    // 🔴 Every id is DERIVED from (requirement, key, list position) — nothing in
    // this command calls `generateId()`.
    const scope = createWorkItemsScope(REQ_ID, PROJECT, clientKey())
    for (let i = 0; i < 2; i++) {
      const expected = commandObjectId<Issue>(CREATE_WORK_ITEMS, scope, createWorkItemsRoles.issue(i))
      expect(outcome.result.workItems[i].workItem).toBe(expected)
    }

    const links = edges(h)
    expect(links.length).toBe(2)
    expect(links.every((l) => l.kind === 'implements')).toBe(true)
    expect(links.every((l) => l.docB === REQ_ID)).toBe(true)
    expect(links.map((l) => l.docA).sort()).toEqual(created.map((it) => it._id).sort())
    for (const link of links) {
      expect(link._id).toBe(traceLinkId('implements', link.docA, REQ_ID))
    }

    // 🔴 DOMAIN_RELATION writes no Activity, so two records per edge exist only
    // because the shared `ensureImplementsLink` wrote them: one on the issue,
    // one on the requirement.
    const messages = h.db.find(activity.class.DocUpdateMessage, {}) as DocUpdateMessage[]
    expect(messages.length).toBe(4)
    expect(messages.filter((m) => m.attachedTo === REQ_ID).length).toBe(2)
    expect(messages.filter((m) => created.some((c) => c._id === m.attachedTo)).length).toBe(2)
  })

  it('is idempotent: a repeated batch writes nothing new and replays', async () => {
    const h = await harness()
    const key = clientKey()
    const first = await createWorkItems(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { requirement: REQ_ID, project: PROJECT, items: twoItems, idempotencyKey: key }
    )
    const second = await createWorkItems(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { requirement: REQ_ID, project: PROJECT, items: twoItems, idempotencyKey: key }
    )

    expect(second.replayed).toBe(true)
    expect(second.result.workItems.map((it) => it.workItem)).toEqual(first.result.workItems.map((it) => it.workItem))
    expect(issues(h).length).toBe(2)
    expect(edges(h).length).toBe(2)
    expect(h.db.find(activity.class.DocUpdateMessage, {}).length).toBe(4)
    // The project sequence was bumped exactly twice, not four times.
    expect((h.db.docs.get(PROJECT) as Project).sequence).toBe(2)

    // ONE ledger row, namespaced by the requirement.
    const executions = h.db.find(serverAgentraCore.class.CommandExecution, {}) as CommandExecution[]
    expect(executions.length).toBe(1)
    expect(executions[0].command).toBe(createWorkItemsCommandNamespace(REQ_ID, PROJECT))
    // ⚠️ The BARE command name is never a row: it would be shared by every
    // requirement, so one caller's key could replay against another's subject.
    expect(executions[0].command).not.toBe(CREATE_WORK_ITEMS)
  })

  it('keeps one key from replaying across a DIFFERENT requirement', async () => {
    // 🔴 Iron law ①. With a constant command name the ledger row would be
    // addressed by the caller's key alone and `resume` would hand back the
    // first requirement's issue list while naming the second requirement.
    const h = await harness()
    const key = 'one-key-two-requirements'
    const first = await createWorkItems(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { requirement: REQ_ID, project: PROJECT, items: twoItems, idempotencyKey: key }
    )
    const second = await createWorkItems(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { requirement: OTHER_REQ_ID, project: PROJECT, items: twoItems, idempotencyKey: key }
    )

    expect(second.replayed).toBe(false)
    expect(second.result.requirement).toBe(OTHER_REQ_ID)
    const firstIds = first.result.workItems.map((it) => it.workItem)
    const secondIds = second.result.workItems.map((it) => it.workItem)
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false)
    expect(issues(h).length).toBe(4)
    expect(edges(h).length).toBe(4)
  })

  it('keeps one key from replaying across a DIFFERENT project', async () => {
    // 🔴 Iron law ①, the half Codex caught. The client's key carries the
    // requirement and the batch but NOT the project, so without the project in
    // the namespace AND in the derived-id scope a second call naming another
    // project would hand back the first project's issues and file nothing.
    const h = await harness()
    const OTHER_PROJECT = 'bbbbbbbbbbbbbbbbbbbbbp02' as Ref<Project>
    seed<Project>(h.db, {
      _id: OTHER_PROJECT,
      _class: tracker.class.Project,
      identifier: 'OTH',
      sequence: 0,
      type: PROJECT_TYPE,
      defaultIssueStatus: STATUS
    } as any)

    const key = clientKey()
    const first = await createWorkItems(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { requirement: REQ_ID, project: PROJECT, items: twoItems, idempotencyKey: key }
    )
    const second = await createWorkItems(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { requirement: REQ_ID, project: OTHER_PROJECT, items: twoItems, idempotencyKey: key }
    )

    expect(second.replayed).toBe(false)
    expect(second.result.workItems.every((it) => it.created)).toBe(true)
    const firstIds = first.result.workItems.map((it) => it.workItem)
    expect(second.result.workItems.some((it) => firstIds.includes(it.workItem))).toBe(false)
    // Four real issues, two per project — not two issues reported twice.
    expect(issues(h).length).toBe(4)
    expect(issues(h).filter((it) => it.space === OTHER_PROJECT).length).toBe(2)
    expect(
      issues(h)
        .map((it) => it.identifier)
        .sort()
    ).toEqual(['AGE-1', 'AGE-2', 'OTH-1', 'OTH-2'])
  })

  it('treats a SECOND batch against the same requirement as new work', async () => {
    // ⚠️ The deliberate difference from `linkImplements`: there is no claim on
    // the requirement, because "split it further" is a legitimate second
    // intent. A subject claim here would silently replay the first batch.
    const h = await harness()
    await createWorkItems(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      {
        requirement: REQ_ID,
        project: PROJECT,
        items: [{ title: 'First slice' }],
        idempotencyKey: clientKey(REQ_ID, 'b1')
      }
    )
    const second = await createWorkItems(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      {
        requirement: REQ_ID,
        project: PROJECT,
        items: [{ title: 'Second slice' }],
        idempotencyKey: clientKey(REQ_ID, 'b2')
      }
    )
    expect(second.replayed).toBe(false)
    expect(issues(h).length).toBe(2)
    expect(edges(h).length).toBe(2)
  })

  it('re-enters cleanly when a crash left the issues written and the edges missing', async () => {
    // The realistic partial run: the issues landed, the process died before the
    // edges. A fresh key over the same drafts must not duplicate the issues…
    const h = await harness()
    const key = clientKey()
    const first = await createWorkItems(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { requirement: REQ_ID, project: PROJECT, items: twoItems, idempotencyKey: key }
    )
    // Wipe the edges, the activity and the ledger row: exactly the state a
    // crashed-then-preempted attempt leaves behind.
    for (const link of edges(h)) h.db.docs.delete(link._id)
    for (const message of h.db.find(activity.class.DocUpdateMessage, {})) h.db.docs.delete(message._id)
    for (const row of h.db.find(serverAgentraCore.class.CommandExecution, {})) h.db.docs.delete(row._id)

    const again = await createWorkItems(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { requirement: REQ_ID, project: PROJECT, items: twoItems, idempotencyKey: key }
    )

    expect(again.result.workItems.map((it) => it.workItem)).toEqual(first.result.workItems.map((it) => it.workItem))
    // Nothing was created a second time…
    expect(again.result.workItems.every((it) => !it.created)).toBe(true)
    expect(issues(h).length).toBe(2)
    // …and the missing halves were completed rather than skipped.
    expect(edges(h).length).toBe(2)
    expect(h.db.find(activity.class.DocUpdateMessage, {}).length).toBe(4)
    // 🔴 The sequence was NOT bumped again: the reentrant body finds the issue
    // by its derived id and never reaches the `$inc`.
    expect((h.db.docs.get(PROJECT) as Project).sequence).toBe(2)
  })

  it('shares its edge and its activity records with a later manual link', async () => {
    // The batch and the manual entry point write the SAME edge id and the SAME
    // two activity ids, so re-asserting a pair the batch already made produces
    // no second announcement of one fact.
    const h = await harness()
    const outcome = await createWorkItems(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { requirement: REQ_ID, project: PROJECT, items: [{ title: 'Only one' }], idempotencyKey: clientKey() }
    )
    const workItem = outcome.result.workItems[0].workItem

    const manual = await linkImplements(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { workItem, requirement: REQ_ID, idempotencyKey: `traceability:link-implements:v1:${workItem}:${REQ_ID}` }
    )
    expect(manual.result.alreadyLinked).toBe(true)
    expect(manual.result.traceLink).toBe(outcome.result.workItems[0].traceLink)
    expect(edges(h).length).toBe(1)
    expect(h.db.find(activity.class.DocUpdateMessage, {}).length).toBe(2)

    // The activity ids the batch wrote are the pair-derived ones the manual
    // command looks for.
    // Round 0 of the pair's lifecycle: the edge has never been withdrawn, so
    // the revocation generation the batch folded into the scope is 0.
    const pairKey = linkImplementsPairKey(workItem, REQ_ID, 0)
    for (const role of ['activity:work-item', 'activity:requirement']) {
      expect(h.db.docs.get(commandObjectId(LINK_IMPLEMENTS_PAIR, pairKey, role))).toBeDefined()
    }
  })

  it('refuses a REPLAY to a caller who lost access to the requirement', async () => {
    // 🔴 Iron law ②. The stored result carries the `Ref` of every issue the
    // batch created, and `resume` hands it back WITHOUT re-entering the body.
    const h = await harness()
    await createWorkItems(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { requirement: REQ_ID, project: PROJECT, items: twoItems, idempotencyKey: clientKey() }
    )
    h.db.hidden.add(REQ_ID)
    await expect(
      createWorkItems(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { requirement: REQ_ID, project: PROJECT, items: twoItems, idempotencyKey: clientKey() }
      )
    ).rejects.toMatchObject({ name: 'CreateWorkItemsError', reason: 'requirement-not-found' })
  })

  it('refuses a REPLAY to a caller who lost access to the project', async () => {
    // The project is part of the subject, not an incidental parameter: the
    // result names issues that live in it.
    const h = await harness()
    await createWorkItems(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { requirement: REQ_ID, project: PROJECT, items: twoItems, idempotencyKey: clientKey() }
    )
    h.db.hidden.add(PROJECT)
    await expect(
      createWorkItems(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { requirement: REQ_ID, project: PROJECT, items: twoItems, idempotencyKey: clientKey() }
      )
    ).rejects.toMatchObject({ reason: 'project-not-found' })
  })

  it('refuses a superseded requirement revision', async () => {
    const h = await harness({ isLatest: false })
    await expect(
      createWorkItems(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { requirement: REQ_ID, project: PROJECT, items: twoItems, idempotencyKey: clientKey() }
      )
    ).rejects.toMatchObject({ reason: 'requirement-not-latest' })
    expect(issues(h).length).toBe(0)
  })

  it('refuses an empty batch', async () => {
    const h = await harness()
    await expect(
      createWorkItems(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { requirement: REQ_ID, project: PROJECT, items: [], idempotencyKey: clientKey() }
      )
    ).rejects.toMatchObject({ name: 'CreateWorkItemsError', reason: 'no-items' })
  })

  it('refuses rather than writing an edge the matrix forbids', async () => {
    const h = await harness()
    await expect(
      createWorkItems(
        { ctx: h.ctx, client: h.client, runner: h.runner, endpoints: new Map() },
        { requirement: REQ_ID, project: PROJECT, items: twoItems, idempotencyKey: clientKey() }
      )
    ).rejects.toBeInstanceOf(Error)
    // The first issue is written before the matrix refusal is reached, but no
    // edge is — the refusal is what stops the batch, and the reentrant body
    // makes a corrected retry pick the same issue up rather than duplicating it.
    expect(edges(h).length).toBe(0)
  })

  it('refuses when the project has no issue status to file under', async () => {
    const h = await harness({ defaultStatus: false })
    h.db.docs.delete(TASK_TYPE)
    await expect(
      createWorkItems(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { requirement: REQ_ID, project: PROJECT, items: twoItems, idempotencyKey: clientKey() }
      )
    ).rejects.toMatchObject({ name: 'CreateWorkItemsError', reason: 'task-type-not-found' })
    expect(issues(h).length).toBe(0)
  })

  it('honours per-draft task type, assignee and priority', async () => {
    const h = await harness()
    const assignee = 'bbbbbbbbbbbbbbbbbbbbbe01' as Ref<any>
    const outcome = await createWorkItems(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      {
        requirement: REQ_ID,
        project: PROJECT,
        items: [{ title: 'Urgent slice', taskType: TASK_TYPE, assignee, priority: IssuePriority.Urgent }],
        idempotencyKey: clientKey()
      }
    )
    const issue = h.db.docs.get(outcome.result.workItems[0].workItem) as Issue
    expect(issue.priority).toBe(IssuePriority.Urgent)
    expect(issue.assignee).toBe(assignee)
    expect(issue.kind).toBe(TASK_TYPE)
  })

  it('reports a missing project as such', async () => {
    const h = await harness()
    await expect(
      createWorkItems(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        {
          requirement: REQ_ID,
          project: 'bbbbbbbbbbbbbbbbbbbbbp99' as Ref<Project>,
          items: twoItems,
          idempotencyKey: clientKey()
        }
      )
    ).rejects.toMatchObject({ name: 'CreateWorkItemsError', reason: 'project-not-found' })
  })

  it('exposes CreateWorkItemsError with a 400 code', async () => {
    expect(new CreateWorkItemsError('no-items', 'x').code).toBe(400)
  })
})

describe('createWorkItems: the server says whether a refusal may have written', () => {
  it('classifies every reason it can refuse for', () => {
    // 🔴 THE RUNTIME HALF OF THE EXHAUSTIVENESS GUARD. The compile-time half is
    // `PartialWriteTable<CreateWorkItemsReason>`, which rejects a missing or a
    // surplus key; this catches the case it cannot see — somebody widening the
    // reason type to `string` and leaving the table behind.
    const reasons: CreateWorkItemsReason[] = [
      'requirement-not-found',
      'requirement-not-latest',
      'project-not-found',
      'task-type-not-found',
      'no-items',
      'issue-id-taken',
      'sequence-unavailable'
    ]
    expect(Object.keys(createWorkItemsPartialWrite).sort()).toEqual([...reasons].sort())
    for (const reason of reasons) {
      expect(['none', 'possible']).toContain(createWorkItemsPartialWrite[reason])
    }
  })

  it('calls the four pre-loop refusals clean', () => {
    for (const reason of [
      'requirement-not-found',
      'requirement-not-latest',
      'project-not-found',
      'no-items'
    ] as const) {
      expect(new CreateWorkItemsError(reason, 'x').partialWrite).toBe('none')
      expect(new CreateWorkItemsError(reason, 'x').itemsWritten).toBe(0)
    }
  })

  it('calls the three in-loop refusals possible', () => {
    for (const reason of ['task-type-not-found', 'sequence-unavailable', 'issue-id-taken'] as const) {
      expect(new CreateWorkItemsError(reason, 'x').partialWrite).toBe('possible')
    }
  })

  it('cannot be told a classification that contradicts the table', () => {
    // `partialWrite` is derived, never passed: the third argument is the COUNT.
    const err = new CreateWorkItemsError('sequence-unavailable', 'x', 3)
    expect(err.partialWrite).toBe('possible')
    expect(err.itemsWritten).toBe(3)
  })

  it('reports how many items already exist when it gives up mid-batch', async () => {
    // Three items; the task type disappears once the first two are written, so
    // the refusal comes out of item 2 with items 0 and 1 committed.
    const h = await harness()
    let seen = 0
    const realFindAll = h.client.findAll.bind(h.client)
    ;(h.client as any).findAll = async (_class: any, query: any, options?: any) => {
      if (_class === task.class.TaskType && query.ofClass === tracker.class.Issue) {
        if (seen++ >= 2) return toFindResult([])
      }
      return await realFindAll(_class, query, options)
    }
    await expect(
      createWorkItems(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        {
          requirement: REQ_ID,
          project: PROJECT,
          items: [{ title: 'a' }, { title: 'b' }, { title: 'c' }],
          idempotencyKey: clientKey()
        }
      )
    ).rejects.toMatchObject({
      name: 'CreateWorkItemsError',
      reason: 'task-type-not-found',
      partialWrite: 'possible',
      itemsWritten: 2
    })
    expect(issues(h).length).toBe(2)
  })

  it('carries the classification onto the wire envelope', () => {
    const clean = toCommandResult(new CreateWorkItemsError('project-not-found', 'x'))
    expect(clean).toMatchObject({ ok: false, code: 400, partialWrite: 'none', itemsWritten: 0 })
    const dirty = toCommandResult(new CreateWorkItemsError('issue-id-taken', 'x', 4))
    expect(dirty).toMatchObject({ ok: false, code: 400, partialWrite: 'possible', itemsWritten: 4 })
  })

  it('never reports an unaudited command as clean', () => {
    const other = toCommandResult(new LinkImplementsError('work-item-not-found', 'x'))
    expect(other).toMatchObject({ ok: false, partialWrite: 'unclassified' })
  })
})
