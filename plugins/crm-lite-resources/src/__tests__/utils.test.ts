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

import { canTransitionLead, leadStatusOrder, type LeadStatus } from '@hcengineering/crm-lite'
import type { Client, Doc, DomainParams, OperationDomain, Ref } from '@hcengineering/core'

import crmLite from '../plugin'
import {
  AGENTRA_COMMAND_DOMAIN,
  AGENTRA_OP_CONVERT_LEAD,
  convertLeadIdempotencyKey,
  convertLeadReasonLabel,
  convertLeadToRequirement,
  getAllLeadPriorities,
  getAllLeadStatuses,
  leadStatusChoices,
  canDisqualifyLead,
  disqualifyLead,
  parseConvertLeadResult,
  resolveDisqualifyIntent,
  resolveLeadStatusChange,
  sortLeadPriorities,
  sortLeadStatuses
} from '../utils'

const LEAD = 'lead-1' as Ref<Doc>
const OTHER_LEAD = 'lead-2' as Ref<Doc>
const REQ = 'requirement-1' as Ref<Doc>

function ok (extra: Record<string, any> = {}, result: Record<string, any> = {}): Record<string, any> {
  return {
    ok: true,
    executionId: 'exec-1',
    replayed: false,
    preempted: false,
    result: { lead: LEAD, requirement: REQ, traceLink: 'link-1', alreadyConverted: false, ...result },
    ...extra
  }
}

describe('sort helpers', () => {
  it('orders statuses canonically and keeps unknown values last', async () => {
    const sorted = await sortLeadStatuses(undefined as any, ['Converted', 'New', 'zzz' as any, 'Contacted'])
    expect(sorted).toEqual(['New', 'Contacted', 'Converted', 'zzz'])
  })

  it('exposes every status and priority as a group value', async () => {
    expect(await getAllLeadStatuses()).toContain('Disqualified')
    expect(await sortLeadPriorities(undefined as any, ['Low', 'Urgent'])).toEqual(['Urgent', 'Low'])
    expect(await getAllLeadPriorities()).toContain('NoPriority')
  })
})

describe('convertLeadIdempotencyKey', () => {
  it('is stable for one lead across independent calls', () => {
    // The whole point: two clicks, two dialogs, two tabs, two sessions — one key.
    expect(convertLeadIdempotencyKey(LEAD)).toBe(convertLeadIdempotencyKey(LEAD))
  })

  it('separates different leads', () => {
    expect(convertLeadIdempotencyKey(LEAD)).not.toBe(convertLeadIdempotencyKey(OTHER_LEAD))
  })

  it('carries the lead id and a version prefix', () => {
    expect(convertLeadIdempotencyKey(LEAD)).toContain(LEAD)
    expect(convertLeadIdempotencyKey(LEAD).startsWith('crm-lite:convert-lead:v1:')).toBe(true)
  })

  it('never varies with time or call order', () => {
    const keys = new Set([0, 1, 2, 3].map(() => convertLeadIdempotencyKey(LEAD)))
    expect(keys.size).toBe(1)
  })
})

describe('parseConvertLeadResult', () => {
  it('reads a fresh success', () => {
    expect(parseConvertLeadResult(ok())).toEqual({
      kind: 'converted',
      executionId: 'exec-1',
      requirement: REQ,
      retryable: false
    })
  })

  it('reads a ledger replay as `replayed`, not as a fresh conversion', () => {
    expect(parseConvertLeadResult(ok({ replayed: true })).kind).toBe('replayed')
  })

  it('treats an already linked lead as `replayed` too', () => {
    expect(parseConvertLeadResult(ok({}, { alreadyConverted: true })).kind).toBe('replayed')
  })

  it('reports 409 as retryable', () => {
    const outcome = parseConvertLeadResult({
      ok: false,
      code: 409,
      reason: 'command-in-progress',
      message: 'held'
    })
    expect(outcome).toEqual({
      kind: 'in-progress',
      code: 409,
      reason: 'command-in-progress',
      message: 'held',
      retryable: true
    })
  })

  it('reports a preemption as 409 as well', () => {
    expect(parseConvertLeadResult({ ok: false, code: 409, reason: 'command-preempted', message: '' }).retryable).toBe(
      true
    )
  })

  it('reports 400 as a non retryable refusal carrying its reason', () => {
    const outcome = parseConvertLeadResult({
      ok: false,
      code: 400,
      reason: 'illegal-transition',
      message: 'bad status'
    })
    expect(outcome).toEqual({
      kind: 'refused',
      code: 400,
      reason: 'illegal-transition',
      message: 'bad status',
      retryable: false
    })
  })

  // ── fail closed ────────────────────────────────────────────────────────
  it.each([
    ['no handler registered', null],
    ['pipeline with no head', undefined],
    ['a scalar', 42],
    ['no `ok` discriminator', { executionId: 'e', result: { requirement: REQ } }],
    ['ok:true without an executionId', { ok: true, result: { requirement: REQ } }],
    ['ok:true without a result', { ok: true, executionId: 'e' }],
    ['ok:true whose result names no requirement', { ok: true, executionId: 'e', result: { lead: LEAD } }],
    ['ok:false without a code', { ok: false, reason: 'illegal-transition' }],
    ['ok:false without a reason', { ok: false, code: 400 }],
    ['a truthy but non boolean ok', { ok: 'yes', executionId: 'e', result: { requirement: REQ } }]
  ])('fails closed on %s', (_name, value) => {
    expect(parseConvertLeadResult(value)).toEqual({ kind: 'unavailable', retryable: false })
  })

  it('never reports an unrecognised failure code as retryable', () => {
    expect(parseConvertLeadResult({ ok: false, code: 503, reason: 'whatever', message: '' })).toEqual({
      kind: 'refused',
      code: 503,
      reason: 'whatever',
      message: '',
      retryable: false
    })
  })
})

describe('convertLeadReasonLabel', () => {
  it('maps every documented reason to its own string', () => {
    const reasons = [
      'lead-not-found',
      'illegal-transition',
      'invalid-trace-link',
      'converted-without-link',
      'requirement-id-taken',
      'malformed-input'
    ]
    const labels = reasons.map(convertLeadReasonLabel)
    expect(new Set(labels).size).toBe(reasons.length)
    expect(labels).not.toContain(crmLite.string.ReasonUnknown)
  })

  it('falls back to the generic string for a reason this build does not know', () => {
    expect(convertLeadReasonLabel('reason-invented-later')).toBe(crmLite.string.ReasonUnknown)
  })
})

describe('convertLeadToRequirement', () => {
  function clientOf (value: unknown): { client: Client, calls: Array<[OperationDomain, DomainParams]> } {
    const calls: Array<[OperationDomain, DomainParams]> = []
    const client = {
      domainRequest: async (domain: OperationDomain, params: DomainParams) => {
        calls.push([domain, params])
        return { domain, value }
      }
    } as unknown as Client
    return { client, calls }
  }

  it('sends the request on the agentra-command domain under `params`', async () => {
    const { client, calls } = clientOf(ok())
    await convertLeadToRequirement(client, { lead: LEAD, idempotencyKey: 'k' })
    expect(calls).toHaveLength(1)
    const [domain, params] = calls[0]
    expect(domain).toBe(AGENTRA_COMMAND_DOMAIN)
    expect(AGENTRA_COMMAND_DOMAIN).toBe('agentra-command')
    // 🔴 `params`, not `query`: the middleware destructures
    // `args.convertLeadToRequirement.params`.
    expect(Object.keys(params)).toEqual([AGENTRA_OP_CONVERT_LEAD])
    expect(Object.keys((params as any)[AGENTRA_OP_CONVERT_LEAD])).toEqual(['params'])
    expect((params as any)[AGENTRA_OP_CONVERT_LEAD].params).toEqual({ lead: LEAD, idempotencyKey: 'k' })
  })

  it('forwards the optional refs untouched', async () => {
    const { client, calls } = clientOf(ok())
    await convertLeadToRequirement(client, {
      lead: LEAD,
      idempotencyKey: 'k',
      product: 'p' as Ref<Doc>,
      project: 'pr' as Ref<Doc>,
      owner: 'o' as Ref<Doc>
    })
    expect((calls[0][1] as any)[AGENTRA_OP_CONVERT_LEAD].params).toEqual({
      lead: LEAD,
      idempotencyKey: 'k',
      product: 'p',
      project: 'pr',
      owner: 'o'
    })
  })

  it('reports an unrouted domain request as unavailable rather than as failure to convert', async () => {
    const { client } = clientOf(null)
    expect(await convertLeadToRequirement(client, { lead: LEAD, idempotencyKey: 'k' })).toEqual({
      kind: 'unavailable',
      retryable: false
    })
  })

  it('renders a rethrown server bug as `errored`, never as a silent no-op', async () => {
    // `toCommandResult` rethrows anything that is not one of the two expected
    // failure families, so this is the shape a server bug actually arrives in.
    const client = {
      domainRequest: async () => {
        throw new Error('boom')
      }
    } as unknown as Client
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await convertLeadToRequirement(client, { lead: LEAD, idempotencyKey: 'k' })).toEqual({
        kind: 'errored',
        message: 'boom',
        retryable: false
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('does not confuse a thrown error with an absent handler', async () => {
    const client = {
      domainRequest: async () => {
        throw new Error('boom')
      }
    } as unknown as Client
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await convertLeadToRequirement(client, { lead: LEAD, idempotencyKey: 'k' })).kind).not.toBe('unavailable')
    } finally {
      spy.mockRestore()
    }
  })

  it('parses the envelope it received', async () => {
    const { client } = clientOf({ ok: false, code: 409, reason: 'command-in-progress', message: 'x' })
    expect((await convertLeadToRequirement(client, { lead: LEAD, idempotencyKey: 'k' })).retryable).toBe(true)
  })
})

describe('lead status editor: the state machine gate', () => {
  const every: LeadStatus[] = ['New', 'Contacted', 'Qualifying', 'Converted', 'Disqualified']

  it('offers only the transitions the state machine allows, in kanban order', () => {
    expect(leadStatusChoices('New')).toEqual(['New', 'Contacted', 'Disqualified'])
    expect(leadStatusChoices('Contacted')).toEqual(['Contacted', 'Qualifying', 'Disqualified'])
    expect(leadStatusChoices('Qualifying')).toEqual(['Qualifying', 'Converted', 'Disqualified'])
  })

  it('offers nothing but itself from a terminal status', () => {
    // `Converted` and `Disqualified` have empty transition lists, so the only
    // entry left is the self transition — the dropdown is effectively frozen.
    expect(leadStatusChoices('Converted')).toEqual(['Converted'])
    expect(leadStatusChoices('Disqualified')).toEqual(['Disqualified'])
  })

  it('offers the whole vocabulary when there is no current status', () => {
    expect(leadStatusChoices(undefined)).toEqual(leadStatusOrder)
  })

  it('accepts every legal transition', () => {
    for (const from of every) {
      for (const to of leadStatusChoices(from)) {
        if (from === to) continue
        expect(resolveLeadStatusChange(from, to)).toEqual({ kind: 'accepted', status: to })
      }
    }
  })

  it('rejects every illegal transition', () => {
    let rejected = 0
    for (const from of every) {
      for (const to of every) {
        if (from === to || canTransitionLead(from, to)) continue
        expect(resolveLeadStatusChange(from, to)).toEqual({ kind: 'rejected', from, to })
        rejected++
      }
    }
    // Guards the guard: if the transition table were ever widened to "anything
    // goes", the loop above would pass vacuously.
    expect(rejected).toBeGreaterThan(0)
  })

  it('refuses the specific jumps the product forbids', () => {
    // The two that matter: a lead may not be declared Converted without going
    // through Qualifying, and a terminal lead may not be resurrected.
    expect(resolveLeadStatusChange('New', 'Converted').kind).toBe('rejected')
    expect(resolveLeadStatusChange('Converted', 'New').kind).toBe('rejected')
    expect(resolveLeadStatusChange('Disqualified', 'Qualifying').kind).toBe('rejected')
  })

  it('reports a self transition as unchanged rather than as an accepted write', () => {
    // `canTransitionLead('New', 'New')` is true, so without the short circuit
    // this would produce a Tx and an Activity entry claiming a change that did
    // not happen.
    for (const status of every) {
      expect(resolveLeadStatusChange(status, status)).toEqual({ kind: 'unchanged' })
    }
  })

  it('accepts any status when the lead has none yet', () => {
    expect(resolveLeadStatusChange(undefined, 'Converted')).toEqual({ kind: 'accepted', status: 'Converted' })
  })

  it('agrees with canTransitionLead on every pair', () => {
    // The gate must never be more permissive than the shared predicate the
    // server command also uses.
    for (const from of every) {
      for (const to of every) {
        const accepted = resolveLeadStatusChange(from, to).kind !== 'rejected'
        expect(accepted).toBe(canTransitionLead(from, to))
      }
    }
  })
})

describe('resolveDisqualifyIntent', () => {
  it('refuses an empty or whitespace-only reason', () => {
    expect(resolveDisqualifyIntent('New', '')).toEqual({ kind: 'empty-reason' })
    expect(resolveDisqualifyIntent('New', '   ')).toEqual({ kind: 'empty-reason' })
    expect(resolveDisqualifyIntent('New', '\n\t ')).toEqual({ kind: 'empty-reason' })
  })

  it('trims the reason it hands on, because the server trims before checking', () => {
    expect(resolveDisqualifyIntent('Contacted', '  no budget  ')).toEqual({ kind: 'ready', reason: 'no budget' })
  })

  it('refuses a Converted lead: the only status with no path to Disqualified', () => {
    expect(resolveDisqualifyIntent('Converted', 'anything')).toEqual({ kind: 'illegal', from: 'Converted' })
  })

  it('lets an already-disqualified lead amend its reason', () => {
    // `canTransitionLead` treats `from === to` as legal, and the server guard
    // uses the same predicate, so this is a real (no-op status, new reason)
    // edit rather than an accident. It still cannot become reasonless.
    expect(resolveDisqualifyIntent('Disqualified', 'better wording')).toEqual({
      kind: 'ready',
      reason: 'better wording'
    })
    expect(resolveDisqualifyIntent('Disqualified', '  ')).toEqual({ kind: 'empty-reason' })
  })

  it('checks legality BEFORE the reason, so a terminal lead is not asked to type first', () => {
    expect(resolveDisqualifyIntent('Converted', '')).toEqual({ kind: 'illegal', from: 'Converted' })
  })

  it('accepts every non-terminal source status', () => {
    for (const from of ['New', 'Contacted', 'Qualifying'] as LeadStatus[]) {
      expect(resolveDisqualifyIntent(from, 'lost')).toEqual({ kind: 'ready', reason: 'lost' })
      expect(canDisqualifyLead(from)).toBe(true)
    }
    expect(canDisqualifyLead('Converted')).toBe(false)
    // `Disqualified` -> `Disqualified` is a self transition, which the shared
    // predicate calls legal; see the reason-amendment case above.
    expect(canDisqualifyLead('Disqualified')).toBe(true)
    // A lead with no status yet has asserted nothing, so nothing is violated.
    expect(canDisqualifyLead(undefined)).toBe(true)
    expect(resolveDisqualifyIntent(undefined, 'lost')).toEqual({ kind: 'ready', reason: 'lost' })
  })

  it('agrees with canTransitionLead on every source status', () => {
    for (const from of leadStatusOrder) {
      expect(canDisqualifyLead(from)).toBe(canTransitionLead(from, 'Disqualified'))
    }
  })
})

describe('disqualifyLead', () => {
  it('writes status and reason in ONE update, so the server never sees a reasonless step', async () => {
    const calls: any[] = []
    const client = {
      updateDoc: async (_class: any, space: any, id: any, operations: any) => {
        calls.push({ _class, space, id, operations })
      }
    } as any
    await disqualifyLead(
      client,
      { _id: 'lead-1' as Ref<Doc>, _class: 'crm-lite:masterTag:Lead' as any, space: 'space-1' as any },
      'no budget'
    )
    expect(calls).toEqual([
      {
        _class: 'crm-lite:masterTag:Lead',
        space: 'space-1',
        id: 'lead-1',
        operations: { status: 'Disqualified', disqualifyReason: 'no budget' }
      }
    ])
  })
})
