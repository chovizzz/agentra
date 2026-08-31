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

import { toFindResult, type Class, type Client, type Doc, type Ref } from '@hcengineering/core'
import testManagement, { TestRunStatus, type TestCase, type TestResult } from '@hcengineering/test-management'
import type { TraceLinkView } from '@hcengineering/traceability-resources/src/types'

import { coverageEdges, latestVerdicts, verdictOf } from '../coverage'

const CASE_A = 'case-a' as Ref<TestCase>
const CASE_B = 'case-b' as Ref<TestCase>
const REQ_V1 = 'req-v1' as Ref<Doc>

function link (over: Partial<TraceLinkView> = {}): TraceLinkView {
  return {
    _id: 'link-1' as any,
    kind: 'verifies',
    state: 'active',
    source: { _id: CASE_A, visible: true, _class: testManagement.class.TestCase, doc: { _id: CASE_A } as any },
    target: {
      _id: REQ_V1,
      visible: true,
      _class: 'requirements:masterTag:Requirement' as any,
      doc: { _id: REQ_V1 } as any
    },
    ...over
  }
}

describe('verdictOf', () => {
  it('maps every persisted status explicitly', () => {
    expect(verdictOf(TestRunStatus.Passed)).toBe('passed')
    expect(verdictOf(TestRunStatus.Failed)).toBe('failed')
    expect(verdictOf(TestRunStatus.Blocked)).toBe('blocked')
    expect(verdictOf(TestRunStatus.Skipped)).toBe('skipped')
    expect(verdictOf(TestRunStatus.Untested)).toBe('untested')
  })

  it('does NOT fold Skipped into a pass', () => {
    // 🔴 `Skipped` was APPENDED at 4. A `switch` with a `default` would have
    // quietly reported a test nobody ran as passing.
    expect(verdictOf(TestRunStatus.Skipped)).not.toBe('passed')
    expect(verdictOf(undefined)).toBe('untested')
    expect(verdictOf(99 as TestRunStatus)).toBe('untested')
  })
})

describe('coverageEdges', () => {
  it('keeps a fully visible edge and carries the logical target id', () => {
    const edges = coverageEdges([link()])
    expect(edges).toHaveLength(1)
    expect(edges[0].source).toBe(CASE_A)
    expect(edges[0].target).toBe(REQ_V1)
    expect(edges[0].targetBaseId).toBe(REQ_V1)
  })

  it('normalises the target through baseId when the requirement is a later revision', () => {
    const edges = coverageEdges([
      link({
        target: {
          _id: 'req-v2' as Ref<Doc>,
          visible: true,
          _class: 'requirements:masterTag:Requirement' as any,
          doc: { _id: 'req-v2', baseId: REQ_V1 } as any
        }
      })
    ])
    expect(edges[0].targetBaseId).toBe(REQ_V1)
  })

  it('DROPS an edge whose far endpoint the caller may not read', () => {
    // 🔴 Counting it would contribute a `covered` unit whose verdict can never
    // be resolved, and would disclose how many test cases exist in a project the
    // caller has no access to.
    expect(coverageEdges([link({ source: { _id: CASE_A, visible: false } })])).toHaveLength(0)
    expect(coverageEdges([link({ target: { _id: REQ_V1, visible: false } })])).toHaveLength(0)
  })

  it('drops an endpoint that claims visible but ships no document', () => {
    // Fail closed on shape as well as on the flag: a malformed reply must not
    // be rendered from.
    expect(coverageEdges([link({ source: { _id: CASE_A, visible: true } })])).toHaveLength(0)
  })
})

describe('latestVerdicts', () => {
  function client (results: Array<Partial<TestResult>>): Client {
    return {
      async findAll (_class: Ref<Class<Doc>>): Promise<any> {
        return toFindResult(results as any)
      }
    } as unknown as Client
  }

  it('takes the NEWEST result per case', async () => {
    const verdicts = await latestVerdicts(
      client([
        { testCase: CASE_A, status: TestRunStatus.Failed, modifiedOn: 100 } as any,
        { testCase: CASE_A, status: TestRunStatus.Passed, modifiedOn: 200 } as any,
        { testCase: CASE_B, status: TestRunStatus.Blocked, modifiedOn: 50 } as any
      ]),
      [CASE_A, CASE_B]
    )
    expect(verdicts.get(CASE_A)).toBe('passed')
    expect(verdicts.get(CASE_B)).toBe('blocked')
  })

  it('leaves a never-executed case out entirely, so it reads as untested', async () => {
    const verdicts = await latestVerdicts(client([]), [CASE_A])
    expect(verdicts.has(CASE_A)).toBe(false)
  })

  it('issues no query at all for an empty case list', async () => {
    let called = false
    const spy = {
      async findAll (): Promise<any> {
        called = true
        return toFindResult([] as any)
      }
    } as unknown as Client
    expect((await latestVerdicts(spy, [])).size).toBe(0)
    expect(called).toBe(false)
  })
})
