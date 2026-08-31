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

import { cycleStatusOrder, type CycleStatus } from '@hcengineering/cycle'
import type { Client, Doc, Ref } from '@hcengineering/core'

import {
  AGENTRA_COMMAND_DOMAIN,
  AGENTRA_OP_COMPLETE_CYCLE,
  COMPLETE_CYCLE_KEY_PREFIX,
  completeCycle,
  completeCycleIdempotencyKey,
  completeCycleReasonLabel,
  cycleStatusChoices,
  getAllCycleStatuses,
  parseCompleteCycleResult,
  linkRequirementsPopupProps,
  LINK_IMPLEMENTS_POPUP,
  LINK_IMPLEMENTS_TO_REQUIREMENT,
  REQUIREMENT_MASTER_TAG,
  resolveCycleStatusChange,
  sortCycleStatuses
} from '../utils'

const CYCLE = 'cccccccccccccccccccccc01' as Ref<Doc>

describe('cycleStatusChoices — the cosmetic gate', () => {
  it('offers only legal successors of the current status', () => {
    // `planned -> active | cancelled`, and `completed` is withheld (below).
    expect(cycleStatusChoices('planned')).toEqual(['planned', 'active', 'cancelled'])
    expect(cycleStatusChoices('active')).toEqual(['active', 'cancelled'])
  })

  it('offers nothing but itself out of a terminal status', () => {
    expect(cycleStatusChoices('completed')).toEqual(['completed'])
    expect(cycleStatusChoices('cancelled')).toEqual(['cancelled'])
  })

  it('never offers `completed`, which only the CompleteCycle command may write', () => {
    // 🔴 `active -> completed` IS a legal transition. Writing it inline would
    // produce a completed cycle whose open issues still hang off it and whose
    // snapshot never exists — and nothing would finish the job, because the
    // command refuses a cycle that is already completed.
    for (const from of cycleStatusOrder) {
      if (from === 'completed') continue
      expect(cycleStatusChoices(from)).not.toContain('completed')
    }
  })

  it('offers the whole vocabulary minus `completed` when there is no status yet', () => {
    expect(cycleStatusChoices(undefined)).toEqual(['planned', 'active', 'cancelled'])
  })

  it('returns choices in cycleStatusOrder, not in transition-table order', () => {
    const choices = cycleStatusChoices('planned')
    const ranks = choices.map((it) => cycleStatusOrder.indexOf(it))
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })
})

describe('resolveCycleStatusChange — the gate that actually refuses', () => {
  it('accepts a legal move', () => {
    expect(resolveCycleStatusChange('planned', 'active')).toEqual({ kind: 'accepted', status: 'active' })
    expect(resolveCycleStatusChange('active', 'cancelled')).toEqual({ kind: 'accepted', status: 'cancelled' })
  })

  it('rejects an illegal move', () => {
    expect(resolveCycleStatusChange('planned', 'completed')).toEqual({
      kind: 'rejected',
      from: 'planned',
      to: 'completed'
    })
    expect(resolveCycleStatusChange('cancelled', 'active')).toEqual({
      kind: 'rejected',
      from: 'cancelled',
      to: 'active'
    })
  })

  it('reports a self transition as `unchanged`, not as `accepted`', () => {
    // `canTransitionCycle` answers true for `from === to`, but writing the
    // value back would produce a pointless Tx and an Activity entry claiming
    // the status "changed" to what it already was.
    for (const status of cycleStatusOrder) {
      expect(resolveCycleStatusChange(status, status)).toEqual({ kind: 'unchanged' })
    }
  })

  it('refuses `completed` even when the transition would be legal', () => {
    expect(resolveCycleStatusChange('active', 'completed').kind).toBe('rejected')
    expect(resolveCycleStatusChange(undefined, 'completed').kind).toBe('rejected')
  })

  it('REFUSES THE RACE: the popup was opened on `planned`, the cycle is now `cancelled`', () => {
    // 🔴 This is why the second gate exists. `DropdownLabelsIntl` can dispatch
    // `selected` for an id that is no longer in `items`, because the cycle's
    // status can move underneath an open popup. The choices list said `active`
    // was fine when the popup opened; by the time it is answered the cycle is
    // terminal and the pick must be dropped rather than written.
    const staleChoice: CycleStatus = 'active'
    expect(cycleStatusChoices('planned')).toContain(staleChoice)
    expect(resolveCycleStatusChange('cancelled', staleChoice)).toEqual({
      kind: 'rejected',
      from: 'cancelled',
      to: 'active'
    })
  })

  it('accepts anything legal when there is no current status to violate', () => {
    expect(resolveCycleStatusChange(undefined, 'active')).toEqual({ kind: 'accepted', status: 'active' })
  })
})

describe('the sort / all-values resources', () => {
  it('orders statuses canonically and keeps unknown values at the end', async () => {
    const sorted = await sortCycleStatuses(undefined as any, ['cancelled', 'weird' as CycleStatus, 'planned'])
    expect(sorted).toEqual(['planned', 'cancelled', 'weird'])
  })

  it('reports the whole vocabulary so an empty status still gets a group', async () => {
    expect(await getAllCycleStatuses()).toEqual(cycleStatusOrder)
  })
})

describe('completeCycleIdempotencyKey', () => {
  it('is a pure function of the cycle, so every retry converges on one ledger row', () => {
    expect(completeCycleIdempotencyKey(CYCLE)).toBe(completeCycleIdempotencyKey(CYCLE))
    expect(completeCycleIdempotencyKey(CYCLE)).toBe(`${COMPLETE_CYCLE_KEY_PREFIX}:${CYCLE}`)
  })

  it('separates two cycles', () => {
    expect(completeCycleIdempotencyKey(CYCLE)).not.toBe(completeCycleIdempotencyKey('other' as Ref<Doc>))
  })
})

describe('parseCompleteCycleResult — fails closed', () => {
  const snapshot = { total: 5, done: 3, open: 2, rolledOver: 2 }

  it('reads a fresh completion', () => {
    const outcome = parseCompleteCycleResult({
      ok: true,
      executionId: 'exec-1',
      replayed: false,
      result: { cycle: CYCLE, snapshot, alreadyCompleted: false }
    })
    expect(outcome).toEqual({ kind: 'completed', executionId: 'exec-1', cycle: CYCLE, snapshot, retryable: false })
  })

  it('collapses both "this already happened" signals onto `replayed`', () => {
    const fromLedger = parseCompleteCycleResult({
      ok: true,
      executionId: 'e',
      replayed: true,
      result: { cycle: CYCLE, snapshot }
    })
    const fromCycle = parseCompleteCycleResult({
      ok: true,
      executionId: 'e',
      replayed: false,
      result: { cycle: CYCLE, snapshot, alreadyCompleted: true }
    })
    expect(fromLedger.kind).toBe('replayed')
    expect(fromCycle.kind).toBe('replayed')
  })

  it('refuses to call a success a success without a readable snapshot', () => {
    // 🔴 Otherwise the popup would render "N issues rolled over" with no N.
    expect(parseCompleteCycleResult({ ok: true, executionId: 'e', result: { cycle: CYCLE } }).kind).toBe('unavailable')
    expect(
      parseCompleteCycleResult({
        ok: true,
        executionId: 'e',
        result: { cycle: CYCLE, snapshot: { total: 1, done: 0, open: 1 } }
      }).kind
    ).toBe('unavailable')
    expect(parseCompleteCycleResult({ ok: true, result: { cycle: CYCLE, snapshot } }).kind).toBe('unavailable')
  })

  it('keeps 409 apart from 400 — one is retryable and the other is not', () => {
    expect(parseCompleteCycleResult({ ok: false, code: 409, reason: 'command-in-progress' })).toEqual({
      kind: 'in-progress',
      code: 409,
      reason: 'command-in-progress',
      message: '',
      retryable: true
    })
    expect(parseCompleteCycleResult({ ok: false, code: 400, reason: 'illegal-transition', message: 'no' })).toEqual({
      kind: 'refused',
      code: 400,
      reason: 'illegal-transition',
      message: 'no',
      retryable: false
    })
  })

  it('treats an unrouted domain request as unavailable rather than as a silent success', () => {
    // `value: null` is what `BaseMiddleware.provideDomainRequest` returns when
    // the middleware is not registered at all.
    expect(parseCompleteCycleResult(null).kind).toBe('unavailable')
    expect(parseCompleteCycleResult(undefined).kind).toBe('unavailable')
    expect(parseCompleteCycleResult({}).kind).toBe('unavailable')
    expect(parseCompleteCycleResult({ ok: false }).kind).toBe('unavailable')
  })
})

describe('completeCycleReasonLabel', () => {
  it('maps every known reason to its own sentence', () => {
    const labels = [
      'cycle-not-found',
      'illegal-transition',
      'rollover-target-required',
      'rollover-target-invalid',
      'malformed-input'
    ].map(completeCycleReasonLabel)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('lands an unknown reason on the generic sentence, never on a wrong specific one', () => {
    expect(completeCycleReasonLabel('something-new')).toBe(completeCycleReasonLabel('also-new'))
    expect(completeCycleReasonLabel('something-new')).not.toBe(completeCycleReasonLabel('illegal-transition'))
  })
})

describe('completeCycle — the call itself', () => {
  function clientWith (impl: (domain: string, params: any) => Promise<any>): Client {
    return { domainRequest: async (domain: any, params: any) => await impl(domain, params) } as unknown as Client
  }

  it('sends the request under the `params` key of the operation', async () => {
    let seenDomain: string | undefined
    let seenParams: any
    const client = clientWith(async (domain, params) => {
      seenDomain = domain
      seenParams = params
      return {
        domain,
        value: {
          ok: true,
          executionId: 'e',
          result: { cycle: CYCLE, snapshot: { total: 0, done: 0, open: 0, rolledOver: 0 } }
        }
      }
    })
    await completeCycle(client, { cycle: CYCLE, idempotencyKey: 'k', rolloverPolicy: 'keep' })
    expect(seenDomain).toBe(AGENTRA_COMMAND_DOMAIN)
    // 🔴 `params`, not `query`. The server destructures
    // `args.completeCycle.params`, and neither side is type checked because
    // `DomainParams` is `Record<string, any>`.
    expect(Object.keys(seenParams[AGENTRA_OP_COMPLETE_CYCLE])).toEqual(['params'])
    expect(seenParams[AGENTRA_OP_COMPLETE_CYCLE].params.rolloverPolicy).toBe('keep')
  })

  it('renders a thrown call as `errored`, which is NOT the same as `unavailable`', async () => {
    // The body may have run and partially completed, so the UI must not claim
    // "nothing happened".
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const client = clientWith(async () => {
      throw new Error('transport died')
    })
    const outcome = await completeCycle(client, { cycle: CYCLE, idempotencyKey: 'k', rolloverPolicy: 'keep' })
    expect(outcome).toEqual({ kind: 'errored', message: 'transport died', retryable: false })
    spy.mockRestore()
  })
})

describe('linkRequirementsPopupProps — the array that cannot be a string', () => {
  const ISSUE = 'iiiiiiiiiiiiiiiiiiiiii01' as Ref<Doc>

  it('wraps the issue in an ARRAY', () => {
    // 🔴 THE ONE ASSERTION THIS WHOLE HELPER EXISTS FOR. `LinkImplementsPopup`
    // declares `fixed: Array<Ref<Doc>>` and walks it with `for…of`. A bare
    // `Ref` is a string, so that loop would iterate CHARACTERS and send 24 junk
    // pairs to the `linkImplements` command — and `showPopup` types `props` as
    // `any`, so no compiler would say a word about it.
    const props = linkRequirementsPopupProps(ISSUE)
    expect(Array.isArray(props.fixed)).toBe(true)
    expect(props.fixed).toEqual([ISSUE])
    // Spelled out, because "it happens to have length 1" is also true of the
    // string 'i' and this is the property that matters.
    expect(props.fixed).toHaveLength(1)
  })

  it('pins the requirement side and names its own class', () => {
    const props = linkRequirementsPopupProps(ISSUE)
    // "The work item is fixed, pick requirements."
    expect(props.pick).toBe('requirement')
    // The popup only defaults `pickClass` for the work-item direction.
    expect(props.pickClass).toBe(REQUIREMENT_MASTER_TAG)
  })

  it("searches 'title', the Card field — not 'name'", () => {
    // A Requirement is a Card. `'name'`, which the Cycle picker uses, does not
    // exist on it and would search nothing while looking perfectly healthy.
    expect(linkRequirementsPopupProps(ISSUE).searchField).toBe('title')
  })

  it('pins the cross-package ids that no import is checking', () => {
    // ⚠️ These three are literals precisely because this package must not grow
    // a traceability / requirements dependency, which means TypeScript cannot
    // catch a rename on the far side. This test is the substitute, and the
    // values are asserted verbatim so a diff here is a deliberate act.
    expect(LINK_IMPLEMENTS_POPUP).toBe('traceability:component:LinkImplementsPopup')
    expect(REQUIREMENT_MASTER_TAG).toBe('requirements:masterTag:Requirement')
    // The ISSUE-side spelling. `LinkImplementsFromRequirement` is its mirror
    // and reads backwards here.
    expect(LINK_IMPLEMENTS_TO_REQUIREMENT).toBe('traceability:string:LinkImplementsToRequirement')
  })
})
