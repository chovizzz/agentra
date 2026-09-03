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
// Shared in-memory pipeline for the Task 15 command tests.
//
// ⚠️ NOT a `*.test.ts`, so jest's `testMatch` leaves it alone.
//
// ⚠️ SCOPE. There is no `TriggersMiddleware` here, so the only activity records
// in the store are the ones a command wrote itself. In production the platform
// also generates activity for the ordinary create/update transactions; the
// assertions built on this harness are about the commands' OWN explicit
// trace-edge records, which is the interesting part precisely because
// `DOMAIN_RELATION` produces none.

import core, {
  TxOperations,
  TxProcessor,
  getObjectValue,
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
  type TxMixin,
  type TxResult,
  type TxUpdateDoc
} from '@hcengineering/core'
import type { Middleware, PipelineContext, TxMiddlewareResult } from '@hcengineering/server-core'

import { CommandMiddleware } from '../commandMiddleware'
import { getCommandRunner, type CommandRunner } from '../commands/convertLeadToRequirement'

/** One store shared by the idempotency ledger and the domain objects. */
export class MemoryDb {
  readonly docs = new Map<Ref<Doc>, Doc>()
  /** Ids the security filter hides from `find`, so permission tests are real. */
  readonly hidden = new Set<Ref<Doc>>()

  find (_class: Ref<any>, query: Record<string, any>): Doc[] {
    const out: Doc[] = []
    for (const doc of this.docs.values()) {
      if (this.hidden.has(doc._id)) continue
      // `core.class.Doc` stands in for "any class"; everything else matches
      // exactly, mirroring a pipeline whose reads always pin a concrete class.
      if (_class !== core.class.Doc && doc._class !== _class) continue
      let ok = true
      for (const [k, v] of Object.entries(query)) {
        // ⚠️ `getObjectValue`, not `doc[k]`. Mixin state is nested under
        // `doc[<mixinId>]`, so every archive-related query names the DOTTED key
        // `<mixinId>.archived`; a bare property read would answer `undefined`
        // for all of them and silently return the wrong rows.
        if (!matches(getObjectValue(k, doc as any), v)) {
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
        // The genuine cross-process arbiter: `PRIMARY KEY("workspaceId", _id)`.
        const err: any = new Error('duplicate key value violates unique constraint')
        err.code = '23505'
        throw err
      }
      this.docs.set(create.objectId, TxProcessor.createDoc2Doc(create))
    } else if (tx._class === core.class.TxMixin) {
      // Mixin writes are how SYS-005's archive flag lands. Without this branch
      // they were dropped silently and an archive test would "pass" against a
      // document that never changed.
      const mixinTx = tx as TxMixin<Doc, Doc>
      const doc = this.docs.get(mixinTx.objectId)
      if (doc !== undefined) {
        TxProcessor.updateMixin4Doc(doc, mixinTx)
      }
    } else if (tx._class === core.class.TxUpdateDoc) {
      const update = tx as TxUpdateDoc<Doc>
      const doc = this.docs.get(update.objectId)
      if (doc !== undefined) {
        TxProcessor.applyUpdate(doc, { ...update.operations } as any)
      }
    }
  }
}

function matches (value: any, expected: any): boolean {
  if (expected != null && typeof expected === 'object' && !Array.isArray(expected)) {
    if (Array.isArray(expected.$in)) {
      return expected.$in.includes(value)
    }
    if ('$ne' in expected) {
      return value !== expected.$ne
    }
    if ('$exists' in expected) {
      return (value !== undefined) === (expected.$exists === true)
    }
  }
  return value === expected
}

/** Stands in for everything under `CommandMiddleware`, ledger side only. */
export class LedgerAdapter implements Middleware {
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
 * The domain client.
 *
 * `applyOutcome` lets a test make `ApplyTxMiddleware` REJECT a `TxApplyIf` the
 * way the real one does — by returning `success: false` rather than throwing.
 */
export class FakeClient implements Client {
  applyOutcome: (tx: TxApplyIf) => boolean = () => true
  readonly seen: Tx[] = []

  constructor (readonly db: MemoryDb) {}

  getHierarchy (): Hierarchy {
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
    if (tx._class === core.class.TxUpdateDoc && (tx as TxUpdateDoc<Doc>).retrieve === true) {
      return { object: { ...(this.db.docs.get((tx as TxUpdateDoc<Doc>).objectId) as Doc) } } as any
    }
    return {}
  }

  async close (): Promise<void> {}
}

export function makeCtx (): MeasureContext<SessionData> {
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

export interface Harness {
  ctx: MeasureContext<SessionData>
  db: MemoryDb
  client: TxOperations
  fake: FakeClient
  runner: CommandRunner
}

export async function makeHarness (): Promise<Harness> {
  const db = new MemoryDb()
  const ctx = makeCtx()
  const context = { contextVars: {} } as unknown as PipelineContext
  await CommandMiddleware.create(ctx, context, new LedgerAdapter(db))
  const runner = getCommandRunner(context)
  const fake = new FakeClient(db)
  return { ctx, db, client: new TxOperations(fake, core.account.System), fake, runner }
}

/** Put a plain document into the store without going through a transaction. */
export function seed<T extends Doc> (db: MemoryDb, doc: Partial<T> & { _id: Ref<any>, _class: Ref<any> }): T {
  const full = {
    space: core.space.Workspace,
    modifiedBy: core.account.System,
    modifiedOn: Date.now(),
    ...doc
  } as unknown as T
  db.docs.set(full._id, full)
  return full
}
