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

import core, {
  TxProcessor,
  type Doc,
  type Hierarchy,
  type MeasureContext,
  type OperationDomain,
  type PersonId,
  type Ref,
  type SessionData,
  type Tx,
  type TxApplyIf,
  type TxCreateDoc,
  type TxUpdateDoc
} from '@hcengineering/core'
import crmLite, { type Lead } from '@hcengineering/crm-lite'
import requirements, { type Requirement } from '@hcengineering/requirements'
import traceability, { type TraceLink } from '@hcengineering/traceability'
import { commandObjectId } from '@hcengineering/server-agentra-core'
import type { Middleware, PipelineContext, TxMiddlewareResult } from '@hcengineering/server-core'

import { CommandMiddleware } from '../commandMiddleware'
import {
  AGENTRA_COMMAND_DOMAIN,
  AGENTRA_OP_CONVERT_LEAD,
  AgentraCommandRequestMiddleware,
  toCommandResult
} from '../commandRequest'
import { CONVERT_LEAD_LOCK, ConvertLeadError, convertLeadRoles } from '../commands/convertLeadToRequirement'

const LEAD_ID = 'aaaaaaaaaaaaaaaaaaaaaaa1' as Ref<Lead>
const KEY = 'request-key-1'

/** The CALLER. Deliberately not `core.account.System`. */
const ALICE = 'alice-social-id' as PersonId

class MemoryDb {
  readonly docs = new Map<Ref<Doc>, Doc>()

  find (_class: Ref<any>, query: Record<string, any>): Doc[] {
    const out: Doc[] = []
    for (const doc of this.docs.values()) {
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

/**
 * Stands in for the whole chain BELOW the head, i.e. what
 * `SessionPipelineClient` reaches through `context.head`.
 *
 * It records the account on every ctx it is handed, which is what proves the
 * caller's session — not a system one — is the identity the middleware runs on.
 */
class HeadAdapter implements Middleware {
  readonly accounts: PersonId[] = []

  constructor (readonly db: MemoryDb) {}

  async tx (ctx: MeasureContext<SessionData>, txes: Tx[]): Promise<TxMiddlewareResult> {
    this.accounts.push(ctx.contextData.account.primarySocialId)
    const results: any[] = []
    for (const tx of txes) {
      if (tx._class === core.class.TxApplyIf) {
        const applyIf = tx as TxApplyIf
        // Mirrors `ApplyTxMiddleware.tx`: match/notMatch only when scoped.
        const matched =
          applyIf.scope == null ||
          ((applyIf.match ?? []).every(({ _class, query }) => this.db.find(_class, query).length > 0) &&
            (applyIf.notMatch ?? []).every(({ _class, query }) => this.db.find(_class, query).length === 0))
        if (matched) {
          for (const inner of applyIf.txes) {
            this.db.apply(inner)
          }
        }
        results.push({ success: matched, derived: [], serverTime: 0 })
        continue
      }
      this.db.apply(tx)
      if (tx._class === core.class.TxUpdateDoc && (tx as TxUpdateDoc<Doc>).retrieve === true) {
        results.push({ object: { ...(this.db.docs.get((tx as TxUpdateDoc<Doc>).objectId) as Doc) } })
      }
    }
    return results.length === 1 ? results[0] : results
  }

  async findAll (ctx: MeasureContext<SessionData>, _class: Ref<any>, query: any): Promise<any> {
    this.accounts.push(ctx.contextData.account.primarySocialId)
    return this.db.find(_class, query)
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

/** The ledger side, below `CommandMiddleware`. Same store. */
class LedgerAdapter extends HeadAdapter {}

function makeCtx (user: PersonId = ALICE): MeasureContext<SessionData> {
  const ctx: any = {
    contextData: { account: { uuid: 'alice', primarySocialId: user } },
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
  head: HeadAdapter
  middleware: AgentraCommandRequestMiddleware
  context: PipelineContext
  next: Middleware
}

async function makeHarness (leadStatus: Lead['status'] = 'Qualifying'): Promise<Harness> {
  const db = new MemoryDb()
  const ctx = makeCtx()
  const head = new HeadAdapter(db)

  const context = {
    contextVars: {},
    // `TxOperations` asks exactly these two questions before building a tx.
    hierarchy: {
      isDerived: (_class: Ref<any>, from: Ref<any>) => from === core.class.Doc,
      findDomain: () => undefined
    } as unknown as Hierarchy,
    modelDb: {} as any
  } as unknown as PipelineContext

  await CommandMiddleware.create(ctx, context, new LedgerAdapter(db))

  const next = {
    domainRequest: async (_ctx: any, domain: OperationDomain) => ({ domain, value: 'forwarded' })
  } as unknown as Middleware

  const middleware = (await AgentraCommandRequestMiddleware.create(
    ctx,
    context,
    next
  )) as AgentraCommandRequestMiddleware
  // Assigned by `PipelineImpl.create` in production; assigned here for the same
  // reason — it is the entry point a client request comes in through.
  ;(context as any).head = head

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

  return { ctx, db, head, middleware, context, next }
}

async function invoke (h: Harness, params: any, ctx?: MeasureContext<SessionData>): Promise<any> {
  const result = await h.middleware.domainRequest(ctx ?? h.ctx, AGENTRA_COMMAND_DOMAIN, {
    [AGENTRA_OP_CONVERT_LEAD]: { params }
  })
  return (result as any).value
}

function requirementIdFor (lead: Ref<Lead> = LEAD_ID): Ref<Requirement> {
  return commandObjectId<Requirement>(CONVERT_LEAD_LOCK, lead, convertLeadRoles.requirement)
}

describe('AgentraCommandRequestMiddleware', () => {
  it('actually runs convertLeadToRequirement and returns its outcome', async () => {
    const h = await makeHarness()
    const value = await invoke(h, { lead: LEAD_ID, idempotencyKey: KEY })

    expect(value.ok).toBe(true)
    expect(value.replayed).toBe(false)
    expect(value.result).toMatchObject({
      lead: LEAD_ID,
      requirement: requirementIdFor(),
      alreadyConverted: false
    })
    // The writes really landed, through the head.
    expect(h.db.find(requirements.masterTag.Requirement as Ref<any>, {})).toHaveLength(1)
    expect(h.db.find(traceability.class.TraceLink, {})).toHaveLength(1)
    expect((h.db.docs.get(LEAD_ID) as Lead).status).toBe('Converted')
  })

  it('replays the same idempotency key without a second requirement', async () => {
    const h = await makeHarness()
    const input = { lead: LEAD_ID, idempotencyKey: KEY }
    await invoke(h, input)
    const again = await invoke(h, input)

    expect(again.ok).toBe(true)
    expect(again.replayed).toBe(true)
    expect(h.db.find(requirements.masterTag.Requirement as Ref<any>, {})).toHaveLength(1)
  })

  // ── identity ──────────────────────────────────────────────────────────────
  it('🔴 writes as the CALLER, not as the system account', async () => {
    const h = await makeHarness()
    await invoke(h, { lead: LEAD_ID, idempotencyKey: KEY })

    const requirement = h.db.docs.get(requirementIdFor()) as Doc
    expect(requirement.modifiedBy).toBe(ALICE)
    const trace = h.db.find(traceability.class.TraceLink, {})[0] as TraceLink
    expect(trace.modifiedBy).toBe(ALICE)
    // And every trip through the head carried that same session account.
    expect(new Set(h.head.accounts)).toEqual(new Set([ALICE]))
  })

  it('🔴 clears isTriggerCtx on every read so the Postgres ACL is never skipped', async () => {
    const h = await makeHarness()
    const seen: Array<boolean | undefined> = []
    const realFind = h.head.findAll.bind(h.head)
    ;(h.head as any).findAll = async (ctx: any, ...rest: any[]) => {
      seen.push(ctx.contextData.isTriggerCtx)
      // A trigger fired by one of the command's own writes would set this.
      ctx.contextData.isTriggerCtx = true
      return (realFind as any)(ctx, ...rest)
    }
    ;(h.ctx.contextData as any).isTriggerCtx = true

    await invoke(h, { lead: LEAD_ID, idempotencyKey: KEY })

    expect(seen.length).toBeGreaterThan(1)
    // Every read the COMMAND makes arrives with the flag cleared, even though
    // something keeps setting it back between calls.
    expect(seen.filter((v) => v === true)).toEqual([])
  })

  it('🔴 refuses to run when the session carries no account', async () => {
    const h = await makeHarness()
    const anon = makeCtx()
    ;(anon.contextData as any).account = undefined
    await expect(invoke(h, { lead: LEAD_ID, idempotencyKey: KEY }, anon)).rejects.toThrow(/no caller account/)
    expect(h.db.find(requirements.masterTag.Requirement as Ref<any>, {})).toHaveLength(0)
  })

  it('🔴 refuses to run when the pipeline head is missing', async () => {
    const h = await makeHarness()
    ;(h.context as any).head = undefined
    await expect(invoke(h, { lead: LEAD_ID, idempotencyKey: KEY })).rejects.toThrow(/pipeline head is not available/)
  })

  // ── error mapping ─────────────────────────────────────────────────────────
  it('🔴 maps a live concurrent claim to 409, visible to the caller', async () => {
    const h = await makeHarness()
    const input = { lead: LEAD_ID, idempotencyKey: KEY }

    // Hold the first body open so its claim is live and not yet stale.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // ⚠️ Gate the SECOND read, not the first. `convertLeadToRequirement` now
    // re-reads the lead BEFORE the runner, to stop a ledger replay from
    // answering a caller who may not read it — so parking on read #1 would
    // freeze the first attempt before it ever claims, and the second caller
    // would find nothing live to collide with. Read #2 is taken after the
    // claim is held, which is the state this test is about.
    let reads = 0
    const realFind = h.head.findAll.bind(h.head)
    ;(h.head as any).findAll = async (...args: any[]) => {
      if (++reads === 2) {
        await gate
      }
      return (realFind as any)(...args)
    }

    const first = invoke(h, input)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const second = await invoke(h, input)
    expect(second).toMatchObject({ ok: false, code: 409, reason: 'command-in-progress' })
    expect(second.message).toContain(KEY)

    release()
    const done = await first
    expect(done.ok).toBe(true)
    expect(h.db.find(requirements.masterTag.Requirement as Ref<any>, {})).toHaveLength(1)
  })

  it('maps an illegal lead transition to 400 with the command reason', async () => {
    for (const status of ['New', 'Contacted', 'Disqualified'] as const) {
      const h = await makeHarness(status)
      const value = await invoke(h, { lead: LEAD_ID, idempotencyKey: `${KEY}-${status}` })
      expect(value).toMatchObject({ ok: false, code: 400, reason: 'illegal-transition' })
      expect(h.db.find(requirements.masterTag.Requirement as Ref<any>, {})).toHaveLength(0)
    }
  })

  it('maps a missing lead to 400', async () => {
    const h = await makeHarness()
    h.db.docs.delete(LEAD_ID)
    const value = await invoke(h, { lead: LEAD_ID, idempotencyKey: KEY })
    expect(value).toMatchObject({ ok: false, code: 400, reason: 'lead-not-found' })
  })

  it('rejects a request with no idempotency key instead of inventing one', async () => {
    const h = await makeHarness()
    const value = await invoke(h, { lead: LEAD_ID })
    expect(value).toMatchObject({ ok: false, code: 400, reason: 'malformed-input' })
    expect(h.db.find(requirements.masterTag.Requirement as Ref<any>, {})).toHaveLength(0)
  })

  it('rejects a request with no lead', async () => {
    const h = await makeHarness()
    expect(await invoke(h, { idempotencyKey: KEY })).toMatchObject({ ok: false, code: 400, reason: 'malformed-input' })
    expect(await invoke(h, undefined)).toMatchObject({ ok: false, code: 400, reason: 'malformed-input' })
  })

  // ── routing ───────────────────────────────────────────────────────────────
  it('forwards every other domain untouched', async () => {
    const h = await makeHarness()
    const result = (await h.middleware.domainRequest(h.ctx, 'communication' as OperationDomain, {})) as any
    expect(result.value).toBe('forwarded')
  })

  it('reports an unknown operation as "no handler" (null)', async () => {
    const h = await makeHarness()
    const result = (await h.middleware.domainRequest(h.ctx, AGENTRA_COMMAND_DOMAIN, { nope: { params: {} } })) as any
    expect(result.value).toBeNull()
  })
})

describe('toCommandResult', () => {
  it('keeps 409 and 400 apart and reads the code off the error class', () => {
    expect(toCommandResult(new ConvertLeadError('lead-not-found', 'gone'))).toEqual({
      ok: false,
      code: 400,
      reason: 'lead-not-found',
      message: 'gone',
      // ⚠️ `convertLeadToRequirement`'s refusal paths have not been walked one
      // by one, so the envelope says so rather than guessing 'none'.
      partialWrite: 'unclassified'
    })
  })

  it('🔴 rethrows anything it does not recognise rather than faking a 400', () => {
    const boom = new Error('adapter exploded')
    expect(() => toCommandResult(boom)).toThrow(boom)
  })
})
