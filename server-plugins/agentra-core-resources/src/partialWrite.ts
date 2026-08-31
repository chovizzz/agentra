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

/**
 * Whether a REFUSAL may have left documents behind.
 *
 * 🔴 THIS IS A SECOND, ORTHOGONAL AXIS — NOT A NEW STATUS CODE. `code` answers
 * "will retrying help?" (409 = the result does not exist yet; 400 = terminal).
 * This answers "did anything get written before the refusal?". They are
 * independent: a 400 raised from item 4 of a 10-item batch is terminal AND has
 * written three issues. Folding the second question into the first — say by
 * re-coding the mid-loop refusals as 409 — would have told every existing
 * client `retryable: true`, which is a DIFFERENT claim ("nothing ran, try
 * again") and the one that was already wrong.
 *
 * 🔴 THE QUESTION IS ABOUT THE REQUEST, NOT ABOUT THIS INVOCATION. "May
 * documents for this request exist?" — not "did the call I just made write
 * anything?". The two differ exactly where it matters: a refusal because
 * another attempt ON THE SAME IDEMPOTENCY KEY holds the claim wrote nothing
 * *here*, while that other attempt may be halfway through the batch. The user
 * is asking the first question, and answering the second one is how they get
 * told an inhabited batch is empty.
 *
 * - `none` — the refusal is raised on a path that provably precedes every
 *   write. "Nothing was created" is a true sentence to put in front of a user.
 * - `possible` — the refusal can be raised after writes have begun. The client
 *   must NOT say "nothing was created", and must offer a retry ON THE SAME
 *   IDEMPOTENCY KEY rather than a fresh submission.
 * - `unclassified` — nobody has audited this refusal path. Treated exactly like
 *   `possible` by any honest client; it exists so that "not yet answered" is
 *   distinguishable from "answered: clean", because those two must never
 *   collapse into the same wire value.
 *
 * @public
 */
export type PartialWriteRisk = 'none' | 'possible' | 'unclassified'

/**
 * The classification a command that has NOT been audited reports.
 *
 * ⚠️ Deliberately not `'none'`. An absent or defaulted field that means "clean"
 * is how the original bug would come back: a new command would inherit a
 * reassuring answer nobody ever gave.
 *
 * @public
 */
export const PARTIAL_WRITE_UNCLASSIFIED: PartialWriteRisk = 'unclassified'

/**
 * A per-reason classification table.
 *
 * 🔴 THE EXHAUSTIVENESS MECHANISM. `Record<Reason, ...>` over a string-literal
 * union is checked in BOTH directions by the compiler: a reason added to the
 * union with no entry here is `TS2739 (missing property)`, and an entry for a
 * reason that is not in the union is `TS2353 (object literal may only specify
 * known properties)`. So the next person who adds a refusal reason cannot ship
 * it without saying, in this table, whether it can fire mid-write — which is
 * exactly the step that was skipped when all seven reasons were given one 400.
 *
 * `PartialWriteRisk` is deliberately NOT the value type here: a per-command
 * table must decide, and `'unclassified'` is not a decision.
 *
 * @public
 */
export type PartialWriteTable<Reason extends string> = Record<Reason, 'none' | 'possible'>

/**
 * A runtime companion to the compile-time check above.
 *
 * The `Record` check is defeated the moment somebody widens a reason type to
 * `string`, and it says nothing to a JavaScript caller. This turns a missing
 * entry into a thrown error at the point of use instead of a silent `undefined`
 * that would serialise as a missing field and read as "clean".
 *
 * @public
 */
export function lookupPartialWrite<Reason extends string> (
  table: PartialWriteTable<Reason>,
  reason: Reason
): 'none' | 'possible' {
  const risk = table[reason]
  if (risk !== 'none' && risk !== 'possible') {
    throw new Error(`Refusal reason '${String(reason)}' has no partial-write classification`)
  }
  return risk
}
