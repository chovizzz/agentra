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

import { ProductVersionState } from '@hcengineering/products'

/**
 * Why every refusal carries a machine readable reason: "you may not set
 * `Released` by hand" and "I cannot evaluate what `$inc` does to `state`" are
 * different operator problems with different fixes, and a bare
 * `Error('not allowed')` would collapse them into one useless message. Same
 * shape, and the same reason, as `LeadGuardReason`.
 *
 * @public
 */
export type ProductReleaseGuardReason =
  | 'release-requires-command'
  | 'release-on-create'
  | 'opaque-operation'
  | 'state-removed'
  | 'unknown-state'

/**
 * @public
 */
export interface ProductReleaseGuardRefusal {
  ok: false
  reason: ProductReleaseGuardReason
  message: string
}

/**
 * @public
 */
export type ProductReleaseGuardVerdict = { ok: true } | ProductReleaseGuardRefusal

/**
 * @public
 */
export function refuseRelease (reason: ProductReleaseGuardReason, message: string): ProductReleaseGuardRefusal {
  return { ok: false, reason, message }
}

/**
 * The fields this guard evaluates AT ALL.
 *
 * 🔴 A LIST, NOT "REFUSE EVERY WRITE TO A ProductVersion". A blanket freeze
 * would break the platform's own writers, and they are not hypothetical:
 * `VersioningMiddleware` stamps `readonly` / `isLatest`, `models/products`'s
 * `migratePatchVersion` backfills `patch`, and the whole product panel edits
 * `name` / `description` / `codename` on unreleased versions. Every one of
 * those updates would have to be enumerated as an exception, and the first one
 * anybody forgot would be a silent outage rather than a silent hole.
 *
 * Naming the one field that carries the security property inverts that: a tx
 * that does not mention `state` leaves {@link readProductVersionStateIntent}
 * with `untouched` and the middleware returns WITHOUT READING THE DOCUMENT.
 *
 * ⚠️ `readonly` is deliberately NOT here even though the release command writes
 * it in the same tx. It is a UI/edit marker; setting it grants nobody a release
 * and freezing it would collide with the frozen-state handling in
 * `plugins/products`.
 *
 * @public
 */
export const RELEASE_GUARDED_FIELDS: readonly string[] = ['state']

/**
 * What a `TxUpdateDoc.operations` object does to ONE named field.
 *
 * 🔴 WHY THIS IS NOT `'state' in operations`. `DocumentUpdate` is either a
 * plain partial or an OPERATOR object (`isOperator` demands every key start
 * with `$`), and the operator vocabulary includes `$rename`, which moves an
 * arbitrary field ONTO `state` without the string `state` ever appearing as a
 * key. The adapters do not agree on what they refuse either: the Mongo adapter
 * hands the operator object to Mongo verbatim, so an operator this codebase
 * does not implement (`$set`) still executes there.
 *
 * 🔴 AND `state` IS A NUMBER, WHICH MAKES THIS SHARPER THAN THE LEAD CASE.
 * `ProductVersionState.Active` is `0` and `Released` is `1`, so
 * `{ $inc: { state: 1 } }` on an Active version IS a release — with the literal
 * `Released` appearing nowhere in the transaction. Anything this function
 * cannot read as a concrete value must therefore be refused, not guessed at.
 *
 * No legitimate writer in this codebase touches `state` with an operator: the
 * create dialogs, the state editor and the `ReleaseProductVersion` command all
 * write a plain value. Refusing is a closed door, not a lost feature.
 *
 * @public
 */
export type FieldWrite =
  | { kind: 'untouched' }
  | { kind: 'plain', value: unknown }
  | { kind: 'unset' }
  | { kind: 'opaque', operator: string }

/**
 * @public
 */
export function readFieldWrite (operations: Record<string, any>, field: string): FieldWrite {
  if (operations == null || typeof operations !== 'object') {
    return { kind: 'untouched' }
  }
  // 🔴 PER-KEY DISPATCH, MIRRORING `TxProcessor.applyUpdate`, NOT
  // `isOperator(operations)`. This is a real hole that an `isOperator` gate
  // leaves open, and it is silent:
  //
  //   `isOperator` demands that EVERY key start with `$`, but `applyUpdate`
  //   (and `updateMixin4Doc`) decide PER KEY — `key.startsWith('$')` picks the
  //   operator, anything else is a plain `setObjectValue`. So a MIXED payload
  //   like `{ codename: 'x', $inc: { state: 1 } }` makes `isOperator` answer
  //   `false`, sends a guard down the plain branch, where `'state' in
  //   operations` is `false` — and the tx reads as "does not touch state" while
  //   every in-memory applier (ModelDb, the client cache, live queries, and the
  //   Postgres adapter's own operator path) really does `state += 1`, i.e.
  //   `Active` -> `Released`.
  //
  // Walking the keys the way the appliers do removes the discrepancy entirely.
  let result: FieldWrite = { kind: 'untouched' }
  const escalate = (next: FieldWrite): void => {
    // Refusal-biased: with two writes to the same field the applied order is
    // object-key order, and an unevaluable one anywhere in the payload makes
    // the outcome unevaluable. Never downgrade `opaque`/`unset` to `plain`.
    if (result.kind === 'opaque') return
    if (result.kind === 'unset' && next.kind === 'plain') return
    result = next
  }
  for (const key of Object.keys(operations)) {
    if (!key.startsWith('$')) {
      if (key === field) {
        escalate({ kind: 'plain', value: operations[key] })
      } else if (key.startsWith(`${field}.`)) {
        // `setObjectValue` honours dotted paths, so `state.x` reaches INTO the
        // field. Nothing legitimate does it and the result is not a state.
        escalate({ kind: 'opaque', operator: key })
      }
      continue
    }
    const payload = operations[key]
    if (payload == null || typeof payload !== 'object') {
      continue
    }
    if (key === '$unset') {
      if (field in payload) escalate({ kind: 'unset' })
      continue
    }
    if (key === '$rename') {
      // Both halves matter: renaming `state` AWAY removes it, and renaming
      // something else ONTO `state` writes it. Neither is evaluable here.
      if (field in payload || Object.values(payload).includes(field)) {
        escalate({ kind: 'opaque', operator: key })
      }
      continue
    }
    if (field in payload) {
      escalate({ kind: 'opaque', operator: key })
    }
  }
  return result
}

/**
 * `Released` may never be written by a CREATE, under any evidence.
 *
 * 🔴 THIS CLOSES A STALE-EVIDENCE BYPASS. Both facts the update path checks are
 * keyed on the VERSION ID and both outlive the version: `ProductVersionRemove`
 * collects nothing, so deleting a released version leaves its ledger row and
 * its audit record behind. Re-creating a document at the SAME `_id` with
 * `{ state: Released }` would then satisfy an evidence lookup with a previous
 * release's paperwork, and the new document could say anything at all.
 *
 * Refusing outright costs nothing, because `ReleaseProductVersion` only ever
 * releases an EXISTING version — it issues a `TxUpdateDoc` at Step 5 and never
 * a create — so no legitimate writer is on this path. Both shipped creators
 * write `ProductVersionState.Active`.
 *
 * @public
 */
export function checkProductVersionCreate (attributes: Record<string, any>): ProductVersionStateIntent {
  const intent = readProductVersionStateIntent(attributes)
  if (intent.kind !== 'needs-command') {
    return intent
  }
  return {
    kind: 'refused',
    verdict: refuseRelease(
      'release-on-create',
      "A product version cannot be created as 'Released'; the release command updates an existing version"
    )
  }
}

/**
 * Is `value` a member of {@link ProductVersionState}?
 *
 * 🔴 THE REVERSE MAPPING ALONE IS NOT ENOUGH. TypeScript compiles a numeric
 * enum to an object holding BOTH directions, so `ProductVersionState['Released']`
 * is `1` and `Object.values(ProductVersionState)` contains the strings
 * `'Active'`, `'Released'`, … as well as the numbers. A check written as
 * `ProductVersionState[value] !== undefined` therefore accepts the STRING
 * `'Released'`, and `Object.values(...).includes(value)` accepts it too. The
 * `typeof value === 'number'` clause is what closes that.
 *
 * @public
 */
export function isProductVersionState (value: unknown): value is ProductVersionState {
  return typeof value === 'number' && (ProductVersionState as Record<number, string>)[value] !== undefined
}

/**
 * What a transaction intends to do to `ProductVersion.state`.
 *
 * Split out from the middleware as a pure function so the classification is
 * testable without a pipeline, and so the ONE branch that needs database
 * evidence (`needs-command`) is visibly the only one.
 *
 * @public
 */
export type ProductVersionStateIntent =
  | { kind: 'untouched' }
  /** A concrete, valid state that is not `Released`. Nothing to enforce. */
  | { kind: 'allowed', state: ProductVersionState }
  /** `Released`. Only the release command may produce this. */
  | { kind: 'needs-command' }
  | { kind: 'refused', verdict: ProductReleaseGuardRefusal }

/**
 * Classify a `state` write.
 *
 * ⚠️ THIS FUNCTION DOES NOT LOOK AT THE CURRENT STATE, ON PURPOSE. The rule
 * being enforced is "`Released` is produced by `ReleaseProductVersion` and by
 * nothing else"; it is a property of the VALUE BEING WRITTEN, not of the
 * transition. That is what keeps `Released -> Archived`, `Planning -> Active`,
 * `ReleaseCandidate -> Planning` and every other move working without this
 * guard inventing a transition table the technical spec never wrote down. The
 * only transition table in the codebase is `RELEASABLE_FROM`, and it lives
 * inside the command, where the release decision belongs.
 *
 * @public
 */
export function readProductVersionStateIntent (operations: Record<string, any>): ProductVersionStateIntent {
  const write = readFieldWrite(operations, 'state')
  switch (write.kind) {
    case 'untouched':
      return { kind: 'untouched' }
    case 'unset':
      // 🔴 REFUSED, and not for state-machine tidiness. `state` is what
      // `isFrozenProductVersionState` reads, so a version with no state is a
      // RELEASED version that no longer reports as frozen — an unfreeze
      // disguised as a deletion. Nothing in the product writes `$unset` here.
      return {
        kind: 'refused',
        verdict: refuseRelease('state-removed', 'A product version state cannot be removed')
      }
    case 'opaque':
      return {
        kind: 'refused',
        verdict: refuseRelease(
          'opaque-operation',
          `'${write.operator}' may not be used on a product version state; ` +
            'the value it would produce cannot be checked against the release gate'
        )
      }
    case 'plain':
      if (!isProductVersionState(write.value)) {
        return {
          kind: 'refused',
          verdict: refuseRelease('unknown-state', `'${String(write.value)}' is not a product version state`)
        }
      }
      return write.value === ProductVersionState.Released
        ? { kind: 'needs-command' }
        : { kind: 'allowed', state: write.value }
  }
}

/**
 * @public
 */
export class ProductReleaseGuardError extends Error {
  readonly code = 400

  constructor (
    readonly reason: ProductReleaseGuardReason,
    message: string,
    readonly txClass?: string
  ) {
    super(message)
    this.name = 'ProductReleaseGuardError'
  }
}
