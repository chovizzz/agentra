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

import type { Client, Doc, Ref } from '@hcengineering/core'
import testManagement, { TestRunStatus, type TestCase, type TestResult } from '@hcengineering/test-management'
import {
  normId,
  summariseRequirementCoverage,
  type CoverageEdge,
  type CoverageVerdict,
  type MaybeVersioned,
  type RequirementCoverage
} from '@hcengineering/traceability'
//
// 🔴 DEEP IMPORTS, NOT THE PACKAGE ROOT. `traceability-resources/src/index.ts`
// imports four `.svelte` components; pulling it in from here would drag the
// Svelte runtime into the node-environment unit tests, which cannot parse a
// `.svelte` file at all. The same reasoning already keeps
// `checkRequirementTraceLinksVisibility` out of `./utils` (see `./sections`).
// Deep `src/*` imports are the in-tree convention for this — `models/*` reach
// `-resources/src/plugin` the same way, and the packages' `svelte` field points
// at `src`, so the browser bundle resolves them identically.
//
import { findIncomingTraceLinks, isRestrictedLink } from '@hcengineering/traceability-resources/src/utils'
import type { TraceLinkView, TraceLinksState } from '@hcengineering/traceability-resources/src/types'

/**
 * Coverage as the Requirement page renders it.
 *
 * `available` and `restricted` are carried through UNCHANGED from the server:
 * the first says whether the traceability handler is installed at all (which is
 * not the same as "no coverage"), the second is the server's count of edges with
 * an endpoint this caller may not read.
 *
 * @public
 */
export interface RequirementCoverageState extends RequirementCoverage {
  available: boolean
  restricted: number
}

/**
 * @public
 */
export const emptyRequirementCoverageState: RequirementCoverageState = {
  available: false,
  restricted: 0,
  covered: 0,
  stale: 0,
  passed: 0,
  failed: 0,
  blocked: 0,
  skipped: 0,
  untested: 0,
  supersededCoverage: false
}

/**
 * Map a persisted `TestRunStatus` onto the coverage vocabulary.
 *
 * 🔴 EXHAUSTIVE, WITH NO `default`. `TestRunStatus` is a numeric enum whose
 * values are persisted verbatim, and `Skipped` was APPENDED at 4 — a `switch`
 * with a `default` branch would have folded it into whichever case the default
 * returned, silently reporting a skipped test as a pass. An unmapped value falls
 * through to `untested`, which is the only reading that cannot overstate quality.
 *
 * @public
 */
export function verdictOf (status: TestRunStatus | undefined): CoverageVerdict {
  if (status === TestRunStatus.Passed) return 'passed'
  if (status === TestRunStatus.Failed) return 'failed'
  if (status === TestRunStatus.Blocked) return 'blocked'
  if (status === TestRunStatus.Skipped) return 'skipped'
  return 'untested'
}

/**
 * Turn permission-filtered edges into coverage input.
 *
 * 🔴 RESTRICTED EDGES ARE DROPPED, not counted. An edge whose far endpoint the
 * caller may not read would otherwise contribute a `covered` unit whose verdict
 * can never be resolved — and counting it would tell the caller how many test
 * cases exist in a project they have no access to, which is precisely the side
 * channel the server's per-endpoint filter exists to close. Their volume is
 * still reported, as the server's own `restricted` figure.
 *
 * @public
 */
export function coverageEdges (links: readonly TraceLinkView[]): CoverageEdge[] {
  const out: CoverageEdge[] = []
  for (const link of links) {
    if (isRestrictedLink(link)) continue
    const target = link.target
    out.push({
      kind: link.kind,
      target: target._id,
      targetBaseId: target.doc !== undefined ? normId(target.doc as MaybeVersioned) : target._id,
      source: link.source._id
    })
  }
  return out
}

/**
 * The latest verdict for each verifying test case.
 *
 * "Latest" is by `modifiedOn` over every `TestResult` naming the case. A case
 * that has never been executed simply has no entry, which
 * {@link summariseRequirementCoverage} reads as `untested` — never as a pass.
 *
 * @public
 */
export async function latestVerdicts (
  client: Client,
  testCases: Array<Ref<TestCase>>
): Promise<Map<Ref<Doc>, CoverageVerdict>> {
  const verdicts = new Map<Ref<Doc>, CoverageVerdict>()
  if (testCases.length === 0) {
    return verdicts
  }
  const results = await client.findAll<TestResult>(testManagement.class.TestResult, {
    testCase: { $in: testCases }
  })
  const newest = new Map<Ref<TestCase>, TestResult>()
  for (const result of results) {
    const current = newest.get(result.testCase)
    if (current === undefined || result.modifiedOn > current.modifiedOn) {
      newest.set(result.testCase, result)
    }
  }
  for (const [testCase, result] of newest) {
    verdicts.set(testCase, verdictOf(result.status))
  }
  return verdicts
}

/**
 * Full coverage state for one requirement revision.
 *
 * ⚠️ `normalize: true` plus `baseId` is what makes the STALE count possible: it
 * asks the server for every edge towards any revision of this logical
 * requirement, and the arithmetic then splits "points at this revision" from
 * "points at an earlier one". Without it a revised requirement would report zero
 * coverage with no explanation of why.
 *
 * @public
 */
export async function requirementCoverage (
  client: Client,
  requirement: Doc & MaybeVersioned
): Promise<RequirementCoverageState> {
  const state: TraceLinksState = await findIncomingTraceLinks(client, {
    doc: requirement._id,
    baseId: normId(requirement),
    normalize: true,
    kinds: ['verifies']
  })
  if (!state.available) {
    return { ...emptyRequirementCoverageState }
  }
  const edges = coverageEdges(state.links)
  const verdicts = await latestVerdicts(
    client,
    edges.filter((it) => it.target === requirement._id).map((it) => it.source as Ref<TestCase>)
  )
  return {
    ...summariseRequirementCoverage(edges, requirement._id, normId(requirement), verdicts),
    available: true,
    // 🔴 The SERVER's number, rendered as received. Recomputing it client side
    // would be trivially "corrected" into leaking what it hides.
    restricted: state.coverage.restricted
  }
}
