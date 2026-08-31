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
import type {
  ApplyOperations,
  Class,
  Doc,
  MeasureContext,
  Mixin,
  Ref,
  SessionData,
  Space,
  Status,
  Timestamp,
  TxOperations
} from '@hcengineering/core'
import type { Asset, IntlString } from '@hcengineering/platform'
import { commandObjectId, type CommandOutcome, type CommandRequest } from '@hcengineering/server-agentra-core'

import { assertCommitted } from '../commandMiddleware'
import type { CommandRunner } from './convertLeadToRequirement'

/**
 * Command name. Also the first component of every derived `_id` this command
 * produces, so it is part of the persisted contract: renaming it re-points all
 * of them and a replay would build a second snapshot record.
 *
 * @public
 */
export const COMPLETE_CYCLE = 'CompleteCycle'

/**
 * The name of the INNER claim, the one keyed on the Cycle rather than on the
 * caller's idempotency key.
 *
 * 🔴 WHY THERE ARE TWO CLAIMS, even though the shipped client derives its key
 * from the cycle anyway. The ledger excludes on `(command, idempotencyKey)`,
 * which stops the SAME request running twice — it says nothing about two
 * DIFFERENT keys completing the same cycle, and `idempotencyKey` is caller
 * supplied: a script, a future UI or a typo can present any string it likes.
 * Claiming `(COMPLETE_CYCLE_LOCK, cycleId)` moves the exclusion onto the CYCLE,
 * where the Postgres primary key can enforce it, and every object this command
 * produces is derived from the CYCLE id so two racing callers converge on the
 * same `_id`s rather than on two snapshots.
 *
 * @public
 */
export const COMPLETE_CYCLE_LOCK = `${COMPLETE_CYCLE}:cycle`

/**
 * Object roles for {@link commandObjectId}. Stable forever, same reason.
 *
 * @public
 */
export const completeCycleRoles = {
  snapshot: 'activity:snapshot'
} as const

// ───────────────────────────────────────────────────────────────────────────
// Wire constants.
//
// 🔴 DECLARED, NOT IMPORTED. `@hcengineering/cycle` and `@hcengineering/tracker`
// are not dependencies of this package, and adding them means a `rush update`
// and a rewritten `pnpm-lock.yaml`. `convertLeadToRequirement` already types its
// `project` as a bare `Ref<Doc>` for exactly this reason, and the two client
// packages copy their wire types the same way.
//
// ⚠️ THE COST, STATED PLAINLY: a rename on the other side does not fail to
// compile here. Every constant below is `plugin()` output, i.e.
// `'<pluginId>:<kind>:<name>'` by construction, and the tests pin the literals.
// Swapping these for real imports is a one-line change per constant once the
// lockfile can be touched.
// ───────────────────────────────────────────────────────────────────────────

/** `cycle.class.Cycle`. */
export const CYCLE_CLASS = 'cycle:class:Cycle' as Ref<Class<Doc>>
/** `cycle.mixin.CycleIssue`. */
export const CYCLE_ISSUE_MIXIN = 'cycle:mixin:CycleIssue' as Ref<Mixin<Doc>>
/**
 * The query key a mixin attribute is stored and queried under.
 *
 * 🔴 A mixin value lives NESTED under the mixin id, never on the bare
 * attribute name. This is the same key `makeFilterQuery`
 * (`plugins/view-resources/src/filter/query-builder.ts`) builds, and querying
 * `{ cycle: ... }` instead would match nothing at all — silently, because
 * `DocumentQuery` is not type checked against a mixin.
 */
export const CYCLE_ISSUE_KEY = `${CYCLE_ISSUE_MIXIN as string}.cycle`
/** `tracker.class.Issue`. */
export const TRACKER_ISSUE_CLASS = 'tracker:class:Issue' as Ref<Class<Doc>>
/** `tracker.class.IssueStatus`. */
export const TRACKER_ISSUE_STATUS_CLASS = 'tracker:class:IssueStatus' as Ref<Class<Status>>
/**
 * The two status categories that mean "this issue is finished".
 *
 * 🔴 `tracker.IssueStatus` extends `core.Status`, whose `category` is what says
 * whether a status is terminal — the status NAME does not, because a project
 * type may rename or add statuses freely. `Won` is "done", `Lost` is
 * "cancelled"; everything else (`UnStarted`, `ToDo`, `Active`) is open work
 * that rollover is about.
 */
export const DONE_STATUS_CATEGORIES: Array<Ref<Doc>> = [
  'task:statusCategory:Won' as Ref<Doc>,
  'task:statusCategory:Lost' as Ref<Doc>
]
/** `cycle.string.CycleCompletedActivity`. */
export const CYCLE_COMPLETED_MESSAGE = 'cycle:string:CycleCompletedActivity' as IntlString
/** `cycle.icon.Cycle`. */
export const CYCLE_ICON = 'cycle:icon:Cycle' as Asset

/**
 * The cycle status vocabulary, restated.
 *
 * 🔴 THIS IS A COPY OF `plugins/cycle/src/types.ts` AND IT CAN DRIFT. It is
 * here only because this package may not depend on `@hcengineering/cycle`
 * without rewriting the lockfile (see the wire-constant note above). The copy
 * is deliberately MINIMAL — just the terminal-ness question this command asks —
 * so that there is as little as possible to keep in sync, and the tests pin
 * both halves. Replacing it with `import { canTransitionCycle } from
 * '@hcengineering/cycle'` is the intended end state.
 */
export type CycleStatusWire = 'planned' | 'active' | 'completed' | 'cancelled'

/** The statuses a cycle may legally be completed FROM. */
export const COMPLETABLE_FROM: CycleStatusWire[] = ['planned', 'active']

/** `completed` and `cancelled` are terminal — nothing may roll INTO them. */
export const TERMINAL_STATUSES: CycleStatusWire[] = ['completed', 'cancelled']

/** The complement, as a query value for the per-write target guard. */
export const NON_TERMINAL_STATUSES: CycleStatusWire[] = ['planned', 'active']

/**
 * What `CompleteCycle` does with the issues still open when the cycle closes.
 * Mirrors `CycleRolloverPolicy` in `plugins/cycle/src/types.ts`.
 *
 * @public
 */
export type CycleRolloverPolicyWire = 'keep' | 'backlog' | 'move'

/** The minimum of `Cycle` this command reads. */
interface CycleDoc extends Doc {
  space: Ref<Space>
  name: string
  status: CycleStatusWire
  sequence: number
  startDate: Timestamp
}

/** The minimum of `Issue` this command reads. */
interface IssueDoc extends Doc {
  space: Ref<Space>
  status: Ref<Status>
}

/**
 * @public
 */
export interface CompleteCycleInput {
  cycle: Ref<Doc>
  idempotencyKey: string
  rolloverPolicy: CycleRolloverPolicyWire
  /** Required iff `rolloverPolicy === 'move'`. */
  rolloverTarget?: Ref<Doc>
}

/**
 * The statistics snapshot Technical Spec §4 asks for.
 *
 * 🔴 NOT STORED ON THE CYCLE. §3.4 forbids hand-maintained velocity / burndown
 * / rollover fields: "速度、燃尽和滚动数据从 Activity/Issue 快照计算，不以手工字段
 * 作为事实来源". Its homes are the Cycle's own Activity timeline (which is
 * exactly the source §3.4 names) and the command ledger row, both of which are
 * append-only records rather than a second mutable source of truth.
 *
 * @public
 */
export interface CompleteCycleSnapshot extends Record<string, any> {
  /** Issues carrying `CycleIssue.cycle = <this cycle>` when the pass started. */
  total: number
  /** Of those, the ones whose status category is `Won` or `Lost`. */
  done: number
  /** The rest. */
  open: number
  /** How many of `open` this completion moved out. `0` under `keep`. */
  rolledOver: number
}

/**
 * @public
 */
export interface CompleteCycleResult extends Record<string, any> {
  cycle: Ref<Doc>
  rolloverPolicy: CycleRolloverPolicyWire
  rolloverTarget?: Ref<Doc>
  snapshot: CompleteCycleSnapshot
  /**
   * `true` when the cycle was ALREADY `completed` when this attempt read it,
   * rather than being completed by it.
   *
   * ⚠️ Distinct from `CommandOutcome.replayed`, which means "same idempotency
   * key, result served from the ledger". This flag is about the CYCLE, under
   * any key.
   */
  alreadyCompleted: boolean
}

/**
 * The rollover decision this completion is actually carrying out.
 *
 * 🔴 IT IS PINNED ON THE FIRST PASS AND REPLAYED THEREAFTER. The caller's
 * `rolloverPolicy` / `rolloverTarget` are only consulted when no snapshot
 * record exists yet; from then on the PERSISTED plan wins, whatever the request
 * says. Without that, a first attempt that moved half the issues into cycle A
 * and then crashed could be retried — legitimately, since `CommandRunner` treats
 * a `failed` row as retryable — with target B, and the cycle's leftovers would
 * end up split across two cycles with nothing recording that it happened.
 *
 * @public
 */
export interface CompleteCyclePlan {
  policy: CycleRolloverPolicyWire
  target?: Ref<Doc>
}

/**
 * @public
 */
export interface CompleteCycleContext {
  ctx: MeasureContext<SessionData>
  /** Must carry the CALLING account, so every write is attributed and secured. */
  client: TxOperations
  runner: CommandRunner
  /** Overrides the runner's default stale-claim timeout. */
  staleTimeoutMs?: number
}

/**
 * Raised for the input-level refusals, so a caller can tell "you asked for
 * something impossible" apart from "the write failed".
 *
 * @public
 */
export class CompleteCycleError extends Error {
  readonly code = 400

  constructor (
    readonly reason: 'cycle-not-found' | 'illegal-transition' | 'rollover-target-required' | 'rollover-target-invalid',
    message: string
  ) {
    super(message)
    this.name = 'CompleteCycleError'
  }
}

/**
 * Complete a cycle, exactly once per `idempotencyKey`.
 *
 * 🔴 REENTRANCY, NOT ATOMICITY. `PostgresAdapter.tx()` groups transactions by
 * domain and each group lands as its own `BEGIN`/`COMMIT`, so the snapshot
 * record, the N mixin updates and the status change below are many unrelated
 * database transactions. A crash in the middle leaves the ledger row `running`;
 * once it goes stale another attempt preempts it and re-enters this body, which
 * is why EVERY step is a `findOne`-then-write over a DERIVED `_id` or a
 * per-issue "is it already there?" check. Nothing here may use `generateId()`.
 *
 * 🔴 THE SNAPSHOT IS WRITTEN BEFORE THE ROLLOVER, AND THAT ORDER IS THE WHOLE
 * TRICK. `total` / `done` / `open` are only measurable while the issues are
 * still IN the cycle; once `backlog` or `move` has emptied it they are gone,
 * and a re-entry that recomputed them would report a smaller cycle than the one
 * that was actually closed. Persisting the counts first — under a derived id,
 * so the second pass finds the first pass's record instead of writing another —
 * makes the reported numbers identical across every replay.
 *
 * 🔴 EVERY `commit()` IS ASSERTED. `ApplyTxMiddleware` reports a rejected
 * `TxApplyIf` by RETURNING `{ result: false }`; it does not throw. An unchecked
 * commit would let the runner mark the execution `succeeded` over writes that
 * never landed, and the ledger would then replay that phantom result forever.
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
export function completeCycleCommandNamespace (cycle: Ref<Doc>): string {
  return `${COMPLETE_CYCLE}:${cycle}`
}

export async function completeCycle (
  context: CompleteCycleContext,
  input: CompleteCycleInput
): Promise<CommandOutcome<CompleteCycleResult>> {
  const { ctx, client, runner } = context
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
    command: completeCycleCommandNamespace(input.cycle),
    idempotencyKey: input.idempotencyKey,
    staleTimeoutMs: context.staleTimeoutMs
  }

  // 🔴 CHECKED BEFORE THE RUNNER, not only inside the body. `CommandMiddleware`
  // replays a `succeeded` row's stored result WITHOUT re-entering the body, and
  // BOTH claims are keyed on data the caller supplies — the outer key is a pure
  // function of the cycle id, the inner one IS the cycle id. So once anyone
  // completes a cycle, an unauthorised caller naming it would otherwise be
  // handed the stored result: the issue counts, the rollover target, and the
  // fact that the cycle exists at all. Re-reading here makes the replayed path
  // answer exactly like the fresh one.
  //
  // The same read happens again inside the body; that is deliberate rather than
  // redundant. This one guards the REPLAY, the one inside guards the write and
  // additionally supplies the document.
  await assertCycleReadable(client, input.cycle)

  return await runner.run<CompleteCycleResult>(ctx, request, async () => {
    // Inner claim, keyed on the Cycle. Four outcomes, all of them correct:
    //  - free       -> run the body;
    //  - succeeded  -> replay the ORIGINAL completion without writing anything;
    //  - running    -> `CommandInProgressError` (409) rather than a silent
    //                  success;
    //  - failed / stale -> preempted, and the body re-enters to finish a
    //                  completion an earlier key abandoned half done.
    const inner = await runner.run<CompleteCycleResult>(
      ctx,
      { command: COMPLETE_CYCLE_LOCK, idempotencyKey: input.cycle, staleTimeoutMs: context.staleTimeoutMs },
      async () => await runCompletion(ctx, client, input)
    )
    return { ...inner.result, alreadyCompleted: inner.result.alreadyCompleted || inner.replayed }
  })
}

/**
 * The cycle must be readable BY THE CALLER, on every path.
 */
async function assertCycleReadable (client: TxOperations, cycle: Ref<Doc>): Promise<void> {
  const found = await client.findOne<CycleDoc>(CYCLE_CLASS as Ref<any>, { _id: cycle as Ref<CycleDoc> })
  if (found === undefined) {
    throw new CompleteCycleError('cycle-not-found', `Cycle '${cycle}' does not exist`)
  }
}

async function runCompletion (
  ctx: MeasureContext<SessionData>,
  client: TxOperations,
  input: CompleteCycleInput
): Promise<CompleteCycleResult> {
  // ── Step 0: read the Cycle. ───────────────────────────────────────────────
  const cycle = await client.findOne<CycleDoc>(CYCLE_CLASS as Ref<any>, { _id: input.cycle as Ref<CycleDoc> })
  if (cycle === undefined) {
    throw new CompleteCycleError('cycle-not-found', `Cycle '${input.cycle}' does not exist`)
  }
  const alreadyCompleted = cycle.status === 'completed'

  // ── Step 0b: validate BEFORE writing anything. ───────────────────────────
  // Ordering is load bearing. Rolling the issues out first and only then
  // discovering that the cycle cannot be completed would leave an OPEN cycle
  // that had been emptied — the worst of both states, and nothing would ever
  // put it back.
  if (!alreadyCompleted && !COMPLETABLE_FROM.includes(cycle.status)) {
    throw new CompleteCycleError(
      'illegal-transition',
      `Cycle '${cycle._id}' cannot be completed from status '${cycle.status}'`
    )
  }

  // ── Step 0c: the plan. THE PERSISTED ONE WINS. ───────────────────────────
  // 🔴 An earlier pass may already have moved issues under a plan of its own;
  // honouring a different one now would split this cycle's leftovers across two
  // destinations. See {@link CompleteCyclePlan}.
  const record = await findSnapshotRecord(client, cycle)
  const plan: CompleteCyclePlan =
    record !== undefined
      ? (readPlan(record.props) ?? { policy: input.rolloverPolicy, target: input.rolloverTarget })
      : { policy: input.rolloverPolicy, target: input.rolloverTarget }

  // ⚠️ The pinned target is re-validated on EVERY pass, so a completion whose
  // target was deleted mid-flight refuses instead of writing dangling refs. It
  // does mean such a completion stays wedged until someone restores or replaces
  // the target — which is the safe direction: the alternative is diverting
  // issues somewhere the first pass never chose.
  const target = await resolveRolloverTarget(client, cycle, plan)

  // ── Step 1: the roster, classified. ──────────────────────────────────────
  const issues = await client.findAll<IssueDoc>(TRACKER_ISSUE_CLASS as Ref<any>, { [CYCLE_ISSUE_KEY]: cycle._id })
  const doneIds = await findDoneIssues(client, issues)
  const open = issues.filter((it) => !doneIds.has(it._id))

  // ── Step 2: the snapshot record (query, then write). ─────────────────────
  // 🔴 Before the rollover. See the header.
  const snapshot = await ensureSnapshot(client, cycle, plan, record, {
    total: issues.length,
    done: issues.length - open.length,
    open: open.length,
    // Deterministic from the policy rather than counted afterwards: `keep`
    // moves nothing, the other two move every open issue. Counting the writes
    // instead would report 0 on a re-entry that found the work already done.
    rolledOver: plan.policy === 'keep' ? 0 : open.length
  })

  // ── Step 3: the rollover, ISSUE BY ISSUE. ────────────────────────────────
  // §4: "rollover 按 Issue 逐个判定，已滚动的不重复滚动". The roster query above
  // only returns issues still pointing at THIS cycle, so an issue an earlier
  // pass already moved is not in it and cannot be moved twice.
  if (plan.policy !== 'keep') {
    const destination = plan.policy === 'backlog' ? null : (target as Ref<Doc>)
    for (const issue of open) {
      await rolloverIssue(client, issue, cycle._id, destination)
    }
  }

  // ── Step 4: the Cycle status (compare-and-swap, not a blind write). ──────
  // 🔴 The `status` read at Step 0 is stale by the time we get here — up to N
  // issue writes happened in between. A bare `updateDoc` would happily stamp
  // `completed` over a `cancelled` someone set meanwhile. `match` makes
  // `ApplyTxMiddleware.verifyApplyIf` re-read the cycle immediately before
  // applying and refuse the whole `TxApplyIf` if the status moved, which
  // `assertCommitted` then surfaces as a failure the replay can redo.
  //
  // ⚠️ THIS IS NOT A DATABASE-LEVEL CONDITIONAL UPDATE. `verifyApplyIf` is
  // read-then-write inside the transactor, and the `scopes` map it serialises
  // on is a per-PROCESS `Map` — a second transactor replica does not see it. It
  // closes the window from "the whole command" down to "between the match query
  // and the write", which is the strongest guarantee this platform offers a
  // plugin; the genuine cross-process exclusion is the ledger claim above,
  // whose `_id` is enforced by the Postgres primary key.
  if (!alreadyCompleted) {
    const apply = applyStep(client, 'cycle-status', `${COMPLETE_CYCLE_LOCK} ${cycle._id}`)
    apply.match<CycleDoc>(CYCLE_CLASS as Ref<any>, { _id: cycle._id, status: cycle.status })
    await apply.updateDoc<CycleDoc>(CYCLE_CLASS as Ref<any>, cycle.space, cycle._id, { status: 'completed' })
    assertCommitted(await apply.commit(), 'set cycle status to completed')
  }

  ctx.info('agentra cycle completed', {
    cycle: cycle._id,
    rolloverPolicy: plan.policy,
    rolloverTarget: target,
    ...snapshot
  })

  return {
    cycle: cycle._id,
    // The plan that was CARRIED OUT, which on a replay is the pinned one rather
    // than the one this request asked for.
    rolloverPolicy: plan.policy,
    ...(target !== undefined ? { rolloverTarget: target } : {}),
    snapshot,
    alreadyCompleted
  }
}

/**
 * Validate the destination of a `move`.
 *
 * 🔴 THE SERVER DOES NOT PICK "THE NEXT CYCLE". `nextCycleAfter`
 * (`plugins/cycle/src/types.ts`) runs on the CLIENT and the resolved id travels
 * in the request; this function only says yes or no. Resolving it here would
 * make the command non-deterministic across re-entries — a cycle created
 * between a crashed attempt and its replay would change the answer, and the two
 * halves of one rollover would land in different cycles.
 *
 * 🔴 EVERY REJECTION IS A REFUSAL, NEVER A FALLBACK. Silently downgrading an
 * invalid target to `backlog` (or to `keep`) would move issues somewhere the
 * caller did not ask for, and the caller would be told the completion
 * succeeded. Losing track of unfinished work is the one failure this command
 * exists to prevent.
 */
async function resolveRolloverTarget (
  client: TxOperations,
  cycle: CycleDoc,
  plan: CompleteCyclePlan
): Promise<Ref<Doc> | undefined> {
  if (plan.policy !== 'move') {
    return undefined
  }
  if (plan.target === undefined || plan.target === null) {
    throw new CompleteCycleError('rollover-target-required', "rolloverPolicy 'move' requires `rolloverTarget`")
  }
  if (plan.target === cycle._id) {
    throw new CompleteCycleError('rollover-target-invalid', 'A cycle cannot roll over into itself')
  }
  const target = await client.findOne<CycleDoc>(CYCLE_CLASS as Ref<any>, {
    _id: plan.target as Ref<CycleDoc>
  })
  if (target === undefined) {
    throw new CompleteCycleError('rollover-target-invalid', `Cycle '${plan.target}' does not exist`)
  }
  if (target.space !== cycle.space) {
    // A Cycle's space IS the tracker Project (§3.4), so a cross-space target
    // would move issues into another project's cycle while leaving them in
    // their own project — a membership the UI can never show.
    throw new CompleteCycleError('rollover-target-invalid', `Cycle '${target._id}' belongs to another project`)
  }
  if (TERMINAL_STATUSES.includes(target.status)) {
    // Rolling unfinished work into a cycle that is itself closed hides the
    // work instead of rescheduling it.
    throw new CompleteCycleError(
      'rollover-target-invalid',
      `Cycle '${target._id}' is '${target.status}' and cannot receive rolled over issues`
    )
  }
  return target._id
}

/**
 * Which of these issues are finished?
 *
 * ⚠️ Answered from the status CATEGORY, never from the status name or from a
 * hard-coded list of ids: a tracker project type may rename its statuses and
 * add its own, and only `Status.category` survives that.
 *
 * ⚠️ An issue whose status document cannot be read counts as OPEN. Guessing
 * "done" would silently drop it from the rollover, which is the one direction
 * this command must never fail in.
 */
async function findDoneIssues (client: TxOperations, issues: IssueDoc[]): Promise<Set<Ref<Doc>>> {
  const done = new Set<Ref<Doc>>()
  if (issues.length === 0) {
    return done
  }
  const statusIds = [...new Set(issues.map((it) => it.status))]
  const statuses = await client.findAll<Status>(TRACKER_ISSUE_STATUS_CLASS as Ref<any>, {
    _id: { $in: statusIds }
  })
  const doneStatuses = new Set(
    statuses
      .filter((it) => it.category !== undefined && DONE_STATUS_CATEGORIES.includes(it.category))
      .map((it) => it._id)
  )
  for (const issue of issues) {
    if (doneStatuses.has(issue.status)) {
      done.add(issue._id)
    }
  }
  return done
}

/**
 * The snapshot as an `ActivityInfoMessage` on the Cycle (query, then write).
 *
 * 🔴 IT IS THE RE-ENTRANCY ANCHOR, not decoration. The counts it carries are
 * only measurable before the rollover empties the cycle, so a second pass reads
 * them back from here instead of recomputing a smaller cycle. Derived `_id`, so
 * two passes — and two racing callers — converge on ONE record.
 *
 * ⚠️ An `ActivityInfoMessage` rather than the `DocUpdateMessage` that
 * `convertLeadToRequirement` uses, because this one has to CARRY DATA: `props`
 * is what makes the numbers readable back. The `IntlString` it needs is served
 * from `cycle-assets`, which is why the message id is a wire constant here.
 *
 * ⚠️ Also the §3.4 artifact: velocity and burndown are supposed to be computed
 * from the Activity timeline, and this is the entry that puts a cycle's closing
 * numbers into it.
 */
export function snapshotRecordId (cycle: Ref<Doc>): Ref<ActivityInfoMessage> {
  return commandObjectId<ActivityInfoMessage>(COMPLETE_CYCLE_LOCK, cycle, completeCycleRoles.snapshot)
}

async function findSnapshotRecord (client: TxOperations, cycle: CycleDoc): Promise<ActivityInfoMessage | undefined> {
  return await client.findOne<ActivityInfoMessage>(activity.class.ActivityInfoMessage, {
    _id: snapshotRecordId(cycle._id)
  })
}

async function ensureSnapshot (
  client: TxOperations,
  cycle: CycleDoc,
  plan: CompleteCyclePlan,
  found: ActivityInfoMessage | undefined,
  computed: CompleteCycleSnapshot
): Promise<CompleteCycleSnapshot> {
  if (found !== undefined) {
    return readSnapshot(found.props) ?? computed
  }
  const apply = applyStep(client, 'snapshot')
  await apply.addCollection<Doc, ActivityInfoMessage>(
    activity.class.ActivityInfoMessage,
    cycle.space,
    cycle._id,
    CYCLE_CLASS,
    'activity',
    {
      message: CYCLE_COMPLETED_MESSAGE,
      icon: CYCLE_ICON,
      // 🔴 The PLAN is persisted alongside the counts, not just the policy: it
      // is what a later pass replays instead of trusting its own request.
      props: {
        ...computed,
        rolloverPolicy: plan.policy,
        ...(plan.target !== undefined ? { rolloverTarget: plan.target } : {})
      }
    },
    snapshotRecordId(cycle._id)
  )
  assertCommitted(await apply.commit(), 'record cycle completion snapshot')
  return computed
}

/**
 * Read back the pinned plan. `undefined` when the record predates plan pinning
 * or carries something this build cannot read — in which case the caller falls
 * back to the request, which is the old behaviour rather than a crash.
 */
function readPlan (props: Record<string, any> | undefined): CompleteCyclePlan | undefined {
  if (props === undefined) return undefined
  const policy = props.rolloverPolicy
  if (policy !== 'keep' && policy !== 'backlog' && policy !== 'move') {
    return undefined
  }
  const target = props.rolloverTarget
  return { policy, ...(typeof target === 'string' ? { target: target as Ref<Doc> } : {}) }
}

function readSnapshot (props: Record<string, any> | undefined): CompleteCycleSnapshot | undefined {
  if (props === undefined) return undefined
  const { total, done, open, rolledOver } = props
  if (
    typeof total !== 'number' ||
    typeof done !== 'number' ||
    typeof open !== 'number' ||
    typeof rolledOver !== 'number'
  ) {
    return undefined
  }
  return { total, done, open, rolledOver }
}

/**
 * Move ONE issue out of the closing cycle.
 *
 * 🔴 GUARDED, not a blind mixin write. `match` pins the issue to the cycle it
 * was read in, so an issue somebody re-filed between the roster query and this
 * write is NOT dragged along; the apply comes back `success: false`,
 * `assertCommitted` turns that into a failure, and the replay re-reads a roster
 * that no longer contains it. Failing loudly and converging on retry is the
 * only outcome here that cannot lose an issue.
 *
 * ⚠️ Same caveat as the status write: `verifyApplyIf` is read-then-write inside
 * one transactor, not a database conditional update. It shrinks the race
 * window, it does not eliminate it.
 *
 * ⚠️ `updateMixin`, not `updateDoc`: `CycleIssue.cycle` lives NESTED under the
 * mixin id in the Issue row, and a `TxUpdateDoc` would write a bare `cycle`
 * field that nothing reads.
 */
async function rolloverIssue (
  client: TxOperations,
  issue: IssueDoc,
  from: Ref<Doc>,
  to: Ref<Doc> | null
): Promise<void> {
  const apply = applyStep(client, 'rollover', `${COMPLETE_CYCLE_LOCK} ${issue._id}`)
  apply.match<Doc>(TRACKER_ISSUE_CLASS as Ref<any>, { _id: issue._id, [CYCLE_ISSUE_KEY]: from })
  if (to !== null) {
    // 🔴 THE TARGET IS RE-CHECKED ON EVERY SINGLE WRITE, not once up front.
    // `resolveRolloverTarget` runs before the roster is even read, and a cycle
    // can be deleted or closed in between; without this clause the issue would
    // be stamped with a `Ref` to a cycle that no longer exists — leaving it in
    // neither the old cycle, nor a live target, nor the backlog, which is the
    // one outcome this command must never produce.
    apply.match<Doc>(CYCLE_CLASS as Ref<any>, { _id: to, status: { $in: NON_TERMINAL_STATUSES } })
  }
  await apply.updateMixin<Doc, Doc>(issue._id, TRACKER_ISSUE_CLASS, issue.space, CYCLE_ISSUE_MIXIN, {
    cycle: to
  } as any)
  assertCommitted(await apply.commit(), `roll issue ${issue._id} over`)
}

/**
 * Open an apply block for one command step.
 *
 * 🔴 See the twin helper in `convertLeadToRequirement.ts` for the full note on
 * what `assertCommitted` can and cannot see. The short version: the measure
 * name is what stops `ApplyOperations.commit()` taking its single-transaction
 * fast path (which returns a hard-coded `{ result: true }`), and a `scope` plus
 * a `match` clause is what lets `ApplyTxMiddleware` return `success: false` at
 * all. The two steps that can genuinely be refused — the per-issue rollover and
 * the cycle status CAS — supply both.
 */
function applyStep (client: TxOperations, step: string, scope?: string): ApplyOperations {
  return client.apply(scope, `${COMPLETE_CYCLE}:${step}`)
}
