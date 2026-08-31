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
import core, { ClassifierKind, Hierarchy, TxFactory, type Class, type Doc, type Ref } from '@hcengineering/core'
import traceability, { traceLinkId, type TraceLink } from '@hcengineering/traceability'
import tracker, { type Issue } from '@hcengineering/tracker'
import serverAgentraCore, { commandExecutionId, type CommandExecution } from '@hcengineering/server-agentra-core'

import {
  FIXED_BY_MAX_ATTEMPTS,
  FixedByError,
  LINK_FIXED_BY,
  REVOKE_FIXED_BY,
  fixedByIdempotencyKey,
  linkFixedBy,
  linkFixedByCommandNamespace,
  reconcileFixedBy,
  revokeFixedBy,
  revokeFixedByCommandNamespace
} from '../commands/linkFixedBy'
import { GITHUB_PULL_REQUEST_CLASS, agentraTraceEndpoints } from '../commands/traceEndpoints'
import { ArchivableGuard, ArchivableGuardError } from '../deleteGuard'
import agentraCore, { ARCHIVABLE_CLASSES } from '@hcengineering/agentra-core'
import { makeHarness, seed, type Harness } from './harness'

const DEFECT = 'aaaaaaaaaaaaaaaaaaaaab01' as Ref<Issue>
const OTHER_DEFECT = 'aaaaaaaaaaaaaaaaaaaaab02' as Ref<Issue>
const PR = 'aaaaaaaaaaaaaaaaaaaaap01' as Ref<Doc>
const OTHER_PR = 'aaaaaaaaaaaaaaaaaaaaap02' as Ref<Doc>
const PROJECT = 'aaaaaaaaaaaaaaaaaaaaas01' as Ref<any>

const LINK_ID = traceLinkId('fixed-by', DEFECT, PR)

async function harness (): Promise<Harness> {
  const h = await makeHarness()
  for (const _id of [DEFECT, OTHER_DEFECT]) {
    seed<Issue>(h.db, {
      _id,
      _class: tracker.class.Issue,
      space: PROJECT,
      title: 'Login 500s',
      identifier: 'AGE-9'
    } as any)
  }
  for (const _id of [PR, OTHER_PR]) {
    seed<Doc>(h.db, { _id, _class: GITHUB_PULL_REQUEST_CLASS as Ref<any>, space: PROJECT } as any)
  }
  return h
}

function link (h: Harness, key: string, defect: Ref<Issue> = DEFECT, pullRequest: Ref<Doc> = PR): Promise<any> {
  return linkFixedBy(
    { ctx: h.ctx, client: h.client, runner: h.runner },
    { defect, pullRequest, pullRequestClass: GITHUB_PULL_REQUEST_CLASS, idempotencyKey: key }
  )
}

function revoke (h: Harness, key: string, defect: Ref<Issue> = DEFECT, pullRequest: Ref<Doc> = PR): Promise<any> {
  return revokeFixedBy(
    { ctx: h.ctx, client: h.client, runner: h.runner },
    { defect, pullRequest, pullRequestClass: GITHUB_PULL_REQUEST_CLASS, idempotencyKey: key }
  )
}

function edge (h: Harness): TraceLink | undefined {
  return h.db.docs.get(LINK_ID) as TraceLink | undefined
}

function key (revision: string, defect: Ref<Issue> = DEFECT, pullRequest: Ref<Doc> = PR): string {
  return fixedByIdempotencyKey(defect, pullRequest, revision)
}

/** Just enough of a hierarchy for `ArchivableGuard.isArchivableClass`. */
function makeHierarchy (): Hierarchy {
  const hierarchy = new Hierarchy()
  const factory = new TxFactory(core.account.System)
  const stub = (_id: Ref<Class<Doc>>, ext?: Ref<Class<Doc>>, kind = ClassifierKind.CLASS): void => {
    hierarchy.tx(
      factory.createTxCreateDoc(
        kind === ClassifierKind.MIXIN ? core.class.Mixin : core.class.Class,
        core.space.Model,
        { kind, label: '', extends: ext } as any,
        _id
      )
    )
  }
  stub(core.class.Doc)
  for (const _class of ARCHIVABLE_CLASSES) stub(_class, core.class.Doc)
  stub(GITHUB_PULL_REQUEST_CLASS, core.class.Doc)
  stub(agentraCore.mixin.Archivable as Ref<Class<Doc>>, core.class.Doc, ClassifierKind.MIXIN)
  return hierarchy
}

describe('linkFixedBy — the edge', () => {
  it('creates an active fixed-by edge with a derived id', async () => {
    const h = await harness()
    const out = await link(h, key('r1'))
    expect(out.result.traceLink).toBe(LINK_ID)
    expect(out.result.alreadyLinked).toBe(false)
    expect(out.result.revived).toBe(false)
    const stored = edge(h)
    expect(stored).toMatchObject({
      docA: DEFECT,
      docB: PR,
      kind: 'fixed-by',
      state: 'active',
      sourceClass: tracker.class.Issue,
      targetClass: GITHUB_PULL_REQUEST_CLASS
    })
  })

  it('is idempotent under the same key and under a different one', async () => {
    const h = await harness()
    await link(h, key('r1'))
    expect((await link(h, key('r1'))).replayed).toBe(true)
    expect((await link(h, key('r2'))).result.alreadyLinked).toBe(true)
    expect(h.db.find(traceability.class.TraceLink, {})).toHaveLength(1)
  })

  it('announces the edge on BOTH endpoints, because DOMAIN_RELATION has no activity', async () => {
    const h = await harness()
    await link(h, key('r1'))
    const records = h.db.find(activity.class.DocUpdateMessage, {}) as DocUpdateMessage[]
    expect(records.map((r) => r.attachedTo).sort()).toEqual([DEFECT, PR].sort())
    expect(records.every((r) => r.objectId === LINK_ID && r.action === 'create')).toBe(true)
  })

  it('refuses a defect that does not exist, and writes nothing', async () => {
    const h = await harness()
    await expect(link(h, key('r1'), 'aaaaaaaaaaaaaaaaaaaaaz99' as Ref<Issue>)).rejects.toMatchObject({
      reason: 'defect-not-found'
    })
    expect(h.db.find(traceability.class.TraceLink, {})).toHaveLength(0)
  })

  it('refuses a target class nobody registered as a PullRequest', async () => {
    const h = await harness()
    await expect(
      linkFixedBy(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        {
          defect: DEFECT,
          pullRequest: PR,
          pullRequestClass: tracker.class.Issue as any,
          idempotencyKey: key('r1')
        }
      )
    ).rejects.toMatchObject({ reason: 'pull-request-class-not-registered' })
  })

  it('has the GitHub pull request class registered, or every edge fails closed', () => {
    expect(agentraTraceEndpoints.get(GITHUB_PULL_REQUEST_CLASS)).toBe('PullRequest')
    // Pinned literally: a typo compiles but disables the whole feature.
    expect(GITHUB_PULL_REQUEST_CLASS).toBe('github:class:GithubPullRequest')
  })
})

describe('revokeFixedBy', () => {
  it('revokes rather than deletes, and announces the withdrawal on both ends', async () => {
    const h = await harness()
    await link(h, key('r1'))
    const out = await revoke(h, key('r2'))
    expect(out.result.alreadyRevoked).toBe(false)
    expect(edge(h)?.state).toBe('revoked')
    const removals = (h.db.find(activity.class.DocUpdateMessage, {}) as DocUpdateMessage[]).filter(
      (r) => r.action === 'remove'
    )
    expect(removals.map((r) => r.attachedTo).sort()).toEqual([DEFECT, PR].sort())
  })

  it('refuses a pair that was never asserted, rather than answering "done"', async () => {
    const h = await harness()
    await expect(revoke(h, key('r1'))).rejects.toMatchObject({ reason: 'link-not-found' })
  })

  it('releases the delete protection on both endpoints — a real privilege change', async () => {
    const h = await harness()
    await link(h, key('r1'))
    const guard = new ArchivableGuard({
      hierarchy: makeHierarchy(),
      findAll: async (_ctx: any, _class: any, query: any) => h.db.find(_class, query) as any
    })
    const remove = new TxFactory(core.account.System).createTxRemoveDoc(tracker.class.Issue, PROJECT, DEFECT)
    await expect(guard.validate(h.ctx, [remove])).rejects.toBeInstanceOf(ArchivableGuardError)
    // 🔴 Revoking is not only bookkeeping: `ArchivableGuard.validateRemove`
    // queries with `state: { $ne: 'revoked' }`, so a machine editing a pull
    // request body turns an undeletable defect into a deletable one.
    await revoke(h, key('r2'))
    await expect(guard.validate(h.ctx, [remove])).resolves.toBeUndefined()
  })
})

describe('🔴 iron law ⑤ — a reference removed and added back must revive the edge', () => {
  it('survives an unbounded number of link/revoke rounds', async () => {
    const h = await harness()
    // Five full rounds. `linkImplements` fails on the very first revive because
    // its inner pair claim is keyed on the pair alone; this command has no such
    // claim, so every round re-enters the body.
    for (let round = 1; round <= 5; round++) {
      const linked = await link(h, key(`body-${round}-added`))
      expect(edge(h)?.state).toBe('active')
      expect(linked.result.revived).toBe(round > 1)
      expect(linked.result.alreadyLinked).toBe(false)

      const revoked = await revoke(h, key(`body-${round}-removed`))
      expect(edge(h)?.state).toBe('revoked')
      expect(revoked.result.alreadyRevoked).toBe(false)
    }
    // One row for the pair, forever — the audit fact is never duplicated.
    expect(h.db.find(traceability.class.TraceLink, {})).toHaveLength(1)
  })

  it('writes a fresh history entry for every round, not just the first', async () => {
    const h = await harness()
    await link(h, key('r1'))
    await revoke(h, key('r2'))
    await link(h, key('r3'))
    const onDefect = (h.db.find(activity.class.DocUpdateMessage, {}) as DocUpdateMessage[]).filter(
      (r) => r.attachedTo === DEFECT
    )
    // create, remove, create — a pair-only activity scope would have collapsed
    // the third into the first and left the revive invisible.
    expect(onDefect.map((r) => r.action)).toEqual(['create', 'remove', 'create'])
  })

  it('revives an `orphaned` edge too, since both ends were just read', async () => {
    const h = await harness()
    await link(h, key('r1'))
    const stored = h.db.docs.get(LINK_ID) as TraceLink
    const orphaned: TraceLink = { ...stored, state: 'orphaned' }
    h.db.docs.set(LINK_ID, orphaned)
    expect((await link(h, key('r2'))).result.revived).toBe(true)
    expect(edge(h)?.state).toBe('active')
  })

  it('🔴 pins the caller contract: a CONSTANT key re-creates the trap one level up', async () => {
    const h = await harness()
    const constant = 'traceability:fixed-by:v1:constant'
    await link(h, constant)
    await revoke(h, key('r2'))
    const replayed = await link(h, constant)
    // The OUTER ledger row is the caller's declared "this is the same request",
    // so replaying it is correct by definition — which is precisely why
    // `fixedByIdempotencyKey` folds the pull request body revision in, and why
    // this test exists to make the consequence of ignoring it explicit.
    expect(replayed.replayed).toBe(true)
    expect(edge(h)?.state).toBe('revoked')
  })
})

describe('🔴 iron law ① — the outer command name folds in BOTH ids', () => {
  it('names both the defect and the pull request', () => {
    expect(linkFixedByCommandNamespace(DEFECT, PR)).toBe(`${LINK_FIXED_BY}:${DEFECT}:${PR}`)
    expect(revokeFixedByCommandNamespace(DEFECT, PR)).toBe(`${REVOKE_FIXED_BY}:${DEFECT}:${PR}`)
    for (const ns of [linkFixedByCommandNamespace, revokeFixedByCommandNamespace]) {
      expect(ns(DEFECT, PR)).not.toBe(ns(OTHER_DEFECT, PR))
      expect(ns(DEFECT, PR)).not.toBe(ns(DEFECT, OTHER_PR))
    }
  })

  it('does not let one key cross between subjects', async () => {
    const h = await harness()
    const shared = 'one-key-for-everything'
    await link(h, shared, DEFECT, PR)
    // Same key, different pair: must RUN, not replay the first pair's answer.
    const second = await link(h, shared, OTHER_DEFECT, PR)
    expect(second.replayed).toBe(false)
    expect(second.result.traceLink).toBe(traceLinkId('fixed-by', OTHER_DEFECT, PR))
    const third = await link(h, shared, DEFECT, OTHER_PR)
    expect(third.replayed).toBe(false)
    expect(h.db.find(traceability.class.TraceLink, {})).toHaveLength(3)
  })

  it('derives the ledger row from the namespaced command name', async () => {
    const h = await harness()
    await link(h, key('r1'))
    const row = h.db.docs.get(
      commandExecutionId(linkFixedByCommandNamespace(DEFECT, PR), key('r1'))
    ) as CommandExecution
    expect(row?._class).toBe(serverAgentraCore.class.CommandExecution)
    expect(row.status).toBe('succeeded')
  })
})

describe('🔴 iron law ② — a read guard on the CALLER, before the runner', () => {
  it('refuses a replay to somebody who cannot read the defect', async () => {
    const h = await harness()
    await link(h, key('r1'))
    // The ledger row is `succeeded`, so the body will not be re-entered; only a
    // guard placed BEFORE `runner.run` can stop the stored result leaking.
    h.db.hidden.add(DEFECT)
    await expect(link(h, key('r1'))).rejects.toMatchObject({ reason: 'defect-not-found' })
  })

  it('refuses a replay to somebody who cannot read the pull request', async () => {
    const h = await harness()
    await link(h, key('r1'))
    h.db.hidden.add(PR)
    await expect(link(h, key('r1'))).rejects.toMatchObject({ reason: 'pull-request-not-found' })
  })

  it('guards the revoke replay the same way', async () => {
    const h = await harness()
    await link(h, key('r1'))
    await revoke(h, key('r2'))
    h.db.hidden.add(PR)
    await expect(revoke(h, key('r2'))).rejects.toMatchObject({ reason: 'pull-request-not-found' })
  })
})

describe('🔴 iron law ③ — derived ids, query-then-write, asserted commits', () => {
  it('uses no generateId: every id is reproducible from the input', async () => {
    const a = await harness()
    const b = await harness()
    await link(a, key('r1'))
    await link(b, key('r1'))
    expect([...a.db.docs.keys()].sort()).toEqual([...b.db.docs.keys()].sort())
  })

  it('agrees with a racing creator instead of surfacing a duplicate key error', async () => {
    const h = await harness()
    let gated = 0
    const realFindOne = h.fake.findOne.bind(h.fake)
    // ⚠️ GATED BY CLASS, not by call count. The pre-runner read guard (iron law
    // ②) issues two `findOne`s of its own before the body ever runs, so a naive
    // "intercept the first call" gate would fire on the guard's read of the
    // defect and never reach the edge at all.
    h.fake.findOne = async (_class: any, query: any): Promise<any> => {
      const found = await realFindOne(_class, query)
      if (_class === traceability.class.TraceLink && ++gated === 1) {
        // A competitor lands the edge between our read and our write.
        h.db.docs.set(LINK_ID, {
          _id: LINK_ID,
          _class: traceability.class.TraceLink,
          space: core.space.Workspace,
          docA: DEFECT,
          docB: PR,
          kind: 'fixed-by',
          state: 'active'
        } as any)
        return undefined
      }
      return found
    }
    const out = await link(h, key('r1'))
    expect(out.result.alreadyLinked).toBe(true)
    expect(h.db.find(traceability.class.TraceLink, {})).toHaveLength(1)
  })

  it('reports contention rather than looping when the row keeps moving', async () => {
    const h = await harness()
    await link(h, key('r1'))
    await revoke(h, key('r2'))
    // Every compare-and-swap is rejected, the way `ApplyTxMiddleware` rejects a
    // `TxApplyIf` — by RETURNING false rather than throwing.
    h.fake.applyOutcome = () => false
    await expect(link(h, key('r3'))).rejects.toMatchObject({ reason: 'contended' })
    expect(FIXED_BY_MAX_ATTEMPTS).toBeGreaterThan(1)
  })
})

describe('reconcileFixedBy', () => {
  it('links what the body names and revokes what it dropped', async () => {
    const h = await harness()
    const context = { ctx: h.ctx, client: h.client, runner: h.runner }
    await reconcileFixedBy(context, {
      pullRequest: PR,
      pullRequestClass: GITHUB_PULL_REQUEST_CLASS,
      defects: [DEFECT, OTHER_DEFECT],
      revision: 'body-1'
    })
    expect(h.db.find(traceability.class.TraceLink, { state: 'active' })).toHaveLength(2)

    const second = await reconcileFixedBy(context, {
      pullRequest: PR,
      pullRequestClass: GITHUB_PULL_REQUEST_CLASS,
      defects: [DEFECT],
      revision: 'body-2'
    })
    expect(second.revoked).toEqual([OTHER_DEFECT])
    expect(edge(h)?.state).toBe('active')
    expect((h.db.docs.get(traceLinkId('fixed-by', OTHER_DEFECT, PR)) as TraceLink).state).toBe('revoked')

    // …and back again, which is the whole point.
    const third = await reconcileFixedBy(context, {
      pullRequest: PR,
      pullRequestClass: GITHUB_PULL_REQUEST_CLASS,
      defects: [DEFECT, OTHER_DEFECT],
      revision: 'body-3'
    })
    expect(third.linked.sort()).toEqual([DEFECT, OTHER_DEFECT].sort())
    expect((h.db.docs.get(traceLinkId('fixed-by', OTHER_DEFECT, PR)) as TraceLink).state).toBe('active')
  })

  it('never throws at the caller: an unresolvable defect is skipped, the rest still land', async () => {
    const h = await harness()
    const missing = 'aaaaaaaaaaaaaaaaaaaaaz99' as Ref<Issue>
    const out = await reconcileFixedBy(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { pullRequest: PR, pullRequestClass: GITHUB_PULL_REQUEST_CLASS, defects: [missing, DEFECT], revision: 'r1' }
    )
    expect(out.skipped).toEqual([{ subject: missing, reason: 'defect-not-found' }])
    expect(out.linked).toEqual([DEFECT])
  })

  it('never throws when the caller cannot read a defect', async () => {
    const h = await harness()
    h.db.hidden.add(OTHER_DEFECT)
    const out = await reconcileFixedBy(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      {
        pullRequest: PR,
        pullRequestClass: GITHUB_PULL_REQUEST_CLASS,
        defects: [DEFECT, OTHER_DEFECT],
        revision: 'r1'
      }
    )
    expect(out.linked).toEqual([DEFECT])
    expect(out.skipped).toHaveLength(1)
  })

  it('🔴 iron law ④ — the "which edges exist" query does not go through the runner', async () => {
    const h = await harness()
    const context = { ctx: h.ctx, client: h.client, runner: h.runner }
    await reconcileFixedBy(context, {
      pullRequest: PR,
      pullRequestClass: GITHUB_PULL_REQUEST_CLASS,
      defects: [DEFECT],
      revision: 'body-1'
    })
    // No ledger row exists for a bare "list the edges" command; if the query had
    // been claimed, this second reconcile would replay the FIRST one's edge list
    // and revoke nothing.
    const rows = h.db.find(serverAgentraCore.class.CommandExecution, {}) as CommandExecution[]
    expect(rows.every((r) => r.command.startsWith(LINK_FIXED_BY) || r.command.startsWith(REVOKE_FIXED_BY))).toBe(true)
    const out = await reconcileFixedBy(context, {
      pullRequest: PR,
      pullRequestClass: GITHUB_PULL_REQUEST_CLASS,
      defects: [],
      revision: 'body-2'
    })
    expect(out.revoked).toEqual([DEFECT])
  })
})

describe('FixedByError', () => {
  it('carries a machine readable reason and an HTTP-ish code', () => {
    const err = new FixedByError('link-not-found', 'nope')
    expect(err.code).toBe(400)
    expect(err.name).toBe('FixedByError')
  })
})
