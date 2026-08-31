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

import { type DocUpdateMessage } from '@hcengineering/activity'
import contact, { type Employee } from '@hcengineering/contact'
import core, {
  type AttachedData,
  type Class,
  type Doc,
  type MarkupBlobRef,
  type MeasureContext,
  type Ref,
  type SessionData,
  type TxOperations
} from '@hcengineering/core'
import products, { type ProductVersion } from '@hcengineering/products'
import { type Requirement } from '@hcengineering/requirements'
import task, { type TaskType } from '@hcengineering/task'
import testManagement, {
  type Build,
  type TestCase,
  type TestCaseSnapshot,
  type TestEnvironment,
  type TestResult,
  type TestRun
} from '@hcengineering/test-management'
import traceability, {
  normId,
  traceEndpointRoles,
  traceLinkId,
  validateTraceLink,
  type TraceEndpointRegistry,
  type TraceLink
} from '@hcengineering/traceability'
import tracker, { IssuePriority, type Issue, type Project } from '@hcengineering/tracker'
import { commandObjectId, type CommandOutcome, type CommandRequest } from '@hcengineering/server-agentra-core'

import { assertCommitted, isDuplicateKeyError } from '../commandMiddleware'
import { traceLinkMetadata } from '../traceLinkMetadata'
import { buildDefectContent, type DefectFacts, type DefectStep, type DefectTargetKind } from './defectContent'
import { type CommandRunner } from './convertLeadToRequirement'
import { agentraTraceEndpoints } from './traceEndpoints'
import { applyStepFor, ensureTraceActivity } from './traceCommandSupport'

/**
 * @public
 */
export const CREATE_DEFECT = 'CreateDefect'

/**
 * The INNER claim, keyed on the TARGET rather than on the caller's key.
 *
 * 🔴 THIS IS WHAT MAKES "OPEN THE EXISTING BUG" TRUE. Task 15 requires that a
 * failed result which already has a defect OPENS it rather than raising a
 * second one, and a read-then-create check on the edge cannot deliver that
 * under concurrency: two callers both read no edge, both create an Issue, and
 * only the second edge write collides. Claiming `(CREATE_DEFECT_TARGET, target)`
 * moves the exclusion onto the failed object itself, where the ledger's primary
 * key enforces it, and every object the command produces derives its `_id` from
 * the TARGET so two racing callers converge on one Issue.
 *
 * @public
 */
export const CREATE_DEFECT_TARGET = `${CREATE_DEFECT}:target`

/**
 * Object roles for {@link commandObjectId}. Stable forever.
 *
 * ⚠️ Derived against `(CREATE_DEFECT_TARGET, target)`, NOT against the caller's
 * idempotency key: keying them on the request would give two requests for one
 * failure two different Issue ids, which is exactly the duplicate this command
 * exists to prevent.
 *
 * @public
 */
export const createDefectRoles = {
  issue: 'issue',
  targetActivity: 'activity:target',
  issueActivity: 'activity:issue'
} as const

/**
 * @public
 */
export interface CreateDefectInput {
  target: Ref<Doc>
  targetClass: Ref<Class<Doc>>
  /** The tracker project the defect is filed into. */
  project: Ref<Project>
  /** Overrides the project's first Issue task type. */
  taskType?: Ref<TaskType>
  assignee?: Ref<Employee>
  /** Free text describing what actually happened. */
  actual?: string
  idempotencyKey: string
}

/**
 * @public
 */
export interface CreateDefectResult extends Record<string, any> {
  target: Ref<Doc>
  /**
   * ⚠️ ABSENT when {@link CreateDefectResult.restricted} is set. A defect the
   * caller may not read must not travel back as a `Ref` — see the resolve in
   * `runCreate`.
   */
  bug?: Ref<Issue>
  traceLink?: Ref<TraceLink>
  /**
   * `true` when an EARLIER defect already covered this target, so the caller
   * should open that Issue instead of announcing a new one.
   */
  alreadyReported: boolean
  /**
   * `true` when a defect exists but this caller may not see it. The UI must say
   * exactly that and offer no link — the same degradation the traceability
   * block uses for a restricted endpoint.
   */
  restricted: boolean
}

/**
 * @public
 */
export class CreateDefectError extends Error {
  readonly code = 400

  constructor (
    readonly reason:
    | 'target-not-found'
    | 'target-role-unknown'
    | 'project-not-found'
    | 'task-type-not-found'
    | 'invalid-trace-link'
    | 'issue-id-taken'
    | 'sequence-unavailable',
    message: string
  ) {
    super(message)
    this.name = 'CreateDefectError'
  }
}

/**
 * Writes the defect body into blob storage.
 *
 * 🔴 INJECTED, and the `_id` it is handed is DERIVED. `makeCollabJsonId` stamps
 * `Date.now()` into the blob id, so using it here would mint a NEW blob on every
 * replay and leak one per crashed attempt. The command therefore names the blob
 * itself, which makes the write idempotent — the same bytes land on the same key.
 *
 * Injected rather than reached through `PipelineContext.storageAdapter` so the
 * body composition can be asserted without an object store; when it is absent
 * the Issue is created with `description: null` rather than with a dangling ref.
 *
 * @public
 */
export type DefectBodyWriter = (blob: MarkupBlobRef, markup: string) => Promise<void>

/**
 * @public
 */
export interface CreateDefectContext {
  ctx: MeasureContext<SessionData>
  /** Must carry the CALLING account, so every write is attributed and secured. */
  client: TxOperations
  runner: CommandRunner
  endpoints?: TraceEndpointRegistry
  writeBody?: DefectBodyWriter
  staleTimeoutMs?: number
}

/**
 * Raise a defect against a failed result, a test case or a requirement, exactly
 * once per target.
 *
 * 🔴 REENTRANCY, NOT ATOMICITY: the blob, the Issue, the project sequence bump,
 * the edge and the two activity records are five unrelated database
 * transactions. Every step is `findOne`-then-write over a DERIVED `_id`.
 *
 * ⚠️ THE ONE NON-REENTRANT WRITE IS THE SEQUENCE BUMP, and it is deliberate.
 * `Project.sequence` is advanced with `$inc`, which cannot be made idempotent
 * without a second ledger; a crash between the bump and the Issue create
 * therefore BURNS an issue number. That is the correct trade: issue numbers are
 * documented as monotonic, never as gapless, and the alternative — reusing a
 * number — would give two different issues the same identifier. The bump is
 * placed immediately before the create and guarded by the derived-id existence
 * check, so it happens at most once per successful defect.
 *
 * @public
 */
/**
 * The outer ledger namespace for one subject.
 *
 * See the note at the call site: a constant command name would let a key that
 * succeeded for one subject replay under another.
 *
 * @public
 */
export function createDefectCommandNamespace (target: Ref<Doc>): string {
  return `${CREATE_DEFECT}:${target}`
}

export async function createDefect (
  context: CreateDefectContext,
  input: CreateDefectInput
): Promise<CommandOutcome<CreateDefectResult>> {
  const { ctx, client, runner } = context
  const endpoints = context.endpoints ?? agentraTraceEndpoints
  // 🔴 THE OUTER COMMAND NAME CARRIES THE SUBJECT, and that is a security
  // property rather than a naming choice. `commandExecutionId` is
  // `sha256(command + ' ' + idempotencyKey)`, so with a CONSTANT command name
  // the ledger row is decided entirely by a key the CALLER supplies. A caller
  // could then present a key that already succeeded for one subject while
  // naming a different one, and `CommandMiddleware.resume` would hand back the
  // first subject's stored result without ever entering the body — past the
  // pre-runner readability check, which only ever sees the subject that was
  // NAMED. Folding the subject into the name makes the two rows disjoint.
  const request: CommandRequest = {
    command: createDefectCommandNamespace(input.target),
    idempotencyKey: input.idempotencyKey,
    staleTimeoutMs: context.staleTimeoutMs
  }

  const outcome = await runner.run<CreateDefectResult>(ctx, request, async () => {
    const inner = await runner.run<CreateDefectResult>(
      ctx,
      {
        command: CREATE_DEFECT_TARGET,
        idempotencyKey: input.target,
        staleTimeoutMs: context.staleTimeoutMs
      },
      async () => await runCreate(ctx, client, endpoints, context.writeBody, input)
    )
    return { ...inner.result, alreadyReported: inner.result.alreadyReported || inner.replayed }
  })

  // 🔴 THE LEDGER REPLAY BYPASSES EVERY CHECK INSIDE THE BODY, INCLUDING THE
  // PERMISSION ONE. `CommandMiddleware.resume` returns a `succeeded` row's
  // stored `result` verbatim WITHOUT running the body again, and both claims
  // this command uses are keyed on data the caller controls: the outer one on a
  // key the client derives from the target, the inner one on the target itself.
  // So once ANY authorised user files a defect, an UNAUTHORISED user calling on
  // the same target replays that user's stored result — `bug` Ref included —
  // and `runCreate`'s `findOne` never executes.
  //
  // Re-checking here, OUTSIDE the runner, is what closes that: it runs on every
  // path (fresh, replayed, preempted) and always as the CALLER.
  return await withReadableBug(client, outcome)
}

/**
 * Strip a defect the CALLER may not read out of a command outcome.
 *
 * ⚠️ Deliberately does not touch the ledger row. The stored result stays
 * correct for whoever produced it; what changes is what THIS caller is told.
 */
async function withReadableBug (
  client: TxOperations,
  outcome: CommandOutcome<CreateDefectResult>
): Promise<CommandOutcome<CreateDefectResult>> {
  const bug = outcome.result.bug
  if (bug === undefined) {
    return outcome
  }
  const readable = await client.findOne<Issue>(tracker.class.Issue, { _id: bug })
  if (readable !== undefined) {
    return outcome
  }
  return {
    ...outcome,
    result: {
      target: outcome.result.target,
      alreadyReported: true,
      restricted: true
    }
  }
}

/**
 * The role a class plays, restricted to the three the `defect-of` matrix row
 * allows as targets.
 *
 * ⚠️ Read through `traceEndpointRoles`, never off `registry.get()`: a class may
 * carry several roles (Bug and WorkItem are both `tracker.class.Issue`).
 */
function defectTargetKind (endpoints: TraceEndpointRegistry, _class: Ref<Class<Doc>>): DefectTargetKind | undefined {
  const roles = traceEndpointRoles(endpoints, _class)
  for (const role of roles) {
    if (role === 'TestResult' || role === 'TestCase' || role === 'Requirement') {
      return role
    }
  }
  return undefined
}

async function runCreate (
  ctx: MeasureContext<SessionData>,
  client: TxOperations,
  endpoints: TraceEndpointRegistry,
  writeBody: DefectBodyWriter | undefined,
  input: CreateDefectInput
): Promise<CreateDefectResult> {
  const issueId = commandObjectId<Issue>(CREATE_DEFECT_TARGET, input.target, createDefectRoles.issue)

  // ── Step 0: read the target, pinned to the class the caller named. ────────
  const target = await client.findOne<Doc>(input.targetClass, { _id: input.target })
  if (target === undefined) {
    throw new CreateDefectError('target-not-found', `Defect target '${input.target}' does not exist`)
  }

  const kind = defectTargetKind(endpoints, target._class)
  if (kind === undefined) {
    throw new CreateDefectError(
      'target-role-unknown',
      `Class '${target._class}' is not a legal 'defect-of' target (expected TestResult, TestCase or Requirement)`
    )
  }

  // ── Step 0b: has an EARLIER defect already claimed this target? ───────────
  // Answered from the edge, which is the only durable record of the fact.
  const existing = await client.findAll<TraceLink>(traceability.class.TraceLink, {
    docB: target._id,
    kind: 'defect-of',
    state: 'active'
  })
  const foreign = existing.find((link) => link.docA !== issueId)
  if (foreign !== undefined) {
    // 🔴 THE EDGE READ ABOVE IS NOT PERMISSION FILTERED. TraceLink lives in
    // `core.space.Workspace` by design, so `SpaceSecurityMiddleware` lets every
    // member read every edge; only the per-ENDPOINT resolve in
    // `server-traceability-resources` decides what a caller may learn about the
    // objects at its ends. Returning `foreign.docA` unconditionally would hand
    // out the `Ref` of a Bug in a project the caller has no access to — the
    // exact leak that filter exists to close.
    //
    // Re-reading the Issue through the CALLER's client is the check: an
    // unreadable bug comes back `undefined`, and the reply then says only that
    // a defect exists, with no id to follow. That degradation matches the
    // "restricted link" shape the traceability block already renders.
    const readable = await client.findOne<Issue>(tracker.class.Issue, { _id: foreign.docA as Ref<Issue> })
    if (readable === undefined) {
      return {
        target: target._id,
        alreadyReported: true,
        restricted: true
      }
    }
    return {
      target: target._id,
      bug: readable._id,
      traceLink: foreign._id,
      alreadyReported: true,
      restricted: false
    }
  }

  // ── Step 0c: validate BEFORE writing anything. ───────────────────────────
  // Ordering is load bearing: creating the Issue first and only then finding the
  // combination illegal would strand a bug no edge points at.
  const validation = validateTraceLink(endpoints, 'defect-of', tracker.class.Issue, target._class, issueId, target._id)
  if (!validation.valid) {
    throw new CreateDefectError(
      'invalid-trace-link',
      `Trace link Bug --defect-of--> ${kind} rejected: ${validation.reason ?? 'unknown'}`
    )
  }

  // ── Step 1: the Issue (query, then write). ───────────────────────────────
  // ⚠️ The evidence is gathered INSIDE this branch, not before it. A replay that
  // finds the issue already there would otherwise re-read the run, the
  // snapshot, the build, the environment, the executor and the product version
  // only to throw the result away.
  let issue = await client.findOne<Issue>(tracker.class.Issue, { _id: issueId })
  if (issue === undefined) {
    const facts = await gatherFacts(client, kind, target, input.actual)
    const content = buildDefectContent(facts)
    const project = await client.findOne<Project>(tracker.class.Project, { _id: input.project })
    if (project === undefined) {
      throw new CreateDefectError('project-not-found', `Tracker project '${input.project}' does not exist`)
    }
    const taskType = input.taskType ?? (await defaultTaskType(client, project))
    if (taskType === undefined) {
      throw new CreateDefectError(
        'task-type-not-found',
        `Project '${project._id}' has no task type for tracker.class.Issue`
      )
    }

    const status = project.defaultIssueStatus ?? (await firstStatus(client, taskType))
    if (status === undefined) {
      // 🔴 Refuse rather than create an Issue with no status. `Issue.status` is
      // required, and a document written with `undefined` there would render as
      // a blank column in every board and be invisible to every status filter —
      // a defect nobody can find is worse than a refusal somebody can read.
      throw new CreateDefectError(
        'task-type-not-found',
        `Project '${project._id}' has no issue status to file a defect under`
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
      // 🔴 NEVER GUESS THE NUMBER. The obvious fallback — `project.sequence + 1`
      // off the value read before the bump — is what makes two concurrent
      // defects share an `identifier`: both read the same stale sequence and
      // both compute the same successor, and the Issue `_id`s differ (they are
      // derived from the TARGET) so nothing collides to stop them. A refusal is
      // recoverable; two issues called `BUG-42` are not.
      throw new CreateDefectError(
        'sequence-unavailable',
        `Project '${project._id}' did not return its incremented sequence; refusing to guess an issue number`
      )
    }

    // 🔴 THE BLOB IS WRITTEN LAST AMONG THE THINGS THAT CAN STILL REFUSE, and
    // still BEFORE the Issue. Both halves are load bearing:
    //
    // - before the Issue, so the create never publishes a `description` ref to
    //   bytes that are not there yet;
    // - after every `CreateDefectError` above, because a refusal raised AFTER
    //   the bytes had landed would strand them. `writeBody` names a derived key
    //   that only this `issueId` will ever use, so nothing later reclaims it:
    //   the defect is refused, no Issue is ever created to point at it, and the
    //   blob sits in the object store forever. Ordering removes the orphan
    //   outright — there is nothing to clean up, and therefore no cleanup that
    //   can itself fail and turn a clean refusal into a half-broken one.
    //
    // The key is derived, so a replay overwrites rather than accumulating; a
    // crash between the sequence bump and this write burns an issue number,
    // which is the trade already documented on the bump itself.
    const description = `${issueId}-description` as MarkupBlobRef
    let descriptionRef: MarkupBlobRef | null = null
    if (writeBody !== undefined) {
      await writeBody(description, content.markup)
      descriptionRef = description
    }

    const value: AttachedData<Issue> = {
      title: content.title,
      description: descriptionRef,
      assignee: (input.assignee ?? null) as Issue['assignee'],
      component: null,
      milestone: null,
      number,
      priority: IssuePriority.Urgent,
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

    const apply = applyStepFor(client, CREATE_DEFECT, 'issue')
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
      assertCommitted(await apply.commit(), 'create defect issue')
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
        throw new CreateDefectError(
          'issue-id-taken',
          `Derived issue id '${issueId}' is already held by another document`
        )
      }
      throw err
    }
    issue = await client.findOne<Issue>(tracker.class.Issue, { _id: issueId })
    if (issue === undefined) {
      throw new Error(`Issue '${issueId}' vanished immediately after being created`)
    }
  }

  // ── Step 2: the edge (query, then write). ────────────────────────────────
  const linkId = traceLinkId('defect-of', issueId, target._id)
  let link = await client.findOne<TraceLink>(traceability.class.TraceLink, { _id: linkId })
  if (link === undefined) {
    const apply = applyStepFor(client, CREATE_DEFECT, 'trace-link')
    await apply.createDoc<TraceLink>(
      traceability.class.TraceLink,
      core.space.Workspace,
      {
        docA: issueId,
        sourceClass: tracker.class.Issue as Ref<Class<Doc>>,
        docB: target._id,
        targetClass: target._class,
        kind: 'defect-of',
        sourceBaseId: normId(issue),
        targetBaseId: normId(target),
        state: 'active',
        // ⚠️ NO `targetKind` — it used to be written here. It was a pure
        // function of `target._class`, which is the `targetClass` column right
        // above, so it disclosed nothing new; it was still a second copy of an
        // endpoint's shape in the blob, and the pattern is what the next
        // command copies. Recompute it from `targetClass` if it is ever needed.
        metadata: traceLinkMetadata({
          command: CREATE_DEFECT,
          idempotencyKey: input.idempotencyKey
        })
      },
      linkId
    )
    assertCommitted(await apply.commit(), 'create defect-of link')
    link = await client.findOne<TraceLink>(traceability.class.TraceLink, { _id: linkId })
    if (link === undefined) {
      throw new Error(`Trace link '${linkId}' vanished immediately after being created`)
    }
  }

  // ── Step 3 / 4: Activity on BOTH endpoints. ──────────────────────────────
  await ensureTraceActivity(client, CREATE_DEFECT, {
    _id: commandObjectId<DocUpdateMessage>(CREATE_DEFECT_TARGET, input.target, createDefectRoles.targetActivity),
    attachedTo: target._id,
    attachedToClass: target._class,
    space: target.space,
    link: linkId
  })
  await ensureTraceActivity(client, CREATE_DEFECT, {
    _id: commandObjectId<DocUpdateMessage>(CREATE_DEFECT_TARGET, input.target, createDefectRoles.issueActivity),
    attachedTo: issue._id,
    attachedToClass: issue._class,
    space: issue.space,
    link: linkId
  })

  ctx.info('agentra defect raised', {
    target: target._id,
    targetKind: kind,
    bug: issueId,
    traceLink: linkId,
    idempotencyKey: input.idempotencyKey
  })

  return { target: target._id, bug: issueId, traceLink: linkId, alreadyReported: false, restricted: false }
}

/**
 * The sequence value out of a `retrieve: true` update, across both adapters.
 *
 * 🔴 THE TWO ADAPTERS DISAGREE ON THE SHAPE, and neither is wrong.
 * `PostgresAdapterBase.txUpdateDoc` returns `{ object: doc }`
 * (`foundations/server/packages/postgres/src/storage.ts`), while
 * `MongoAdapter.txUpdateDoc` returns the document itself — `res.value` from
 * `findOneAndUpdate` (`foundations/server/packages/mongo/src/storage.ts`).
 * Reading only the Postgres shape means every Mongo deployment silently falls
 * into whatever fallback follows, so the branch that looks like defensive
 * programming is in fact the ONLY branch that ever runs there.
 *
 * A middleware may also hand back an array when the batch was regrouped, hence
 * the first-element unwrap.
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

/**
 * Read the evidence behind the failure.
 *
 * 🔴 SNAPSHOT FIRST. A `TestResult` pins the frozen `TestCaseSnapshot` the
 * verdict was reached against; the live `TestCase` may have been rewritten since.
 * Quoting the live case would put steps into the defect that the run never
 * executed, so the snapshot is read whenever the result names one and the live
 * case is only a fallback (older results predate snapshots entirely).
 */
async function gatherFacts (
  client: TxOperations,
  kind: DefectTargetKind,
  target: Doc,
  actual: string | undefined
): Promise<DefectFacts> {
  const links: DefectFacts['links'] = [{ label: kind, id: target._id, objectClass: target._class }]
  const base: DefectFacts = {
    targetKind: kind,
    target: target._id,
    targetClass: target._class,
    targetTitle: '',
    actual,
    links
  }

  if (kind === 'Requirement') {
    const requirement = target as Requirement
    return { ...base, targetTitle: requirement.title }
  }

  if (kind === 'TestCase') {
    const testCase = target as TestCase
    const { steps, version, snapshotUsed } = await caseSteps(client, testCase)
    return {
      ...base,
      targetTitle: testCase.name,
      caseName: testCase.name,
      caseVersion: version,
      snapshotUsed,
      steps
    }
  }

  const result = target as TestResult
  const facts: DefectFacts = { ...base, targetTitle: result.name }

  const snapshot =
    result.snapshot !== undefined
      ? await client.findOne<TestCaseSnapshot>(testManagement.class.TestCaseSnapshot, { _id: result.snapshot })
      : undefined
  if (snapshot !== undefined) {
    facts.caseName = snapshot.name
    facts.caseVersion = snapshot.version
    facts.snapshotUsed = true
    facts.steps = snapshot.steps.map((step, index) => toDefectStep(step, index))
  } else {
    const testCase = await client.findOne<TestCase>(testManagement.class.TestCase, { _id: result.testCase })
    if (testCase !== undefined) {
      const resolved = await caseSteps(client, testCase)
      facts.caseName = testCase.name
      facts.caseVersion = resolved.version
      facts.snapshotUsed = resolved.snapshotUsed
      facts.steps = resolved.steps
    }
  }
  if (facts.caseName !== undefined) {
    links.push({ label: facts.caseName, id: result.testCase, objectClass: testManagement.class.TestCase })
  }

  // 🔴 Build / Environment / executor / timing live FLAT ON THE RUN, not on the
  // result: `TestRun` carries `build` / `environment` / `executedBy` /
  // `startedOn` / `finishedOn` / `productVersion`. Reading them off the result
  // would silently produce a defect with no execution context at all.
  const run = await client.findOne<TestRun>(testManagement.class.TestRun, { _id: result.attachedTo })
  if (run !== undefined) {
    facts.runName = run.name
    links.push({ label: run.name, id: run._id, objectClass: testManagement.class.TestRun })
    if (run.startedOn !== undefined) facts.startedOn = run.startedOn
    if (run.finishedOn !== undefined) facts.finishedOn = run.finishedOn
    if (run.build !== undefined) {
      const build = await client.findOne<Build>(testManagement.class.Build, { _id: run.build })
      if (build !== undefined) facts.build = build.name
    }
    if (run.environment !== undefined) {
      const environment = await client.findOne<TestEnvironment>(testManagement.class.TestEnvironment, {
        _id: run.environment
      })
      if (environment !== undefined) facts.environment = environment.name
    }
    if (run.productVersion !== undefined) {
      // The VERSION STRING, not the ref: `ProductVersion` has no `name`, its
      // identity is `major.minor.patch` (see `ProductVersionPresenter`). Falls
      // back to the ref when the version is unreadable for this caller.
      const version = await client.findOne<ProductVersion>(products.class.ProductVersion, {
        _id: run.productVersion
      })
      facts.productVersion =
        version !== undefined
          ? `${version.major}.${version.minor}.${version.patch}${
              version.codename !== undefined ? ` (${version.codename})` : ''
            }`
          : run.productVersion
    }
    if (run.executedBy !== undefined) {
      // The NAME, not the ref. A defect body is prose; a 24-char id in the
      // "Executed by" line tells the reader nothing and cannot be looked up
      // once the run is archived. Falls back to the ref only when the person is
      // unreadable for this caller, which keeps the field honest rather than
      // dropping it.
      const employee = await client.findOne<Employee>(contact.mixin.Employee, { _id: run.executedBy })
      facts.executedBy = employee?.name ?? run.executedBy
    }
  }

  return facts
}

function toDefectStep (step: { action: string, testData?: string, expectedResult: string }, index: number): DefectStep {
  return {
    index: index + 1,
    action: step.action,
    testData: step.testData,
    expectedResult: step.expectedResult
  }
}

async function caseSteps (
  client: TxOperations,
  testCase: TestCase
): Promise<{ steps: DefectStep[], version: number | undefined, snapshotUsed: boolean }> {
  // Prefer the newest snapshot: it is the immutable record, and a case that has
  // one has already been pinned by a plan or a run.
  const snapshots = await client.findAll<TestCaseSnapshot>(testManagement.class.TestCaseSnapshot, {
    attachedTo: testCase._id
  })
  const newest = snapshots.sort((a, b) => b.version - a.version)[0]
  if (newest !== undefined) {
    return {
      steps: newest.steps.map((step, index) => toDefectStep(step, index)),
      version: newest.version,
      snapshotUsed: true
    }
  }
  const steps = await client.findAll(testManagement.class.TestStep, { attachedTo: testCase._id })
  return {
    steps: steps.map((step, index) => toDefectStep(step, index)),
    version: testCase.version,
    snapshotUsed: false
  }
}
