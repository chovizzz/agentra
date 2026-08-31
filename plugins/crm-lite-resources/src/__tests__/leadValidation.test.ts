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

import {
  canTransitionLead,
  leadStatusOrder,
  requiresDisqualifyReason,
  type Lead,
  type LeadStatus
} from '@hcengineering/crm-lite'

import crmLite from '../plugin'
import {
  COMMAND_ONLY_LEAD_STATUS,
  canDisqualifyLead,
  isLeadReadonly,
  leadRequiredFieldLabel,
  leadRequiredFields,
  leadStatusChoices,
  requiresConversionCommand,
  resolveDisqualifyIntent,
  resolveLeadStatusChange,
  validateLeadFields
} from '../utils'

function lead (over: Partial<Lead> = {}): Partial<Lead> {
  return {
    account: 'org-1' as any,
    contact: 'person-1' as any,
    owner: 'employee-1' as any,
    nextActionAt: 1700000000000,
    status: 'New',
    priority: 'NoPriority',
    ...over
  }
}

describe('validateLeadFields: the required-field checklist', () => {
  it('accepts a lead carrying all four mandatory fields', () => {
    expect(validateLeadFields(lead())).toEqual({ complete: true, missing: [] })
  })

  it('names every missing field, in checklist order rather than key order', () => {
    // Built back to front on purpose: the verdict must not depend on the order
    // the object's own keys happen to enumerate in.
    const bare: Partial<Lead> = { status: 'New', priority: 'NoPriority' }
    expect(validateLeadFields(bare).missing).toEqual(['account', 'contact', 'owner', 'nextActionAt'])
    expect(validateLeadFields(bare).complete).toBe(false)
  })

  it('reports each field independently', () => {
    for (const field of leadRequiredFields) {
      const verdict = validateLeadFields(lead({ [field]: undefined } as any))
      expect(verdict.missing).toEqual([field])
      expect(verdict.complete).toBe(false)
    }
  })

  it('treats an explicit null as missing, because clearing a date writes null', () => {
    // 🔴 `Lead.nextActionAt` is `Timestamp | null`. A `=== undefined` check
    // would report a deliberately cleared date as present.
    expect(validateLeadFields(lead({ nextActionAt: null })).missing).toEqual(['nextActionAt'])
  })

  it('treats an empty or whitespace-only ref as missing', () => {
    expect(validateLeadFields(lead({ account: '' as any })).missing).toEqual(['account'])
    expect(validateLeadFields(lead({ contact: '   ' as any })).missing).toEqual(['contact'])
  })

  it('keeps 0 — the epoch is a legal timestamp, absurd but not this gate to reject', () => {
    expect(validateLeadFields(lead({ nextActionAt: 0 })).complete).toBe(true)
  })

  it('reports an absent lead as missing everything rather than throwing', () => {
    expect(validateLeadFields(undefined)).toEqual({ complete: false, missing: [...leadRequiredFields] })
  })

  it('does not mutate the shared field list it hands back', () => {
    validateLeadFields(undefined).missing.push('account')
    expect(leadRequiredFields).toEqual(['account', 'contact', 'owner', 'nextActionAt'])
  })

  it('labels every required field with a namespaced IntlString', () => {
    const labels = leadRequiredFields.map(leadRequiredFieldLabel)
    expect(labels).toEqual([
      crmLite.string.Account,
      crmLite.string.Contact,
      crmLite.string.Owner,
      crmLite.string.NextActionAt
    ])
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('isLeadReadonly: the Converted rule', () => {
  it('closes a converted lead', () => {
    expect(isLeadReadonly('Converted')).toBe(true)
  })

  it('leaves every other status open, INCLUDING Disqualified', () => {
    // 🔴 Both are terminal in the transition table, but only one is read only.
    // `LeadGuardMiddleware.validateUpdate` explicitly permits amending
    // `disqualifyReason` on an already-disqualified lead; treating the two
    // alike would take away an edit the server allows.
    for (const status of leadStatusOrder.filter((s) => s !== 'Converted')) {
      expect(isLeadReadonly(status)).toBe(false)
    }
    expect(isLeadReadonly(undefined)).toBe(false)
  })

  it('agrees with the transition table: a read-only lead has nowhere legal to go', () => {
    for (const status of leadStatusOrder) {
      if (!isLeadReadonly(status)) continue
      const targets = leadStatusOrder.filter((to) => to !== status && canTransitionLead(status, to))
      expect(targets).toEqual([])
    }
  })

  it('lets an already-disqualified lead still amend its reason', () => {
    expect(isLeadReadonly('Disqualified')).toBe(false)
    expect(resolveDisqualifyIntent('Disqualified', 'still not a fit')).toEqual({
      kind: 'ready',
      reason: 'still not a fit'
    })
  })
})

describe('requiresConversionCommand: no pick the server would refuse gets written', () => {
  it('names exactly the command-only status', () => {
    expect(COMMAND_ONLY_LEAD_STATUS).toBe('Converted')
    for (const status of leadStatusOrder) {
      expect(requiresConversionCommand(status)).toBe(status === 'Converted')
    }
  })

  it('covers the one status the state machine offers but a plain write cannot produce', () => {
    // `Qualifying -> Converted` is legal in the table, so the dropdown offers
    // it — but `enforceConversionEvidence` demands an idempotency-ledger row no
    // transaction can create, so writing it would be refused with
    // `converted-requires-command`. The pick must be handed to the command.
    expect(leadStatusChoices('Qualifying')).toContain('Converted')
    expect(requiresConversionCommand('Converted')).toBe(true)
  })

  it('partitions every offered pick into write / convert-command / disqualify-popup', () => {
    // The invariant the editor relies on: every status it can offer is routed
    // somewhere, and the two hand-offs are disjoint.
    for (const from of leadStatusOrder) {
      for (const to of leadStatusChoices(from)) {
        const handled = requiresConversionCommand(to) || requiresDisqualifyReason(to) || to === from
        expect(handled || resolveLeadStatusChange(from, to).kind === 'accepted').toBe(true)
        expect(requiresConversionCommand(to) && requiresDisqualifyReason(to)).toBe(false)
      }
    }
  })
})

describe('client rules never exceed the server: what the client writes, the guard accepts', () => {
  // The one property that matters. `checkLeadStatusChange` in
  // `server-plugins/crm-lite/src/leadGuard.ts` is restated here rather than
  // imported: this is a browser bundle and importing a `server-*` package would
  // both drag the server runtime in and rewrite `pnpm-lock.yaml`. Restating it
  // is only safe because it is four lines and pinned by this test.
  type Verdict = 'accept' | 'refuse'
  function serverVerdict (from: LeadStatus | undefined, to: LeadStatus, reason: unknown, evidence: boolean): Verdict {
    if (from !== undefined && !canTransitionLead(from, to)) return 'refuse'
    if (to === 'Disqualified' && !(typeof reason === 'string' && reason.trim().length > 0)) return 'refuse'
    if (to === 'Converted' && from !== 'Converted' && !evidence) return 'refuse'
    return 'accept'
  }

  it('never writes a status the guard would refuse', () => {
    for (const from of leadStatusOrder) {
      for (const to of leadStatusOrder) {
        // What the editor actually does with this pick.
        if (requiresConversionCommand(to)) continue // handed to the command, never written here
        if (requiresDisqualifyReason(to)) continue // handed to the reason popup, tested below
        if (isLeadReadonly(from)) continue // control is disabled
        const change = resolveLeadStatusChange(from, to)
        if (change.kind !== 'accepted') continue
        expect(serverVerdict(from, change.status, undefined, false)).toBe('accept')
      }
    }
  })

  it('never disqualifies where the guard would refuse', () => {
    for (const from of leadStatusOrder) {
      for (const reason of ['', '   ', 'not a fit']) {
        const intent = resolveDisqualifyIntent(from, reason)
        if (intent.kind !== 'ready') continue
        expect(serverVerdict(from, 'Disqualified', intent.reason, false)).toBe('accept')
        // And the popup only offers itself where disqualification is legal.
        expect(canDisqualifyLead(from)).toBe(true)
      }
    }
  })

  it('routes the one pick a plain write could never satisfy through the command instead', () => {
    // Without the hand-off this is precisely the "client allows, server rejects"
    // failure: no evidence exists at pick time, so the write is refused.
    expect(serverVerdict('Qualifying', 'Converted', undefined, false)).toBe('refuse')
    expect(requiresConversionCommand('Converted')).toBe(true)
  })

  it('adds no required-field rule the server does not have', () => {
    // 🔴 The checklist is advisory. An incomplete lead must still be able to
    // move through the state machine, because the guard lets it and a client
    // that refused would disagree with the server about a legal write.
    const bare: Partial<Lead> = { status: 'New' }
    const incomplete = validateLeadFields(bare)
    expect(incomplete.complete).toBe(false)
    expect(resolveLeadStatusChange('New', 'Contacted')).toEqual({ kind: 'accepted', status: 'Contacted' })
    expect(canDisqualifyLead('New')).toBe(true)
  })
})
