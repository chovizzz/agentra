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

import type {
  Class,
  Doc,
  MeasureContext,
  OperationDomain,
  PersonId,
  Ref,
  SessionData,
  Space
} from '@hcengineering/core'
import type { Middleware, PipelineContext } from '@hcengineering/server-core'
import {
  TRACEABILITY_DOMAIN,
  TRACE_OP_FIND_INCOMING,
  TRACE_OP_FIND_OUTGOING,
  type TraceLinksResult
} from '@hcengineering/server-traceability'
import traceability, { traceLinkId, type TraceLink } from '@hcengineering/traceability'

import { TraceabilityMiddleware } from '../middleware'

const REQ = 'requirement:class:Requirement' as Ref<Class<Doc>>
const CASE = 'test:class:TestCase' as Ref<Class<Doc>>
/** A subclass of CASE. Proves the class guard is `isDerived`, not `===`. */
const MANUAL_CASE = 'test:class:ManualTestCase' as Ref<Class<Doc>>

const REQ_ID = '111111111111111111111111' as Ref<Doc>
const CASE_ID = '222222222222222222222222' as Ref<Doc>

const WORKSPACE = 'core:space:Workspace' as Ref<Space>
const SYSTEM = 'core:account:System' as PersonId

const SECRET_TITLE = 'CLASSIFIED-payload-nobody-may-read'

/** `alice` sees everything; `mallory` sees only the near endpoint. */
const VISIBILITY: Record<string, Set<Ref<Doc>>> = {
  alice: new Set([REQ_ID, CASE_ID]),
  mallory: new Set([REQ_ID]),
  nobody: new Set()
}

function link (over: Partial<TraceLink> = {}): TraceLink {
  return {
    _id: traceLinkId('verifies', CASE_ID, REQ_ID),
    _class: traceability.class.TraceLink,
    space: WORKSPACE,
    modifiedBy: SYSTEM,
    modifiedOn: 1,
    docA: REQ_ID,
    sourceClass: REQ,
    docB: CASE_ID,
    targetClass: CASE,
    kind: 'verifies',
    sourceBaseId: REQ_ID,
    targetBaseId: CASE_ID,
    state: 'active',
    ...over
  }
}

function endpoints (caseClass: Ref<Class<Doc>> = CASE): Doc[] {
  return [
    { _id: REQ_ID, _class: REQ, space: WORKSPACE, modifiedBy: SYSTEM, modifiedOn: 1, title: 'public req' } as any,
    { _id: CASE_ID, _class: caseClass, space: WORKSPACE, modifiedBy: SYSTEM, modifiedOn: 1, title: SECRET_TITLE } as any
  ]
}

function sessionCtx (account: string): MeasureContext<SessionData> {
  return {
    contextData: { account: { uuid: account, primarySocialId: `${account}-social` } },
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any
}

interface Harness {
  middleware: TraceabilityMiddleware
  /** Calls that went DOWN the chain via `provideFindAll` — must stay empty. */
  nextFindAllCalls: number
  headFindAllAccounts: string[]
  /** `isTriggerCtx` as seen by the read that actually reaches the pipeline. */
  headTriggerFlags: Array<boolean | undefined>
}

/**
 * The fake head models the ONE thing that matters: what comes back depends on
 * `ctx.contextData.account`, exactly as `SpaceSecurityMiddleware.findAll` does
 * (`isSystem(account, ctx)` is `account.uuid === systemAccountUuid`, and the
 * allowed-space set is derived from that same account).
 */
function harness (links: TraceLink[], docs: Doc[], derived: Record<string, string[]> = {}): Harness {
  const state: Harness = {
    middleware: undefined as any,
    nextFindAllCalls: 0,
    headFindAllAccounts: [],
    headTriggerFlags: []
  }

  const head = {
    findAll: async (ctx: MeasureContext<SessionData>, _class: Ref<Class<Doc>>, query: any) => {
      const account = (ctx.contextData as any).account.uuid as string
      state.headFindAllAccounts.push(account)
      state.headTriggerFlags.push((ctx.contextData as any).isTriggerCtx)
      if (_class === traceability.class.TraceLink) {
        return links.filter((l) =>
          Object.entries(query).every(([k, v]: [string, any]) => {
            if (v !== null && typeof v === 'object' && '$in' in v) return (v.$in as any[]).includes((l as any)[k])
            return (l as any)[k] === v
          })
        )
      }
      const wanted: Array<Ref<Doc>> = query._id?.$in ?? []
      const allowed = VISIBILITY[account] ?? new Set<Ref<Doc>>()
      return docs.filter((d) => wanted.includes(d._id) && allowed.has(d._id))
    }
  } as unknown as Middleware

  // 🔴 If the middleware ever reaches for `provideFindAll` this blows up: that
  // path descends BELOW SpaceSecurityMiddleware and would be a system-level read.
  const next = {
    findAll: async () => {
      state.nextFindAllCalls++
      throw new Error('provideFindAll must never be used to resolve endpoints')
    },
    domainRequest: async (_ctx: any, domain: OperationDomain) => ({ domain, value: 'forwarded' })
  } as unknown as Middleware

  const context: PipelineContext = {
    head,
    hierarchy: {
      isDerived: (a: string, b: string) => a === b || (derived[a] ?? []).includes(b)
    },
    contextVars: {}
  } as any

  state.middleware = new (TraceabilityMiddleware as any)(context, next)
  return state
}

function query (doc: Ref<Doc>): any {
  return { doc }
}

describe('TraceabilityMiddleware', () => {
  it('answers findOutgoingLinks with links and coverage', async () => {
    const h = harness([link()], endpoints())
    const result = (await h.middleware.domainRequest(sessionCtx('alice'), TRACEABILITY_DOMAIN, {
      [TRACE_OP_FIND_OUTGOING]: { params: query(REQ_ID) }
    })) as any
    const value = result.value as TraceLinksResult

    expect(result.domain).toBe(TRACEABILITY_DOMAIN)
    expect(value.links).toHaveLength(1)
    expect(value.links[0].source.visible).toBe(true)
    expect(value.links[0].target.visible).toBe(true)
    expect(value.coverage).toEqual({ total: 1, visible: 1, restricted: 1 - 1, byKind: { verifies: 1 } })
  })

  it('answers findIncomingLinks off the docB side', async () => {
    const h = harness([link()], endpoints())
    const value = (
      (await h.middleware.domainRequest(sessionCtx('alice'), TRACEABILITY_DOMAIN, {
        [TRACE_OP_FIND_INCOMING]: { params: query(CASE_ID) }
      })) as any
    ).value as TraceLinksResult
    expect(value.links).toHaveLength(1)
    expect(value.links[0]._id).toBe(traceLinkId('verifies', CASE_ID, REQ_ID))
  })

  it('unpacks the inner `params` key, not `query`', async () => {
    const h = harness([link()], endpoints())
    const call = async (inner: string): Promise<any> =>
      await h.middleware.domainRequest(sessionCtx('alice'), TRACEABILITY_DOMAIN, {
        [TRACE_OP_FIND_OUTGOING]: { [inner]: query(REQ_ID) }
      } as any)

    expect((await call('params')).value.links).toHaveLength(1)
    // The client sends `{ findOutgoingLinks: { params } }`; a handler that read
    // `.query` instead would silently see `undefined` on every real request.
    await expect(call('query')).rejects.toThrow(/`doc` is required/)
  })

  // ── the security floor ────────────────────────────────────────────────────
  it('🔴 gives an unprivileged caller NOTHING about the far endpoint', async () => {
    const h = harness([link()], endpoints())
    const value = (
      (await h.middleware.domainRequest(sessionCtx('mallory'), TRACEABILITY_DOMAIN, {
        [TRACE_OP_FIND_OUTGOING]: { params: query(REQ_ID) }
      })) as any
    ).value as TraceLinksResult

    expect(value.links).toHaveLength(1)
    const target = value.links[0].target
    expect(target.visible).toBe(false)
    expect(target.doc).toBeUndefined()
    expect(target._class).toBeUndefined()
    // Nothing anywhere in the reply carries the protected content.
    expect(JSON.stringify(value)).not.toContain(SECRET_TITLE)
    expect(JSON.stringify(value)).not.toContain(CASE)
    // Restricted edges are counted but excluded from `visible`.
    expect(value.coverage).toEqual({ total: 1, visible: 0, restricted: 1, byKind: {} })
  })

  it('🔴 the SAME middleware answers differently per caller (identity comes from ctx)', async () => {
    const h = harness([link()], endpoints())
    const ask = async (account: string): Promise<TraceLinksResult> =>
      (
        (await h.middleware.domainRequest(sessionCtx(account), TRACEABILITY_DOMAIN, {
          [TRACE_OP_FIND_OUTGOING]: { params: query(REQ_ID) }
        })) as any
      ).value

    expect((await ask('alice')).links[0].target.visible).toBe(true)
    expect((await ask('mallory')).links[0].target.visible).toBe(false)
    // Every read carried the calling account, never a system one.
    expect(new Set(h.headFindAllAccounts)).toEqual(new Set(['alice', 'mallory']))
  })

  it('🔴 never resolves endpoints through provideFindAll (which bypasses space security)', async () => {
    const h = harness([link()], endpoints())
    await h.middleware.domainRequest(sessionCtx('alice'), TRACEABILITY_DOMAIN, {
      [TRACE_OP_FIND_OUTGOING]: { params: query(REQ_ID) }
    })
    expect(h.nextFindAllCalls).toBe(0)
    expect(h.headFindAllAccounts.length).toBeGreaterThan(0)
  })

  it('🔴 hides the whole edge when the NEAR endpoint is unreadable', async () => {
    const h = harness([link()], endpoints())
    const value = (
      (await h.middleware.domainRequest(sessionCtx('nobody'), TRACEABILITY_DOMAIN, {
        [TRACE_OP_FIND_OUTGOING]: { params: query(REQ_ID) }
      })) as any
    ).value as TraceLinksResult
    expect(value.links).toEqual([])
    expect(value.coverage).toEqual({ total: 0, visible: 0, restricted: 0, byKind: {} })
  })

  it('🔴 clears isTriggerCtx so the Postgres ACL is never skipped', async () => {
    const h = harness([link()], endpoints())
    const ctx = sessionCtx('alice')
    // What `TriggersMiddleware.processDerived` leaves behind on a shared context.
    ;(ctx.contextData as any).isTriggerCtx = true
    await h.middleware.domainRequest(ctx, TRACEABILITY_DOMAIN, {
      [TRACE_OP_FIND_OUTGOING]: { params: query(REQ_ID) }
    })
    // Every read that reached the pipeline carried the flag cleared...
    expect(h.headTriggerFlags.length).toBeGreaterThan(0)
    expect(h.headTriggerFlags.every((f) => f === false)).toBe(true)
    // ...and the CALLER's own session was not written to on the way. Clearing it
    // in place used to reach back into a context other work may still hold.
    expect((ctx.contextData as any).isTriggerCtx).toBe(true)
  })

  it('🔴 refuses to read at all when the pipeline head is missing', async () => {
    const h = harness([link()], endpoints())
    ;(h.middleware as any).context.head = undefined
    await expect(
      h.middleware.domainRequest(sessionCtx('alice'), TRACEABILITY_DOMAIN, {
        [TRACE_OP_FIND_OUTGOING]: { params: query(REQ_ID) }
      })
    ).rejects.toThrow(/pipeline head is not available/)
  })

  // ── the class guard ───────────────────────────────────────────────────────
  it('accepts a SUBCLASS endpoint (isDerived, not strict equality)', async () => {
    const h = harness([link()], endpoints(MANUAL_CASE), { [MANUAL_CASE]: [CASE] })
    const value = (
      (await h.middleware.domainRequest(sessionCtx('alice'), TRACEABILITY_DOMAIN, {
        [TRACE_OP_FIND_OUTGOING]: { params: query(REQ_ID) }
      })) as any
    ).value as TraceLinksResult
    expect(value.links[0].target.visible).toBe(true)
  })

  it('drops an endpoint whose class is not derived from the one asked for', async () => {
    // No `derived` mapping, so MANUAL_CASE is not a CASE as far as the
    // hierarchy is concerned and the endpoint fails closed.
    const h = harness([link()], endpoints(MANUAL_CASE))
    const value = (
      (await h.middleware.domainRequest(sessionCtx('alice'), TRACEABILITY_DOMAIN, {
        [TRACE_OP_FIND_OUTGOING]: { params: query(REQ_ID) }
      })) as any
    ).value as TraceLinksResult
    expect(value.links[0].target.visible).toBe(false)
    expect(JSON.stringify(value)).not.toContain(SECRET_TITLE)
  })

  // ── routing / degradation ─────────────────────────────────────────────────
  it('forwards every other domain untouched', async () => {
    const h = harness([], [])
    const result = (await h.middleware.domainRequest(sessionCtx('alice'), 'communication' as OperationDomain, {
      findMessagesMeta: { params: {} }
    })) as any
    expect(result.value).toBe('forwarded')
  })

  it('reports an unknown operation as "no handler" (null), never as zero links', async () => {
    const h = harness([link()], endpoints())
    const result = (await h.middleware.domainRequest(sessionCtx('alice'), TRACEABILITY_DOMAIN, {
      findSomethingElse: { params: {} }
    })) as any
    expect(result.value).toBeNull()
  })

  it('degrades to `{ domain, value: null }` when it is not in the chain at all', async () => {
    // What the client sees today: BaseMiddleware.provideDomainRequest with no
    // next. `parseTraceLinksResult` maps this to `available: false`.
    const bareContext: PipelineContext = { contextVars: {} } as any
    const bare = new (TraceabilityMiddleware as any)(bareContext, undefined)
    const result = await bare.domainRequest(sessionCtx('alice'), 'some-other-domain' as OperationDomain, {})
    expect(result).toEqual({ domain: 'some-other-domain', value: null })
  })

  it('rejects a malformed query rather than reading with an undefined doc', async () => {
    const h = harness([link()], endpoints())
    await expect(
      h.middleware.domainRequest(sessionCtx('alice'), TRACEABILITY_DOMAIN, {
        [TRACE_OP_FIND_OUTGOING]: { params: {} }
      })
    ).rejects.toThrow(/`doc` is required/)
  })
})
