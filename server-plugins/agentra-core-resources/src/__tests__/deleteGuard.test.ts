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
import agentraCore, {
  ARCHIVABLE_ISSUE,
  ARCHIVABLE_LEAD,
  ARCHIVABLE_REQUIREMENT,
  ARCHIVABLE_TEST_CASE,
  archivableKey,
  archivedQuery,
  notArchivedQuery
} from '@hcengineering/agentra-core'
import core, {
  ClassifierKind,
  Hierarchy,
  TxFactory,
  type Class,
  type Doc,
  type MeasureContext,
  type Ref,
  type Tx
} from '@hcengineering/core'
import crmLite from '@hcengineering/crm-lite'
import requirements from '@hcengineering/requirements'
import serverAgentraCore, { commandExecutionId } from '@hcengineering/server-agentra-core'
import testManagement from '@hcengineering/test-management'
import traceability, { type TraceLink } from '@hcengineering/traceability'
import tracker from '@hcengineering/tracker'

import {
  ARCHIVE_TRANSITION_LOCK,
  ArchivableGuard,
  ArchivableGuardError,
  archiveAuditId,
  archiveTransitionKey,
  readArchivableFieldWrite,
  readArchiveGeneration
} from '../deleteGuard'
import { MemoryDb, makeCtx, seed } from './harness'

const SPACE = 'space-1' as Ref<any>
const LEAD = 'leadleadleadleadleadlea1' as Ref<Doc>
const OTHER = 'otherotherotherotherot01' as Ref<Doc>
const LEAD_SUBCLASS = 'crm-lite:masterTag:HotLead' as Ref<Class<Doc>>
const MIXIN = agentraCore.mixin.Archivable as string
const ARCHIVED = archivableKey('archived')
const GENERATION = archivableKey('archiveGeneration')

/**
 * A REAL `Hierarchy`, seeded with the handful of classifiers the guard asks
 * about.
 *
 * ⚠️ NOT a stub whose `isDerived` returns `true`. The guard's whole subclass
 * story (`isDerivedFrom`) and its `hasClass`-first defence are hierarchy
 * behaviour; faking them would test the fake.
 */
function makeHierarchy (): Hierarchy {
  const hierarchy = new Hierarchy()
  const factory = new TxFactory(core.account.System)
  const stub = (_id: Ref<Class<Doc>>, ext?: Ref<Class<Doc>>, kind = ClassifierKind.CLASS): void => {
    hierarchy.tx(
      factory.createTxCreateDoc(
        kind === ClassifierKind.MIXIN ? core.class.Mixin : core.class.Class,
        core.space.Model,
        { kind, label: '', extends: ext } as any,
        _id
      )
    )
  }
  stub(core.class.Doc)
  stub(core.class.Obj as Ref<Class<Doc>>, core.class.Doc)
  stub(ARCHIVABLE_LEAD, core.class.Doc)
  stub(LEAD_SUBCLASS, ARCHIVABLE_LEAD)
  stub(ARCHIVABLE_REQUIREMENT, core.class.Doc)
  stub(ARCHIVABLE_ISSUE, core.class.Doc)
  stub(ARCHIVABLE_TEST_CASE, core.class.Doc)
  stub(OTHER as unknown as Ref<Class<Doc>>, core.class.Doc)
  stub(agentraCore.mixin.Archivable as Ref<Class<Doc>>, core.class.Doc, ClassifierKind.MIXIN)
  return hierarchy
}

interface Fixture {
  db: MemoryDb
  ctx: MeasureContext
  guard: ArchivableGuard
  reads: number
}

function makeFixture (): Fixture {
  const db = new MemoryDb()
  const fixture: Fixture = {
    db,
    ctx: makeCtx(),
    reads: 0,
    guard: undefined as unknown as ArchivableGuard
  }
  fixture.guard = new ArchivableGuard({
    hierarchy: makeHierarchy(),
    findAll: async (_ctx, _class, query) => {
      fixture.reads++
      return db.find(_class as Ref<Class<Doc>>, query) as any
    }
  })
  return fixture
}

const factory = new TxFactory(core.account.System)

function removeTx (objectId: Ref<Doc>, objectClass: Ref<Class<Doc>>): Tx {
  return factory.createTxRemoveDoc(objectClass, SPACE, objectId)
}

function updateTx (operations: Record<string, any>, objectClass: Ref<Class<Doc>> = ARCHIVABLE_LEAD): Tx {
  return factory.createTxUpdateDoc(objectClass, SPACE, LEAD, operations as any)
}

function mixinTx (attributes: Record<string, any>, mixin = agentraCore.mixin.Archivable): Tx {
  return factory.createTxMixin(LEAD, ARCHIVABLE_LEAD, SPACE, mixin as any, attributes as any)
}

function seedLink (id: string, from: Ref<Doc>, to: Ref<Doc>, state: string = 'active'): void {
  // Deliberately a module-level helper over the CURRENT fixture's db, set below.
  seed<TraceLink>(currentDb, {
    _id: id as Ref<any>,
    _class: traceability.class.TraceLink,
    space: SPACE,
    docA: from,
    docB: to,
    state
  } as any)
}

let currentDb: MemoryDb
let f: Fixture
beforeEach(() => {
  f = makeFixture()
  currentDb = f.db
})

/** Record the evidence a legitimate command would have left behind. */
function seedEvidence (target: Ref<Doc>, generation: number): void {
  seed(f.db, {
    _id: commandExecutionId(ARCHIVE_TRANSITION_LOCK, archiveTransitionKey(target, generation)),
    _class: serverAgentraCore.class.CommandExecution,
    status: 'running'
  } as any)
  seed(f.db, {
    _id: archiveAuditId(target, generation) as Ref<any>,
    _class: activity.class.ActivityInfoMessage
  } as any)
}

async function refusal (txes: Tx[]): Promise<ArchivableGuardError> {
  try {
    await f.guard.validate(f.ctx, txes)
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(ArchivableGuardError)
    return err as ArchivableGuardError
  }
  throw new Error('expected the guard to refuse')
}

describe('archivable wire constants', () => {
  // 🔴 THE OTHER HALF OF THE LITERAL PIN. `plugins/agentra-core` spells these
  // four class ids as string literals because it is the FOUNDATION package and
  // may not depend on the four modules. A literal does not fail to compile when
  // it is wrong; this package DOES depend on all four, so it can prove the
  // literal names the thing it is supposed to name.
  it('name the real Lead / Requirement / Issue / TestCase classifiers', () => {
    expect(ARCHIVABLE_LEAD).toBe(crmLite.masterTag.Lead as unknown as Ref<Class<Doc>>)
    expect(ARCHIVABLE_REQUIREMENT).toBe(requirements.masterTag.Requirement as unknown as Ref<Class<Doc>>)
    expect(ARCHIVABLE_ISSUE).toBe(tracker.class.Issue as unknown as Ref<Class<Doc>>)
    expect(ARCHIVABLE_TEST_CASE).toBe(testManagement.class.TestCase as unknown as Ref<Class<Doc>>)
  })

  it('pin the exact literals, so a rename upstream is visible here too', () => {
    expect(ARCHIVABLE_LEAD).toBe('crm-lite:masterTag:Lead')
    expect(ARCHIVABLE_REQUIREMENT).toBe('requirements:masterTag:Requirement')
    expect(ARCHIVABLE_ISSUE).toBe('tracker:class:Issue')
    // ⚠️ camelCase plugin id, not `test-management`.
    expect(ARCHIVABLE_TEST_CASE).toBe('testManagement:class:TestCase')
    expect(MIXIN).toBe('agentra-core:mixin:Archivable')
    expect(ARCHIVED).toBe('agentra-core:mixin:Archivable.archived')
  })

  it('defaults the list filter to `$ne: true`, so never-archived documents stay visible', () => {
    // 🔴 `archived: false` would hide every document created after the SYS-005
    // migration: those carry no mixin at all, `findProperty` reads `undefined`,
    // and `undefined === false` is false.
    expect(notArchivedQuery()).toEqual({ [ARCHIVED]: { $ne: true } })
    expect(archivedQuery()).toEqual({ [ARCHIVED]: true })
  })
})

describe('CRM-T013: physical delete of a referenced object', () => {
  it('refuses a Lead that is the SOURCE of an active trace edge, and says to archive', async () => {
    seedLink('link-1', LEAD, OTHER)
    const err = await refusal([removeTx(LEAD, ARCHIVABLE_LEAD)])
    expect(err.reason).toBe('delete-referenced')
    expect(err.message).toContain('archive it instead')
  })

  it('refuses a Lead that is the TARGET of an active trace edge', async () => {
    // Two queries rather than one, because `DocumentQuery` has no cross-field
    // `$or`; asking about `docA` only would let this through.
    seedLink('link-1', OTHER, LEAD)
    expect((await refusal([removeTx(LEAD, ARCHIVABLE_LEAD)])).reason).toBe('delete-referenced')
  })

  it('allows a Lead whose only edges are revoked — those are history, not references', async () => {
    seedLink('link-1', LEAD, OTHER, 'revoked')
    await expect(f.guard.validate(f.ctx, [removeTx(LEAD, ARCHIVABLE_LEAD)])).resolves.toBeUndefined()
  })

  it('refuses on an `orphaned` edge: it still names the object', async () => {
    seedLink('link-1', LEAD, OTHER, 'orphaned')
    expect((await refusal([removeTx(LEAD, ARCHIVABLE_LEAD)])).reason).toBe('delete-referenced')
  })

  it('allows an unreferenced object through', async () => {
    await expect(f.guard.validate(f.ctx, [removeTx(LEAD, ARCHIVABLE_LEAD)])).resolves.toBeUndefined()
  })

  it('covers SUBCLASSES of an archivable class', async () => {
    seedLink('link-1', LEAD, OTHER)
    expect((await refusal([removeTx(LEAD, LEAD_SUBCLASS)])).reason).toBe('delete-referenced')
  })

  it('covers all four archivable classes', async () => {
    for (const cls of [ARCHIVABLE_LEAD, ARCHIVABLE_REQUIREMENT, ARCHIVABLE_ISSUE, ARCHIVABLE_TEST_CASE]) {
      f = makeFixture()
      currentDb = f.db
      seedLink('link-1', LEAD, OTHER)
      expect((await refusal([removeTx(LEAD, cls)])).reason).toBe('delete-referenced')
    }
  })

  it('sees a removal SMUGGLED inside a TxApplyIf', async () => {
    seedLink('link-1', LEAD, OTHER)
    const applyIf = factory.createTxApplyIf(SPACE, 'scope', [], [], [removeTx(LEAD, ARCHIVABLE_LEAD)] as any, undefined)
    expect((await refusal([applyIf])).reason).toBe('delete-referenced')
  })

  it('sees a removal nested TWO TxApplyIf deep', async () => {
    seedLink('link-1', LEAD, OTHER)
    const inner = factory.createTxApplyIf(SPACE, 's2', [], [], [removeTx(LEAD, ARCHIVABLE_LEAD)] as any, undefined)
    const outer = factory.createTxApplyIf(SPACE, 's1', [], [], [inner] as any, undefined)
    expect((await refusal([outer])).reason).toBe('delete-referenced')
  })

  it('covers the COLLECTION spelling of a removal', async () => {
    // ⚠️ There is no `TxCollectionCUD` wrapper class any more:
    // `TxFactory.createTxCollectionCUD` returns the SAME `TxCUD` with
    // `attachedTo` / `collection` stamped on it
    // (`foundations/core/packages/core/src/tx.ts:497-513`), and
    // `TxProcessor.isExtendsCUD` lists only the four plain kinds. A guard
    // written against a wrapper class would see nothing here.
    seedLink('link-1', LEAD, OTHER)
    const collectionTx = factory.createTxCollectionCUD(
      OTHER as unknown as Ref<Class<Doc>>,
      OTHER,
      SPACE,
      'leads',
      removeTx(LEAD, ARCHIVABLE_LEAD) as any
    )
    expect((await refusal([collectionTx])).reason).toBe('delete-referenced')
  })

  it('does not read the database at all for a non-archivable class', async () => {
    seedLink('link-1', LEAD, OTHER)
    await f.guard.validate(f.ctx, [removeTx(LEAD, OTHER as unknown as Ref<Class<Doc>>)])
    expect(f.reads).toBe(0)
  })
})

describe('the archive flag may only be written by the command', () => {
  it('refuses a TxMixin with no ledger evidence', async () => {
    const err = await refusal([mixinTx({ archived: true, archiveGeneration: 1 })])
    expect(err.reason).toBe('archive-requires-command')
  })

  it('refuses the DOTTED TxUpdateDoc spelling — the one that really stores the value', async () => {
    // 🔴 Guarding only `TxMixin` would be the same as not guarding at all.
    const err = await refusal([updateTx({ [ARCHIVED]: true, [GENERATION]: 1 })])
    expect(err.reason).toBe('archive-requires-command')
  })

  it('refuses the whole-mixin object spelling', async () => {
    const err = await refusal([updateTx({ [MIXIN]: { archived: true, archiveGeneration: 1 } })])
    expect(err.reason).toBe('archive-requires-command')
  })

  it('refuses a $set payload — as UNEVALUABLE, even with evidence on file', async () => {
    // ⚠️ `opaque-operation`, not `archive-requires-command`, and the difference
    // is the point: an operator payload is refused BEFORE any evidence lookup,
    // because the command never writes the flag that way and an operator is not
    // something to interpret leniently. Evidence does not rescue it.
    seedEvidence(LEAD, 1)
    const err = await refusal([updateTx({ $set: { [ARCHIVED]: true, [GENERATION]: 1 } })])
    expect(err.reason).toBe('opaque-operation')
  })

  it('refuses a MIXED payload — the `isOperator` trap', async () => {
    // 🔴 THE REGRESSION THIS TEST EXISTS FOR. `isOperator` requires EVERY key
    // to start with `$`, but `TxProcessor.applyUpdate` dispatches key by key. A
    // guard that asked `isOperator` first and then looked only for a literal
    // key would report this `untouched` and wave it through, while every
    // applier in the platform really did write the flag.
    const err = await refusal([updateTx({ title: 'x', $set: { [ARCHIVED]: true, [GENERATION]: 1 } })])
    expect(err.reason).toBe('opaque-operation')
  })

  it('refuses $unset, $rename and $inc as unevaluable', async () => {
    expect((await refusal([updateTx({ $unset: { [ARCHIVED]: '' } })])).reason).toBe('opaque-operation')
    expect((await refusal([updateTx({ $rename: { [ARCHIVED]: 'somewhereElse' } })])).reason).toBe('opaque-operation')
    // Renaming something else ONTO the flag is the other half of $rename.
    expect((await refusal([updateTx({ $rename: { somethingElse: ARCHIVED } })])).reason).toBe('opaque-operation')
    expect((await refusal([updateTx({ $inc: { [GENERATION]: 1, [ARCHIVED]: 1 } })])).reason).toBe('opaque-operation')
  })

  it('refuses a plain write that declares no generation: there is no evidence to address', async () => {
    expect((await refusal([updateTx({ [ARCHIVED]: true })])).reason).toBe('opaque-operation')
  })

  it('refuses when the ledger row exists but the audit record does not', async () => {
    seed(f.db, {
      _id: commandExecutionId(ARCHIVE_TRANSITION_LOCK, archiveTransitionKey(LEAD, 1)),
      _class: serverAgentraCore.class.CommandExecution
    } as any)
    expect((await refusal([mixinTx({ archived: true, archiveGeneration: 1 })])).reason).toBe('archive-requires-command')
  })

  it('refuses evidence recorded for a DIFFERENT generation', async () => {
    // 🔴 The point of keying evidence on `(target, generation)`: the row left
    // by the first archive must not authorise every later hand-written flip.
    seedEvidence(LEAD, 1)
    expect((await refusal([mixinTx({ archived: false, archiveGeneration: 2 })])).reason).toBe(
      'archive-requires-command'
    )
  })

  it('refuses evidence recorded for a DIFFERENT object', async () => {
    seedEvidence(OTHER, 1)
    expect((await refusal([mixinTx({ archived: true, archiveGeneration: 1 })])).reason).toBe('archive-requires-command')
  })

  it('ADMITS the write once both halves of the evidence exist', async () => {
    seedEvidence(LEAD, 1)
    await expect(f.guard.validate(f.ctx, [mixinTx({ archived: true, archiveGeneration: 1 })])).resolves.toBeUndefined()
    await expect(f.guard.validate(f.ctx, [updateTx({ [ARCHIVED]: true, [GENERATION]: 1 })])).resolves.toBeUndefined()
  })

  it('refuses a document BORN archived', async () => {
    // 🔴 `TxProcessor.createDoc2Doc` spreads `attributes` onto the new document
    // verbatim, so a create carrying the mixin key produces a document that
    // `hierarchy.hasMixin` already considers archived — with no command, no
    // audit record and no history.
    const create = factory.createTxCreateDoc(
      ARCHIVABLE_LEAD,
      SPACE,
      { title: 'x', [MIXIN]: { archived: true, archiveGeneration: 1 } } as any,
      LEAD
    )
    expect((await refusal([create])).reason).toBe('archive-requires-command')
  })

  it('refuses a TxMixin that forges only the PROVENANCE pair', async () => {
    // Writing `archivedBy` / `archivedOn` by hand falsifies the SYS-005 record
    // just as much as writing the flag, so any payload into this mixin is
    // guarded — not only the ones that name `archived`.
    expect((await refusal([mixinTx({ archivedBy: 'someone-else' })])).reason).toBe('opaque-operation')
  })

  it('sees a flag write smuggled inside a TxApplyIf', async () => {
    const applyIf = factory.createTxApplyIf(
      SPACE,
      'scope',
      [],
      [],
      [mixinTx({ archived: true, archiveGeneration: 1 })] as any,
      undefined
    )
    expect((await refusal([applyIf])).reason).toBe('archive-requires-command')
  })
})

describe('the platform’s own writes are not collateral damage', () => {
  // 🔴 A FIELD LIST, NOT "refuse every write". Everything below is an ordinary
  // transaction the platform or a user issues constantly; a guard that read
  // "does this touch the document" rather than "does this touch the flag" would
  // make the four archivable classes uneditable.
  it('lets ordinary field edits through without reading the database', async () => {
    await f.guard.validate(f.ctx, [
      updateTx({ title: 'x' }),
      updateTx({ $push: { members: 'a' } }),
      updateTx({ $inc: { rank: 1 } }),
      updateTx({ $unset: { description: '' } }),
      updateTx({ 'title.sub': 'x' })
    ])
    expect(f.reads).toBe(0)
  })

  it('ignores a TxMixin aimed at some OTHER mixin', async () => {
    await expect(
      f.guard.validate(f.ctx, [mixinTx({ archived: true }, 'some-other:mixin:Thing' as any)])
    ).resolves.toBeUndefined()
  })

  it('ignores an ordinary create', async () => {
    const create = factory.createTxCreateDoc(ARCHIVABLE_LEAD, SPACE, { title: 'x' } as any, LEAD)
    await expect(f.guard.validate(f.ctx, [create])).resolves.toBeUndefined()
    expect(f.reads).toBe(0)
  })

  it('ignores non-CUD transactions', async () => {
    await expect(f.guard.validate(f.ctx, [{ _class: core.class.TxWorkspaceEvent } as any])).resolves.toBeUndefined()
  })

  it('refuses a pathologically nested TxApplyIf rather than recursing forever', async () => {
    let tx: Tx = removeTx(LEAD, ARCHIVABLE_LEAD)
    for (let i = 0; i < 12; i++) {
      tx = factory.createTxApplyIf(SPACE, `s${i}`, [], [], [tx] as any, undefined)
    }
    await expect(f.guard.validate(f.ctx, [tx])).rejects.toThrow('pathologically nested')
  })
})

describe('readArchivableFieldWrite', () => {
  it('reads plain, dotted, operator, unset and rename spellings', () => {
    expect(readArchivableFieldWrite({}, MIXIN).kind).toBe('untouched')
    expect(readArchivableFieldWrite({ [MIXIN]: { archived: true } }, MIXIN).kind).toBe('plain')
    expect(readArchivableFieldWrite({ [ARCHIVED]: true }, MIXIN).kind).toBe('plain')
    expect(readArchivableFieldWrite({ $set: { [ARCHIVED]: true } }, MIXIN).kind).toBe('opaque')
    expect(readArchivableFieldWrite({ $unset: { [ARCHIVED]: '' } }, MIXIN).kind).toBe('unset')
    expect(readArchivableFieldWrite({ $rename: { x: ARCHIVED } }, MIXIN).kind).toBe('opaque')
    expect(readArchivableFieldWrite({ other: 1 }, MIXIN).kind).toBe('untouched')
    expect(readArchivableFieldWrite(null as any, MIXIN).kind).toBe('untouched')
  })

  it('lets the operator reading win when a batch names the field twice', () => {
    expect(readArchivableFieldWrite({ [ARCHIVED]: false, $set: { [ARCHIVED]: true } }, MIXIN).kind).toBe('opaque')
  })
})

describe('readArchiveGeneration', () => {
  it('reads the mixin-scoped, dotted, whole-object and $set spellings', () => {
    expect(readArchiveGeneration({ archiveGeneration: 3 }, true)).toBe(3)
    expect(readArchiveGeneration({ [GENERATION]: 3 }, false)).toBe(3)
    expect(readArchiveGeneration({ [MIXIN]: { archiveGeneration: 3 } }, false)).toBe(3)
    expect(readArchiveGeneration({ $set: { [GENERATION]: 3 } }, false)).toBe(3)
  })

  it('refuses to invent one', () => {
    expect(readArchiveGeneration({}, false)).toBeUndefined()
    expect(readArchiveGeneration({ [GENERATION]: -1 }, false)).toBeUndefined()
    expect(readArchiveGeneration({ [GENERATION]: 1.5 }, false)).toBeUndefined()
    expect(readArchiveGeneration({ [GENERATION]: 'one' }, false)).toBeUndefined()
    expect(readArchiveGeneration({ $unset: { [GENERATION]: '' } }, false)).toBeUndefined()
  })
})
