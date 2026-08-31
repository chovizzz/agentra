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

import type { Doc, Ref } from '@hcengineering/core'

import {
  inheritableTraceEdges,
  inheritableTraceEdgesFrom,
  summariseRequirementCoverage,
  type CoverageEdge,
  type CoverageVerdict
} from '../coverage'
import { traceLinkInheritsOnRevision } from '../links'

const V1 = 'requirement-v1' as Ref<Doc>
const V2 = 'requirement-v2' as Ref<Doc>
const LOGICAL = V1
const CASE_A = 'case-a' as Ref<Doc>
const CASE_B = 'case-b' as Ref<Doc>

function edge (kind: CoverageEdge['kind'], source: Ref<Doc>, target: Ref<Doc>): CoverageEdge {
  return { kind, source, target, targetBaseId: LOGICAL }
}

function verdicts (entries: Array<[Ref<Doc>, CoverageVerdict]>): Map<Ref<Doc>, CoverageVerdict> {
  return new Map(entries)
}

describe('summariseRequirementCoverage', () => {
  it('counts one verifying case per source, with its verdict', () => {
    const result = summariseRequirementCoverage(
      [edge('verifies', CASE_A, V1), edge('verifies', CASE_B, V1)],
      V1,
      LOGICAL,
      verdicts([
        [CASE_A, 'passed'],
        [CASE_B, 'failed']
      ])
    )
    expect(result.covered).toBe(2)
    expect(result.passed).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.stale).toBe(0)
    expect(result.supersededCoverage).toBe(false)
  })

  it('treats a linked but never executed case as untested, not as passing', () => {
    const result = summariseRequirementCoverage([edge('verifies', CASE_A, V1)], V1, LOGICAL, verdicts([]))
    expect(result.covered).toBe(1)
    expect(result.untested).toBe(1)
    expect(result.passed).toBe(0)
  })

  it('counts blocked and skipped in their own buckets', () => {
    const result = summariseRequirementCoverage(
      [edge('verifies', CASE_A, V1), edge('verifies', CASE_B, V1)],
      V1,
      LOGICAL,
      verdicts([
        [CASE_A, 'blocked'],
        [CASE_B, 'skipped']
      ])
    )
    expect(result.blocked).toBe(1)
    expect(result.skipped).toBe(1)
    // 🔴 Neither is a pass. A `switch` with a `default` would have folded the
    // appended `Skipped` status into the passing branch.
    expect(result.passed).toBe(0)
  })

  it('ignores non-verifies kinds', () => {
    const result = summariseRequirementCoverage(
      [edge('implements', CASE_A, V1), edge('defect-of', CASE_B, V1)],
      V1,
      LOGICAL,
      verdicts([])
    )
    expect(result.covered).toBe(0)
  })

  it('de-duplicates several edges from the same case onto one count', () => {
    const result = summariseRequirementCoverage(
      [edge('verifies', CASE_A, V1), edge('verifies', CASE_A, V1)],
      V1,
      LOGICAL,
      verdicts([[CASE_A, 'passed']])
    )
    expect(result.covered).toBe(1)
    expect(result.passed).toBe(1)
  })
})

describe('a revised requirement', () => {
  const beforeRevision: CoverageEdge[] = [edge('verifies', CASE_A, V1), edge('verifies', CASE_B, V1)]

  it('drops to ZERO coverage on the new revision', () => {
    // 🔴 Technical Spec §3.2.1. The edges still exist and still point at v1;
    // the new revision simply has none of its own.
    const result = summariseRequirementCoverage(beforeRevision, V2, LOGICAL, verdicts([[CASE_A, 'passed']]))
    expect(result.covered).toBe(0)
    expect(result.passed).toBe(0)
  })

  it('reports the old coverage as STALE, so the page can say why it is zero', () => {
    const result = summariseRequirementCoverage(beforeRevision, V2, LOGICAL, verdicts([]))
    expect(result.stale).toBe(2)
    // The flag is what separates "this revision was never verified" from
    // "nobody ever verified this requirement at all".
    expect(result.supersededCoverage).toBe(true)
  })

  it('does not count edges towards a DIFFERENT requirement as stale', () => {
    const other: CoverageEdge = {
      kind: 'verifies',
      source: CASE_A,
      target: 'other-v1' as Ref<Doc>,
      targetBaseId: 'other' as Ref<Doc>
    }
    const result = summariseRequirementCoverage([other], V2, LOGICAL, verdicts([]))
    expect(result.stale).toBe(0)
    expect(result.supersededCoverage).toBe(false)
  })

  it('starts covered again as soon as ONE case is re-linked to the new revision', () => {
    const result = summariseRequirementCoverage(
      [...beforeRevision, edge('verifies', CASE_A, V2)],
      V2,
      LOGICAL,
      verdicts([[CASE_A, 'passed']])
    )
    expect(result.covered).toBe(1)
    expect(result.passed).toBe(1)
    expect(result.stale).toBe(2)
    expect(result.supersededCoverage).toBe(false)
  })
})

describe('inheritableTraceEdges', () => {
  it('never inherits verifies', () => {
    const inherited = inheritableTraceEdges([edge('verifies', CASE_A, V1), edge('implements', CASE_B, V1)], V1)
    expect(inherited.map((it) => it.kind)).toEqual(['implements'])
  })

  it('never inherits delivered-in either, and inherits the other four', () => {
    const all: CoverageEdge[] = (
      ['converted-to', 'implements', 'verifies', 'defect-of', 'fixed-by', 'delivered-in'] as const
    ).map((kind) => edge(kind, CASE_A, V1))
    const inherited = inheritableTraceEdges(all, V1).map((it) => it.kind)
    expect(inherited).toEqual(['converted-to', 'implements', 'defect-of', 'fixed-by'])
  })

  it('executes the spec table rather than a second copy of it', () => {
    // Guards against the table and this function drifting apart.
    for (const [kind, inherits] of Object.entries(traceLinkInheritsOnRevision)) {
      const got = inheritableTraceEdges([edge(kind as CoverageEdge['kind'], CASE_A, V1)], V1)
      expect(got.length).toBe(inherits ? 1 : 0)
    }
  })

  it('ignores edges that point at some other revision', () => {
    expect(inheritableTraceEdges([edge('implements', CASE_A, V2)], V1)).toHaveLength(0)
  })
})

describe('inheritableTraceEdgesFrom', () => {
  it('matches on the SOURCE end, which is where delivered-in lives', () => {
    // `Requirement --delivered-in--> ProductVersion`: the revised requirement is
    // the source, so the target-side function sees nothing at all here.
    const edges = [edge('delivered-in', V1, CASE_A), edge('converted-to', V1, CASE_B)]
    expect(inheritableTraceEdges(edges, V1)).toHaveLength(0)
    expect(inheritableTraceEdgesFrom(edges, V1).map((it) => it.kind)).toEqual(['converted-to'])
  })

  it('executes the SAME table as the target side', () => {
    for (const [kind, inherits] of Object.entries(traceLinkInheritsOnRevision)) {
      const got = inheritableTraceEdgesFrom([edge(kind as CoverageEdge['kind'], V1, CASE_A)], V1)
      expect(got.length).toBe(inherits ? 1 : 0)
    }
  })

  it('ignores edges whose source is some other revision', () => {
    expect(inheritableTraceEdgesFrom([edge('implements', V2, CASE_A)], V1)).toHaveLength(0)
  })
})
