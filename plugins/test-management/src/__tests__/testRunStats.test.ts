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

import { toFindResult, type Ref } from '@hcengineering/core'

import testManagement from '../plugin'
import { TestRunStatus, testRunStatuses, type TestRun } from '../types'
import { collectTestRunStats, summariseTestRunStats, testRunPassRate, type TestManagementReader } from '../utils'

const RUN = 'test-management:run:1' as Ref<TestRun>

/**
 * Answers `{ attachedTo, status }` counting queries out of a table.
 *
 * `limit: 0, total: true` is the shape the production code uses, so the fake
 * returns an empty page with a `total` — the same thing a real adapter does.
 */
function reader (counts: Partial<Record<TestRunStatus, number>>): TestManagementReader {
  return {
    findAll: async (_class, query: any) => {
      expect(_class).toBe(testManagement.class.TestResult)
      expect(query.attachedTo).toBe(RUN)
      const total = counts[query.status as TestRunStatus] ?? 0
      return toFindResult([] as any, total)
    }
  }
}

describe('TestRunStatus', () => {
  it('appends Skipped at 4 and leaves every historical value untouched', () => {
    // 🔴 The persisted values ARE these numbers. If this test ever fails, the
    // enum was reordered and every stored TestResult.status now means something
    // different than it did.
    expect(TestRunStatus.Untested).toBe(0)
    expect(TestRunStatus.Blocked).toBe(1)
    expect(TestRunStatus.Passed).toBe(2)
    expect(TestRunStatus.Failed).toBe(3)
    expect(TestRunStatus.Skipped).toBe(4)
  })

  it('lists every member in testRunStatuses', () => {
    const byValue = (a: number, b: number): number => a - b
    const declared = Object.values(TestRunStatus).filter((value): value is number => typeof value === 'number')
    expect(testRunStatuses.slice().sort(byValue)).toEqual(declared.slice().sort(byValue))
  })
})

describe('getTestRunStats regression: Skipped must not vanish', () => {
  it('does NOT report total = 0 for a run whose results are all skipped', async () => {
    // This is the exact bug the four hard-coded queries produced: Skipped fell
    // into no bucket and into no sum, so a completed run rendered as
    // "0 of 0, 0% done" and raised nothing at all.
    const stats = await collectTestRunStats(reader({ [TestRunStatus.Skipped]: 7 }), RUN)

    expect(stats.total).toBe(7)
    expect(stats.skipped).toBe(7)
    expect(stats.untested).toBe(0)
    expect(stats.done).toBe(100)
  })

  it('counts every bucket and sums all five into the total', async () => {
    const stats = await collectTestRunStats(
      reader({
        [TestRunStatus.Untested]: 1,
        [TestRunStatus.Blocked]: 2,
        [TestRunStatus.Passed]: 3,
        [TestRunStatus.Failed]: 4,
        [TestRunStatus.Skipped]: 5
      }),
      RUN
    )

    expect(stats).toEqual({
      untested: 1,
      blocked: 2,
      completed: 3,
      failed: 4,
      skipped: 5,
      total: 15,
      done: ((15 - 1) * 100) / 15
    })
  })

  it('queries once per declared status', async () => {
    const seen: TestRunStatus[] = []
    const spy: TestManagementReader = {
      findAll: async (_class, query: any) => {
        seen.push(query.status)
        return toFindResult([] as any, 0)
      }
    }
    await collectTestRunStats(spy, RUN)
    expect(seen).toEqual(testRunStatuses)
  })

  it('reports 0% rather than dividing by zero on an empty run', async () => {
    const stats = await collectTestRunStats(reader({}), RUN)
    expect(stats.total).toBe(0)
    expect(stats.done).toBe(0)
  })
})

describe('summariseTestRunStats', () => {
  it('accepts a plain record as well as a map', () => {
    expect(summariseTestRunStats({ [TestRunStatus.Skipped]: 2 }).total).toBe(2)
  })
})

describe('testRunPassRate', () => {
  const stats = summariseTestRunStats({
    [TestRunStatus.Passed]: 3,
    [TestRunStatus.Failed]: 1,
    [TestRunStatus.Skipped]: 6
  })

  it('excludes skipped from the denominator by default', () => {
    expect(testRunPassRate(stats)).toBe(75)
  })

  it('includes skipped when the gate asks for it', () => {
    expect(testRunPassRate(stats, false)).toBe(30)
  })

  it('answers undefined — not 0 — when there is nothing to rate', () => {
    // A gate that cannot distinguish "everything was skipped" from "everything
    // failed" will pass or block the wrong build.
    const allSkipped = summariseTestRunStats({ [TestRunStatus.Skipped]: 4 })
    expect(testRunPassRate(allSkipped)).toBeUndefined()
    expect(testRunPassRate(allSkipped, false)).toBe(0)
  })
})
