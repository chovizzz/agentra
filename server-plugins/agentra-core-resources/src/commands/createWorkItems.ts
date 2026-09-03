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

import { type Employee } from '@hcengineering/contact'
import core, {
  type AttachedData,
  type MeasureContext,
  type Ref,
  type SessionData,
  type TxOperations
} from '@hcengineering/core'
import requirements, { type Requirement } from '@hcengineering/requirements'
import task, { type TaskType } from '@hcengineering/task'
import { type TraceEndpointRegistry, type TraceLink } from '@hcengineering/traceability'
import tracker, { IssuePriority, type Issue, type Project } from '@hcengineering/tracker'
import { commandObjectId, type CommandOutcome, type CommandRequest } from '@hcengineering/server-agentra-core'

import { assertCommitted, isDuplicateKeyError } from '../commandMiddleware'
import { lookupPartialWrite, type PartialWriteTable } from '../partialWrite'
import { agentraTraceEndpoints } from './traceEndpoints'
import { type CommandRunner } from './convertLeadToRequirement'
import { applyStepFor } from './traceCommandSupport'
import { ensureImplementsLink } from './linkImplements'

/**
 * Command name. Part of the persisted contract: it is the first component of
 * every derived `_id` this command produces, so renaming it re-points all of
 * them and a replay would write a second set of issues.
 *
 * @public
 */
export const CREATE_WORK_ITEMS = 'CreateWorkItems'

/**
 * Object roles for {@link commandObjectId}. The issue role is INDEXED, because
 * a batch produces N issues from one claim and each of them needs an id that is
 * a pure function of the request.
 *
 * @public
 */
export const createWorkItemsRoles = {
  issue: (index: number) => `issue:${index}`
} as const

/**
 * @public
 */
export interface WorkItemDraft {
  title: string
  /** Overrides the project's first Issue task type. */
  taskType?: Ref<TaskType>
  assignee?: Ref<Employee>
  priority?: IssuePriority
}

/**
 * @public
 */
export interface CreateWorkItemsInput {
  requirement: Ref<Requirement>
  /** The tracker project the work items are filed into. */
  project: Ref<Project>
  items: WorkItemDraft[]
  idempotencyKey: string
}

/**
 * @public
 */
export interface CreatedWorkItem {
  workItem: Ref<Issue>
  traceLink: Ref<TraceLink>
  /** `false` when a previous attempt had already written this issue. */
  created: boolean
}

/**
 * @public
 */
export interface CreateWorkItemsResult extends Record<string, any> {
  requirement: Ref<Requirement>
  workItems: CreatedWorkItem[]
}

/**
 * Every reason this command refuses for.
 *
 * 🔴 A NAMED UNION, NOT AN INLINE ONE. {@link createWorkItemsPartialWrite} is
 * keyed on it, so adding a member here without classifying it there does not
 * compile. That is the whole point: the bug this exists to prevent was seven
 * reasons sharing one 400 because nobody was ever forced to say which of them
 * can fire after the batch has started writing.
 *
 * @public
 */
export type CreateWorkItemsReason =
  | 'requirement-not-found'
  | 'requirement-not-latest'
  | 'project-not-found'
  | 'task-type-not-found'
  | 'no-items'
  | 'issue-id-taken'
  | 'sequence-unavailable'

/**
 * Which refusals can be raised AFTER the write loop has begun.
 *
 * 🔴 WORST CASE PER REASON, NOT PER OCCURRENCE. `task-type-not-found`,
 * `sequence-unavailable` and `issue-id-taken` all come out of `writeIssue`,
 * which runs once per item; raised from item 0 they are in fact clean, raised
 * from item 4 they leave four issues behind. The reason alone cannot tell those
 * apart, so it reports the dangerous case and {@link CreateWorkItemsError.itemsWritten}
 * carries the exact count for a client that wants to be precise. Erring the
 * other way would put "nothing was created" in front of a user looking at a
 * half-written batch — the failure mode this whole classification exists for.
 *
 * ⚠️ `no-items` and both `*-not-found` reasons are raised before the loop, and
 * `requirement-not-latest` between the two subject reads; those four are clean
 * by construction, not by inspection of the message.
 *
 * ⚠️ `malformed-input` IS NOT HERE, and that is not an omission: it is not
 * thrown by this file at all. `AgentraCommandMiddleware` returns it from its
 * pre-validation in `commandRequest.ts`, before `createWorkItems` is entered,
 * so it is classified at that site (as `none`, which is provable there — the
 * body never ran).
 *
 * @public
 */
export const createWorkItemsPartialWrite: PartialWriteTable<CreateWorkItemsReason> = {
  'requirement-not-found': 'none',
  'requirement-not-latest': 'none',
  'project-not-found': 'none',
  'no-items': 'none',
  'task-type-not-found': 'possible',
  'sequence-unavailable': 'possible',
  'issue-id-taken': 'possible'
}

/**
 * @public
 */
export class CreateWorkItemsError extends Error {
  readonly code = 400

  /**
   * Whether work items may already exist despite this refusal. Derived from
   * {@link createWorkItemsPartialWrite} rather than passed in, so no throw site
   * can contradict the declared contract.
   */
  readonly partialWrite: 'none' | 'possible'

  constructor (
    readonly reason: CreateWorkItemsReason,
    message: string,
    /**
     * How many items of this batch are KNOWN to exist at the moment of the
     * refusal — the loop index the throw came from, or 0 for a throw that
     * precedes the loop. Never a guess: it counts iterations that completed,
     * so an item whose write failed halfway is not included.
     */
    readonly itemsWritten: number = 0
  ) {
    super(message)
    this.name = 'CreateWorkItemsError'
    this.partialWrite = lookupPartialWrite(createWorkItemsPartialWrite, reason)
  }
}

/**
 * @public
 */
export interface CreateWorkItemsContext {
  ctx: MeasureContext<SessionData>
  /** Must carry the CALLING account, so every write is attributed and secured. */
  client: TxOperations
  runner: CommandRunner
  endpoints?: TraceEndpointRegistry
  staleTimeoutMs?: number
}

/**
 * The outer ledger namespace for one requirement.
 *
 * 🔴 THE WHOLE SUBJECT IS FOLDED INTO THE COMMAND NAME. `commandExecutionId` is
 * `sha256(command ‖ idempotencyKey)`, so with a CONSTANT command name the
 * ledger row is decided entirely by a key the CALLER supplies. A caller could
 * then present a key that already succeeded for one requirement while naming a
 * different one, and `CommandMiddleware.resume` would hand back the first
 * requirement's stored result — issue `Ref`s included — without ever entering
 * the body, past the pre-runner readability check, which only ever sees the
 * subject that was NAMED.
 *
 * 🔴 THE PROJECT IS PART OF THE SUBJECT, not an incidental parameter, so it goes
 * in too. Binding only the requirement leaves the row shared by every project:
 * a key that succeeded for (requirement R, project P1) would REPLAY for
 * (R, P2) and hand back a list of issues that live in P1 while the caller
 * asked for P2 — no issue is created in P2 at all, and P1's `Ref`s leak to a
 * caller who may have access to P2 only. The client's key does not carry the
 * project either (see `createWorkItemsIdempotencyKey`), which is precisely why
 * the binding has to happen here rather than being left to callers.
 *
 * @public
 */
export function createWorkItemsCommandNamespace (requirement: Ref<Requirement>, project: Ref<Project>): string {
  return `${CREATE_WORK_ITEMS}:${requirement}:${project}`
}

/**
 * The scope every derived issue id hangs off.
 *
 * 🔴 THE SAME THREE COMPONENTS AS THE LEDGER NAMESPACE, and they must stay in
 * step. The key alone would let one key used against two requirements derive
 * the SAME issue ids; the requirement alone would make a second, deliberate
 * batch collide with the first one's issues instead of adding to them; and
 * dropping the project would be worse than either — the ledger rows for
 * (R, P1, K) and (R, P2, K) are distinct, so the second request DOES enter the
 * body, finds P1's issues under the derived ids, reports them as already
 * created and files nothing into P2.
 *
 * @public
 */
export function createWorkItemsScope (
  requirement: Ref<Requirement>,
  project: Ref<Project>,
  idempotencyKey: string
): string {
  return `${requirement} ${project} ${idempotencyKey}`
}

/**
 * Split a requirement into work items, each carrying an `implements` edge back
 * to it.
 *
 * 🔴 ONE CLAIM, NOT TWO — and that is a deliberate difference from
 * `linkImplements` / `createDefect`. Those two need an inner claim because
 * several DIFFERENT intents (three verifies entry points; a re-raised defect)
 * must converge on one object, so the exclusion has to sit on the subject
 * rather than on the caller's key. Here the opposite is true: two batches
 * against the same requirement are two legitimate, different intents ("split it
 * further"), and a claim on the requirement would silently replay the first
 * batch's result for the second. The unit of intent IS the idempotency key, so
 * the outer claim is the whole story and every derived id hangs off
 * {@link createWorkItemsScope}.
 *
 * 🔴 REENTRANCY, NOT ATOMICITY. Each issue, each sequence bump, each edge and
 * each pair of activity records is its own database transaction. Every step is
 * `findOne`-then-write over a DERIVED `_id`; `generateId()` is never called.
 *
 * ⚠️ THE ONE NON-REENTRANT WRITE IS THE SEQUENCE BUMP, exactly as in
 * `createDefect`: `Project.sequence` is advanced with `$inc`, so a crash
 * between the bump and the create BURNS an issue number. Issue numbers are
 * documented as monotonic, never as gapless, and the alternative — recomputing
 * a number from a stale read — gives two issues the same `identifier`.
 *
 * @public
 */
export async function createWorkItems (
  context: CreateWorkItemsContext,
  input: CreateWorkItemsInput
): Promise<CommandOutcome<CreateWorkItemsResult>> {
  const { ctx, client, runner } = context
  const endpoints = context.endpoints ?? agentraTraceEndpoints
  const request: CommandRequest = {
    command: createWorkItemsCommandNamespace(input.requirement, input.project),
    idempotencyKey: input.idempotencyKey,
    staleTimeoutMs: context.staleTimeoutMs
  }

  // 🔴 CHECKED BEFORE THE RUNNER, not only inside the body. `CommandMiddleware`
  // replays a `succeeded` row's stored result WITHOUT re-entering the body, and
  // the stored result carries the `Ref` of every issue the batch created. A
  // caller who has since lost access to the requirement (or never had it, but
  // knows the key) would otherwise be handed that list back as a clean success.
  // Re-reading here runs on every path — fresh, replayed and preempted alike.
  await assertSubjectReadable(client, input)

  return await runner.run<CreateWorkItemsResult>(
    ctx,
    request,
    async () => await runCreate(ctx, client, endpoints, input)
  )
}

/**
 * The subject — the requirement AND the project — must be readable BY THE
 * CALLER on every path.
 *
 * The project counts as part of the subject rather than as an incidental
 * parameter: the result names issues that live in it, so a caller who may not
 * read the project may not learn which issues a batch put there.
 */
async function assertSubjectReadable (client: TxOperations, input: CreateWorkItemsInput): Promise<void> {
  const requirement = await client.findOne<Requirement>(requirements.masterTag.Requirement as Ref<any>, {
    _id: input.requirement
  })
  if (requirement === undefined) {
    throw new CreateWorkItemsError('requirement-not-found', `Requirement '${input.requirement}' does not exist`)
  }
  const project = await client.findOne<Project>(tracker.class.Project, { _id: input.project })
  if (project === undefined) {
    throw new CreateWorkItemsError('project-not-found', `Tracker project '${input.project}' does not exist`)
  }
}

async function runCreate (
  ctx: MeasureContext<SessionData>,
  client: TxOperations,
  endpoints: TraceEndpointRegistry,
  input: CreateWorkItemsInput
): Promise<CreateWorkItemsResult> {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new CreateWorkItemsError('no-items', 'A work item batch must name at least one item')
  }

  // ── Step 0: read the subject, pinned to its class. ───────────────────────
  const requirement = await client.findOne<Requirement>(requirements.masterTag.Requirement as Ref<any>, {
    _id: input.requirement
  })
  if (requirement === undefined) {
    throw new CreateWorkItemsError('requirement-not-found', `Requirement '${input.requirement}' does not exist`)
  }

  // ⚠️ Same rule as `linkImplements`, and for the same reason: `implements`
  // inherits FORWARD at revision time, so an edge attached to an already
  // superseded revision is never carried on to the current one and no delivery
  // view will ever see it. `isLatest === undefined` is accepted — the flag only
  // exists on documents `VersioningMiddleware` created.
  if ((requirement as { isLatest?: boolean }).isLatest === false) {
    throw new CreateWorkItemsError(
      'requirement-not-latest',
      `Requirement '${requirement._id}' is a superseded revision; split the current one`
    )
  }

  const project = await client.findOne<Project>(tracker.class.Project, { _id: input.project })
  if (project === undefined) {
    throw new CreateWorkItemsError('project-not-found', `Tracker project '${input.project}' does not exist`)
  }

  const scope = createWorkItemsScope(input.requirement, input.project, input.idempotencyKey)
  const workItems: CreatedWorkItem[] = []

  for (let index = 0; index < input.items.length; index++) {
    const draft = input.items[index]
    // 🔴 THE INDEX IS PART OF THE ID, NOT THE TITLE. Deriving from the title
    // would collapse two work items a user deliberately named the same, and
    // would move every subsequent id if the caller retried after fixing a typo.
    // The list position is the only stable coordinate a retry preserves.
    const issueId = commandObjectId<Issue>(CREATE_WORK_ITEMS, scope, createWorkItemsRoles.issue(index))

    let issue = await client.findOne<Issue>(tracker.class.Issue, { _id: issueId })
    const created = issue === undefined
    if (issue === undefined) {
      issue = await writeIssue(client, project, issueId, draft, index)
    }

    // The edge is asserted whether or not this attempt created the issue: the
    // realistic crash leaves the issue written and the edge missing, and a
    // replay that skipped this would strand a work item nothing points at.
    const { link } = await ensureImplementsLink(client, endpoints, CREATE_WORK_ITEMS, issue, requirement, {
      command: CREATE_WORK_ITEMS,
      idempotencyKey: input.idempotencyKey
    })

    workItems.push({ workItem: issueId, traceLink: link, created })
  }

  ctx.info('agentra work items created', {
    requirement: requirement._id,
    project: project._id,
    count: workItems.length,
    createdNow: workItems.filter((it) => it.created).length,
    idempotencyKey: input.idempotencyKey
  })

  return { requirement: requirement._id, workItems }
}

async function writeIssue (
  client: TxOperations,
  project: Project,
  issueId: Ref<Issue>,
  draft: WorkItemDraft,
  /** The loop index, i.e. how many items of the batch are already written. */
  itemsWritten: number
): Promise<Issue> {
  const taskType = draft.taskType ?? (await defaultTaskType(client, project))
  if (taskType === undefined) {
    throw new CreateWorkItemsError(
      'task-type-not-found',
      `Project '${project._id}' has no task type for tracker.class.Issue`,
      itemsWritten
    )
  }
  const status = project.defaultIssueStatus ?? (await firstStatus(client, taskType))
  if (status === undefined) {
    // 🔴 Refuse rather than create an Issue with no status. `Issue.status` is
    // required, and a document written with `undefined` there renders as a
    // blank column in every board and is invisible to every status filter.
    throw new CreateWorkItemsError(
      'task-type-not-found',
      `Project '${project._id}' has no issue status to file a work item under`,
      itemsWritten
    )
  }

  const incremented = await client.updateDoc(
    tracker.class.Project,
    core.space.Space,
    project._id,
    { $inc: { sequence: 1 } },
    true
  )
  const number = readSequence(incremented)
  if (number === undefined) {
    // 🔴 NEVER GUESS THE NUMBER. `project.sequence + 1` off the value read
    // before the bump is what makes two concurrent batches share an
    // `identifier`: both read the same stale sequence, both compute the same
    // successor, and the issue `_id`s differ (they are derived from the request)
    // so nothing collides to stop them.
    throw new CreateWorkItemsError(
      'sequence-unavailable',
      `Project '${project._id}' did not return its incremented sequence; refusing to guess an issue number`,
      itemsWritten
    )
  }

  const value: AttachedData<Issue> = {
    title: draft.title,
    description: null,
    assignee: (draft.assignee ?? null) as Issue['assignee'],
    component: null,
    milestone: null,
    number,
    priority: draft.priority ?? IssuePriority.Medium,
    rank: '',
    comments: 0,
    subIssues: 0,
    dueDate: null,
    startDate: null,
    parents: [],
    reportedTime: 0,
    remainingTime: 0,
    estimation: 0,
    reports: 0,
    relations: [],
    childInfo: [],
    kind: taskType,
    status,
    identifier: `${project.identifier}-${number}`
  }

  const apply = applyStepFor(client, CREATE_WORK_ITEMS, 'issue')
  await apply.addCollection<Issue, Issue>(
    tracker.class.Issue,
    project._id,
    tracker.ids.NoParent,
    tracker.class.Issue,
    'subIssues',
    value,
    issueId
  )
  try {
    assertCommitted(await apply.commit(), 'create work item issue')
  } catch (err: unknown) {
    if (isDuplicateKeyError(err)) {
      throw new CreateWorkItemsError(
        'issue-id-taken',
        `Derived issue id '${issueId}' is already held by another document`,
        itemsWritten
      )
    }
    throw err
  }
  const issue = await client.findOne<Issue>(tracker.class.Issue, { _id: issueId })
  if (issue === undefined) {
    throw new Error(`Issue '${issueId}' vanished immediately after being created`)
  }
  return issue
}

/**
 * The sequence value out of a `retrieve: true` update, across both adapters.
 *
 * 🔴 THE TWO ADAPTERS DISAGREE ON THE SHAPE. `PostgresAdapterBase.txUpdateDoc`
 * returns `{ object: doc }`, `MongoAdapter.txUpdateDoc` returns the document
 * itself. A middleware may also hand back an array when the batch was
 * regrouped, hence the first-element unwrap.
 */
function readSequence (result: unknown): number | undefined {
  const first = Array.isArray(result) ? result[0] : result
  if (first == null || typeof first !== 'object') return undefined
  const wrapped = (first as { object?: { sequence?: unknown } }).object
  const value = wrapped?.sequence ?? (first as { sequence?: unknown }).sequence
  return typeof value === 'number' ? value : undefined
}

async function defaultTaskType (client: TxOperations, project: Project): Promise<Ref<TaskType> | undefined> {
  const types = await client.findAll<TaskType>(task.class.TaskType, {
    parent: project.type,
    ofClass: tracker.class.Issue
  })
  return types[0]?._id
}

async function firstStatus (client: TxOperations, taskType: Ref<TaskType>): Promise<Issue['status'] | undefined> {
  const type = await client.findOne<TaskType>(task.class.TaskType, { _id: taskType })
  return type?.statuses[0] as Issue['status'] | undefined
}
