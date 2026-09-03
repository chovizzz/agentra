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

import type { Ref, Space } from '@hcengineering/core'

import {
  compareCycleOrder,
  cycleRolloverPolicies,
  isCycleRolloverPolicy,
  nextCycleAfter,
  type Cycle,
  type CycleStatus
} from '../types'

const SPACE = 'project-1' as Ref<any>
const OTHER_SPACE = 'project-2' as Ref<any>

function cycle (
  _id: string,
  sequence: number,
  status: CycleStatus = 'planned',
  startDate = 0,
  space: Ref<Space> = SPACE
): Cycle {
  return {
    _id: _id as Ref<Cycle>,
    _class: 'cycle:class:Cycle' as Ref<any>,
    space: space as Cycle['space'],
    modifiedBy: '' as any,
    modifiedOn: 0,
    name: _id,
    status,
    startDate,
    endDate: startDate,
    sequence
  }
}

describe('the rollover policy vocabulary', () => {
  it('is exactly the three the command implements', () => {
    // 🔴 The literals travel on the wire and are recorded in the command
    // ledger; the server restates the same three as `CycleRolloverPolicyWire`.
    expect(cycleRolloverPolicies).toEqual(['keep', 'backlog', 'move'])
  })

  it('rejects anything else, so a bad wire value cannot be defaulted into one', () => {
    expect(isCycleRolloverPolicy('keep')).toBe(true)
    expect(isCycleRolloverPolicy('next')).toBe(false)
    expect(isCycleRolloverPolicy(undefined)).toBe(false)
    expect(isCycleRolloverPolicy(null)).toBe(false)
    expect(isCycleRolloverPolicy(0)).toBe(false)
  })
})

describe('compareCycleOrder', () => {
  it('orders by sequence first', () => {
    expect(compareCycleOrder(cycle('a', 1), cycle('b', 2))).toBeLessThan(0)
  })

  it('falls back to startDate when the sequence ties', () => {
    // ⚠️ NOT a hypothetical tie: `backfillCycleDefaults` writes `sequence: 0`
    // to every row that predates the field, so an upgraded workspace can hold
    // many cycles all numbered 0.
    expect(compareCycleOrder(cycle('a', 0, 'planned', 100), cycle('b', 0, 'planned', 200))).toBeLessThan(0)
  })

  it('falls back to _id last, so the order is total rather than adapter dependent', () => {
    expect(compareCycleOrder(cycle('a', 0, 'planned', 100), cycle('b', 0, 'planned', 100))).toBeLessThan(0)
    expect(compareCycleOrder(cycle('a', 0), cycle('a', 0))).toBe(0)
  })
})

describe('nextCycleAfter', () => {
  it('picks the nearest later cycle', () => {
    const current = cycle('c2', 2)
    const list = [cycle('c1', 1), current, cycle('c3', 3), cycle('c4', 4)]
    expect(nextCycleAfter(list, current)?._id).toBe('c3')
  })

  it('never picks the cycle itself', () => {
    const current = cycle('c2', 2)
    expect(nextCycleAfter([current], current)).toBeUndefined()
  })

  it('never picks an earlier cycle', () => {
    const current = cycle('c2', 2)
    expect(nextCycleAfter([cycle('c1', 1), current], current)).toBeUndefined()
  })

  it('skips terminal cycles — rolling work into a closed cycle hides it', () => {
    const current = cycle('c2', 2, 'active')
    const list = [current, cycle('c3', 3, 'completed'), cycle('c4', 4, 'cancelled'), cycle('c5', 5, 'planned')]
    expect(nextCycleAfter(list, current)?._id).toBe('c5')
  })

  it('never crosses into another project', () => {
    // A Cycle's space IS the tracker Project, so a cross-space target would
    // move issues into another project's cycle.
    const current = cycle('c2', 2)
    const list = [current, cycle('foreign', 3, 'planned', 0, OTHER_SPACE)]
    expect(nextCycleAfter(list, current)).toBeUndefined()
  })

  it('uses the startDate tie-break when every sequence is 0', () => {
    const current = cycle('c1', 0, 'active', 100)
    const list = [current, cycle('c2', 0, 'planned', 300), cycle('c3', 0, 'planned', 200)]
    expect(nextCycleAfter(list, current)?._id).toBe('c3')
  })

  it('is a pure function of the list it is given', () => {
    const current = cycle('c2', 2)
    const list = [cycle('c3', 3), current, cycle('c1', 1)]
    const before = list.map((it) => it._id)
    nextCycleAfter(list, current)
    // Sorting in place would reorder the caller's array, which in a Svelte
    // component is a reactive store nobody expects to be mutated.
    expect(list.map((it) => it._id)).toEqual(before)
  })
})
