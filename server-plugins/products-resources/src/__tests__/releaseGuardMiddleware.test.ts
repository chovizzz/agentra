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

import activity from '@hcengineering/activity'
import core, {
  toFindResult,
  TxFactory,
  type Class,
  type Doc,
  type MeasureContext,
  type Ref,
  type Space,
  type Tx
} from '@hcengineering/core'
import { ApplyTxMiddleware } from '@hcengineering/middleware'
import products, { ProductVersionState, type ProductVersion } from '@hcengineering/products'
import serverAgentraCore, { commandExecutionId } from '@hcengineering/server-agentra-core'
import { auditRecordId, RELEASE_PRODUCT_VERSION_LOCK } from '@hcengineering/server-agentra-core-resources'
import type { Middleware, PipelineContext } from '@hcengineering/server-core'
import { ProductReleaseGuardError } from '@hcengineering/server-products'

import { ProductVersionReleaseGuardMiddleware } from '../releaseGuardMiddleware'

const VERSION_CLASS = products.class.ProductVersion as Ref<Class<Doc>>
/** A fork of ProductVersion, i.e. the "just subclass it" bypass. */
const VERSION_SUBCLASS = 'products:class:ProductVersionV2' as Ref<Class<Doc>>
/** A mixin hung on ProductVersion that redeclares `state`. */
const VERSION_MIXIN = 'products:mixin:ReleasableVersion' as Ref<Class<Doc>>
/** A mixin on something else entirely — its `state` is not ours. */
const FOREIGN_MIXIN = 'tracker:mixin:Whatever' as Ref<Class<Doc>>

const SPACE = 'products:space:Products' as Ref<Space>
const VERSION_ID = '000000000000000000000001' as Ref<ProductVersion>
const OTHER_VERSION_ID = '000000000000000000000002' as Ref<ProductVersion>

/**
 * `_class` values are compared by string in the guard, so a table of edges is
 * enough — no ModelDb, no model transactions, no adapters. The one thing this
 * stub MUST get right is `TxApplyIf`, because `ApplyTxMiddleware` asks the very
 * same `isDerived` when deciding whether to unwrap.
 */
const derivedFrom: Record<string, string[]> = {
  [VERSION_SUBCLASS]: [VERSION_CLASS],
  [VERSION_MIXIN]: [VERSION_CLASS],
  [core.class.TxApplyIf]: [core.class.Tx]
}

const known = new Set<string>([
  VERSION_CLASS,
  VERSION_SUBCLASS,
  VERSION_MIXIN,
  FOREIGN_MIXIN,
  activity.class.ActivityInfoMessage,
  serverAgentraCore.class.CommandExecution
])

const hierarchy = {
  hasClass: (_class: string) => known.has(_class),
  isDerived: (a: string, b: string) => a === b || (derivedFrom[a] ?? []).includes(b)
} as any

/** The bottom of the chain: answers reads out of `docs`, records writes. */
class Recorder implements Partial<Middleware> {
  readonly written: Tx[] = []
  constructor (readonly docs: Doc[]) {}

  async tx (_ctx: MeasureContext, txes: Tx[]): Promise<any> {
    this.written.push(...txes)
    return {}
  }

  async findAll (_ctx: MeasureContext, _class: Ref<Class<Doc>>, query: Record<string, any>): Promise<any> {
    const matches = this.docs.filter(
      (doc) =>
        (doc._class === _class || (derivedFrom[doc._class] ?? []).includes(_class)) &&
        Object.entries(query).every(([key, value]) => (doc as any)[key] === value)
    )
    return toFindResult(matches as any)
  }
}

function context (): PipelineContext {
  return { hierarchy, contextVars: {} } as any
}

async function guard (docs: Doc[]): Promise<{ mw: Middleware, sink: Recorder }> {
  const sink = new Recorder(docs)
  const mw = (await ProductVersionReleaseGuardMiddleware.create({} as any, context(), sink as any)) as Middleware
  return { mw, sink }
}

/** The guard behind a real ApplyTxMiddleware, i.e. the production stacking. */
async function applyStack (docs: Doc[]): Promise<{ head: Middleware, sink: Recorder }> {
  const sink = new Recorder(docs)
  const ctx = context()
  const inner = (await ProductVersionReleaseGuardMiddleware.create({} as any, ctx, sink as any)) as Middleware
  const head = await ApplyTxMiddleware.create({} as any, ctx, inner)
  return { head, sink }
}

const factory = new TxFactory(core.account.System, true)

function version (state: ProductVersionState, extra: Partial<ProductVersion> = {}): Doc {
  return {
    _id: VERSION_ID,
    _class: VERSION_CLASS,
    space: SPACE,
    modifiedBy: core.account.System,
    modifiedOn: 0,
    name: 'Agentra',
    major: 1,
    minor: 0,
    patch: 0,
    description: '',
    state,
    parent: products.ids.NoParentVersion,
    ...extra
  } as any
}

/**
 * The two facts `enforceReleaseEvidence` looks for, exactly as
 * `releaseProductVersion` leaves them behind:
 *   - the INNER idempotency claim, keyed `(RELEASE_PRODUCT_VERSION_LOCK, id)`;
 *   - the audit `ActivityInfoMessage` at the derived `auditRecordId`.
 */
function ledgerRow (id: Ref<ProductVersion>): Doc {
  return {
    _id: commandExecutionId(RELEASE_PRODUCT_VERSION_LOCK, id),
    _class: serverAgentraCore.class.CommandExecution,
    space: core.space.DerivedTx,
    modifiedBy: core.account.System,
    modifiedOn: 0,
    command: RELEASE_PRODUCT_VERSION_LOCK,
    idempotencyKey: id,
    attemptId: 'a',
    status: 'running',
    startedOn: 0,
    epoch: 0
  } as any
}

function auditRecord (id: Ref<ProductVersion>): Doc {
  return {
    _id: auditRecordId(id),
    _class: activity.class.ActivityInfoMessage,
    space: SPACE,
    modifiedBy: core.account.System,
    modifiedOn: 0,
    attachedTo: id,
    props: { gate: { passed: true, blockers: [] } }
  } as any
}

function commandEvidence (id: Ref<ProductVersion> = VERSION_ID): Doc[] {
  return [ledgerRow(id), auditRecord(id)]
}

function setState (state: unknown, id: Ref<ProductVersion> = VERSION_ID, _class: Ref<Class<Doc>> = VERSION_CLASS): Tx {
  return factory.createTxUpdateDoc<ProductVersion>(_class as any, SPACE, id, { state } as any)
}

async function refusal (mw: Middleware, tx: Tx): Promise<ProductReleaseGuardError> {
  try {
    await mw.tx({} as any, [tx])
  } catch (err: any) {
    return err
  }
  throw new Error('expected the guard to refuse this transaction')
}

// ── The core rule ────────────────────────────────────────────────────────────

describe('a bare TxUpdateDoc into Released', () => {
  it('is refused when no command ran', async () => {
    const { mw, sink } = await guard([version(ProductVersionState.ReleaseCandidate)])
    const err = await refusal(mw, setState(ProductVersionState.Released))
    expect(err).toBeInstanceOf(ProductReleaseGuardError)
    expect(err.reason).toBe('release-requires-command')
    // 🔴 REFUSED MEANS NOT WRITTEN. A guard that threw after `provideTx` would
    // report an error over a write that landed.
    expect(sink.written).toHaveLength(0)
  })

  it('is refused when only the audit record was forged', async () => {
    // The record is writable by anyone at a derived `_id`; it is the SECOND
    // fact precisely because it is forgeable on its own.
    const { mw } = await guard([version(ProductVersionState.Active), auditRecord(VERSION_ID)])
    const err = await refusal(mw, setState(ProductVersionState.Released))
    expect(err.reason).toBe('release-requires-command')
    expect(err.message).toContain('no ReleaseProductVersion execution')
  })

  it('is refused when the ledger row is claimed but the command never got to its audit step', async () => {
    // The residual window: an attempt that claimed the version and then failed
    // (or was refused by the gate, which throws BEFORE the record is written).
    const { mw } = await guard([version(ProductVersionState.Active), ledgerRow(VERSION_ID)])
    const err = await refusal(mw, setState(ProductVersionState.Released))
    expect(err.reason).toBe('release-requires-command')
    expect(err.message).toContain('no release audit record')
  })

  it('is refused when the evidence belongs to a DIFFERENT version', async () => {
    // 🔴 Both derivations take the version id, so evidence cannot be borrowed.
    const { mw } = await guard([version(ProductVersionState.Active), ...commandEvidence(OTHER_VERSION_ID)])
    expect((await refusal(mw, setState(ProductVersionState.Released))).reason).toBe('release-requires-command')
  })

  it('passes once the command has left both facts behind', async () => {
    const { mw, sink } = await guard([version(ProductVersionState.ReleaseCandidate), ...commandEvidence()])
    await mw.tx({} as any, [setState(ProductVersionState.Released)])
    expect(sink.written).toHaveLength(1)
  })
})

describe('the unforgeability of the anchor', () => {
  it('derives the ledger id the way the command does, from the version alone', () => {
    // A client cannot mint this `_id`: `CommandMiddleware.tx` throws on ANY CUD
    // whose objectClass is CommandExecution, and the id is a SHA-256 prefix of
    // a constant plus the version id, so it cannot be guessed either.
    expect(commandExecutionId(RELEASE_PRODUCT_VERSION_LOCK, VERSION_ID)).toMatch(/^[0-9a-f]{24}$/)
    expect(commandExecutionId(RELEASE_PRODUCT_VERSION_LOCK, VERSION_ID)).not.toBe(
      commandExecutionId(RELEASE_PRODUCT_VERSION_LOCK, OTHER_VERSION_ID)
    )
  })

  it('anchors on the INNER claim, not the caller-keyed outer one', () => {
    // The outer row is keyed `(releaseCommandNamespace(v), idempotencyKey)` and
    // the key is caller supplied — the guard holds a tx, never a request, so it
    // could not recompute that id even in principle. Pin that the constant used
    // here is the version-keyed one.
    expect(RELEASE_PRODUCT_VERSION_LOCK).toBe('ReleaseProductVersion:version')
  })

  it('is not satisfied by a ledger row under some other command name', async () => {
    const forged = { ...(ledgerRow(VERSION_ID) as any), _id: commandExecutionId('SomethingElse', VERSION_ID) }
    const { mw } = await guard([version(ProductVersionState.Active), forged, auditRecord(VERSION_ID)])
    expect((await refusal(mw, setState(ProductVersionState.Released))).reason).toBe('release-requires-command')
  })
})

// ── Bypass paths ─────────────────────────────────────────────────────────────

describe('bypass paths', () => {
  it('refuses a Released write smuggled inside a TxApplyIf', async () => {
    const { head, sink } = await applyStack([version(ProductVersionState.Active)])
    const applyIf = factory.createTxApplyIf(
      SPACE,
      'scope',
      [],
      [],
      [setState(ProductVersionState.Released) as any],
      undefined
    )
    await expect(head.tx({} as any, [applyIf])).rejects.toBeInstanceOf(ProductReleaseGuardError)
    expect(sink.written).toHaveLength(0)
  })

  it('refuses one nested two levels deep, without ApplyTxMiddleware in front', async () => {
    // The guard's own descent is defensive: "no TxApplyIf reaches us" is a
    // property of the pipeline list, not of this class.
    const { mw } = await guard([version(ProductVersionState.Active)])
    const innerApply = factory.createTxApplyIf(
      SPACE,
      's1',
      [],
      [],
      [setState(ProductVersionState.Released) as any],
      undefined
    )
    const outer = factory.createTxApplyIf(SPACE, 's2', [], [], [innerApply as any], undefined)
    await expect(mw.tx({} as any, [outer])).rejects.toBeInstanceOf(ProductReleaseGuardError)
  })

  it('refuses $set, $inc and $rename onto state', async () => {
    const { mw } = await guard([version(ProductVersionState.Active)])
    for (const ops of [
      { $set: { state: ProductVersionState.Released } },
      // Active is 0, Released is 1: `$inc` by one IS a release.
      { $inc: { state: 1 } },
      { $rename: { smuggled: 'state' } }
    ]) {
      const tx = factory.createTxUpdateDoc<ProductVersion>(VERSION_CLASS as any, SPACE, VERSION_ID, ops as any)
      expect((await refusal(mw, tx)).reason).toBe('opaque-operation')
    }
  })

  it('refuses an operator even when the command DID run — the value is still unreadable', async () => {
    const { mw } = await guard([version(ProductVersionState.Active), ...commandEvidence()])
    const tx = factory.createTxUpdateDoc<ProductVersion>(VERSION_CLASS as any, SPACE, VERSION_ID, {
      $inc: { state: 1 }
    } as any)
    expect((await refusal(mw, tx)).reason).toBe('opaque-operation')
  })

  it('refuses $unset of state — an unfreeze disguised as a deletion', async () => {
    const { mw } = await guard([version(ProductVersionState.Released), ...commandEvidence()])
    const tx = factory.createTxUpdateDoc<ProductVersion>(VERSION_CLASS as any, SPACE, VERSION_ID, {
      $unset: { state: '' }
    } as any)
    expect((await refusal(mw, tx)).reason).toBe('state-removed')
  })

  it('refuses the string "Released" and any other non-member value', async () => {
    const { mw } = await guard([version(ProductVersionState.Active)])
    for (const value of ['Released', 99, null]) {
      expect((await refusal(mw, setState(value))).reason).toBe('unknown-state')
    }
  })

  it('covers a SUBCLASS of ProductVersion', async () => {
    const { mw } = await guard([version(ProductVersionState.Active, { _class: VERSION_SUBCLASS } as any)])
    const tx = setState(ProductVersionState.Released, VERSION_ID, VERSION_SUBCLASS)
    expect((await refusal(mw, tx)).reason).toBe('release-requires-command')
  })

  it('covers a TxCreateDoc that is born Released', async () => {
    const { mw, sink } = await guard([])
    const tx = factory.createTxCreateDoc<ProductVersion>(
      VERSION_CLASS as any,
      SPACE,
      { state: ProductVersionState.Released } as any,
      VERSION_ID
    )
    expect((await refusal(mw, tx)).reason).toBe('release-on-create')
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a create into Released even when a PREVIOUS release left its evidence behind', async () => {
    // 🔴 THE STALE-EVIDENCE BYPASS: delete a released version, then re-create a
    // document at the same `_id`. `ProductVersionRemove` collects nothing, so
    // the ledger row and the audit record are still there and an evidence
    // lookup would happily approve a brand new document.
    const { mw, sink } = await guard([...commandEvidence()])
    const tx = factory.createTxCreateDoc<ProductVersion>(
      VERSION_CLASS as any,
      SPACE,
      { state: ProductVersionState.Released } as any,
      VERSION_ID
    )
    expect((await refusal(mw, tx)).reason).toBe('release-on-create')
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a MIXED plain/operator payload that reaches state', async () => {
    // 🔴 `isOperator` answers `false` for this object (`codename` has no `$`),
    // but `TxProcessor.applyUpdate` dispatches per key and runs the `$inc`, so
    // Active(0) becomes Released(1) with the word `Released` nowhere in the tx.
    const { mw, sink } = await guard([version(ProductVersionState.Active)])
    const tx = factory.createTxUpdateDoc<ProductVersion>(VERSION_CLASS as any, SPACE, VERSION_ID, {
      codename: 'aurora',
      $inc: { state: 1 }
    } as any)
    expect((await refusal(mw, tx)).reason).toBe('opaque-operation')
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a MIXED payload on a TxMixin too — updateMixin4Doc uses the same per-key rule', async () => {
    const { mw } = await guard([version(ProductVersionState.Active)])
    const tx = factory.createTxMixin<Doc, Doc>(VERSION_ID, VERSION_CLASS, SPACE, VERSION_MIXIN, {
      note: 'x',
      $inc: { state: 1 }
    } as any)
    expect((await refusal(mw, tx)).reason).toBe('opaque-operation')
  })

  it('covers a TxMixin whose mixin descends from ProductVersion', async () => {
    const { mw } = await guard([version(ProductVersionState.Active)])
    const tx = factory.createTxMixin<Doc, Doc>(VERSION_ID, VERSION_CLASS, SPACE, VERSION_MIXIN, {
      state: ProductVersionState.Released
    } as any)
    expect((await refusal(mw, tx)).reason).toBe('release-requires-command')
  })

  it('ignores a TxMixin whose mixin is unrelated — its `state` is a different attribute', async () => {
    const { mw, sink } = await guard([version(ProductVersionState.Active)])
    const tx = factory.createTxMixin<Doc, Doc>(VERSION_ID, VERSION_CLASS, SPACE, FOREIGN_MIXIN, {
      state: ProductVersionState.Released
    } as any)
    await mw.tx({} as any, [tx])
    expect(sink.written).toHaveLength(1)
  })

  it('ignores an unknown classifier instead of trusting isDerived on an empty chain', async () => {
    const { mw, sink } = await guard([])
    const tx = setState(ProductVersionState.Released, VERSION_ID, 'not:a:class' as Ref<Class<Doc>>)
    await mw.tx({} as any, [tx])
    expect(sink.written).toHaveLength(1)
  })
})

// ── Everything that must keep working ────────────────────────────────────────

describe('writes the guard must not touch', () => {
  it("lets the platform's readonly / isLatest stamps through without reading the document", async () => {
    const { mw, sink } = await guard([])
    const tx = factory.createTxUpdateDoc<ProductVersion>(VERSION_CLASS as any, SPACE, VERSION_ID, {
      readonly: true,
      isLatest: false
    } as any)
    await mw.tx({} as any, [tx])
    expect(sink.written).toEqual([tx])
  })

  it("lets migratePatchVersion's patch backfill through", async () => {
    const { mw, sink } = await guard([])
    const tx = factory.createTxUpdateDoc<ProductVersion>(VERSION_CLASS as any, SPACE, VERSION_ID, { patch: 0 } as any)
    await mw.tx({} as any, [tx])
    expect(sink.written).toEqual([tx])
  })

  it('lets an ordinary content edit through', async () => {
    const { mw, sink } = await guard([])
    const tx = factory.createTxUpdateDoc<ProductVersion>(VERSION_CLASS as any, SPACE, VERSION_ID, {
      codename: 'aurora',
      description: 'notes'
    } as any)
    await mw.tx({} as any, [tx])
    expect(sink.written).toEqual([tx])
  })

  it('lets CreateProduct / CreateProductVersion create an Active version', async () => {
    const { mw, sink } = await guard([])
    const tx = factory.createTxCreateDoc<ProductVersion>(
      VERSION_CLASS as any,
      SPACE,
      { state: ProductVersionState.Active, major: 1, minor: 0, patch: 0 } as any,
      VERSION_ID
    )
    await mw.tx({} as any, [tx])
    expect(sink.written).toEqual([tx])
  })

  it('lets CreateProductVersion freeze the forked parent as Archived', async () => {
    // The upstream bypass this whole task exists for used to write `Released`
    // here. `parentStateOnChildVersion` is `Archived`, and `Archived` is free.
    const { mw, sink } = await guard([version(ProductVersionState.Active)])
    await mw.tx({} as any, [setState(ProductVersionState.Archived)])
    expect(sink.written).toHaveLength(1)
  })

  it('lets a Released version move on to Archived — Released is not a dead end', async () => {
    const { mw, sink } = await guard([version(ProductVersionState.Released)])
    await mw.tx({} as any, [setState(ProductVersionState.Archived)])
    expect(sink.written).toHaveLength(1)
  })

  it('lets every other lifecycle move through', async () => {
    const { mw, sink } = await guard([version(ProductVersionState.Planning)])
    for (const state of [
      ProductVersionState.Planning,
      ProductVersionState.Active,
      ProductVersionState.ReleaseCandidate,
      ProductVersionState.Archived
    ]) {
      await mw.tx({} as any, [setState(state)])
    }
    expect(sink.written).toHaveLength(4)
  })

  it('ignores transactions aimed at other classes entirely', async () => {
    const { mw, sink } = await guard([])
    const tx = factory.createTxUpdateDoc<Doc>(activity.class.ActivityInfoMessage as any, SPACE, VERSION_ID, {
      state: ProductVersionState.Released
    } as any)
    await mw.tx({} as any, [tx])
    expect(sink.written).toEqual([tx])
  })

  it("accepts the release command's own compare-and-swap TxApplyIf end to end", async () => {
    // 🔴 THE GENUINE PATH. `runRelease` claims the inner ledger row before the
    // body, writes the audit record at Step 2 and the state at Step 5, and the
    // state write is a `TxApplyIf` carrying `{ state: Released, readonly: true }`.
    // Both facts hold by the time the guard sees it.
    const { head, sink } = await applyStack([version(ProductVersionState.ReleaseCandidate), ...commandEvidence()])
    const inner = factory.createTxUpdateDoc<ProductVersion>(VERSION_CLASS as any, SPACE, VERSION_ID, {
      state: ProductVersionState.Released,
      readonly: true
    } as any)
    const applyIf = factory.createTxApplyIf(SPACE, 'release', [], [], [inner as any], undefined)
    await head.tx({} as any, [applyIf])
    expect(sink.written.length).toBeGreaterThan(0)
  })
})

describe('batch semantics', () => {
  it('refuses the WHOLE batch when one member is illegal', async () => {
    const { mw, sink } = await guard([version(ProductVersionState.Active)])
    const legal = factory.createTxUpdateDoc<ProductVersion>(VERSION_CLASS as any, SPACE, VERSION_ID, {
      codename: 'x'
    } as any)
    await expect(mw.tx({} as any, [legal, setState(ProductVersionState.Released)])).rejects.toBeInstanceOf(
      ProductReleaseGuardError
    )
    // Validation runs to completion BEFORE `provideTx`, so nothing partial lands.
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a pathologically nested TxApplyIf rather than recursing forever', async () => {
    const { mw } = await guard([])
    let tx: any = setState(ProductVersionState.Released)
    for (let i = 0; i < 12; i++) {
      tx = factory.createTxApplyIf(SPACE, `s${i}`, [], [], [tx], undefined)
    }
    await expect(mw.tx({} as any, [tx])).rejects.toThrow('pathologically nested')
  })
})
