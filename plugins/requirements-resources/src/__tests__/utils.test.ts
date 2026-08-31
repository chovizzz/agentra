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

import { canTransitionRequirement, requirementStatusOrder, type RequirementStatus } from '@hcengineering/requirements'

import { requirementStatusChoices, resolveRequirementStatusChange } from '../utils'

const every: RequirementStatus[] = [
  'Draft',
  'Reviewing',
  'Approved',
  'InDelivery',
  'Validating',
  'Released',
  'Rejected',
  'Cancelled'
]

describe('requirement status editor: the state machine gate', () => {
  it('offers only the transitions the state machine allows, in list order', () => {
    // Returned in `requirementStatusOrder`, not in transition-table order, so
    // the dropdown reads the same way as the grouped list sections.
    expect(requirementStatusChoices('Draft')).toEqual(['Draft', 'Reviewing', 'Cancelled'])
    expect(requirementStatusChoices('Reviewing')).toEqual(['Draft', 'Reviewing', 'Approved', 'Rejected', 'Cancelled'])
    expect(requirementStatusChoices('Validating')).toEqual(['InDelivery', 'Validating', 'Released', 'Cancelled'])
  })

  it('offers nothing but itself from a terminal status', () => {
    expect(requirementStatusChoices('Released')).toEqual(['Released'])
    expect(requirementStatusChoices('Cancelled')).toEqual(['Cancelled'])
  })

  it('offers the whole vocabulary when there is no current status', () => {
    expect(requirementStatusChoices(undefined)).toEqual(requirementStatusOrder)
  })

  it('accepts every legal transition', () => {
    for (const from of every) {
      for (const to of requirementStatusChoices(from)) {
        if (from === to) continue
        expect(resolveRequirementStatusChange(from, to)).toEqual({ kind: 'accepted', status: to })
      }
    }
  })

  it('rejects every illegal transition', () => {
    let rejected = 0
    for (const from of every) {
      for (const to of every) {
        if (from === to || canTransitionRequirement(from, to)) continue
        expect(resolveRequirementStatusChange(from, to)).toEqual({ kind: 'rejected', from, to })
        rejected++
      }
    }
    // Guards the guard: if the transition table were ever widened to "anything
    // goes", the loop above would pass vacuously.
    expect(rejected).toBeGreaterThan(0)
  })

  it('refuses the specific jumps the lifecycle forbids', () => {
    // A requirement may not skip review or delivery on its way to Released, and
    // a released or cancelled one may not be reopened in place.
    expect(resolveRequirementStatusChange('Draft', 'Approved').kind).toBe('rejected')
    expect(resolveRequirementStatusChange('Draft', 'Released').kind).toBe('rejected')
    expect(resolveRequirementStatusChange('Approved', 'Released').kind).toBe('rejected')
    expect(resolveRequirementStatusChange('Released', 'Draft').kind).toBe('rejected')
    expect(resolveRequirementStatusChange('Cancelled', 'Draft').kind).toBe('rejected')
  })

  it('reports a self transition as unchanged rather than as an accepted write', () => {
    // `canTransitionRequirement(x, x)` is true, so without the short circuit
    // this would produce a Tx and an Activity entry claiming a change that did
    // not happen.
    for (const status of every) {
      expect(resolveRequirementStatusChange(status, status)).toEqual({ kind: 'unchanged' })
    }
  })

  it('accepts any status when the requirement has none yet', () => {
    expect(resolveRequirementStatusChange(undefined, 'Released')).toEqual({ kind: 'accepted', status: 'Released' })
  })

  it('agrees with canTransitionRequirement on every pair', () => {
    for (const from of every) {
      for (const to of every) {
        const accepted = resolveRequirementStatusChange(from, to).kind !== 'rejected'
        expect(accepted).toBe(canTransitionRequirement(from, to))
      }
    }
  })

  it('allows the documented rework and bounce-back edges', () => {
    // Not every backwards edge is illegal: review may bounce to Draft, a
    // rejected requirement may be reworked, and validation may go back to
    // delivery. A gate that simply forbade "going backwards" would break these.
    expect(resolveRequirementStatusChange('Reviewing', 'Draft').kind).toBe('accepted')
    expect(resolveRequirementStatusChange('Rejected', 'Draft').kind).toBe('accepted')
    expect(resolveRequirementStatusChange('Validating', 'InDelivery').kind).toBe('accepted')
  })
})
