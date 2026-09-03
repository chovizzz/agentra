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
import agentraCore, { ARCHIVABLE_LEAD, ARCHIVABLE_REQUIREMENT } from '@hcengineering/agentra-core'
import core, {
  AccountRole,
  type Class,
  type Doc,
  type MeasureContext,
  type Ref,
  type SessionData
} from '@hcengineering/core'
import { commandExecutionId } from '@hcengineering/server-agentra-core'
import traceability, { type TraceLink } from '@hcengineering/traceability'

import {
  ARCHIVE_OBJECT,
  ArchiveObjectError,
  archiveCommandNamespace,
  archiveIdempotencyKey,
  archiveObject,
  readArchivable,
  type ArchiveObjectResult
} from '../commands/archive'
import { ARCHIVE_TRANSITION_LOCK, archiveAuditId, archiveTransitionKey } from '../deleteGuard'
import { MemoryDb, makeHarness, seed, type Harness } from './harness'

const SPACE = 'space-1' as Ref<any>
const LEAD = 'leadleadleadleadleadlea1' as Ref<Doc>
const LEAD2 = 'leadleadleadleadleadlea2' as Ref<Doc>
const REQ = 'reqreqreqreqreqreqreqre1' as Ref<Doc>
const MIXIN = agentraCore.mixin.Archivable

let h: Harness
beforeEach(async () => {
  h = await makeHarness()
})

function seedLead (db: MemoryDb, _id: Ref<Doc> = LEAD, archived?: { generation: number }): void {
  seed(db, {
    _id: _id as Ref<any>,
    _class: ARCHIVABLE_LEAD,
    space: SPACE,
    title: 'a lead',
    ...(archived !== undefined
      ? { [MIXIN]: { archived: true, archiveGeneration: archived.generation, archivedOn: 1, archivedBy: 'someone' } }
      : {})
  } as any)
}

function seedLink (db: MemoryDb, _id: string, from: Ref<Doc>, to: Ref<Doc>): void {
  seed<TraceLink>(db, {
    _id: _id as Ref<any>,
    _class: traceability.class.TraceLink,
    space: SPACE,
    docA: from,
    docB: to,
    kind: 'converted-to',
    state: 'active'
  } as any)
}

function stateOf (db: MemoryDb, _id: Ref<Doc>): { archived: boolean, archiveGeneration: number } {
  return readArchivable(db.docs.get(_id) as Doc)
}

/** A session for a plain member: readable, but not an administrator. */
function memberCtx (): MeasureContext<SessionData> {
  const ctx = h.ctx as any
  return {
    ...ctx,
    contextData: { account: { uuid: 'member-1', primarySocialId: 'member-social', role: AccountRole.User } }
  }
}

async function archive (
  target: Ref<Doc> = LEAD,
  ctx: MeasureContext<SessionData> = h.ctx,
  from = 0
): Promise<ArchiveObjectResult> {
  const outcome = await archiveObject(
    { ctx, client: h.client, runner: h.runner },
    {
      target,
      targetClass: ARCHIVABLE_LEAD,
      intent: 'archive',
      idempotencyKey: archiveIdempotencyKey('archive', target, from)
    }
  )
  return outcome.result
}

async function restore (
  target: Ref<Doc> = LEAD,
  ctx: MeasureContext<SessionData> = h.ctx,
  from = 1
): Promise<ArchiveObjectResult> {
  const outcome = await archiveObject(
    { ctx, client: h.client, runner: h.runner },
    {
      target,
      targetClass: ARCHIVABLE_LEAD,
      intent: 'restore',
      idempotencyKey: archiveIdempotencyKey('restore', target, from)
    }
  )
  return outcome.result
}

describe('archive: the happy path', () => {
  it('stamps the mixin, bumps the generation and writes one audit record', async () => {
    seedLead(h.db)
    const result = await archive()
    expect(result).toMatchObject({ target: LEAD, archived: true, generation: 1, noop: false })
    expect(stateOf(h.db, LEAD)).toEqual({ archived: true, archiveGeneration: 1 })
    const record = h.db.docs.get(archiveAuditId(LEAD, 1)) as ActivityInfoMessage
    expect(record).toBeDefined()
    expect(record.props).toMatchObject({ archived: true, generation: 1 })
  })

  it('records the caller as `archivedBy` and leaves those fields alone on restore', async () => {
    seedLead(h.db)
    await archive()
    const archived = h.db.docs.get(LEAD) as any
    expect(archived[MIXIN].archivedBy).toBe(core.account.System)
    expect(typeof archived[MIXIN].archivedOn).toBe('number')

    await restore()
    const restored = h.db.docs.get(LEAD) as any
    expect(restored[MIXIN].archived).toBe(false)
    // 🔴 The archival provenance SURVIVES the restore — it is an audit fact,
    // exactly like a revoked trace edge survives an unlink. `archived: false`
    // is what says the object is back.
    expect(restored[MIXIN].archivedBy).toBe(core.account.System)
    expect(typeof restored[MIXIN].archivedOn).toBe('number')
  })

  it('reports a no-op instead of burning a generation when already archived', async () => {
    seedLead(h.db, LEAD, { generation: 1 })
    const result = await archive(LEAD, h.ctx, 1)
    expect(result).toMatchObject({ archived: true, generation: 1, noop: true })
    // 🔴 NO INNER CLAIM AND NO AUDIT RECORD FOR A NO-OP: claiming the
    // transition lock for a generation nothing writes would make the next
    // genuine transition replay this empty result instead of running.
    expect(h.db.docs.get(archiveAuditId(LEAD, 2))).toBeUndefined()
    expect(h.db.find(activity.class.ActivityInfoMessage, {})).toHaveLength(0)
  })

  it('survives an archive -> restore -> archive cycle', async () => {
    seedLead(h.db)
    expect((await archive(LEAD, h.ctx, 0)).generation).toBe(1)
    expect((await restore(LEAD, h.ctx, 1)).generation).toBe(2)
    expect((await archive(LEAD, h.ctx, 2)).generation).toBe(3)
    expect(stateOf(h.db, LEAD)).toEqual({ archived: true, archiveGeneration: 3 })
    // Three distinct audit records; nothing overwrote anything.
    expect(h.db.find(activity.class.ActivityInfoMessage, {})).toHaveLength(3)
  })

  it('refuses a class that is not archivable', async () => {
    seed(h.db, { _id: REQ as Ref<any>, _class: ARCHIVABLE_REQUIREMENT, space: SPACE } as any)
    await expect(
      archiveObject(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        {
          target: REQ,
          targetClass: 'some:other:Class' as Ref<Class<Doc>>,
          intent: 'archive',
          idempotencyKey: 'k'
        }
      )
    ).rejects.toMatchObject({ reason: 'not-archivable' })
  })
})

describe('idempotency (铁律 ③): the key is a pure function of the intent', () => {
  it('replays instead of writing twice', async () => {
    seedLead(h.db)
    const first = await archiveObject(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      {
        target: LEAD,
        targetClass: ARCHIVABLE_LEAD,
        intent: 'archive',
        idempotencyKey: archiveIdempotencyKey('archive', LEAD, 0)
      }
    )
    const second = await archiveObject(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      {
        target: LEAD,
        targetClass: ARCHIVABLE_LEAD,
        intent: 'archive',
        idempotencyKey: archiveIdempotencyKey('archive', LEAD, 0)
      }
    )
    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.result).toEqual(first.result)
    expect(h.db.find(activity.class.ActivityInfoMessage, {})).toHaveLength(1)
    expect(stateOf(h.db, LEAD).archiveGeneration).toBe(1)
  })

  it('is REENTRANT: a body re-entered after a partial write finishes cleanly', async () => {
    seedLead(h.db)
    // Simulate an attempt that wrote the audit record and then died before the
    // flag. Re-entering must find the record (derived `_id`) and NOT write a
    // second one, then finish the flag.
    seed(h.db, {
      _id: archiveAuditId(LEAD, 1) as Ref<any>,
      _class: activity.class.ActivityInfoMessage,
      space: SPACE,
      props: { archived: true, generation: 1 }
    } as any)
    const result = await archive()
    expect(result).toMatchObject({ archived: true, generation: 1, noop: false })
    expect(h.db.find(activity.class.ActivityInfoMessage, {})).toHaveLength(1)
  })

  it('derives every id — `generateId` is never called for a produced object', () => {
    // Both derivations are pure functions of `(target, generation)`, so two
    // racing callers converge on ONE audit record and ONE claim.
    expect(archiveAuditId(LEAD, 1)).toBe(archiveAuditId(LEAD, 1))
    expect(archiveAuditId(LEAD, 1)).not.toBe(archiveAuditId(LEAD, 2))
    expect(archiveAuditId(LEAD, 1)).not.toBe(archiveAuditId(LEAD2, 1))
    expect(archiveTransitionKey(LEAD, 1)).toBe(`${LEAD}:1`)
  })
})

describe('铁律 ①: the outer ledger namespace folds in the subject', () => {
  it('does NOT let one object’s key replay another object’s result', async () => {
    seedLead(h.db, LEAD)
    seedLead(h.db, LEAD2)
    const key = archiveIdempotencyKey('archive', LEAD, 0)
    const first = await archiveObject(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { target: LEAD, targetClass: ARCHIVABLE_LEAD, intent: 'archive', idempotencyKey: key }
    )
    expect(first.result.target).toBe(LEAD)

    // The SAME key, a DIFFERENT subject. Must run for real against LEAD2 rather
    // than hand back LEAD's stored result.
    const second = await archiveObject(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { target: LEAD2, targetClass: ARCHIVABLE_LEAD, intent: 'archive', idempotencyKey: key }
    )
    expect(second.replayed).toBe(false)
    expect(second.result.target).toBe(LEAD2)
    expect(stateOf(h.db, LEAD2)).toEqual({ archived: true, archiveGeneration: 1 })
  })

  it('and archive’s key cannot replay restore’s result', async () => {
    seedLead(h.db)
    expect(archiveCommandNamespace('archive', LEAD)).not.toBe(archiveCommandNamespace('restore', LEAD))
  })

  // 🔴 THE OTHER DIRECTION — what would happen WITHOUT the namespace. A
  // constant command name maps both subjects onto ONE ledger row, and
  // `CommandMiddleware.resume` answers a `succeeded` row from the ledger
  // WITHOUT entering the body, so every inner guard is downstream of the reply
  // and never runs.
  it('collides on one row the moment the subject is dropped from the namespace', () => {
    const key = archiveIdempotencyKey('archive', LEAD, 0)
    expect(commandExecutionId(ARCHIVE_OBJECT, key)).toBe(commandExecutionId(ARCHIVE_OBJECT, key))
    expect(commandExecutionId(archiveCommandNamespace('archive', LEAD), key)).not.toBe(
      commandExecutionId(archiveCommandNamespace('archive', LEAD2), key)
    )
  })

  it('claims the transition lock on the OBJECT, not on the caller’s key', async () => {
    seedLead(h.db)
    await archive()
    const innerId = commandExecutionId(ARCHIVE_TRANSITION_LOCK, archiveTransitionKey(LEAD, 1))
    expect(h.db.docs.get(innerId)).toBeDefined()
  })
})

describe('铁律 ②: the replay is behind a read-permission guard', () => {
  it('refuses a caller who cannot read the object, even when the ledger holds a result', async () => {
    seedLead(h.db)
    const key = archiveIdempotencyKey('archive', LEAD, 0)
    const first = await archiveObject(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { target: LEAD, targetClass: ARCHIVABLE_LEAD, intent: 'archive', idempotencyKey: key }
    )
    expect(first.result.archived).toBe(true)

    // ── DIRECTION 1: with the guard, a caller who cannot see the object is
    // refused — and is told "not found", not "forbidden", so the refusal is not
    // an existence oracle.
    h.db.hidden.add(LEAD)
    await expect(
      archiveObject(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { target: LEAD, targetClass: ARCHIVABLE_LEAD, intent: 'archive', idempotencyKey: key }
      )
    ).rejects.toMatchObject({ reason: 'target-not-found' })

    // ── DIRECTION 2: the guard is the ONLY thing standing in the way. The
    // ledger row is right there, `succeeded`, holding the archive result — so
    // removing the pre-runner assert would have `CommandMiddleware.resume` hand
    // it straight back without ever entering the body.
    const ledgerId = commandExecutionId(archiveCommandNamespace('archive', LEAD), key)
    const row = h.db.docs.get(ledgerId) as any
    expect(row.status).toBe('succeeded')
    expect(row.result).toMatchObject({ target: LEAD, archived: true })

    // ── CONTROL: the same call succeeds (as a replay) the moment the object is
    // readable again, proving the refusal came from the guard and not from some
    // unrelated breakage.
    h.db.hidden.delete(LEAD)
    const replay = await archiveObject(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { target: LEAD, targetClass: ARCHIVABLE_LEAD, intent: 'archive', idempotencyKey: key }
    )
    expect(replay.replayed).toBe(true)
    expect(replay.result).toEqual(first.result)
  })
})

describe('SYS-T004: an administrator restores an archived object', () => {
  it('restores it, keeps every trace edge, and creates no duplicate object', async () => {
    seedLead(h.db, LEAD, { generation: 1 })
    seedLink(h.db, 'link-1', LEAD, REQ)
    const before = h.db.docs.size

    const result = await restore()

    expect(result).toMatchObject({ target: LEAD, archived: false, generation: 2, noop: false })
    expect(stateOf(h.db, LEAD)).toEqual({ archived: false, archiveGeneration: 2 })

    // The relationship is intact and still points at the SAME endpoints: the
    // archive never deleted a trace edge, so "restoring the relations" is a
    // property of not having touched them.
    const link = h.db.docs.get('link-1' as Ref<Doc>) as TraceLink
    expect(link).toMatchObject({ docA: LEAD, docB: REQ, state: 'active' })
    expect(h.db.find(traceability.class.TraceLink, {})).toHaveLength(1)

    // 🔴 NO DUPLICATE OBJECT. There is exactly one Lead, and the only new
    // documents are the two ledger rows (the outer, subject-namespaced claim
    // and the inner transition claim) plus the audit record — all three at
    // DERIVED ids, so a replay converges on them instead of adding more.
    expect(h.db.find(ARCHIVABLE_LEAD, {})).toHaveLength(1)
    expect(h.db.docs.size).toBe(before + 3)
  })

  it('replays a repeated restore rather than restoring twice', async () => {
    seedLead(h.db, LEAD, { generation: 1 })
    await restore()
    const again = await archiveObject(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      {
        target: LEAD,
        targetClass: ARCHIVABLE_LEAD,
        intent: 'restore',
        idempotencyKey: archiveIdempotencyKey('restore', LEAD, 1)
      }
    )
    expect(again.replayed).toBe(true)
    expect(stateOf(h.db, LEAD).archiveGeneration).toBe(2)
    expect(h.db.find(activity.class.ActivityInfoMessage, {})).toHaveLength(1)
  })

  it('refuses a non-administrator, without confirming anything else', async () => {
    seedLead(h.db, LEAD, { generation: 1 })
    await expect(restore(LEAD, memberCtx())).rejects.toMatchObject({ reason: 'restore-forbidden' })
    expect(stateOf(h.db, LEAD).archived).toBe(true)
  })

  it('tells an unauthorised caller who ALSO cannot read it that it does not exist', async () => {
    // 🔴 ORDER IS THE POINT. The readability assert runs BEFORE the
    // administrator check, so "you are not an admin" is never used to confirm
    // that an object the caller cannot see exists.
    seedLead(h.db, LEAD, { generation: 1 })
    h.db.hidden.add(LEAD)
    await expect(restore(LEAD, memberCtx())).rejects.toMatchObject({ reason: 'target-not-found' })
  })

  it('still lets a plain member ARCHIVE — only restore is administrator-only', async () => {
    seedLead(h.db)
    const result = await archive(LEAD, memberCtx())
    expect(result.archived).toBe(true)
  })
})

describe('ArchiveObjectError', () => {
  it('carries a 400 and a machine readable reason', () => {
    const err = new ArchiveObjectError('target-not-found', 'x')
    expect(err.code).toBe(400)
    expect(err.name).toBe('ArchiveObjectError')
  })
})
