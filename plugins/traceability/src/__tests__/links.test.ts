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

import type { Class, Doc, Ref } from '@hcengineering/core'

import {
  registerTraceEndpoint,
  registerTraceEndpointRoles,
  traceEndpointRoles,
  traceLinkMatrix,
  validateTraceLink,
  type TraceEndpointRegistry
} from '../links'

const ISSUE = 'tracker:class:Issue' as Ref<Class<Doc>>
const REQUIREMENT = 'requirements:masterTag:Requirement' as Ref<Class<Doc>>
const TEST_CASE = 'testManagement:class:TestCase' as Ref<Class<Doc>>
const TEST_RESULT = 'testManagement:class:TestResult' as Ref<Class<Doc>>
const LEAD = 'crmLite:masterTag:Lead' as Ref<Class<Doc>>

function registry (): TraceEndpointRegistry {
  const map: TraceEndpointRegistry = new Map()
  registerTraceEndpoint(map, LEAD, 'Lead')
  registerTraceEndpoint(map, REQUIREMENT, 'Requirement')
  registerTraceEndpoint(map, TEST_CASE, 'TestCase')
  registerTraceEndpoint(map, TEST_RESULT, 'TestResult')
  // 🔴 One class, two roles — Technical Spec §3.4 forbids a parallel Issue class.
  registerTraceEndpointRoles(map, ISSUE, ['Bug', 'WorkItem'])
  return map
}

const A = 'aaaaaaaaaaaaaaaaaaaaaaa1' as Ref<Doc>
const B = 'aaaaaaaaaaaaaaaaaaaaaaa2' as Ref<Doc>

describe('traceEndpointRoles', () => {
  it('normalises the scalar and the array halves of the union', () => {
    const map = registry()
    expect(traceEndpointRoles(map, LEAD)).toEqual(['Lead'])
    expect(traceEndpointRoles(map, ISSUE)).toEqual(['Bug', 'WorkItem'])
  })

  it('returns an empty list for an unregistered class, so validation fails closed', () => {
    expect(traceEndpointRoles(registry(), 'nope' as Ref<Class<Doc>>)).toEqual([])
  })

  it('keeps `get()` readable for single-role classes', () => {
    // The scalar half exists so existing callers and assertions keep working.
    expect(registry().get(LEAD)).toBe('Lead')
  })

  it('REPLACES rather than merges, so the outcome does not depend on load order', () => {
    const map = registry()
    registerTraceEndpointRoles(map, ISSUE, ['Bug'])
    expect(traceEndpointRoles(map, ISSUE)).toEqual(['Bug'])
  })
})

describe('validateTraceLink with a multi-role class', () => {
  it('accepts Issue as the Bug source of defect-of', () => {
    expect(validateTraceLink(registry(), 'defect-of', ISSUE, TEST_RESULT, A, B).valid).toBe(true)
  })

  it('accepts Issue as the WorkItem source of implements', () => {
    expect(validateTraceLink(registry(), 'implements', ISSUE, REQUIREMENT, A, B).valid).toBe(true)
  })

  it('accepts all THREE defect-of targets', () => {
    const map = registry()
    for (const target of [TEST_RESULT, TEST_CASE, REQUIREMENT]) {
      expect(validateTraceLink(map, 'defect-of', ISSUE, target, A, B)).toEqual({ valid: true })
    }
  })

  it('does NOT widen the matrix: a combination the table forbids is still refused', () => {
    const map = registry()
    // Issue carries both roles, but `verifies` has no Issue source at all.
    expect(validateTraceLink(map, 'verifies', ISSUE, REQUIREMENT, A, B)).toEqual({
      valid: false,
      reason: 'combination-not-allowed'
    })
    // TestCase --verifies--> TestResult: legal source, illegal target.
    expect(validateTraceLink(map, 'verifies', TEST_CASE, TEST_RESULT, A, B)).toEqual({
      valid: false,
      reason: 'combination-not-allowed'
    })
    // Nothing may be a `converted-to` source except a Lead.
    expect(validateTraceLink(map, 'converted-to', ISSUE, REQUIREMENT, A, B)).toEqual({
      valid: false,
      reason: 'combination-not-allowed'
    })
  })

  it('accepts TestCase --verifies--> Requirement, and only that shape', () => {
    const map = registry()
    expect(validateTraceLink(map, 'verifies', TEST_CASE, REQUIREMENT, A, B).valid).toBe(true)
    expect(validateTraceLink(map, 'verifies', REQUIREMENT, TEST_CASE, A, B).valid).toBe(false)
  })

  it('fails closed on an unregistered class', () => {
    const map = new Map() as TraceEndpointRegistry
    expect(validateTraceLink(map, 'verifies', TEST_CASE, REQUIREMENT, A, B)).toEqual({
      valid: false,
      reason: 'unknown-source-class'
    })
  })

  it('still refuses a self link', () => {
    expect(validateTraceLink(registry(), 'defect-of', ISSUE, TEST_RESULT, A, A)).toEqual({
      valid: false,
      reason: 'self-link'
    })
  })

  it('keeps the defect-of row at three targets', () => {
    // Guards the spec table itself: `Bug --defect-of--> TestResult | TestCase | Requirement`.
    expect([...traceLinkMatrix['defect-of'].target].sort()).toEqual(['Requirement', 'TestCase', 'TestResult'])
    expect(traceLinkMatrix['defect-of'].source).toEqual(['Bug'])
  })
})
