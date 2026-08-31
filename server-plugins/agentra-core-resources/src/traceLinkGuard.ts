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

import core, {
  TxProcessor,
  type Class,
  type Doc,
  type Hierarchy,
  type Ref,
  type Tx,
  type TxApplyIf,
  type TxCUD,
  type TxMixin,
  type TxRemoveDoc,
  type TxUpdateDoc
} from '@hcengineering/core'
import traceability, {
  TRACE_GENERATION_FIELDS,
  traceLinkStates,
  type TraceLinkState
} from '@hcengineering/traceability'

/**
 * Refusal reasons. Machine readable because the rules below fail for completely
 * different operator-visible causes.
 *
 * @public
 */
export type TraceLinkGuardReason =
  | 'trace-link-not-deletable'
  | 'trace-link-field-not-writable'
  | 'trace-link-opaque-operation'
  | 'trace-link-invalid-state'
  | 'trace-link-invalid-increment'
  | 'trace-link-mixed-increment'

/**
 * @public
 */
export class TraceLinkGuardError extends Error {
  readonly code = 400

  constructor (
    readonly reason: TraceLinkGuardReason,
    message: string,
    readonly txClass?: string
  ) {
    super(message)
    this.name = 'TraceLinkGuardError'
  }
}

/**
 * The fields a `TraceLink` may be updated through, AFTER it exists.
 *
 * 🔴 A LIST, NOT A BLANKET REFUSAL — and the difference is not stylistic. The
 * `unlinkImplements` command has to move `state` to `revoked`, and the re-link
 * path has to move it back to `active`; a guard that refused every update would
 * either have to be bypassed by those commands (i.e. be no guard at all) or
 * would make `revoked` a state nothing could leave. Naming the ONE mutable
 * field keeps the audit-bearing columns — `docA` / `docB`, the two classes,
 * `kind`, the two base ids, `metadata` — frozen, which is the part that matters:
 * a rewritable endpoint would let anyone re-point an existing, already
 * announced edge at a different object.
 *
 * @public
 */
export const TRACE_LINK_MUTABLE_FIELDS: readonly string[] = ['state']

/**
 * The fields a `TraceLink` may be ADVANCED through, and nothing else.
 *
 * 🔴 A SECOND, NARROWER DOOR — NOT AN ENTRY IN THE LIST ABOVE. These are the two
 * counters the link/unlink commands fold into their idempotency-ledger keys so
 * that a withdrawn edge can be asserted again (see
 * `TraceLink.revocationGeneration`). Their whole value rests on being
 * MONOTONIC: a caller that could write `revocationGeneration: 0` onto an edge
 * at generation 5
 * would re-point the next assertion at a ledger row that already succeeded, and
 * the "link says yes, edge stays revoked" bug this counter exists to kill would
 * come straight back — this time reachable on demand.
 *
 * Putting them in {@link TRACE_LINK_MUTABLE_FIELDS} would do exactly that,
 * because that list admits an arbitrary assigned value. So they stay OUT of it
 * (a plain assignment is refused as "frozen") and the only write admitted
 * is `$inc` by {@link TRACE_LINK_GENERATION_STEP}. That is enforceable with no
 * database read at all: "increase by one" is monotonic by its own shape,
 * whereas "is greater than what is stored" is not decidable from the
 * transaction, and this guard is synchronous on purpose.
 *
 * @public
 */
export const TRACE_LINK_INCREMENTABLE_FIELDS: readonly string[] = TRACE_GENERATION_FIELDS

/**
 * The ONLY admissible `$inc` amount on a trace link.
 *
 * ⚠️ Not "any positive number". A caller that could jump the counter forward by
 * an arbitrary amount cannot replay an old round, but it can strand every
 * ledger row in between and turn the counter into a caller-chosen value, which
 * is one refactor away from being a caller-chosen key. One transition, one
 * step.
 *
 * @public
 */
export const TRACE_LINK_GENERATION_STEP = 1

/**
 * `TraceLink` write rules, server side.
 *
 * Three rules, none of which the client half can enforce:
 *
 *  1. a physical `TxRemoveDoc` of a trace edge is REFUSED. The matrix is an
 *     audit artefact: deleting the row erases the fact that the assertion was
 *     ever made, which is exactly the history it exists to keep. The supported
 *     withdrawal is `state: 'revoked'` (`commands/unlinkImplements.ts`).
 *  2. a `TxUpdateDoc` may touch only {@link TRACE_LINK_MUTABLE_FIELDS}, with a
 *     plain value or `$set`, and `state` must be a declared `TraceLinkState`;
 *     additionally a {@link TRACE_LINK_INCREMENTABLE_FIELDS} field may be
 *     advanced by `$inc` of exactly {@link TRACE_LINK_GENERATION_STEP}, which is
 *     the only way the two generation counters can ever move.
 *  3. nothing mixes into a trace edge, so a `TxMixin` on one is refused.
 *
 * A `TxCreateDoc` is deliberately NOT guarded here: creation is what the link
 * commands do, and its real arbiter is the primary key on the DERIVED `_id`,
 * which admits exactly one row per (kind, source, target).
 *
 * 🔴 EVERY RULE IS GATED ON `objectClass` DERIVING FROM
 * `traceability.class.TraceLink`, AND THAT GATE IS THE POINT. `TraceLink` lives
 * in `DOMAIN_RELATION`, which it SHARES with upstream `core.class.Relation`; a
 * guard that keyed on the domain, or on "anything in the relation table", would
 * refuse upstream relation deletes across the whole platform. `TraceLink`
 * extends `core.class.Doc` directly and is not a `Relation` descendant, so the
 * class test separates the two co-tenants exactly.
 *
 * 🔴 A MIDDLEWARE, NOT A TRIGGER, and hosted by `CommandMiddleware` for the same
 * reasons spelled out on `ArchivableGuard` — a trigger runs after the write has
 * landed and cannot veto anything.
 *
 * ⚠️ WHAT THIS DOES NOT COVER: `createBackupPipeline` and every
 * `MigrationClient` write reach the domain table directly, so workspace restore
 * and migrations (notably `backfillTraceLinkState`) are unaffected. That is the
 * intended trust boundary and it is shared with every other tx-pipeline guard
 * in this tree.
 *
 * @public
 */
export class TraceLinkGuard {
  constructor (private readonly hierarchy: Hierarchy) {}

  /** Synchronous: every rule is decided from the transaction alone, no reads. */
  validate (txes: Tx[], depth: number = 0): void {
    if (depth > 8) {
      throw new Error('agentra-core: refusing to validate a pathologically nested TxApplyIf')
    }
    for (const tx of txes) {
      // ⚠️ THE LITERAL COMPARISON COMES FIRST, DELIBERATELY — see
      // `ArchivableGuard.validate`. A hierarchy that has not loaded the core
      // model answers `false` for `TxApplyIf`, and skipping the descent would
      // let every smuggled inner write sail through unexamined.
      if (tx._class === core.class.TxApplyIf || this.isDerivedFrom(tx._class, core.class.TxApplyIf)) {
        this.validate((tx as TxApplyIf).txes, depth + 1)
        continue
      }
      if (!TxProcessor.isExtendsCUD(tx._class)) {
        continue
      }
      this.validateCUD(tx as TxCUD<Doc>)
    }
  }

  private validateCUD (cud: TxCUD<Doc>): void {
    // The cheap pre-gate. Anything that is not a trace edge leaves without
    // further work, which keeps every cascade the platform runs free of cost.
    if (!this.isTraceLink(cud.objectClass)) {
      return
    }
    if (cud._class === core.class.TxRemoveDoc) {
      throw new TraceLinkGuardError(
        'trace-link-not-deletable',
        `Trace link '${(cud as TxRemoveDoc<Doc>).objectId}' is an audit record and cannot be deleted; ` +
          'revoke it instead',
        cud._class
      )
    }
    if (cud._class === core.class.TxMixin) {
      throw new TraceLinkGuardError(
        'trace-link-field-not-writable',
        `Trace link '${(cud as TxMixin<Doc, Doc>).objectId}' carries no mixins`,
        cud._class
      )
    }
    if (cud._class === core.class.TxUpdateDoc) {
      this.validateUpdate(cud as TxUpdateDoc<Doc>)
    }
  }

  /**
   * 🔴 DISPATCH PER KEY, NOT PER PAYLOAD. `isOperator` requires EVERY key to
   * start with `$`, but `TxProcessor.applyUpdate` dispatches KEY BY KEY — so a
   * MIXED payload `{ docA: 'x', $set: { state: 'active' } }` is not an operator
   * payload by `isOperator`'s reading while every applier in the platform
   * really does write `docA`. A guard that asked `isOperator` first would wave
   * it through.
   */
  private validateUpdate (tx: TxUpdateDoc<Doc>): void {
    const operations = (tx.operations ?? {}) as Record<string, any>
    this.assertIncrementNotMixed(tx, operations)
    for (const [key, payload] of Object.entries(operations)) {
      if (!key.startsWith('$')) {
        this.assertField(tx, key)
        this.assertValue(tx, key, payload)
        continue
      }
      if (payload == null || typeof payload !== 'object') {
        continue
      }
      if (key === '$set') {
        for (const [field, value] of Object.entries(payload)) {
          this.assertField(tx, field)
          this.assertValue(tx, field, value)
        }
        continue
      }
      // 🔴 `$inc` IS ADMITTED FOR ONE FIELD AND ONE AMOUNT, and it is admitted
      // HERE rather than by widening `TRACE_LINK_MUTABLE_FIELDS` precisely
      // because "advance by one" is checkable without a read while "greater than
      // what is stored" is not. See TRACE_LINK_INCREMENTABLE_FIELDS.
      //
      // ⚠️ IT IS ALSO THE ONLY SHAPE THAT SURVIVES THE WRITE PATH. `$set` is not
      // in `_getOperator`'s table at all (foundations/core .../operator.ts), and
      // a MIXED payload such as `{ state: 'revoked', $inc: {...} }` reads as a
      // NON-operator update to `isOperator`, which routes it down the Postgres
      // `jsonb_set` path where the `$inc` is silently dropped. The commands
      // therefore emit the state change and the increment as two transactions
      // inside ONE apply block, and this branch sees the second of them alone.
      if (key === '$inc') {
        for (const [field, value] of Object.entries(payload)) {
          this.assertIncrement(tx, field, value)
        }
        continue
      }
      // 🔴 EVERY OTHER OPERATOR IS REFUSED WHEN IT NAMES A MUTABLE FIELD, and
      // refused outright when it names a frozen one. `$unset` would erase
      // `state` (leaving an edge with no lifecycle at all), `$rename` can both
      // remove a field and forge one, and `$inc` / `$push` are not evaluable
      // against the state vocabulary. None of them has a legitimate caller here.
      const named =
        key === '$rename' ? [...Object.keys(payload), ...Object.values(payload).map(String)] : Object.keys(payload)
      if (named.length === 0) {
        continue
      }
      throw new TraceLinkGuardError(
        'trace-link-opaque-operation',
        `Operator '${key}' is not evaluable against a trace link (fields: ${named.join(', ')})`,
        tx._class
      )
    }
  }

  private assertField (tx: TxUpdateDoc<Doc>, field: string): void {
    if (TRACE_LINK_MUTABLE_FIELDS.includes(field)) {
      return
    }
    throw new TraceLinkGuardError(
      'trace-link-field-not-writable',
      `Field '${field}' of trace link '${tx.objectId}' is frozen; only ` +
        `${TRACE_LINK_MUTABLE_FIELDS.join(', ')} may be updated`,
      tx._class
    )
  }

  /**
   * 🔴 A `$inc` MAY NOT SHARE A TRANSACTION WITH A PLAIN FIELD, and this is the
   * one rule here that is about the WRITE PATH rather than about authority.
   *
   * `isOperator` demands that EVERY key start with `$`, so a payload like
   * `{ state: 'revoked', $inc: { revocationGeneration: 1 } }` is "not an
   * operator write" by its reading. `PostgresAdapter.txUpdateDoc` groups on
   * exactly that answer and sends this one down the `jsonb_set` branch, which
   * merges the literal keys and NEVER EVALUATES `$inc` — no error, no warning.
   * The state change lands and the counter does not.
   *
   * That is worse than either half failing. The counters are what the ledger
   * keys are built from: an edge whose `state` moved without its generation
   * moving leaves the next round pointing at a row that already succeeded,
   * which is precisely the "link says yes, edge stays revoked" bug these fields
   * exist to kill. The commands in this package split the two into separate
   * `TxUpdateDoc`s inside one apply block; this refuses the shape for everybody
   * else, because a silent half-write cannot be detected after the fact.
   *
   * ⚠️ Checked BEFORE the per-key loop but scoped to `$inc` alone, so a mixed
   * payload carrying a frozen field still fails as `trace-link-field-not-writable`
   * — the more specific answer, and the one its own test asserts.
   */
  private assertIncrementNotMixed (tx: TxUpdateDoc<Doc>, operations: Record<string, any>): void {
    const keys = Object.keys(operations)
    if (!keys.includes('$inc')) {
      return
    }
    const literal = keys.filter((key) => !key.startsWith('$'))
    if (literal.length === 0) {
      return
    }
    throw new TraceLinkGuardError(
      'trace-link-mixed-increment',
      `Trace link '${tx.objectId}': '$inc' cannot share a transaction with a plain field ` +
        `(${literal.join(', ')}) — the write path would drop the increment silently; ` +
        'split them into two transactions inside one apply block',
      tx._class
    )
  }

  private assertIncrement (tx: TxUpdateDoc<Doc>, field: string, value: any): void {
    if (!TRACE_LINK_INCREMENTABLE_FIELDS.includes(field)) {
      throw new TraceLinkGuardError(
        'trace-link-field-not-writable',
        `Field '${field}' of trace link '${tx.objectId}' cannot be incremented; only ` +
          `${TRACE_LINK_INCREMENTABLE_FIELDS.join(', ')} may be`,
        tx._class
      )
    }
    // ⚠️ `=== TRACE_LINK_GENERATION_STEP`, not `> 0`: see the constant. A
    // non-numeric value is refused here rather than left to `$inc`'s own error
    // path, which reports and then writes the garbage anyway.
    if (value !== TRACE_LINK_GENERATION_STEP) {
      throw new TraceLinkGuardError(
        'trace-link-invalid-increment',
        `Field '${field}' of trace link '${tx.objectId}' may only advance by ` +
          `${TRACE_LINK_GENERATION_STEP}, not by '${String(value)}'`,
        tx._class
      )
    }
  }

  private assertValue (tx: TxUpdateDoc<Doc>, field: string, value: any): void {
    if (field !== 'state') {
      return
    }
    // ⚠️ Checked against the DECLARED vocabulary rather than "is a string": an
    // edge in an unknown state is invisible to every coverage query (which asks
    // for `active`) and to the delete guard (which asks for `$ne: 'revoked'`),
    // i.e. it silently drops out of both the matrix and its protections.
    if (!traceLinkStates.includes(value as TraceLinkState)) {
      throw new TraceLinkGuardError(
        'trace-link-invalid-state',
        `'${String(value)}' is not a trace link state; expected one of ${traceLinkStates.join(', ')}`,
        tx._class
      )
    }
  }

  private isTraceLink (_class: Ref<Class<Doc>>): boolean {
    const traceLink = traceability.class.TraceLink as unknown as Ref<Class<Doc>>
    return _class === traceLink || this.isDerivedFrom(_class, traceLink)
  }

  private isDerivedFrom (_class: Ref<Class<Doc>>, from: Ref<Class<Doc>>): boolean {
    try {
      return this.hierarchy.isDerived(_class, from)
    } catch (err: unknown) {
      // A class this hierarchy does not know cannot be a trace link.
      void err
      return false
    }
  }
}
