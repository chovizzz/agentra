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
  toFindResult,
  TxFactory,
  type Class,
  type Doc,
  type MeasureContext,
  type Ref,
  type Space,
  type Tx,
  type TxCUD
} from '@hcengineering/core'
import crmLite, { type Lead, type LeadStatus } from '@hcengineering/crm-lite'
import requirements from '@hcengineering/requirements'
import serverAgentraCore, { commandExecutionId, commandObjectId } from '@hcengineering/server-agentra-core'
import { CONVERT_LEAD_LOCK, convertLeadRoles } from '@hcengineering/server-agentra-core-resources'
import type { Middleware, PipelineContext } from '@hcengineering/server-core'
import { ApplyTxMiddleware } from '@hcengineering/middleware'
import traceability from '@hcengineering/traceability'

import {
  checkLeadStatusChange,
  readFieldWrite,
  hasDisqualifyReason,
  isLeadStatus,
  LeadGuardError,
  LeadGuardMiddleware
} from '../leadGuard'

const LEAD_CLASS = crmLite.masterTag.Lead as Ref<Class<Doc>>
const LEAD_SUBCLASS = 'crm-lite:masterTag:LeadV2' as Ref<Class<Doc>>
const REQUIREMENT_CLASS = requirements.masterTag.Requirement as Ref<Class<Doc>>
const SPACE = 'crm-lite:space:Crm' as Ref<Space>
const LEAD_ID = '000000000000000000000001' as Ref<Lead>

/**
 * `_class` values are compared by string in the guard, so a table of edges is
 * enough — no ModelDb, no model transactions, no adapters. The one thing this
 * stub MUST get right is `TxApplyIf`, because `ApplyTxMiddleware` asks the very
 * same `isDerived` when deciding whether to unwrap.
 */
const derivedFrom: Record<string, string[]> = {
  [LEAD_SUBCLASS]: [LEAD_CLASS],
  [core.class.TxApplyIf]: [core.class.Tx]
}

const known = new Set<string>([LEAD_CLASS, LEAD_SUBCLASS, REQUIREMENT_CLASS, traceability.class.TraceLink])

const hierarchy = {
  hasClass: (_class: string) => known.has(_class),
  isDerived: (a: string, b: string) => a === b || (derivedFrom[a] ?? []).includes(b)
} as any

/** The bottom of the chain: answers reads out of `docs`, records writes. */
class Recorder implements Partial<Middleware> {
  readonly written: Tx[] = []
  constructor (readonly docs: Doc[]) {}

  async tx (_ctx: MeasureContext, txes: Tx[]): Promise<any> {
    this.written.push(...txes)
    return {}
  }

  async findAll (_ctx: MeasureContext, _class: Ref<Class<Doc>>, query: Record<string, any>): Promise<any> {
    const matches = this.docs.filter(
      (doc) =>
        (doc._class === _class || (derivedFrom[doc._class] ?? []).includes(_class)) &&
        Object.entries(query).every(([key, value]) => (doc as any)[key] === value)
    )
    return toFindResult(matches as any)
  }
}

function context (): PipelineContext {
  return { hierarchy, contextVars: {} } as any
}

async function guard (docs: Doc[]): Promise<{ mw: Middleware, sink: Recorder }> {
  const sink = new Recorder(docs)
  const mw = (await LeadGuardMiddleware.create({} as any, context(), sink as any)) as Middleware
  return { mw, sink }
}

/** LeadGuard behind a real ApplyTxMiddleware, i.e. the production stacking. */
async function applyStack (docs: Doc[]): Promise<{ head: Middleware, sink: Recorder }> {
  const sink = new Recorder(docs)
  const ctx = context()
  const inner = (await LeadGuardMiddleware.create({} as any, ctx, sink as any)) as Middleware
  const head = await ApplyTxMiddleware.create({} as any, ctx, inner)
  return { head, sink }
}

const factory = new TxFactory(core.account.System, true)

function lead (status: LeadStatus, extra: Partial<Lead> = {}): Doc {
  return {
    _id: LEAD_ID,
    _class: LEAD_CLASS,
    space: SPACE,
    modifiedBy: core.account.System,
    modifiedOn: 0,
    title: 'Acme',
    status,
    priority: 'NoPriority',
    ...extra
  } as any
}

function setStatus (status: LeadStatus, extra: Record<string, any> = {}, _class: Ref<Class<Doc>> = LEAD_CLASS): Tx {
  return factory.createTxUpdateDoc(_class as Ref<Class<Lead>>, SPACE, LEAD_ID, { status, ...extra } as any)
}

/** The full evidence set a genuine `convertLeadToRequirement` leaves behind. */
function conversionEvidence (leadId: Ref<Lead> = LEAD_ID): Doc[] {
  const requirementId = commandObjectId(CONVERT_LEAD_LOCK, leadId, convertLeadRoles.requirement)
  const base = { space: SPACE, modifiedBy: core.account.System, modifiedOn: 0 }
  return [
    { ...base, _id: commandExecutionId(CONVERT_LEAD_LOCK, leadId), _class: serverAgentraCore.class.CommandExecution },
    { ...base, _id: requirementId, _class: REQUIREMENT_CLASS },
    {
      ...base,
      _id: '000000000000000000000009',
      _class: traceability.class.TraceLink,
      docA: leadId,
      docB: requirementId,
      kind: 'converted-to',
      state: 'active'
    }
  ] as any
}

async function refusalOf (fn: () => Promise<unknown>): Promise<LeadGuardError> {
  try {
    await fn()
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(LeadGuardError)
    return err as LeadGuardError
  }
  throw new Error('expected the guard to refuse, but the write was accepted')
}

describe('checkLeadStatusChange', () => {
  it('accepts every edge the transition table declares', () => {
    expect(checkLeadStatusChange('New', 'Contacted', undefined).ok).toBe(true)
    expect(checkLeadStatusChange('Contacted', 'Qualifying', undefined).ok).toBe(true)
    expect(checkLeadStatusChange('Qualifying', 'Converted', undefined).ok).toBe(true)
    expect(checkLeadStatusChange('New', 'New', undefined).ok).toBe(true)
  })

  it('refuses stage skipping and moves out of terminal states', () => {
    expect(checkLeadStatusChange('New', 'Converted', undefined)).toMatchObject({ reason: 'illegal-transition' })
    expect(checkLeadStatusChange('New', 'Qualifying', undefined)).toMatchObject({ reason: 'illegal-transition' })
    expect(checkLeadStatusChange('Converted', 'New', undefined)).toMatchObject({ reason: 'illegal-transition' })
    expect(checkLeadStatusChange('Disqualified', 'New', undefined)).toMatchObject({ reason: 'illegal-transition' })
  })

  it('requires a non-blank reason for Disqualified from every source state', () => {
    for (const from of ['New', 'Contacted', 'Qualifying'] as LeadStatus[]) {
      expect(checkLeadStatusChange(from, 'Disqualified', undefined)).toMatchObject({
        reason: 'disqualify-requires-reason'
      })
      expect(checkLeadStatusChange(from, 'Disqualified', '   ')).toMatchObject({
        reason: 'disqualify-requires-reason'
      })
      expect(checkLeadStatusChange(from, 'Disqualified', 'Budget withdrawn').ok).toBe(true)
    }
  })

  it('refuses a status the enum does not contain', () => {
    expect(checkLeadStatusChange('New', 'Won' as LeadStatus, undefined)).toMatchObject({ reason: 'unknown-status' })
  })

  it('classifies reasons the way the popup does', () => {
    expect(isLeadStatus('Converted')).toBe(true)
    expect(isLeadStatus('converted')).toBe(false)
    expect(hasDisqualifyReason('')).toBe(false)
    expect(hasDisqualifyReason('\n\t ')).toBe(false)
    expect(hasDisqualifyReason('no budget')).toBe(true)
  })
})

describe('LeadGuardMiddleware', () => {
  it('lets a legal transition through untouched', async () => {
    const { mw, sink } = await guard([lead('New')])
    const tx = setStatus('Contacted')
    await mw.tx({} as any, [tx])
    expect(sink.written).toEqual([tx])
  })

  it('ignores writes to documents that are not leads', async () => {
    const { mw, sink } = await guard([])
    const tx = factory.createTxUpdateDoc('some:other:Class' as Ref<Class<Doc>>, SPACE, LEAD_ID, {
      status: 'Converted'
    } as any)
    await mw.tx({} as any, [tx])
    expect(sink.written).toEqual([tx])
  })

  it('ignores lead writes that touch neither status nor reason', async () => {
    const { mw, sink } = await guard([lead('New')])
    const tx = factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, { priority: 'High' } as any)
    await mw.tx({} as any, [tx])
    expect(sink.written).toEqual([tx])
  })

  it('refuses the kanban drag from New straight to Converted', async () => {
    const { mw, sink } = await guard([lead('New')])
    const err = await refusalOf(async () => await mw.tx({} as any, [setStatus('Converted')]))
    expect(err.reason).toBe('illegal-transition')
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a direct write of Converted even from Qualifying', async () => {
    const { mw, sink } = await guard([lead('Qualifying')])
    const err = await refusalOf(async () => await mw.tx({} as any, [setStatus('Converted')]))
    expect(err.reason).toBe('converted-requires-command')
    expect(sink.written).toHaveLength(0)
  })

  it('refuses Converted when the trace edge is missing, even with a ledger row', async () => {
    const partial = conversionEvidence().filter((doc) => doc._class !== traceability.class.TraceLink)
    const { mw } = await guard([lead('Qualifying'), ...partial])
    const err = await refusalOf(async () => await mw.tx({} as any, [setStatus('Converted')]))
    expect(err.reason).toBe('converted-requires-command')
  })

  it('refuses Converted when the edge is forged but no command ever ran', async () => {
    const forged = conversionEvidence().filter((doc) => doc._class !== serverAgentraCore.class.CommandExecution)
    const { mw } = await guard([lead('Qualifying'), ...forged])
    const err = await refusalOf(async () => await mw.tx({} as any, [setStatus('Converted')]))
    expect(err.reason).toBe('converted-requires-command')
  })

  it('refuses Converted when the edge points somewhere other than the derived requirement', async () => {
    const evidence = conversionEvidence().map((doc: any) =>
      doc._class === traceability.class.TraceLink ? { ...doc, docB: '00000000000000000000000b' } : doc
    )
    const { mw } = await guard([lead('Qualifying'), ...evidence])
    const err = await refusalOf(async () => await mw.tx({} as any, [setStatus('Converted')]))
    expect(err.reason).toBe('converted-requires-command')
  })

  it('refuses Converted when the edge has been revoked', async () => {
    const evidence = conversionEvidence().map((doc: any) =>
      doc._class === traceability.class.TraceLink ? { ...doc, state: 'revoked' } : doc
    )
    const { mw } = await guard([lead('Qualifying'), ...evidence])
    const err = await refusalOf(async () => await mw.tx({} as any, [setStatus('Converted')]))
    expect(err.reason).toBe('converted-requires-command')
  })

  it('admits the conversion command: full evidence present', async () => {
    const { mw, sink } = await guard([lead('Qualifying'), ...conversionEvidence()])
    const tx = setStatus('Converted')
    await mw.tx({} as any, [tx])
    expect(sink.written).toEqual([tx])
  })

  it('refuses Disqualified with no reason and admits it with one', async () => {
    const bare = await guard([lead('Contacted')])
    expect((await refusalOf(async () => await bare.mw.tx({} as any, [setStatus('Disqualified')]))).reason).toBe(
      'disqualify-requires-reason'
    )
    expect(bare.sink.written).toHaveLength(0)

    const blank = await guard([lead('Contacted')])
    expect(
      (
        await refusalOf(
          async () => await blank.mw.tx({} as any, [setStatus('Disqualified', { disqualifyReason: ' ' })])
        )
      ).reason
    ).toBe('disqualify-requires-reason')

    const ok = await guard([lead('Contacted')])
    const tx = setStatus('Disqualified', { disqualifyReason: 'Budget pulled' })
    await ok.mw.tx({} as any, [tx])
    expect(ok.sink.written).toEqual([tx])
  })

  it('accepts a reason already stored on the lead', async () => {
    const { mw, sink } = await guard([lead('Contacted', { disqualifyReason: 'Recorded earlier' })])
    const tx = setStatus('Disqualified')
    await mw.tx({} as any, [tx])
    expect(sink.written).toEqual([tx])
  })

  it('refuses a second write that empties the reason of a disqualified lead', async () => {
    const { mw } = await guard([lead('Disqualified', { disqualifyReason: 'No budget' })])
    const cleared = factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, {
      disqualifyReason: ''
    } as any)
    expect((await refusalOf(async () => await mw.tx({} as any, [cleared]))).reason).toBe('disqualify-requires-reason')

    const unset = factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, {
      $unset: { disqualifyReason: '' }
    } as any)
    expect((await refusalOf(async () => await mw.tx({} as any, [unset]))).reason).toBe('disqualify-requires-reason')
  })

  it('refuses any operator that reaches status or the reason', async () => {
    // 🔴 `$rename` is a real operator here (operator.ts), and the Mongo adapter
    // forwards the whole operator object to Mongo, so an operator this codebase
    // does not implement (`$set`) still executes there. Pattern-matching only
    // `'status' in operations` would miss both.
    const cases: Array<Record<string, any>> = [
      { $set: { status: 'Converted' } },
      { $rename: { legacyStatus: 'status' } },
      { $rename: { status: 'legacyStatus' } },
      { $push: { status: 'Converted' } },
      { $set: { disqualifyReason: '' } },
      { $rename: { note: 'disqualifyReason' } }
    ]
    for (const operations of cases) {
      const { mw, sink } = await guard([lead('Qualifying', { disqualifyReason: 'kept' })])
      const tx = factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, operations as any)
      expect((await refusalOf(async () => await mw.tx({} as any, [tx]))).reason).toBe('opaque-operation')
      expect(sink.written).toHaveLength(0)
    }
  })

  it('leaves operators on unrelated fields alone', async () => {
    const { mw, sink } = await guard([lead('New')])
    const tx = factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, {
      $inc: { rank: 1 },
      $unset: { nextActionAt: '' }
    } as any)
    await mw.tx({} as any, [tx])
    expect(sink.written).toEqual([tx])
  })

  it('refuses removing the status attribute outright', async () => {
    const { mw } = await guard([lead('New')])
    const tx = factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, {
      $unset: { status: '' }
    } as any)
    expect((await refusalOf(async () => await mw.tx({} as any, [tx]))).reason).toBe('status-removed')
  })

  it('guards creation, not only updates', async () => {
    const converted = await guard([])
    const createConverted = factory.createTxCreateDoc(
      LEAD_CLASS as Ref<Class<Lead>>,
      SPACE,
      { title: 'Fake', status: 'Converted', priority: 'NoPriority' } as any,
      LEAD_ID
    )
    expect((await refusalOf(async () => await converted.mw.tx({} as any, [createConverted]))).reason).toBe(
      'converted-requires-command'
    )

    const disqualified = await guard([])
    const createDisqualified = factory.createTxCreateDoc(
      LEAD_CLASS as Ref<Class<Lead>>,
      SPACE,
      { title: 'Fake', status: 'Disqualified', priority: 'NoPriority' } as any,
      LEAD_ID
    )
    expect((await refusalOf(async () => await disqualified.mw.tx({} as any, [createDisqualified]))).reason).toBe(
      'disqualify-requires-reason'
    )

    const fresh = await guard([])
    const createNew = factory.createTxCreateDoc(
      LEAD_CLASS as Ref<Class<Lead>>,
      SPACE,
      { title: 'Real', status: 'New', priority: 'NoPriority' } as any,
      LEAD_ID
    )
    await fresh.mw.tx({} as any, [createNew])
    expect(fresh.sink.written).toEqual([createNew])
  })

  it('admits a new card version of an already-converted lead', async () => {
    // `createSystemType` makes Lead versionable, so a new revision arrives as a
    // TxCreateDoc with a NEW _id and the original in `baseId`. The conversion
    // evidence is keyed on the id the command converted, so a from-scratch
    // reading of this tx would reject every revision of a converted lead.
    const converted = { ...(lead('Converted') as any), baseId: LEAD_ID, isLatest: true }
    const { mw, sink } = await guard([converted, ...conversionEvidence()])
    const successor = factory.createTxCreateDoc(
      LEAD_CLASS as Ref<Class<Lead>>,
      SPACE,
      { title: 'Acme', status: 'Converted', priority: 'NoPriority', baseId: LEAD_ID, version: 2 } as any,
      '00000000000000000000000c' as Ref<Lead>
    )
    await mw.tx({} as any, [successor])
    expect(sink.written).toEqual([successor])
  })

  it('refuses a new card version that REACHES Converted', async () => {
    const qualifying = { ...(lead('Qualifying') as any), baseId: LEAD_ID, isLatest: true }
    const { mw } = await guard([qualifying, ...conversionEvidence()])
    const successor = factory.createTxCreateDoc(
      LEAD_CLASS as Ref<Class<Lead>>,
      SPACE,
      { title: 'Acme', status: 'Converted', priority: 'NoPriority', baseId: LEAD_ID, version: 2 } as any,
      '00000000000000000000000d' as Ref<Lead>
    )
    // The evidence in the store is keyed on LEAD_ID, not on the successor's id,
    // so "convert by publishing a revision" stays closed.
    expect((await refusalOf(async () => await mw.tx({} as any, [successor]))).reason).toBe('converted-requires-command')
  })

  it('refuses a new card version that skips a stage', async () => {
    const news = { ...(lead('New') as any), baseId: LEAD_ID, isLatest: true }
    const { mw } = await guard([news])
    const successor = factory.createTxCreateDoc(
      LEAD_CLASS as Ref<Class<Lead>>,
      SPACE,
      { title: 'Acme', status: 'Qualifying', priority: 'NoPriority', baseId: LEAD_ID, version: 2 } as any,
      '00000000000000000000000e' as Ref<Lead>
    )
    expect((await refusalOf(async () => await mw.tx({} as any, [successor]))).reason).toBe('illegal-transition')
  })

  it('treats baseId === objectId as a genuine first revision', async () => {
    const { mw, sink } = await guard([])
    const first = factory.createTxCreateDoc(
      LEAD_CLASS as Ref<Class<Lead>>,
      SPACE,
      { title: 'Acme', status: 'New', priority: 'NoPriority', baseId: LEAD_ID, version: 1 } as any,
      LEAD_ID
    )
    await mw.tx({} as any, [first])
    expect(sink.written).toEqual([first])
  })

  it('follows the master tag down to subclasses', async () => {
    const { mw } = await guard([{ ...(lead('New') as any), _class: LEAD_SUBCLASS }])
    const err = await refusalOf(async () => await mw.tx({} as any, [setStatus('Converted', {}, LEAD_SUBCLASS)]))
    expect(err.reason).toBe('illegal-transition')
  })

  it('guards TxMixin writes whose mixin descends from the master tag', async () => {
    const { mw } = await guard([lead('New')])
    const tx = factory.createTxMixin(
      LEAD_ID,
      LEAD_CLASS,
      SPACE,
      LEAD_SUBCLASS as any,
      {
        status: 'Converted'
      } as any
    )
    expect((await refusalOf(async () => await mw.tx({} as any, [tx]))).reason).toBe('illegal-transition')
  })

  it('lets an update of an unknown lead through: it writes no row anyway', async () => {
    const { mw, sink } = await guard([])
    const tx = setStatus('Contacted')
    await mw.tx({} as any, [tx])
    expect(sink.written).toEqual([tx])
  })
})

/**
 * 🔴 The bypass this whole file exists for. `convertLeadToRequirement` wraps its
 * status write in `client.apply(...)`, i.e. a `TxApplyIf`, and so could any
 * client. These two tests prove the guard sees inside one BOTH ways round:
 * behind the real `ApplyTxMiddleware` (which unwraps and forwards the inner
 * txes) and when handed a raw `TxApplyIf` directly.
 */
describe('TxApplyIf coverage', () => {
  const wrapped = (inner: Tx): Tx =>
    factory.createTxApplyIf(
      SPACE,
      `${CONVERT_LEAD_LOCK} ${LEAD_ID}`,
      [{ _class: LEAD_CLASS, query: { _id: LEAD_ID } }],
      [],
      [inner as TxCUD<Doc>],
      'ConvertLeadToRequirement:lead-status'
    )

  it('refuses an illegal transition wrapped in TxApplyIf, behind ApplyTxMiddleware', async () => {
    const { head, sink } = await applyStack([lead('New')])
    await expect(head.tx({} as any, [wrapped(setStatus('Converted'))])).rejects.toBeInstanceOf(LeadGuardError)
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a reasonless Disqualified wrapped in TxApplyIf, behind ApplyTxMiddleware', async () => {
    const { head, sink } = await applyStack([lead('Qualifying')])
    await expect(head.tx({} as any, [wrapped(setStatus('Disqualified'))])).rejects.toBeInstanceOf(LeadGuardError)
    expect(sink.written).toHaveLength(0)
  })

  it('admits a legal transition wrapped in TxApplyIf, and the inner tx reaches the sink flattened', async () => {
    const { head, sink } = await applyStack([lead('Qualifying'), ...conversionEvidence()])
    const inner = setStatus('Converted')
    await head.tx({} as any, [wrapped(inner)])
    // ApplyTxMiddleware forwards `applyIf.txes`, not the wrapper: this is the
    // evidence that the guard sees a plain TxUpdateDoc in production.
    expect(sink.written).toEqual([inner])
  })

  it('recurses into a raw TxApplyIf handed straight to the guard', async () => {
    const { mw, sink } = await guard([lead('New')])
    const err = await refusalOf(async () => await mw.tx({} as any, [wrapped(setStatus('Converted'))]))
    expect(err.reason).toBe('illegal-transition')
    expect(sink.written).toHaveLength(0)
  })
})

describe('readFieldWrite', () => {
  it('reads the plain form', () => {
    expect(readFieldWrite({ status: 'Contacted' }, 'status')).toEqual({ kind: 'plain', value: 'Contacted' })
    expect(readFieldWrite({ priority: 'High' }, 'status')).toEqual({ kind: 'untouched' })
  })

  it('reads $unset as a removal, not as untouched', () => {
    expect(readFieldWrite({ $unset: { status: '' } }, 'status')).toEqual({ kind: 'unset' })
  })

  it('reads both directions of $rename as opaque', () => {
    expect(readFieldWrite({ $rename: { status: 'old' } }, 'status')).toEqual({ kind: 'opaque', operator: '$rename' })
    expect(readFieldWrite({ $rename: { old: 'status' } }, 'status')).toEqual({ kind: 'opaque', operator: '$rename' })
    expect(readFieldWrite({ $rename: { a: 'b' } }, 'status')).toEqual({ kind: 'untouched' })
  })

  it('reads an unimplemented operator as opaque rather than as untouched', () => {
    // `$set` is not in this codebase's operator table, but the Mongo adapter
    // forwards operator objects verbatim. Silence here would be the bypass.
    expect(readFieldWrite({ $set: { status: 'Converted' } }, 'status')).toEqual({
      kind: 'opaque',
      operator: '$set'
    })
  })

  it('survives malformed operations without claiming they are safe to ignore', () => {
    expect(readFieldWrite(null as any, 'status')).toEqual({ kind: 'untouched' })
    expect(readFieldWrite({ $unset: null } as any, 'status')).toEqual({ kind: 'untouched' })
  })
})

describe('a converted lead is frozen ON THE SERVER, not just in the panel', () => {
  function update (ops: Record<string, any>): Tx {
    return factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, ops as any)
  }

  it('refuses a business-field write that never touches status or reason', async () => {
    // 🔴 THE ORIGINAL HOLE. The guard used to return immediately when an update
    // named neither `status` nor `disqualifyReason`, so a converted lead was
    // protected by `readonlyFields` — a UI marker — and by nothing else.
    const { mw } = await guard([lead('Converted')])
    const err = await refusalOf(async () => await mw.tx({} as any, [update({ account: 'someone-else' })]))
    expect(err.reason).toBe('lead-converted-readonly')
    expect(err.message).toContain('account')
  })

  it('refuses every listed field, not just the first one anybody tried', async () => {
    const { mw } = await guard([lead('Converted')])
    for (const field of ['title', 'contact', 'owner', 'nextActionAt', 'pipeline', 'priority', 'source']) {
      const err = await refusalOf(async () => await mw.tx({} as any, [update({ [field]: 'x' })]))
      expect(err.reason).toBe('lead-converted-readonly')
      expect(err.message).toContain(field)
    }
  })

  it('refuses an OPERATOR reaching a frozen field, including $unset and $rename', async () => {
    const { mw } = await guard([lead('Converted')])
    for (const ops of [{ $unset: { owner: '' } }, { $rename: { account: 'contact' } }, { $push: { owner: 'x' } }]) {
      const err = await refusalOf(async () => await mw.tx({} as any, [update(ops)]))
      expect(err.reason).toBe('lead-converted-readonly')
    }
  })

  it('refuses a frozen write smuggled inside a TxApplyIf', async () => {
    const { mw } = await guard([lead('Converted')])
    const inner = update({ owner: 'someone-else' }) as any
    const wrapped = factory.createTxApplyIf(SPACE, undefined, [], [], [inner], undefined)
    const err = await refusalOf(async () => await mw.tx({} as any, [wrapped]))
    expect(err.reason).toBe('lead-converted-readonly')
  })

  it('leaves a DISQUALIFIED lead editable, because this file elsewhere says it is', async () => {
    // ⚠️ Not an oversight. The reason-only branch exists precisely so a
    // disqualification can be re-justified; freezing the form would contradict
    // the server in the same file, and the client was built against that.
    const { mw, sink } = await guard([lead('Disqualified', { disqualifyReason: 'no budget' })])
    await mw.tx({} as any, [update({ account: 'someone-else' })])
    expect(sink.written).toHaveLength(1)
  })

  it('lets the PLATFORM keep writing its own version bookkeeping', async () => {
    // 🔴 THE REASON THIS IS A FIELD LIST AND NOT "REFUSE EVERY WRITE".
    // `VersioningMiddleware.setVersionData` stamps `readonly` / `isLatest` on a
    // superseded revision, and the conversion command itself writes
    // `readonlyFields`. Refusing those would make a converted lead impossible to
    // re-version and the freeze impossible to apply.
    const { mw, sink } = await guard([lead('Converted')])
    await mw.tx({} as any, [update({ isLatest: false, readonly: true })])
    await mw.tx({} as any, [update({ readonlyFields: ['title', 'account'] })])
    expect(sink.written).toHaveLength(2)
  })

  it('still names the illegal TRANSITION when status itself is written', async () => {
    // ⚠️ `status` is skipped by the freeze check on purpose: the state machine
    // gives a better error than "the lead is frozen".
    const { mw } = await guard([lead('Converted')])
    const err = await refusalOf(async () => await mw.tx({} as any, [setStatus('Contacted')]))
    expect(err.reason).not.toBe('lead-converted-readonly')
  })
})

describe('readFieldWrite reads the way the applier writes', () => {
  // 🔴 THE MIXED PAYLOAD. `isOperator` requires EVERY key to start with `$`
  // (`foundations/core/packages/core/src/operator.ts:198-204`), but
  // `TxProcessor.applyUpdate` dispatches KEY BY KEY
  // (`foundations/core/packages/core/src/tx.ts:378-387`). A payload that mixes
  // the two forms therefore used to read as `untouched` while the platform
  // really did write the field — the guard waved it straight through.
  it('sees an operator write that shares the payload with a plain key', () => {
    expect(readFieldWrite({ title: 'x', $set: { status: 'Converted' } }, 'status')).toEqual({
      kind: 'opaque',
      operator: '$set'
    })
  })

  it('sees $unset in a mixed payload', () => {
    expect(readFieldWrite({ title: 'x', $unset: { status: '' } }, 'status')).toEqual({ kind: 'unset' })
  })

  it('sees $rename in a mixed payload, in both directions', () => {
    expect(readFieldWrite({ title: 'x', $rename: { status: 'scratch' } }, 'status').kind).toBe('opaque')
    expect(readFieldWrite({ title: 'x', $rename: { scratch: 'status' } }, 'status').kind).toBe('opaque')
  })

  it('still reads a plain write in a mixed payload', () => {
    expect(readFieldWrite({ status: 'Contacted', $inc: { other: 1 } }, 'status')).toEqual({
      kind: 'plain',
      value: 'Contacted'
    })
  })

  it('treats a dotted path as reaching the field', () => {
    // `setObjectValue('status.x', doc, v)` writes INTO `status`.
    expect(readFieldWrite({ 'status.x': 1 }, 'status').kind).toBe('opaque')
  })

  it('leaves an unrelated mixed payload alone', () => {
    expect(readFieldWrite({ title: 'x', $inc: { rank: 1 } }, 'status')).toEqual({ kind: 'untouched' })
  })
})

describe('the guard itself cannot be walked past with a mixed payload', () => {
  it('refuses a converted-lead edit smuggled beside a plain key', async () => {
    const { mw } = await guard([lead('Converted')])
    const tx = factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, {
      title: 'renamed',
      $set: { owner: 'someone-else' }
    } as any)
    const err = await refusalOf(async () => await mw.tx({} as any, [tx]))
    expect(err.reason).toBe('lead-converted-readonly')
  })

  it('refuses an illegal status transition smuggled beside a plain key', async () => {
    const { mw } = await guard([lead('New')])
    const tx = factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, {
      title: 'renamed',
      $set: { status: 'Converted' }
    } as any)
    const err = await refusalOf(async () => await mw.tx({} as any, [tx]))
    // `$set` is opaque on status, and an opaque status write is refused outright.
    expect(err.reason).toBe('opaque-operation')
  })
})
