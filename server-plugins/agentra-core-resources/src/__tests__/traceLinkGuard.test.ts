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
  ClassifierKind,
  Hierarchy,
  TxFactory,
  type Class,
  type Doc,
  type Ref,
  type Tx
} from '@hcengineering/core'
import traceability, { type TraceLink } from '@hcengineering/traceability'

import {
  TRACE_LINK_GENERATION_STEP,
  TRACE_LINK_INCREMENTABLE_FIELDS,
  TRACE_LINK_MUTABLE_FIELDS,
  TraceLinkGuard,
  TraceLinkGuardError
} from '../traceLinkGuard'

const LINK = 'linklinklinklinklinklin1' as Ref<TraceLink>
const SPACE = core.space.Workspace
const SUBCLASS = 'traceability:class:DerivedTraceLink' as Ref<Class<Doc>>
/**
 * The upstream co-tenant of `DOMAIN_RELATION`. 🔴 The guard must NOT touch it:
 * `TraceLink` extends `core.class.Doc` directly and is not a `Relation`
 * descendant, and a guard keyed on the DOMAIN would refuse upstream relation
 * deletes across the whole platform.
 */
const RELATION = core.class.Relation as unknown as Ref<Class<Doc>>

function makeHierarchy (): Hierarchy {
  const hierarchy = new Hierarchy()
  const factory = new TxFactory(core.account.System)
  const stub = (_id: Ref<Class<Doc>>, ext?: Ref<Class<Doc>>): void => {
    hierarchy.tx(
      factory.createTxCreateDoc(
        core.class.Class,
        core.space.Model,
        { kind: ClassifierKind.CLASS, label: '', extends: ext } as any,
        _id
      )
    )
  }
  stub(core.class.Doc)
  stub(traceability.class.TraceLink as unknown as Ref<Class<Doc>>, core.class.Doc)
  stub(SUBCLASS, traceability.class.TraceLink as unknown as Ref<Class<Doc>>)
  stub(RELATION, core.class.Doc)
  return hierarchy
}

const guard = (): TraceLinkGuard => new TraceLinkGuard(makeHierarchy())
const factory = new TxFactory(core.account.System)

function update (operations: Record<string, any>, _class = traceability.class.TraceLink): Tx {
  return factory.createTxUpdateDoc<Doc>(_class as any, SPACE, LINK as Ref<Doc>, operations as any)
}

describe('the TraceLink write rules', () => {
  it('refuses a physical delete and says what to do instead', () => {
    const tx = factory.createTxRemoveDoc(traceability.class.TraceLink as any, SPACE, LINK as Ref<Doc>)
    expect(() => {
      guard().validate([tx])
    }).toThrow(TraceLinkGuardError)
    try {
      guard().validate([tx])
    } catch (err: any) {
      expect(err.reason).toBe('trace-link-not-deletable')
      expect(err.message).toContain('revoke it instead')
    }
  })

  it('refuses a delete of a SUBCLASS of TraceLink too', () => {
    // ⚠️ `isDerived`, not `===`: a class declared as extending `TraceLink` is
    // still an audit edge and must not slip past by naming itself.
    const tx = factory.createTxRemoveDoc(SUBCLASS as any, SPACE, LINK as Ref<Doc>)
    expect(() => {
      guard().validate([tx])
    }).toThrow(TraceLinkGuardError)
  })

  it('leaves upstream core.class.Relation deletes ALONE', () => {
    // 🔴 THE CO-TENANCY RULE. `TraceLink` shares `DOMAIN_RELATION` with
    // `core.class.Relation`; a guard that keyed on the domain would refuse every
    // upstream relation delete in the platform.
    const tx = factory.createTxRemoveDoc(RELATION as any, SPACE, 'some-relation' as Ref<Doc>)
    expect(() => {
      guard().validate([tx])
    }).not.toThrow()
  })

  it('leaves an unrelated class alone', () => {
    const tx = factory.createTxRemoveDoc('tracker:class:Issue' as any, SPACE, 'issue-1' as Ref<Doc>)
    expect(() => {
      guard().validate([tx])
    }).not.toThrow()
  })

  it('allows the ONE mutable field, in both directions', () => {
    // 🔴 THE ESCAPE HATCH. A blanket refusal would make `revoked` a state
    // nothing could leave, so a pair somebody unlinked could never be re-linked.
    expect(TRACE_LINK_MUTABLE_FIELDS).toEqual(['state'])
    for (const state of ['active', 'orphaned', 'revoked']) {
      expect(() => {
        guard().validate([update({ state })])
      }).not.toThrow()
      expect(() => {
        guard().validate([update({ $set: { state } })])
      }).not.toThrow()
    }
  })

  it('refuses an undeclared state value', () => {
    // An edge in an unknown state is invisible to the coverage queries (which
    // ask for `active`) AND to the delete guard (which asks `$ne: 'revoked'`),
    // i.e. it silently drops out of both the matrix and its protections.
    try {
      guard().validate([update({ state: 'withdrawn' })])
      throw new Error('should have thrown')
    } catch (err: any) {
      expect(err.reason).toBe('trace-link-invalid-state')
    }
  })

  it('freezes every audit-bearing field', () => {
    for (const field of [
      'docA',
      'docB',
      'sourceClass',
      'targetClass',
      'kind',
      'sourceBaseId',
      'targetBaseId',
      'metadata'
    ]) {
      try {
        guard().validate([update({ [field]: 'anything' })])
        throw new Error(`should have refused ${field}`)
      } catch (err: any) {
        expect(err.reason).toBe('trace-link-field-not-writable')
      }
    }
  })

  it('reads a MIXED payload key by key', () => {
    // 🔴 `isOperator` requires EVERY key to start with `$`, but
    // `TxProcessor.applyUpdate` dispatches KEY BY KEY. A guard that asked
    // `isOperator` first would call this payload "not an operator write", look
    // for a literal `docA` key it had already decided was absent, and wave
    // through a write that really does re-point the edge.
    try {
      guard().validate([update({ docA: 'somewhere-else', $set: { state: 'revoked' } })])
      throw new Error('should have thrown')
    } catch (err: any) {
      expect(err.reason).toBe('trace-link-field-not-writable')
    }
  })

  it('refuses $unset and $rename on the mutable field', () => {
    for (const ops of [{ $unset: { state: '' } }, { $rename: { state: 'condition' } }]) {
      try {
        guard().validate([update(ops)])
        throw new Error('should have thrown')
      } catch (err: any) {
        expect(err.reason).toBe('trace-link-opaque-operation')
      }
    }
  })

  it('refuses a TxMixin on a trace edge', () => {
    const tx = factory.createTxMixin(
      LINK as Ref<Doc>,
      traceability.class.TraceLink as any,
      SPACE,
      'some:mixin:Thing' as any,
      { anything: true } as any
    )
    expect(() => {
      guard().validate([tx])
    }).toThrow(TraceLinkGuardError)
  })

  it('descends into a TxApplyIf rather than trusting the wrapper', () => {
    // 🔴 A guard that stopped at the wrapper would be bypassed by every write
    // the command path itself produces, which are all `TxApplyIf`.
    const inner = factory.createTxRemoveDoc(traceability.class.TraceLink as any, SPACE, LINK as Ref<Doc>)
    const applyIf = factory.createTxApplyIf(SPACE, 'scope', [], [], [inner], undefined)
    expect(() => {
      guard().validate([applyIf])
    }).toThrow(TraceLinkGuardError)
  })

  it("allows a create — the derived _id primary key is that path's arbiter", () => {
    const tx = factory.createTxCreateDoc(
      traceability.class.TraceLink as any,
      SPACE,
      { docA: 'a', docB: 'b', kind: 'implements', state: 'active' } as any,
      LINK as Ref<Doc>
    )
    expect(() => {
      guard().validate([tx])
    }).not.toThrow()
  })
})

describe('the generation counters', () => {
  // 🔴 THE COUNTERS ARE ONLY AS GOOD AS THEIR MONOTONICITY. `revocationGeneration`
  // and `assertionGeneration` are what the link / unlink commands fold into
  // their idempotency-ledger keys so a withdrawn edge can be asserted again. A
  // caller able to write `revocationGeneration: 0` onto an edge at generation 3
  // would re-point the next assertion at a ledger row that already succeeded and
  // resurrect the "link says yes, edge stays revoked" bug ON DEMAND. So they are
  // NOT in `TRACE_LINK_MUTABLE_FIELDS`, and the only write admitted is `$inc` by
  // exactly one — a shape that is monotonic by construction and therefore
  // checkable by a guard that performs no reads.

  it('names both counters as incrementable and neither as mutable', () => {
    expect([...TRACE_LINK_INCREMENTABLE_FIELDS].sort()).toEqual(['assertionGeneration', 'revocationGeneration'])
    for (const field of TRACE_LINK_INCREMENTABLE_FIELDS) {
      expect(TRACE_LINK_MUTABLE_FIELDS).not.toContain(field)
    }
    expect(TRACE_LINK_GENERATION_STEP).toBe(1)
  })

  it('admits $inc by exactly one on either counter', () => {
    for (const field of TRACE_LINK_INCREMENTABLE_FIELDS) {
      expect(() => {
        guard().validate([update({ $inc: { [field]: TRACE_LINK_GENERATION_STEP } })])
      }).not.toThrow()
    }
  })

  it('refuses an ASSIGNMENT of a counter, plain or through $set', () => {
    for (const operations of [
      { revocationGeneration: 0 },
      { $set: { revocationGeneration: 0 } },
      { assertionGeneration: 99 },
      { $set: { assertionGeneration: 99 } }
    ]) {
      try {
        guard().validate([update(operations)])
        throw new Error(`expected a refusal for ${JSON.stringify(operations)}`)
      } catch (err: any) {
        expect(err).toBeInstanceOf(TraceLinkGuardError)
        expect(err.reason).toBe('trace-link-field-not-writable')
      }
    }
  })

  it('refuses an increment that is not exactly one — backwards, still, or in a leap', () => {
    // ⚠️ `-1` is the attack; `0` and `2` are refused for the reason on the
    // constant: a caller-chosen amount is one refactor away from a
    // caller-chosen key. `'1'` would reach `$inc`'s own error path, which
    // reports AND THEN writes the garbage, so it is stopped before the write.
    for (const amount of [-1, 0, 2, 1000, '1', null, undefined, NaN]) {
      try {
        guard().validate([update({ $inc: { revocationGeneration: amount } })])
        throw new Error(`expected a refusal for ${String(amount)}`)
      } catch (err: any) {
        expect(err).toBeInstanceOf(TraceLinkGuardError)
        expect(err.reason).toBe('trace-link-invalid-increment')
      }
    }
  })

  it('does not let $inc become a door into the frozen audit columns', () => {
    for (const field of ['docA', 'docB', 'kind', 'state', 'metadata', 'sourceBaseId']) {
      try {
        guard().validate([update({ $inc: { [field]: 1 } })])
        throw new Error(`expected a refusal for ${field}`)
      } catch (err: any) {
        expect(err).toBeInstanceOf(TraceLinkGuardError)
        expect(err.reason).toBe('trace-link-field-not-writable')
      }
    }
  })

  it('checks every field of a multi-field $inc, not just the first', () => {
    try {
      guard().validate([update({ $inc: { revocationGeneration: 1, docA: 1 } })])
      throw new Error('expected a refusal')
    } catch (err: any) {
      expect(err).toBeInstanceOf(TraceLinkGuardError)
      expect(err.reason).toBe('trace-link-field-not-writable')
    }
  })

  it('refuses a $inc that shares a transaction with a plain field', () => {
    // 🔴 THE SHAPE THAT LOSES THE INCREMENT WITHOUT SAYING SO. `isOperator`
    // needs EVERY key to start with `$`, so Postgres routes this down the
    // `jsonb_set` branch and never evaluates `$inc`: `state` moves, the counter
    // does not, and the next round's ledger key points at a row that already
    // succeeded — the exact bug the counters exist to kill. Neither half of the
    // payload is illegal on its own, which is why the mix has to be named.
    for (const operations of [
      { state: 'revoked', $inc: { revocationGeneration: 1 } },
      { state: 'active', $inc: { assertionGeneration: 1 } }
    ]) {
      try {
        guard().validate([update(operations)])
        throw new Error(`expected a refusal for ${JSON.stringify(operations)}`)
      } catch (err: any) {
        expect(err).toBeInstanceOf(TraceLinkGuardError)
        expect(err.reason).toBe('trace-link-mixed-increment')
        expect(err.message).toContain('split them into two transactions')
      }
    }
    // The two halves on their own are exactly what the commands emit.
    expect(() => {
      guard().validate([update({ state: 'revoked' }), update({ $inc: { revocationGeneration: 1 } })])
    }).not.toThrow()
  })

  it('still blames the FROZEN FIELD when a mixed payload carries one', () => {
    // ⚠️ The mix check is scoped to `$inc`, so `{ docA, $set }` keeps its more
    // specific answer — see the "reads a MIXED payload key by key" test. And a
    // mixed payload that carries BOTH a frozen field and a `$inc` is refused by
    // the mix rule, which is the earlier and more dangerous fault.
    try {
      guard().validate([update({ docA: 'somewhere-else', $inc: { revocationGeneration: 1 } })])
      throw new Error('expected a refusal')
    } catch (err: any) {
      expect(err.reason).toBe('trace-link-mixed-increment')
    }
  })

  it('leaves an upstream Relation $inc entirely alone', () => {
    // The class gate comes first: upstream relations are a co-tenant of
    // `DOMAIN_RELATION` and none of these rules may touch them.
    expect(() => {
      guard().validate([update({ $inc: { anything: 7 } }, RELATION as any)])
    }).not.toThrow()
  })
})
