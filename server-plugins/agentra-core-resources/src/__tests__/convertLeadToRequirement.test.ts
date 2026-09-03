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
import core, {
  TxOperations,
  TxProcessor,
  toFindResult,
  type Client,
  type Doc,
  type Hierarchy,
  type MeasureContext,
  type ModelDb,
  type Ref,
  type SessionData,
  type Tx,
  type TxApplyIf,
  type TxCreateDoc,
  type TxResult,
  type TxUpdateDoc
} from '@hcengineering/core'
import crmLite, { type Lead } from '@hcengineering/crm-lite'
import requirements, { type Requirement } from '@hcengineering/requirements'
import traceability, { traceLinkId, type TraceEndpointRegistry, type TraceLink } from '@hcengineering/traceability'
import serverAgentraCore, {
  CommandInProgressError,
  commandObjectId,
  commandRunnerContextVar,
  type CommandExecution
} from '@hcengineering/server-agentra-core'
import type { Middleware, PipelineContext, TxMiddlewareResult } from '@hcengineering/server-core'

import { CommandMiddleware } from '../commandMiddleware'
import {
  CONVERTED_LEAD_READONLY_FIELDS,
  CONVERT_LEAD_LOCK,
  ConvertLeadError,
  convertLeadRoles,
  CONVERT_LEAD_TO_REQUIREMENT,
  convertLeadCommandNamespace,
  convertLeadToRequirement,
  getCommandRunner,
  type CommandRunner
} from '../commands/convertLeadToRequirement'
import { agentraTraceEndpoints } from '../commands/traceEndpoints'

const LEAD_ID = 'aaaaaaaaaaaaaaaaaaaaaaa1' as Ref<Lead>
const KEY = 'convert-key-1'

/**
 * One store shared by the idempotency ledger and the domain objects, so the
 * "what does a replay see?" question is answered against the same data the
 * command wrote.
 *
 * ⚠️ SCOPE OF THE ACTIVITY COUNTS BELOW. This harness has no
 * `TriggersMiddleware`, so the only `DocUpdateMessage`s in the store are the
 * ones the command wrote itself. In production the platform ALSO generates
 * activity for the Requirement create and the Lead status update (both classes
 * carry `activity.mixin.ActivityDoc`), so the total there is higher. The
 * assertions here are about the command's own explicit trace-edge records —
 * which is the interesting part, since `DOMAIN_RELATION` produces none.
 */
class MemoryDb {
  readonly docs = new Map<Ref<Doc>, Doc>()
  /** Ids the security filter hides from `find`, so permission tests are real. */
  readonly hidden = new Set<Ref<Doc>>()

  find (_class: Ref<any>, query: Record<string, any>): Doc[] {
    const out: Doc[] = []
    for (const doc of this.docs.values()) {
      if (this.hidden.has(doc._id)) continue
      // `core.class.Doc` stands in for "any class"; everything else is matched
      // exactly. The command relies on both: the squatter probe queries
      // core.class.Doc, every other read pins a concrete class.
      if (_class !== core.class.Doc && doc._class !== _class) continue
      let ok = true
      for (const [k, v] of Object.entries(query)) {
        if ((doc as any)[k] !== v) {
          ok = false
          break
        }
      }
      if (ok) out.push({ ...doc })
    }
    return out
  }

  apply (tx: Tx): void {
    if (tx._class === core.class.TxCreateDoc) {
      const create = tx as TxCreateDoc<Doc>
      if (this.docs.has(create.objectId)) {
        const err: any = new Error('duplicate key value violates unique constraint')
        err.code = '23505'
        throw err
      }
      this.docs.set(create.objectId, TxProcessor.createDoc2Doc(create))
    } else if (tx._class === core.class.TxUpdateDoc) {
      const update = tx as TxUpdateDoc<Doc>
      const doc = this.docs.get(update.objectId)
      if (doc !== undefined) {
        TxProcessor.applyUpdate(doc, { ...update.operations } as any)
      }
    }
  }
}

/** Stands in for everything under `CommandMiddleware`, ledger side only. */
class LedgerAdapter implements Middleware {
  constructor (readonly db: MemoryDb) {}

  async tx (ctx: MeasureContext<SessionData>, txes: Tx[]): Promise<TxMiddlewareResult> {
    const results: any[] = []
    for (const tx of txes) {
      this.db.apply(tx)
      if (tx._class === core.class.TxUpdateDoc && (tx as TxUpdateDoc<Doc>).retrieve === true) {
        results.push({ object: { ...(this.db.docs.get((tx as TxUpdateDoc<Doc>).objectId) as Doc) } })
      }
    }
    return results.length === 1 ? results[0] : results
  }

  async findAll (ctx: MeasureContext<SessionData>, _class: Ref<any>, query: any): Promise<any> {
    return this.db.find(_class, query)
  }

  async findAllRaw (): Promise<any> {
    return []
  }

  async loadModel (): Promise<any> {
    return []
  }

  async groupBy (): Promise<any> {
    return new Map()
  }

  async searchFulltext (): Promise<any> {
    return { docs: [], total: 0 }
  }

  async handleBroadcast (): Promise<void> {}
  async close (): Promise<void> {}
  async domainRequest (): Promise<any> {
    return { domain: '', value: undefined }
  }

  async closeSession (): Promise<void> {}
}

/**
 * The domain client. `applyOutcome` lets a test make `ApplyTxMiddleware` REJECT
 * a `TxApplyIf` the way the real one does — by returning `success: false`
 * instead of throwing.
 */
class FakeClient implements Client {
  applyOutcome: (tx: TxApplyIf) => boolean = () => true
  readonly seen: Tx[] = []

  constructor (readonly db: MemoryDb) {}

  getHierarchy (): Hierarchy {
    // `TxOperations` only asks two questions before building a tx.
    return {
      isDerived: (_class: Ref<any>, from: Ref<any>) => from === core.class.Doc,
      findDomain: () => undefined
    } as unknown as Hierarchy
  }

  getModel (): ModelDb {
    return {} as unknown as ModelDb
  }

  async findAll<T extends Doc>(_class: Ref<any>, query: any): Promise<any> {
    return toFindResult(this.db.find(_class, query) as T[])
  }

  async findOne<T extends Doc>(_class: Ref<any>, query: any): Promise<T | undefined> {
    return this.db.find(_class, query)[0] as T | undefined
  }

  async searchFulltext (): Promise<any> {
    return { docs: [], total: 0 }
  }

  async domainRequest (): Promise<any> {
    return { domain: '', value: undefined }
  }

  async tx (tx: Tx): Promise<TxResult> {
    this.seen.push(tx)
    if (tx._class === core.class.TxApplyIf) {
      const applyIf = tx as TxApplyIf
      // Mirror `ApplyTxMiddleware.tx`: match/notMatch are evaluated ONLY when a
      // scope is present; with a null scope the middleware hard-codes passed.
      const matched =
        applyIf.scope == null ||
        ((applyIf.match ?? []).every(({ _class, query }) => this.db.find(_class, query).length > 0) &&
          (applyIf.notMatch ?? []).every(({ _class, query }) => this.db.find(_class, query).length === 0))
      const success = matched && this.applyOutcome(applyIf)
      if (success) {
        for (const inner of applyIf.txes) {
          this.db.apply(inner)
        }
      }
      return { success, derived: [], serverTime: 0 } as any
    }
    this.db.apply(tx)
    return {}
  }

  async close (): Promise<void> {}
}

function makeCtx (): MeasureContext<SessionData> {
  const ctx: any = {
    contextData: { account: { primarySocialId: core.account.System } },
    info: () => {},
    warn: () => {},
    error: () => {},
    measure: () => {},
    with: async (_n: string, _p: any, op: any) => op(ctx),
    withSync: (_n: string, _p: any, op: any) => op(ctx),
    newChild: () => ctx,
    end: () => {}
  }
  return ctx
}

interface Harness {
  ctx: MeasureContext<SessionData>
  db: MemoryDb
  client: TxOperations
  fake: FakeClient
  runner: CommandRunner
  endpoints: TraceEndpointRegistry
}

async function makeHarness (leadStatus: Lead['status'] = 'Qualifying'): Promise<Harness> {
  const db = new MemoryDb()
  const ctx = makeCtx()
  const context = { contextVars: {} } as unknown as PipelineContext
  await CommandMiddleware.create(ctx, context, new LedgerAdapter(db))
  const runner = getCommandRunner(context)

  const fake = new FakeClient(db)
  const client = new TxOperations(fake, core.account.System)

  db.docs.set(LEAD_ID, {
    _id: LEAD_ID,
    _class: crmLite.masterTag.Lead as Ref<any>,
    space: crmLite.space.Crm as Ref<any>,
    modifiedBy: core.account.System,
    modifiedOn: Date.now(),
    title: 'Acme wants SSO',
    status: leadStatus,
    priority: 'High'
  } as unknown as Lead)

  return { ctx, db, client, fake, runner, endpoints: agentraTraceEndpoints }
}

/** Derived from the LEAD, not from the request key — see CONVERT_LEAD_LOCK. */
function requirementIdFor (lead: Ref<Lead> = LEAD_ID): Ref<Requirement> {
  return commandObjectId<Requirement>(CONVERT_LEAD_LOCK, lead, convertLeadRoles.requirement)
}

function countOf (db: MemoryDb, _class: Ref<any>): number {
  return db.find(_class, {}).length
}

describe('the endpoint registry', () => {
  it('registers both roles the converted-to edge needs', () => {
    // 🔴 If this map is empty at runtime `validateTraceLink` fails closed with
    // `unknown-source-class` and every conversion is refused.
    expect(agentraTraceEndpoints.get(crmLite.masterTag.Lead as Ref<any>)).toBe('Lead')
    expect(agentraTraceEndpoints.get(requirements.masterTag.Requirement as Ref<any>)).toBe('Requirement')
  })
})

describe('convertLeadToRequirement', () => {
  it('creates the requirement, the edge, the status change and activity on BOTH ends', async () => {
    const h = await makeHarness()
    const outcome = await convertLeadToRequirement(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { lead: LEAD_ID, idempotencyKey: KEY }
    )

    expect(outcome.replayed).toBe(false)
    expect(outcome.result.alreadyConverted).toBe(false)

    const requirementId = requirementIdFor()
    expect(outcome.result.requirement).toBe(requirementId)

    const requirement = h.db.docs.get(requirementId) as Requirement
    expect(requirement).toBeDefined()
    expect(requirement.status).toBe('Draft')
    expect(requirement.title).toBe('Acme wants SSO')
    expect(requirement.space).toBe(requirements.space.Requirements)

    const link = h.db.docs.get(traceLinkId('converted-to', LEAD_ID, requirementId)) as TraceLink
    expect(link).toBeDefined()
    // Persisted under docA/docB, not source/target.
    expect(link.docA).toBe(LEAD_ID)
    expect(link.docB).toBe(requirementId)
    expect(link.kind).toBe('converted-to')
    expect(link.state).toBe('active')
    expect(link.space).toBe(core.space.Workspace)

    expect((h.db.docs.get(LEAD_ID) as Lead).status).toBe('Converted')

    // 🔴 DOMAIN_RELATION is excluded from Activity, so these two exist only
    // because the command wrote them explicitly.
    const messages = h.db.find(activity.class.DocUpdateMessage, {}) as DocUpdateMessage[]
    expect(messages).toHaveLength(2)
    expect(new Set(messages.map((m) => m.attachedTo))).toEqual(new Set([LEAD_ID, requirementId]))
    for (const m of messages) {
      expect(m.objectId).toBe(link._id)
      expect(m.objectClass).toBe(traceability.class.TraceLink)
      expect(m.action).toBe('create')
    }
  })

  it('replays the same key without producing a second object, edge or message', async () => {
    const h = await makeHarness()
    const input = { lead: LEAD_ID, idempotencyKey: KEY }
    const first = await convertLeadToRequirement({ ctx: h.ctx, client: h.client, runner: h.runner }, input)
    const before = h.db.docs.size

    const second = await convertLeadToRequirement({ ctx: h.ctx, client: h.client, runner: h.runner }, input)

    expect(second.replayed).toBe(true)
    expect(second.result.requirement).toBe(first.result.requirement)
    expect(second.result.traceLink).toBe(first.result.traceLink)
    expect(h.db.docs.size).toBe(before)
    expect(countOf(h.db, requirements.masterTag.Requirement as Ref<any>)).toBe(1)
    expect(countOf(h.db, traceability.class.TraceLink)).toBe(1)
    expect(countOf(h.db, activity.class.DocUpdateMessage)).toBe(2)
  })

  it('gives the concurrent second caller a 409 rather than a silent success', async () => {
    const h = await makeHarness()
    const input = { lead: LEAD_ID, idempotencyKey: KEY }

    // Hold the first body open so the claim is live and NOT stale.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slowClient = new TxOperations(h.fake, core.account.System)
    const original = slowClient.findOne.bind(slowClient)
    // ⚠️ Gate the SECOND read, not the first. `convertLeadToRequirement` now
    // re-reads the lead BEFORE the runner, to stop a ledger replay from
    // answering a caller who may not read it — so parking on read #1 would
    // freeze the first attempt before it ever claims, and the second caller
    // would find nothing live to collide with. Read #2 is the body's own, taken
    // after the claim is held, which is the state this test is about.
    let reads = 0
    ;(slowClient as any).findOne = async (...args: any[]) => {
      if (++reads === 2) {
        await gate
      }
      return (original as any)(...args)
    }

    const first = convertLeadToRequirement({ ctx: h.ctx, client: slowClient, runner: h.runner }, input)
    // Let the first attempt reach its gated read and park there.
    await new Promise((resolve) => setTimeout(resolve, 0))

    await expect(
      convertLeadToRequirement({ ctx: h.ctx, client: h.client, runner: h.runner }, input)
    ).rejects.toBeInstanceOf(CommandInProgressError)

    release()
    const done = await first
    expect(done.result.requirement).toBe(requirementIdFor())
    // The loser wrote nothing.
    expect(countOf(h.db, requirements.masterTag.Requirement as Ref<any>)).toBe(1)
    expect(countOf(h.db, traceability.class.TraceLink)).toBe(1)
  })

  it('re-enters a partially applied run: fills in the missing edge, reuses the requirement', async () => {
    const h = await makeHarness()
    const input = { lead: LEAD_ID, idempotencyKey: KEY }
    const requirementId = requirementIdFor()

    // Fail the trace-link step to leave exactly the "requirement exists, edge
    // does not" state a mid-command crash produces.
    h.fake.applyOutcome = (tx) => !tx.txes.some((t: any) => t.objectClass === traceability.class.TraceLink)
    await expect(convertLeadToRequirement({ ctx: h.ctx, client: h.client, runner: h.runner }, input)).rejects.toThrow(
      /failed to commit/
    )

    expect(h.db.docs.has(requirementId)).toBe(true)
    expect(countOf(h.db, traceability.class.TraceLink)).toBe(0)
    // 🔴 The failure must NOT have been recorded as a success.
    const ledger = h.db.docs.get(h.db.find(serverAgentraCore.class.CommandExecution, {})[0]._id) as CommandExecution
    expect(ledger.status).toBe('failed')

    // Replay the same key. `failed` is retryable, so the body runs again.
    h.fake.applyOutcome = () => true
    const retry = await convertLeadToRequirement({ ctx: h.ctx, client: h.client, runner: h.runner }, input)

    expect(retry.replayed).toBe(false)
    expect(retry.result.requirement).toBe(requirementId)
    expect(countOf(h.db, requirements.masterTag.Requirement as Ref<any>)).toBe(1)
    expect(countOf(h.db, traceability.class.TraceLink)).toBe(1)
    expect(countOf(h.db, activity.class.DocUpdateMessage)).toBe(2)
    expect((h.db.docs.get(LEAD_ID) as Lead).status).toBe('Converted')
  })

  it('does not duplicate activity when only the second message is missing', async () => {
    const h = await makeHarness()
    const input = { lead: LEAD_ID, idempotencyKey: KEY }
    const requirementId = requirementIdFor()

    // Let everything through except the activity record on the Requirement.
    h.fake.applyOutcome = (tx) =>
      !tx.txes.some(
        (t: any) => t.objectId === commandObjectId(CONVERT_LEAD_LOCK, LEAD_ID, convertLeadRoles.requirementActivity)
      )
    await expect(convertLeadToRequirement({ ctx: h.ctx, client: h.client, runner: h.runner }, input)).rejects.toThrow(
      /failed to commit/
    )
    expect(countOf(h.db, activity.class.DocUpdateMessage)).toBe(1)

    h.fake.applyOutcome = () => true
    const retry = await convertLeadToRequirement({ ctx: h.ctx, client: h.client, runner: h.runner }, input)
    expect(retry.result.requirement).toBe(requirementId)
    expect(countOf(h.db, activity.class.DocUpdateMessage)).toBe(2)
    expect(countOf(h.db, requirements.masterTag.Requirement as Ref<any>)).toBe(1)
    expect(countOf(h.db, traceability.class.TraceLink)).toBe(1)
  })

  it('never reports success when commit() comes back { result: false }', async () => {
    const h = await makeHarness()
    // Reject the very first apply block.
    h.fake.applyOutcome = () => false

    await expect(
      convertLeadToRequirement(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { lead: LEAD_ID, idempotencyKey: KEY }
      )
    ).rejects.toThrow("Command step 'create requirement' failed to commit")

    expect(countOf(h.db, requirements.masterTag.Requirement as Ref<any>)).toBe(0)
    const ledger = h.db.find(serverAgentraCore.class.CommandExecution, {})[0] as CommandExecution
    expect(ledger.status).toBe('failed')
    expect(ledger.result).toBeUndefined()
  })

  it('refuses a status the lead state machine cannot leave for Converted', async () => {
    for (const status of ['New', 'Contacted', 'Disqualified'] as const) {
      const h = await makeHarness(status)
      await expect(
        convertLeadToRequirement(
          { ctx: h.ctx, client: h.client, runner: h.runner },
          { lead: LEAD_ID, idempotencyKey: `${KEY}-${status}` }
        )
      ).rejects.toMatchObject({ reason: 'illegal-transition' })
      // Nothing was written before the check.
      expect(countOf(h.db, requirements.masterTag.Requirement as Ref<any>)).toBe(0)
      expect(countOf(h.db, traceability.class.TraceLink)).toBe(0)
    }
  })

  it('resolves an already converted lead to its ORIGINAL requirement under a new key', async () => {
    const h = await makeHarness()
    const first = await convertLeadToRequirement(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { lead: LEAD_ID, idempotencyKey: KEY }
    )
    const size = h.db.docs.size

    const second = await convertLeadToRequirement(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { lead: LEAD_ID, idempotencyKey: 'a-completely-different-key' }
    )

    expect(second.replayed).toBe(false)
    expect(second.result.alreadyConverted).toBe(true)
    expect(second.result.requirement).toBe(first.result.requirement)
    expect(second.result.traceLink).toBe(first.result.traceLink)
    // Only the new ledger row was added; no second requirement, edge or message.
    expect(h.db.docs.size).toBe(size + 1)
    expect(countOf(h.db, requirements.masterTag.Requirement as Ref<any>)).toBe(1)
    expect(countOf(h.db, traceability.class.TraceLink)).toBe(1)
    expect(countOf(h.db, activity.class.DocUpdateMessage)).toBe(2)
  })

  it('gives a DIFFERENT key racing on the same lead a 409, not a second requirement', async () => {
    // Task 9 Step 1: "the same lead converted concurrently by the same or
    // different clients yields exactly one Requirement and one link". The outer
    // per-key claim cannot deliver this; the inner per-LEAD claim does.
    const h = await makeHarness()

    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slowClient = new TxOperations(h.fake, core.account.System)
    const original = slowClient.findOne.bind(slowClient)
    // ⚠️ Gate the SECOND read, not the first. `convertLeadToRequirement` now
    // re-reads the lead BEFORE the runner, to stop a ledger replay from
    // answering a caller who may not read it — so parking on read #1 would
    // freeze the first attempt before it ever claims, and the second caller
    // would find nothing live to collide with. Read #2 is the body's own, taken
    // after the claim is held, which is the state this test is about.
    let reads = 0
    ;(slowClient as any).findOne = async (...args: any[]) => {
      if (++reads === 2) {
        await gate
      }
      return (original as any)(...args)
    }

    const first = convertLeadToRequirement(
      { ctx: h.ctx, client: slowClient, runner: h.runner },
      { lead: LEAD_ID, idempotencyKey: KEY }
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    await expect(
      convertLeadToRequirement(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { lead: LEAD_ID, idempotencyKey: 'a-second-client-key' }
      )
    ).rejects.toBeInstanceOf(CommandInProgressError)

    release()
    await first
    expect(countOf(h.db, requirements.masterTag.Requirement as Ref<any>)).toBe(1)
    expect(countOf(h.db, traceability.class.TraceLink)).toBe(1)
    expect(countOf(h.db, activity.class.DocUpdateMessage)).toBe(2)
  })

  it('lets a DIFFERENT key finish a conversion an earlier key abandoned half done', async () => {
    const h = await makeHarness()
    const requirementId = requirementIdFor()

    // Key A dies right after the Requirement lands.
    h.fake.applyOutcome = (tx) => !tx.txes.some((t: any) => t.objectClass === traceability.class.TraceLink)
    await expect(
      convertLeadToRequirement(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { lead: LEAD_ID, idempotencyKey: 'key-a' }
      )
    ).rejects.toThrow(/failed to commit/)
    expect((h.db.docs.get(LEAD_ID) as Lead).status).toBe('Qualifying')

    // Key B arrives. The inner per-lead claim is `failed`, so it is preempted
    // and the body re-enters onto the SAME derived ids.
    h.fake.applyOutcome = () => true
    const second = await convertLeadToRequirement(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { lead: LEAD_ID, idempotencyKey: 'key-b' }
    )

    expect(second.result.requirement).toBe(requirementId)
    expect(countOf(h.db, requirements.masterTag.Requirement as Ref<any>)).toBe(1)
    expect(countOf(h.db, traceability.class.TraceLink)).toBe(1)
    expect(countOf(h.db, activity.class.DocUpdateMessage)).toBe(2)
    expect((h.db.docs.get(LEAD_ID) as Lead).status).toBe('Converted')
  })

  it('refuses to stamp Converted over a status that moved under it', async () => {
    const h = await makeHarness()
    // Someone disqualifies the lead after step 0 read it as Qualifying.
    h.fake.applyOutcome = (tx) => {
      if (tx.txes.some((t: any) => t.objectClass === traceability.class.TraceLink)) {
        ;(h.db.docs.get(LEAD_ID) as Lead).status = 'Disqualified'
      }
      return true
    }

    await expect(
      convertLeadToRequirement(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { lead: LEAD_ID, idempotencyKey: KEY }
      )
    ).rejects.toThrow("Command step 'set lead status to Converted' failed to commit")

    // 🔴 The blind write would have produced 'Converted' here.
    expect((h.db.docs.get(LEAD_ID) as Lead).status).toBe('Disqualified')
  })

  it('refuses a lead marked Converted that carries no edge', async () => {
    const h = await makeHarness('Converted')
    await expect(
      convertLeadToRequirement(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { lead: LEAD_ID, idempotencyKey: KEY }
      )
    ).rejects.toMatchObject({ reason: 'converted-without-link' })
  })

  it('translates a foreign document squatting the derived requirement id', async () => {
    const h = await makeHarness()
    const requirementId = requirementIdFor()
    // Same `_id`, different class: the class-pinned `findOne` reads it as
    // absent, so only the primary-key collision can catch it.
    h.db.docs.set(requirementId, {
      _id: requirementId,
      _class: crmLite.masterTag.Lead as Ref<any>,
      space: crmLite.space.Crm as Ref<any>,
      modifiedBy: core.account.System,
      modifiedOn: Date.now()
    } as unknown as Doc)

    await expect(
      convertLeadToRequirement(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { lead: LEAD_ID, idempotencyKey: KEY }
      )
    ).rejects.toMatchObject({ reason: 'requirement-id-taken' })
    expect(countOf(h.db, traceability.class.TraceLink)).toBe(0)
  })

  it('refuses a missing lead', async () => {
    const h = await makeHarness()
    await expect(
      convertLeadToRequirement(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { lead: 'ffffffffffffffffffffffff' as Ref<Lead>, idempotencyKey: KEY }
      )
    ).rejects.toBeInstanceOf(ConvertLeadError)
  })

  it('fails closed when the endpoint registry does not know the classes', async () => {
    const h = await makeHarness()
    await expect(
      convertLeadToRequirement(
        { ctx: h.ctx, client: h.client, runner: h.runner, endpoints: new Map() },
        { lead: LEAD_ID, idempotencyKey: KEY }
      )
    ).rejects.toMatchObject({ reason: 'invalid-trace-link' })
    expect(countOf(h.db, requirements.masterTag.Requirement as Ref<any>)).toBe(0)
  })

  it('derives ids that look exactly like generateId() output', () => {
    expect(requirementIdFor()).toMatch(/^[0-9a-f]{24}$/)
    expect(requirementIdFor()).toBe(requirementIdFor())
    expect(requirementIdFor()).not.toBe(requirementIdFor('bbbbbbbbbbbbbbbbbbbbbbb2' as Ref<Lead>))
    // Length prefixing keeps the three-field encoding injective.
    expect(commandObjectId('a', 'b c', 'd')).not.toBe(commandObjectId('a', 'b', 'c d'))
  })

  it('rejects a pipeline with no command runner registered', () => {
    expect(() => getCommandRunner({ contextVars: {} } as unknown as PipelineContext)).toThrow(commandRunnerContextVar)
  })
})

describe('freezing the converted lead', () => {
  it('marks every business field read only, including title', async () => {
    const h = await makeHarness()
    await convertLeadToRequirement(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { lead: LEAD_ID, idempotencyKey: KEY }
    )

    const lead = h.db.docs.get(LEAD_ID) as Lead
    expect(lead.readonlyFields).toEqual(expect.arrayContaining(CONVERTED_LEAD_READONLY_FIELDS))
    // 🔴 `title` is the entry the whole-form lock hangs off: `EditCardNew`
    // derives its panel-wide `_readonly` from it, and that is what disables the
    // content editor and the tag editor. Without it the form is only half frozen.
    expect(lead.readonlyFields).toContain('title')
    // 🔴 NOT `readonly`. That field belongs to `VersionableDoc` and is written
    // by `VersioningMiddleware` to mean "superseded revision"; a converted lead
    // is the CURRENT revision.
    expect((lead as any).readonly).toBeUndefined()
  })

  it('writes the marker once — a replay adds no second transaction', async () => {
    const h = await makeHarness()
    await convertLeadToRequirement(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { lead: LEAD_ID, idempotencyKey: KEY }
    )
    const after = (h.db.docs.get(LEAD_ID) as Lead).readonlyFields as string[]
    const txesBefore = h.fake.seen.length

    // A different key re-enters the body (the inner lead claim replays), and the
    // same key replays from the ledger. Neither may duplicate the field list.
    await convertLeadToRequirement(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { lead: LEAD_ID, idempotencyKey: 'second-key' }
    )
    await convertLeadToRequirement(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { lead: LEAD_ID, idempotencyKey: KEY }
    )

    const lead = h.db.docs.get(LEAD_ID) as Lead
    expect(lead.readonlyFields).toEqual(after)
    expect(new Set(lead.readonlyFields).size).toBe(lead.readonlyFields?.length)
    // The replays wrote ledger rows, but nothing touched the lead again.
    const leadUpdates = h.fake.seen.slice(txesBefore).filter((tx) => JSON.stringify(tx).includes('readonlyFields'))
    expect(leadUpdates).toHaveLength(0)
  })

  it('leaves a lead that never converted untouched', async () => {
    const h = await makeHarness('Disqualified')
    await expect(
      convertLeadToRequirement(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { lead: LEAD_ID, idempotencyKey: KEY }
      )
    ).rejects.toBeInstanceOf(ConvertLeadError)
    // ⚠️ `Disqualified` is deliberately NOT a frozen state: `leadGuard` permits
    // editing the disqualification reason, so locking the form would contradict
    // the server.
    expect((h.db.docs.get(LEAD_ID) as Lead).readonlyFields).toBeUndefined()
  })
})

describe('convertLeadToRequirement: the ledger replay must not answer a caller who lost read access', () => {
  it('refuses a replay to a caller who may not read the lead', async () => {
    // 🔴 THE REPLAY NEVER ENTERS THE BODY. `CommandMiddleware.resume` returns a
    // `succeeded` row's stored result verbatim, and BOTH claims are keyed on
    // caller-supplied data — the outer key is derived from the lead, the inner
    // one IS the lead. So without a check outside the runner, anyone naming a
    // converted lead would be handed the original caller's result: the
    // Requirement and TraceLink refs, plus the fact that the lead exists and
    // was converted.
    const h = await makeHarness()
    const input = { lead: LEAD_ID, idempotencyKey: KEY }

    const first = await convertLeadToRequirement({ ctx: h.ctx, client: h.client, runner: h.runner }, input)
    expect(first.result.requirement).toBeDefined()

    // The lead becomes unreadable to this caller.
    h.db.hidden.add(LEAD_ID)

    // Same key — the outer ledger row would replay …
    await expect(convertLeadToRequirement({ ctx: h.ctx, client: h.client, runner: h.runner }, input)).rejects.toThrow(
      /does not exist/
    )

    // … and a DIFFERENT key, which would still replay the inner lead claim.
    await expect(
      convertLeadToRequirement(
        { ctx: h.ctx, client: h.client, runner: h.runner },
        { lead: LEAD_ID, idempotencyKey: 'attacker' }
      )
    ).rejects.toThrow(/does not exist/)
  })

  it('still replays normally for a caller who CAN read the lead', async () => {
    // The guard must not break the legitimate replay it sits in front of:
    // re-clicking convert opens the original requirement (CRM-T005).
    const h = await makeHarness()
    const input = { lead: LEAD_ID, idempotencyKey: KEY }

    const first = await convertLeadToRequirement({ ctx: h.ctx, client: h.client, runner: h.runner }, input)
    const again = await convertLeadToRequirement({ ctx: h.ctx, client: h.client, runner: h.runner }, input)

    expect(again.replayed).toBe(true)
    expect(again.result.requirement).toBe(first.result.requirement)
    expect(countOf(h.db, requirements.masterTag.Requirement as Ref<any>)).toBe(1)
  })
})

describe('convertLeadToRequirement: one caller key cannot replay across two leads', () => {
  const OTHER_LEAD = '000000000000000000000042' as Ref<Lead>

  function seedSecondLead (h: Harness): void {
    h.db.docs.set(OTHER_LEAD, {
      _id: OTHER_LEAD,
      _class: crmLite.masterTag.Lead as Ref<any>,
      space: crmLite.space.Crm as Ref<any>,
      modifiedBy: core.account.System,
      modifiedOn: Date.now(),
      title: 'Globex wants SSO',
      status: 'Qualifying',
      priority: 'High'
    } as unknown as Lead)
  }

  it("does not hand lead A's requirement to a call that names lead B", async () => {
    // 🔴 `commandExecutionId` is `sha256(command + ' ' + idempotencyKey)`. With a
    // CONSTANT command name the outer ledger row is addressed entirely by a key
    // the CALLER supplies, so presenting a key that already succeeded for lead A
    // while naming lead B would replay A's stored result — Requirement ref and
    // all — WITHOUT entering the body. The pre-runner readability check does not
    // catch it: it only ever inspects the lead that was NAMED, and B is
    // perfectly readable.
    const h = await makeHarness()
    seedSecondLead(h)
    const sharedKey = KEY

    const first = await convertLeadToRequirement(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { lead: LEAD_ID, idempotencyKey: sharedKey }
    )
    expect(first.result.requirement).toBeDefined()

    const second = await convertLeadToRequirement(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { lead: OTHER_LEAD, idempotencyKey: sharedKey }
    )

    expect(second.result.lead).toBe(OTHER_LEAD)
    expect(second.result.requirement).not.toBe(first.result.requirement)
    expect(second.replayed).toBe(false)
  })

  it('keeps the two outer ledger rows disjoint', async () => {
    // Pins the mechanism rather than the symptom: same key, two subjects, two
    // rows, each named after its own lead.
    const h = await makeHarness()
    seedSecondLead(h)

    await convertLeadToRequirement(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { lead: LEAD_ID, idempotencyKey: KEY }
    )
    await convertLeadToRequirement(
      { ctx: h.ctx, client: h.client, runner: h.runner },
      { lead: OTHER_LEAD, idempotencyKey: KEY }
    )

    const commands = (h.db.find(serverAgentraCore.class.CommandExecution, {}) as any[]).map((e) => e.command as string)
    expect(commands).toContain(convertLeadCommandNamespace(LEAD_ID))
    expect(commands).toContain(convertLeadCommandNamespace(OTHER_LEAD))
    // ⚠️ And the bare command name is NOT a row: that is the whole point.
    expect(commands).not.toContain(CONVERT_LEAD_TO_REQUIREMENT)
  })
})
