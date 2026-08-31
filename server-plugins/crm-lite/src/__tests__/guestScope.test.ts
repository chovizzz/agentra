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
  AccountRole,
  toFindResult,
  TxFactory,
  type Account,
  type AccountUuid,
  type Class,
  type Doc,
  type MeasureContext,
  type Ref,
  type Space,
  type Tx
} from '@hcengineering/core'
import crmLite, { type Lead } from '@hcengineering/crm-lite'
import type { Middleware, PipelineContext } from '@hcengineering/server-core'

import { CRM_SPACE, guestScopeKey, isCrmMembershipGrantTx, scopeGuestQuery } from '../guestScope'
import { LeadGuardMiddleware } from '../leadGuard'

const LEAD_CLASS = crmLite.masterTag.Lead as Ref<Class<Doc>>
const OTHER_SPACE = 'crm-lite:space:NotCrm' as Ref<Space>
const LEAD_ID = '000000000000000000000001' as Ref<Lead>
const GUEST_UUID = 'guest-uuid' as AccountUuid

const derivedFrom: Record<string, string[]> = {}

const hierarchy = {
  hasClass: (_class: string) => true,
  isDerived: (a: string, b: string) => a === b || (derivedFrom[a] ?? []).includes(b),
  findDomain: (_class: string) => (_class === core.class.Tx ? 'tx' : _class === core.class.Space ? 'space' : 'lead')
} as any

/** The bottom of the chain: records every query and every write it is handed. */
class Recorder implements Partial<Middleware> {
  readonly written: Tx[] = []
  readonly queries: Array<Record<string, any>> = []
  searched = 0

  async tx (_ctx: MeasureContext, txes: Tx[]): Promise<any> {
    this.written.push(...txes)
    return {}
  }

  async findAll (_ctx: MeasureContext, _class: Ref<Class<Doc>>, query: Record<string, any>): Promise<any> {
    this.queries.push(query)
    return toFindResult([] as any)
  }

  async searchFulltext (): Promise<any> {
    this.searched++
    return { docs: [{ id: 'leak' }], total: 1 }
  }
}

async function guard (): Promise<{ mw: Middleware, sink: Recorder }> {
  const sink = new Recorder()
  const mw = (await LeadGuardMiddleware.create(
    {} as any,
    { hierarchy, contextVars: {} } as any as PipelineContext,
    sink as any
  )) as Middleware
  return { mw, sink }
}

function account (role: AccountRole, uuid: AccountUuid = GUEST_UUID): Account {
  return { uuid, role, primarySocialId: 'anon', socialIds: [], fullSocialIds: [] } as any
}

/** A session context carrying an account, which is the ONLY guest-scope signal. */
function session (role: AccountRole): MeasureContext {
  return { contextData: { account: account(role) } } as any
}

const factory = new TxFactory(core.account.System, true)

function pushMember (space: Ref<Space> = CRM_SPACE): Tx {
  return factory.createTxUpdateDoc(core.class.Space, core.space.Space, space, {
    $push: { members: GUEST_UUID }
  } as any)
}

describe('guestScopeKey', () => {
  it('mirrors SpaceSecurityMiddleware.getKey for the two domains that differ', () => {
    // The transaction domain keeps the real space on `objectSpace`; filtering
    // on `space` there would leave every lead readable through its own
    // TxCreateDoc.
    expect(guestScopeKey('tx')).toBe('objectSpace')
    expect(guestScopeKey('space')).toBeUndefined()
  })

  it('uses `space` for every data domain', () => {
    expect(guestScopeKey('lead')).toBe('space')
    expect(guestScopeKey('attachment')).toBe('space')
  })
})

describe('scopeGuestQuery', () => {
  it('adds an exclusion when the query says nothing about the space', () => {
    expect(scopeGuestQuery('space', { title: 'Acme' } as any)).toEqual({
      verdict: 'pass',
      query: { title: 'Acme', space: { $nin: [CRM_SPACE] } }
    })
  })

  it('denies a query pinned to the CRM space, and leaves other spaces alone', () => {
    expect(scopeGuestQuery('space', { space: CRM_SPACE } as any)).toEqual({ verdict: 'deny' })
    expect(scopeGuestQuery('space', { space: OTHER_SPACE } as any)).toEqual({
      verdict: 'pass',
      query: { space: OTHER_SPACE }
    })
  })

  it('subtracts the CRM space from an $in rather than adding a second predicate', () => {
    expect(scopeGuestQuery('space', { space: { $in: [CRM_SPACE, OTHER_SPACE] } } as any)).toEqual({
      verdict: 'pass',
      query: { space: { $in: [OTHER_SPACE] } }
    })
    expect(scopeGuestQuery('space', { space: { $in: [CRM_SPACE] } } as any)).toEqual({ verdict: 'deny' })
  })

  it('merges into an existing $nin without dropping what was there', () => {
    expect(scopeGuestQuery('space', { space: { $nin: [OTHER_SPACE] } } as any)).toEqual({
      verdict: 'pass',
      query: { space: { $nin: [OTHER_SPACE, CRM_SPACE] } }
    })
  })

  it('is idempotent, so a re-scoped query does not grow', () => {
    const once = scopeGuestQuery('space', {} as any)
    expect(once.verdict).toBe('pass')
    const twice = scopeGuestQuery('space', (once as any).query)
    expect(twice).toEqual(once)
  })

  it('preserves sibling operators on the same key', () => {
    expect(scopeGuestQuery('space', { space: { $ne: OTHER_SPACE } } as any)).toEqual({
      verdict: 'pass',
      query: { space: { $ne: OTHER_SPACE, $nin: [CRM_SPACE] } }
    })
  })

  it('denies a bare array instead of decorating it with a $nin key', () => {
    // `typeof [] === 'object'`, so the merge branch would produce
    // `{ 0: crm, 1: other, $nin: [crm] }` — a query that constrains nothing.
    expect(scopeGuestQuery('space', { space: [CRM_SPACE, OTHER_SPACE] } as any)).toEqual({ verdict: 'deny' })
  })

  it('denies a shape it does not understand rather than passing it through', () => {
    expect(scopeGuestQuery('space', { space: 42 } as any)).toEqual({ verdict: 'deny' })
  })
})

describe('isCrmMembershipGrantTx', () => {
  it('matches the $push OnEmployeeCreate emits for a granted space', () => {
    expect(isCrmMembershipGrantTx(pushMember())).toBe(true)
  })

  it('matches a whole-array members rewrite from the space editor', () => {
    const tx = factory.createTxUpdateDoc(core.class.Space, core.space.Space, CRM_SPACE, {
      members: [GUEST_UUID]
    } as any)
    expect(isCrmMembershipGrantTx(tx)).toBe(true)
  })

  it('ignores the same push on any other space', () => {
    expect(isCrmMembershipGrantTx(pushMember(OTHER_SPACE))).toBe(false)
  })

  it('never blocks a removal — evicting a guest is the point', () => {
    const tx = factory.createTxUpdateDoc(core.class.Space, core.space.Space, CRM_SPACE, {
      $pull: { members: GUEST_UUID }
    } as any)
    expect(isCrmMembershipGrantTx(tx)).toBe(false)
  })

  it('ignores updates to the CRM space that are not about members', () => {
    const tx = factory.createTxUpdateDoc(core.class.Space, core.space.Space, CRM_SPACE, {
      name: 'CRM'
    } as any)
    expect(isCrmMembershipGrantTx(tx)).toBe(false)
  })

  it('ignores non-CUD transactions', () => {
    expect(isCrmMembershipGrantTx({ _class: core.class.TxWorkspaceEvent } as any)).toBe(false)
  })
})

describe('LeadGuardMiddleware: guest scope, write half', () => {
  it('drops the membership grant a guest session would otherwise be handed', async () => {
    const { mw, sink } = await guard()
    await mw.tx(session(AccountRole.Guest), [pushMember()])
    expect(sink.written).toHaveLength(0)
  })

  it('keeps the guest membership of every OTHER space in the same batch', async () => {
    const { mw, sink } = await guard()
    await mw.tx(session(AccountRole.Guest), [pushMember(), pushMember(OTHER_SPACE)])
    expect(sink.written).toHaveLength(1)
    expect((sink.written[0] as any).objectId).toBe(OTHER_SPACE)
  })

  it('lets a Maintainer add a member on purpose', async () => {
    const { mw, sink } = await guard()
    await mw.tx(session(AccountRole.Maintainer), [pushMember()])
    expect(sink.written).toHaveLength(1)
  })
})

describe('LeadGuardMiddleware: guest scope, read half', () => {
  it('excludes the CRM space from an unscoped guest query', async () => {
    const { mw, sink } = await guard()
    await mw.findAll(session(AccountRole.Guest) as any, LEAD_CLASS, {} as any)
    expect(sink.queries).toEqual([{ space: { $nin: [CRM_SPACE] } }])
  })

  it('answers a guest query pinned to the CRM space without asking the database', async () => {
    const { mw, sink } = await guard()
    const res = await mw.findAll(session(AccountRole.Guest) as any, LEAD_CLASS, { space: CRM_SPACE } as any)
    expect(res).toHaveLength(0)
    expect(res.total).toBe(0)
    expect(sink.queries).toHaveLength(0)
  })

  it('closes the transaction domain too, on `objectSpace`', async () => {
    const { mw, sink } = await guard()
    await mw.findAll(session(AccountRole.Guest) as any, core.class.Tx, { objectId: LEAD_ID } as any)
    expect(sink.queries).toEqual([{ objectId: LEAD_ID, objectSpace: { $nin: [CRM_SPACE] } }])
  })

  it('leaves the space domain alone, so the Space document itself stays readable', async () => {
    const { mw, sink } = await guard()
    await mw.findAll(session(AccountRole.Guest) as any, core.class.Space, { _id: CRM_SPACE } as any)
    expect(sink.queries).toEqual([{ _id: CRM_SPACE }])
  })

  it('does not touch a real user query', async () => {
    const { mw, sink } = await guard()
    await mw.findAll(session(AccountRole.User) as any, LEAD_CLASS, { space: CRM_SPACE } as any)
    expect(sink.queries).toEqual([{ space: CRM_SPACE }])
  })

  it('gives a guest no fulltext results at all', async () => {
    const { mw, sink } = await guard()
    const res = await mw.searchFulltext(session(AccountRole.Guest) as any, {} as any, {} as any)
    expect(res).toEqual({ docs: [], total: 0 })
    expect(sink.searched).toBe(0)
  })

  it('leaves fulltext alone for a real user', async () => {
    const { mw, sink } = await guard()
    await mw.searchFulltext(session(AccountRole.User) as any, {} as any, {} as any)
    expect(sink.searched).toBe(1)
  })
})
