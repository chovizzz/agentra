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
import agentraCore, { ARCHIVABLE_CLASSES, type Archivable } from '@hcengineering/agentra-core'
import core, {
  AccountRole,
  hasAccountRole,
  systemAccountUuid,
  type Class,
  type Doc,
  type MeasureContext,
  type PersonId,
  type Ref,
  type SessionData,
  type TxOperations
} from '@hcengineering/core'
import type { Asset, IntlString } from '@hcengineering/platform'
import { type CommandOutcome, type CommandRequest } from '@hcengineering/server-agentra-core'

import { assertCommitted } from '../commandMiddleware'
import { ARCHIVE_TRANSITION_LOCK, archiveAuditId, archiveTransitionKey } from '../deleteGuard'
import type { CommandRunner } from './convertLeadToRequirement'
import { applyStepFor } from './traceCommandSupport'

/**
 * @public
 */
export const ARCHIVE_OBJECT = 'ArchiveObject'

/**
 * @public
 */
export const RESTORE_OBJECT = 'RestoreObject'

/**
 * @public
 */
export type ArchiveIntent = 'archive' | 'restore'

/**
 * The OUTER ledger namespace, bound to BOTH the intent and the target.
 *
 * 🔴 THE COMMAND NAME ALONE IS NOT ENOUGH, AND THIS IS A SECURITY FIX, not a
 * tidiness one. `commandExecutionId` derives the ledger row's `_id` from
 * `(command, idempotencyKey)` and `idempotencyKey` is CALLER SUPPLIED. With a
 * constant command name, presenting object A's succeeded key while naming
 * object B lands on A's ledger row: `CommandMiddleware.resume` returns A's
 * stored result verbatim WITHOUT ever entering the body — so the caller learns
 * A's class, space and archive state having proved only that they can reach B,
 * and is told B was archived when nothing happened. Every inner guard is
 * downstream of that reply and never runs. Folding the target into the
 * namespace makes the two rows different by construction, so a key can only
 * ever replay the object it was used on.
 *
 * ⚠️ THE INTENT IS IN HERE TOO. Archive and restore are different intents over
 * the same object; sharing a namespace would let a restore key replay an
 * archive's result.
 *
 * Same shape as `releaseCommandNamespace(version)`.
 *
 * @public
 */
export function archiveCommandNamespace (intent: ArchiveIntent, target: Ref<Doc>): string {
  return `${intent === 'archive' ? ARCHIVE_OBJECT : RESTORE_OBJECT}:${target}`
}

/**
 * The idempotency key the client derives.
 *
 * 🔴 A PURE FUNCTION OF THE USER'S INTENT — "move THIS object out of / back
 * into generation N" — and of nothing else. No timestamp, no nonce, no caller
 * identity: a retry after a dropped connection has to present the SAME key or
 * the ledger cannot recognise it and the transition runs twice.
 *
 * 🔴 THE GENERATION IS PART OF THE INTENT, NOT AN IMPLEMENTATION DETAIL.
 * Without it, archive -> restore -> archive presents the FIRST archive's key on
 * the third click, `CommandMiddleware` answers it out of the ledger without
 * re-entering the body, and the object stays restored while the caller is told
 * it was archived. The client always has the document it is acting on, so it
 * can always read the generation off it.
 *
 * The `v1` component is a schema marker, not a version counter — bumping it is
 * how a future incompatible result shape gets a fresh ledger namespace instead
 * of replaying results this build cannot read.
 *
 * @public
 */
export function archiveIdempotencyKey (intent: ArchiveIntent, target: Ref<Doc>, fromGeneration: number): string {
  return `agentra-core:${intent}:v1:${target}:${fromGeneration}`
}

/** `agentraCore.string.Archived`, reused as the audit label. */
const ARCHIVE_MESSAGE = 'agentra-core:string:Archived' as IntlString
/** `agentraCore.string.Restore`, reused as the audit label. */
const RESTORE_MESSAGE = 'agentra-core:string:Restore' as IntlString
/** `agentraCore.icon.AgentraCore`. */
const ARCHIVE_ICON = 'agentra-core:icon:AgentraCore' as Asset

/**
 * @public
 */
export interface ArchiveObjectInput {
  target: Ref<Doc>
  targetClass: Ref<Class<Doc>>
  intent: ArchiveIntent
  idempotencyKey: string
  /** Audited verbatim. Optional for archive, ignored for restore. */
  reason?: string
}

/**
 * @public
 */
export interface ArchiveObjectResult extends Record<string, any> {
  target: Ref<Doc>
  archived: boolean
  generation: number
  /** `true` when the object was ALREADY in the requested state. */
  noop: boolean
}

/**
 * @public
 */
export class ArchiveObjectError extends Error {
  readonly code = 400

  constructor (
    readonly reason: 'target-not-found' | 'not-archivable' | 'restore-forbidden' | 'generation-conflict',
    message: string
  ) {
    super(message)
    this.name = 'ArchiveObjectError'
  }
}

/**
 * @public
 */
export interface ArchiveObjectContext {
  ctx: MeasureContext<SessionData>
  /** Must carry the CALLING account, so every read is filtered and every write attributed. */
  client: TxOperations
  runner: CommandRunner
  staleTimeoutMs?: number
}

/**
 * Archive or restore one object, exactly once per `idempotencyKey`.
 *
 * 🔴 REENTRANCY, NOT ATOMICITY. `PostgresAdapter.tx()` groups transactions by
 * domain and commits each group as its own `BEGIN`/`COMMIT`, so the audit
 * record and the mixin write below are two unrelated database transactions. A
 * crash in between leaves the ledger row `running`; once stale another attempt
 * preempts it and re-enters this body. Every step is therefore a `findOne` over
 * a DERIVED `_id` followed by a write. Nothing here calls `generateId()`.
 *
 * 🔴 THE AUDIT RECORD IS WRITTEN BEFORE THE MIXIN, AND THAT ORDER IS LOAD
 * BEARING TWICE OVER. It is the re-entrancy anchor (a replay finds it and skips
 * straight to the flag), and it is half of the evidence
 * {@link ArchivableGuard} demands of the flag write — which arrives at the
 * guard because this command writes through `context.head`, i.e. re-enters the
 * whole middleware chain from the top. Writing the flag first would refuse the
 * command's own write.
 *
 * 🔴 EVERY `commit()` IS ASSERTED. `ApplyTxMiddleware` reports a rejected
 * `TxApplyIf` by RETURNING `{ result: false }`; it does not throw. An unchecked
 * commit would let the runner mark the execution `succeeded` over writes that
 * never landed, and the ledger would replay that phantom forever.
 *
 * @public
 */
export async function archiveObject (
  context: ArchiveObjectContext,
  input: ArchiveObjectInput
): Promise<CommandOutcome<ArchiveObjectResult>> {
  const { ctx, client, runner } = context

  // 🔴 CHECKED BEFORE THE RUNNER, not only inside the body.
  // `CommandMiddleware` replays a `succeeded` row's stored result WITHOUT
  // re-entering the body, and the outer key is caller supplied — so once anyone
  // archives an object, an unauthorised caller naming it would otherwise be
  // handed the stored result: that the object exists, its archive state and its
  // generation. Namespacing the ledger row by target (see
  // {@link archiveCommandNamespace}) stops a key from crossing objects; it does
  // NOT stop a caller who names the right object without being allowed to read
  // it. These are two different holes, and this assert is the second one's fix.
  //
  // ⚠️ A PRE-RUNNER ASSERT rather than post-runner redaction: this result is
  // sensitive end to end (the archive state, the generation and the object's
  // very existence), so stripping it would leave an envelope that still
  // confirms the object exists. Refusing at the door is strictly tighter.
  //
  // The same read happens again inside the body; that is deliberate rather than
  // redundant. This one guards the REPLAY, the one inside guards the write and
  // additionally supplies the document.
  await assertTargetReadable(client, input.targetClass, input.target)

  if (input.intent === 'restore') {
    // SYS-005: "归档对象默认可由管理员恢复". Checked AFTER the readability
    // assert so that a caller who cannot see the object is told it does not
    // exist rather than that they are not an administrator — the latter would
    // confirm the object's existence to someone with no access to it.
    assertAdministrator(ctx, input.target)
  }

  const request: CommandRequest = {
    command: archiveCommandNamespace(input.intent, input.target),
    idempotencyKey: input.idempotencyKey,
    staleTimeoutMs: context.staleTimeoutMs
  }

  return await runner.run<ArchiveObjectResult>(ctx, request, async () => {
    // ── The state read that decides whether anything happens at all. ───────
    const doc = await assertTargetReadable(client, input.targetClass, input.target)
    const current = readArchivable(doc)
    const wantArchived = input.intent === 'archive'
    if (current.archived === wantArchived) {
      // 🔴 NO INNER CLAIM FOR A NO-OP. Taking one would burn the transition
      // lock for a generation nothing is going to write, and the next genuine
      // transition — which derives the SAME lock key — would find a `succeeded`
      // row and replay this empty result instead of running.
      return {
        target: input.target,
        archived: current.archived,
        generation: current.archiveGeneration,
        noop: true
      }
    }

    const generation = current.archiveGeneration + 1
    // ── The INNER claim, keyed on the TRANSITION rather than on the caller's
    // idempotency key. ────────────────────────────────────────────────────
    //
    // 🔴 WHY BOTH. The outer row excludes on `(namespace, idempotencyKey)`,
    // which stops the SAME request running twice and says nothing about two
    // DIFFERENT keys archiving the same object — and `idempotencyKey` is caller
    // supplied. Claiming `(ARCHIVE_TRANSITION_LOCK, '<target>:<generation>')`
    // moves the exclusion onto the TRANSITION, where the ledger table's
    // Postgres primary key can enforce it.
    //
    // 🔴 IT IS ALSO THE EVIDENCE {@link ArchivableGuard} READS. The guard holds
    // a transaction, not a request, so it can never recompute a caller-supplied
    // key; both halves of THIS key are a constant of this codebase plus data
    // the transaction already names, which is what makes it derivable from the
    // guard's side.
    const inner = await runner.run<ArchiveObjectResult>(
      ctx,
      {
        command: ARCHIVE_TRANSITION_LOCK,
        idempotencyKey: archiveTransitionKey(input.target, generation),
        staleTimeoutMs: context.staleTimeoutMs
      },
      async () => await runTransition(ctx, client, input, doc, generation, wantArchived)
    )
    return inner.result
  })
}

/**
 * The target must be readable BY THE CALLER, on every path.
 *
 * ⚠️ `target-not-found` for both "absent" and "invisible", deliberately. A
 * distinct "forbidden" would be an existence oracle over every id a caller
 * cares to guess.
 */
async function assertTargetReadable (client: TxOperations, _class: Ref<Class<Doc>>, target: Ref<Doc>): Promise<Doc> {
  if (!ARCHIVABLE_CLASSES.includes(_class)) {
    throw new ArchiveObjectError('not-archivable', `'${_class}' is not an archivable class`)
  }
  const found = await client.findOne<Doc>(_class, { _id: target })
  if (found === undefined) {
    throw new ArchiveObjectError('target-not-found', `'${target}' does not exist`)
  }
  return found
}

/**
 * Only an administrator restores.
 *
 * The three escapes mirror `SnapshotGuardMiddleware.validateRoleMatrix`: the
 * system account (migration / tool path), an admin-mode session, and
 * `AccountRole.Maintainer` or above — a WORKSPACE role, which is why it can
 * never be expressed as a per-space `Role` document.
 *
 * ⚠️ `contextData === undefined` PASSES, and that is the same deliberate
 * fail-open every guard in this tree has: every pipeline entry point builds a
 * `SessionData`, so a context without one is not a caller at all, and failing
 * closed there would refuse the in-process tool path that has no account.
 */
function assertAdministrator (ctx: MeasureContext<SessionData>, target: Ref<Doc>): void {
  const session = ctx.contextData
  if (session === undefined) return
  if (session.admin === true) return
  const account = session.account
  if (account === undefined) {
    throw new ArchiveObjectError('restore-forbidden', `'${target}' cannot be restored by an unidentified caller`)
  }
  if (account.primarySocialId === core.account.System || account.uuid === systemAccountUuid) return
  if (hasAccountRole(account, AccountRole.Maintainer)) return
  throw new ArchiveObjectError('restore-forbidden', `'${target}' may only be restored by an administrator`)
}

async function runTransition (
  ctx: MeasureContext<SessionData>,
  client: TxOperations,
  input: ArchiveObjectInput,
  seen: Doc,
  generation: number,
  wantArchived: boolean
): Promise<ArchiveObjectResult> {
  // ── Step 0: RE-READ through the caller's filter. ────────────────────────
  // 🔴 QUERY BEFORE WRITE, which is what makes the body reentrant: a preempted
  // attempt that already stamped the mixin re-enters here, finds the state it
  // wanted and returns rather than burning a second generation. The document
  // the outer pass read is stale by the time the inner claim is granted.
  const doc = (await client.findOne<Doc>(input.targetClass, { _id: input.target })) ?? seen
  const current = readArchivable(doc)
  if (current.archived === wantArchived) {
    return {
      target: input.target,
      archived: current.archived,
      generation: current.archiveGeneration,
      noop: true
    }
  }
  if (current.archiveGeneration + 1 !== generation) {
    // Somebody else moved the object between the outer read and this claim.
    // Refused rather than re-derived: the audit record and the guard's evidence
    // are both keyed on `generation`, and silently writing a different one
    // would leave the flag with no matching evidence and be refused downstream
    // anyway — with a far less legible error.
    throw new ArchiveObjectError(
      'generation-conflict',
      `'${input.target}' moved to generation ${current.archiveGeneration} while this transition was being claimed`
    )
  }

  // ── Step 1: the audit record (query, then write). ───────────────────────
  // 🔴 BEFORE THE FLAG. It is the re-entrancy anchor AND half of the evidence
  // `ArchivableGuard` demands of the flag write; writing the flag first would
  // have this command refused by its own guard.
  await ensureAuditRecord(client, doc, input, generation, wantArchived)

  // ── Step 2: the flag itself, as a compare-and-swap. ─────────────────────
  // ⚠️ `match` IS NOT A DATABASE CONDITIONAL UPDATE. It is `ApplyTxMiddleware`
  // doing a read-then-write inside ONE transactor process, and `scopes` is a
  // per-process `Map`. It narrows the window from "the whole command" to
  // "between the match query and the write"; the genuine cross-process
  // exclusion is the ledger claim's primary key (Postgres `23505`).
  const apply = applyStepFor(client, ARCHIVE_OBJECT, 'flag', `${ARCHIVE_TRANSITION_LOCK} ${input.target}`)
  apply.match<Doc>(input.targetClass, { _id: input.target })
  // 🔴 `archivedOn` / `archivedBy` ARE STAMPED ONLY WHEN ARCHIVING, and a
  // restore deliberately leaves the previous pair in place rather than clearing
  // them. They record who archived it and when — an audit fact, exactly like a
  // revoked trace edge surviving an unlink. `archived: false` is what says the
  // object is back.
  const provenance = wantArchived ? { archivedOn: Date.now(), archivedBy: callerPersonId(ctx) } : {}
  await apply.createMixin<Doc, Archivable>(input.target, input.targetClass, doc.space, agentraCore.mixin.Archivable, {
    archived: wantArchived,
    archiveGeneration: generation,
    ...provenance
  })
  assertCommitted(await apply.commit(), `set archive flag on ${input.target}`)

  ctx.info('agentra archivable transition', {
    target: input.target,
    targetClass: input.targetClass,
    archived: wantArchived,
    generation
  })

  return { target: input.target, archived: wantArchived, generation, noop: false }
}

/**
 * The mixin's current state, with absence read as "never archived".
 *
 * 🔴 ABSENCE IS NOT AN ERROR. Documents created after the SYS-005 migration
 * carry no `Archivable` mixin at all; a reader that required the field would
 * refuse to archive every new Lead in the workspace.
 *
 * @public
 */
export function readArchivable (doc: Doc): { archived: boolean, archiveGeneration: number } {
  const raw = (doc as any)[agentraCore.mixin.Archivable]
  const archived = raw?.archived === true
  const generation = typeof raw?.archiveGeneration === 'number' ? raw.archiveGeneration : 0
  return { archived, archiveGeneration: generation }
}

function callerPersonId (ctx: MeasureContext<SessionData>): PersonId {
  return ctx.contextData?.account?.primarySocialId ?? core.account.System
}

async function ensureAuditRecord (
  client: TxOperations,
  doc: Doc,
  input: ArchiveObjectInput,
  generation: number,
  archived: boolean
): Promise<void> {
  const _id = archiveAuditId(input.target, generation) as Ref<ActivityInfoMessage>
  const found = await client.findOne<ActivityInfoMessage>(activity.class.ActivityInfoMessage, { _id })
  if (found !== undefined) {
    return
  }
  const apply = applyStepFor(client, ARCHIVE_OBJECT, 'audit')
  await apply.addCollection<Doc, ActivityInfoMessage>(
    activity.class.ActivityInfoMessage,
    doc.space,
    doc._id,
    input.targetClass,
    'activity',
    {
      message: archived ? ARCHIVE_MESSAGE : RESTORE_MESSAGE,
      icon: ARCHIVE_ICON,
      props: {
        archived,
        generation,
        transitionKey: archiveTransitionKey(input.target, generation),
        ...(input.reason !== undefined ? { reason: input.reason } : {})
      }
    },
    _id
  )
  assertCommitted(await apply.commit(), `record archive audit for ${input.target}`)
}
