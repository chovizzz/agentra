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
  APPROVED_TEST_CASE_FROZEN_FIELDS,
  TestCaseStatus,
  isTestCaseContentFrozen,
  type TestCase
} from '@hcengineering/test-management'

/**
 * How one field is being written, so an operator write is never mistaken for a
 * plain value.
 *
 * 🔴 AN OPERATOR WRITE CANNOT BE EVALUATED AS "the value after this write".
 * Reading `{ $unset: { name: '' } }` as `undefined` — or worse, as "untouched"
 * — would let a frozen field be emptied on an approved case by a second write
 * instead of the first, which is the same edit reached by another door.
 *
 * @public
 */
export type TestCaseFieldWrite =
  | { kind: 'untouched' }
  | { kind: 'plain', value: unknown }
  | { kind: 'unset' }
  | { kind: 'opaque', operator: string }

/**
 * Classify how `field` is written by one `TxUpdateDoc.operations` object.
 *
 * 🔴 `$rename` IS CHECKED IN BOTH DIRECTIONS. Its shape is
 * `{ $rename: { from: 'to' } }`, so the field being written appears once as a
 * KEY (the source, which is removed) and once as a VALUE (the target, which is
 * created). A guard that only walked the keys would refuse
 * `{ $rename: { name: 'scratch' } }` and wave through
 * `{ $rename: { scratch: 'name' } }` — i.e. it would stop a frozen field being
 * carried away but not a frozen field being overwritten.
 *
 * @public
 */
export function readTestCaseFieldWrite (ops: Record<string, any>, field: string): TestCaseFieldWrite {
  if (Object.prototype.hasOwnProperty.call(ops, field)) {
    return { kind: 'plain', value: ops[field] }
  }
  for (const [key, value] of Object.entries(ops)) {
    if (!key.startsWith('$') || value == null || typeof value !== 'object') continue
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      return key === '$unset' ? { kind: 'unset' } : { kind: 'opaque', operator: key }
    }
    // The rename TARGET side. `Object.values` on anything else would compare
    // unrelated payloads against a field name, so this is scoped to `$rename`.
    if (key === '$rename' && Object.values(value as Record<string, unknown>).includes(field)) {
      return { kind: 'opaque', operator: key }
    }
  }
  return { kind: 'untouched' }
}

/**
 * Whether this update names any field that an approved case freezes.
 *
 * Callers use it as the CHEAP GATE: a transaction touching none of these needs
 * no document read at all, which is what keeps `VersioningMiddleware`'s
 * `readonly` / `isLatest` writes, the `version` bump from `registerTestCaseEdit`
 * and every collection counter on the free path.
 *
 * @public
 */
export function touchesFrozenTestCaseField (ops: Record<string, any>): boolean {
  return APPROVED_TEST_CASE_FROZEN_FIELDS.some((field) => readTestCaseFieldWrite(ops, field).kind !== 'untouched')
}

/**
 * Whether `value` is a member of the `TestCaseStatus` enum.
 *
 * ⚠️ `Object.values` IS NOT USABLE HERE. A numeric TypeScript enum also carries
 * its reverse mapping, so `Object.values(TestCaseStatus)` contains the NAMES as
 * well — and `'Draft'` would pass a membership test that the runtime then
 * compares against a number. The reverse lookup answers the question directly.
 *
 * @public
 */
export function isTestCaseStatus (value: unknown): value is TestCaseStatus {
  return typeof value === 'number' && TestCaseStatus[value] !== undefined
}

/**
 * @public
 */
export interface ApprovedTestCaseViolation {
  readonly field: string
  readonly operator?: string
}

/**
 * QA-T019, decided against the state the document is in RIGHT NOW.
 *
 * The rule: while a `TestCase` is `Approved`, the fields in
 * {@link APPROVED_TEST_CASE_FROZEN_FIELDS} are refused.
 *
 * 🔴 THE ONE EXCEPTION IS THE ESCAPE HATCH, and it is not a loophole. An update
 * that moves `status` OFF `Approved` in the SAME transaction may carry content
 * with it: that is "reopen the case and edit it", done atomically instead of as
 * two writes, and the resulting document is no longer approved — which is
 * precisely the state QA-T019 wants an edited case to be in. Without it the
 * only way to touch an approved case would be two round trips whose first half
 * is indistinguishable from this one.
 *
 * ⚠️ `status: unset` is NOT that exception. A case with no status has no
 * position in the review ladder, and the next write would be judged against
 * `undefined` — laundering, not reopening.
 *
 * ⚠️ An OPAQUE write to `status` is not it either: `{ $inc: { status: 1 } }`
 * cannot be resolved to a value here, so "did this leave Approved" is
 * unanswerable and the safe answer is no.
 *
 * 🔴 NOR IS A STATUS THAT IS NOT A STATUS. `{ name: 'x', status: null }` — or
 * `status: 99`, or `status: 'Draft'` as a string — would otherwise compare
 * unequal to `Approved` and buy the content edit for free, which is the gate
 * defeated by writing GARBAGE rather than by leaving the state. The case would
 * land with no position in the review ladder at all, so an unrecognised value
 * is refused exactly like `$unset`.
 *
 * @public
 */
export function checkApprovedTestCaseUpdate (
  current: Pick<TestCase, 'status'>,
  ops: Record<string, any>
): ApprovedTestCaseViolation | undefined {
  if (!isTestCaseContentFrozen(current)) return undefined

  const touched = APPROVED_TEST_CASE_FROZEN_FIELDS.filter(
    (field) => readTestCaseFieldWrite(ops, field).kind !== 'untouched'
  )
  if (touched.length === 0) return undefined

  const statusWrite = readTestCaseFieldWrite(ops, 'status')
  if (statusWrite.kind === 'opaque') {
    return { field: 'status', operator: statusWrite.operator }
  }
  if (statusWrite.kind === 'unset') {
    return { field: 'status' }
  }

  if (statusWrite.kind === 'plain' && !isTestCaseStatus(statusWrite.value)) {
    return { field: 'status' }
  }

  const statusAfter = statusWrite.kind === 'plain' ? (statusWrite.value as TestCaseStatus) : current.status
  if (statusAfter === TestCaseStatus.Approved) {
    const [field] = touched
    const write = readTestCaseFieldWrite(ops, field)
    return { field, operator: write.kind === 'opaque' ? write.operator : undefined }
  }
  return undefined
}
