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

import testManagement from '../plugin'
import { TestCaseStatus, type TestCase } from '../types'
import { APPROVED_TEST_CASE_FROZEN_FIELDS, isFrozenTestCaseField, isTestCaseContentFrozen } from '../utils'

describe('QA-T019 frozen field contract', () => {
  /**
   * 🔴 PINNED TO LITERALS ON PURPOSE. Both the panel and
   * `SnapshotGuardMiddleware` read this one array, so a silent edit to it moves
   * the gate on both sides at once. Anyone changing the list has to change this
   * line and say why.
   */
  it('names exactly the test case content fields', () => {
    expect([...APPROVED_TEST_CASE_FROZEN_FIELDS]).toEqual([
      'name',
      'description',
      'preconditions',
      'type',
      'priority',
      'automationKey'
    ])
  })

  it('never freezes what the list viewlets edit inline', () => {
    // `models/test-management` renders `status` and `assignee` as inline
    // editors in the list and table viewlets, and neither can be switched off
    // from the test case panel. Freezing either would give the user a control
    // that clicks and a server that refuses the save.
    expect(isFrozenTestCaseField('assignee')).toBe(false)
  })

  it('never freezes status, the escape hatch out of Approved', () => {
    // Freezing it would make `Approved` terminal: no control and no API call
    // could reopen the case, so the gate would be a trap.
    expect(isFrozenTestCaseField('status')).toBe(false)
  })

  it('never freezes the bookkeeping the platform writes itself', () => {
    // `VersioningMiddleware` writes `readonly` / `isLatest`; `registerTestCaseEdit`
    // bumps `version`; the server maintains every collection counter. An
    // approved case must keep receiving all of them.
    for (const field of ['version', 'readonly', 'isLatest', 'attachments', 'comments', 'steps', 'snapshots']) {
      expect(isFrozenTestCaseField(field)).toBe(false)
    }
  })

  it('freezes content only while the case is Approved', () => {
    const at = (status: TestCaseStatus): boolean => {
      const doc: Pick<TestCase, 'status'> = { status }
      return isTestCaseContentFrozen(doc)
    }

    expect(at(TestCaseStatus.Approved)).toBe(true)
    expect(at(TestCaseStatus.Draft)).toBe(false)
    expect(at(TestCaseStatus.ReadyForReview)).toBe(false)
    expect(at(TestCaseStatus.FixReviewComments)).toBe(false)
    expect(at(TestCaseStatus.Rejected)).toBe(false)
  })
})

describe('QA-T019 strings', () => {
  /**
   * ⚠️ The literal, not just "is defined". `plugin()` fills these in from the
   * descriptor at import time, so a key that never reached `lang/en.json` still
   * produces a truthy `IntlString` and renders as a raw id on screen.
   */
  it('resolves the read-only banner ids', () => {
    expect(testManagement.string.ApprovedCaseReadonly).toBe('testManagement:string:ApprovedCaseReadonly')
    expect(testManagement.string.ApprovedCaseReadonlyHint).toBe('testManagement:string:ApprovedCaseReadonlyHint')
  })
})
