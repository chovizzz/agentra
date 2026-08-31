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
  ARCHIVABLE_CLASSES,
  ARCHIVABLE_LEAD,
  agentraCoreId,
  archivableKey,
  type AgentraMarker
} from '@hcengineering/agentra-core'
import core, { type Doc, type Domain, type Tx, type TxCreateDoc, type TxMixin } from '@hcengineering/core'
import { Builder } from '@hcengineering/model'

import { createModel } from '..'
import agentraCore from '../plugin'
import { AGENTRA_CORE_MARKER_KEY, agentraCoreOperation, backfillArchivedFlag, ensureAgentraMarker } from '../migration'
import { DOMAIN_AGENTRA_CORE } from '../types'

/**
 * Minimal in-memory stand-in for `MigrationClient`. Only the members the
 * migration actually touches are implemented; everything else is left undefined
 * on purpose so that an accidentally widened migration fails loudly.
 */
function makeMigrationClient (): { client: any, docs: Doc[], updates: Array<Record<string, any>> } {
  const docs: Doc[] = []
  const updates: Array<Record<string, any>> = []
  const client = {
    migrateState: new Map<string, Set<string>>(),
    logger: { log: jest.fn(), error: jest.fn() },
    // Only the four archivable classifiers plus a domain for them. Anything
    // else answers `false` / `undefined`, which is exactly what a workspace
    // with one of the optional modules disabled looks like.
    hierarchy: {
      hasClass: (_class: string) => ARCHIVABLE_CLASSES.includes(_class as any),
      findDomain: (_class: string) => `domain-for-${_class}` as Domain
    },
    async find (domain: Domain, query: Record<string, any>): Promise<Doc[]> {
      expect(domain).toBe(DOMAIN_AGENTRA_CORE)
      return docs.filter((doc) => Object.entries(query).every(([key, value]) => (doc as any)[key] === value))
    },
    async update (domain: Domain, query: Record<string, any>, operations: Record<string, any>): Promise<void> {
      updates.push({ domain, query, operations })
    },
    async create (domain: Domain, doc: Doc | Doc[]): Promise<void> {
      docs.push(...(Array.isArray(doc) ? doc : [doc]))
    }
  }
  return { client, docs, updates }
}

describe('agentra-core model', () => {
  it('builds without throwing and emits the marker class model', () => {
    const builder = new Builder()
    const txes: string[] = []
    builder.onTx = (tx) => {
      txes.push(tx._class)
    }

    expect(() => {
      createModel(builder)
    }).not.toThrow()
    builder.onTx = undefined

    // A class model must produce transactions; an empty createModel is the
    // classic "compiles but nothing loads" symptom.
    expect(txes.length).toBeGreaterThan(0)
    expect(builder.getTxes().length).toBeGreaterThan(0)
  })

  it('registers the marker class under the agentra-core plugin id', () => {
    expect(agentraCore.class.AgentraMarker.startsWith(`${agentraCoreId}:`)).toBe(true)
    expect(DOMAIN_AGENTRA_CORE).toBe('agentra-core')
  })
})

describe('agentra-core migration', () => {
  it('creates exactly one marker document with a deterministic id', async () => {
    const { client, docs } = makeMigrationClient()

    await ensureAgentraMarker(client)

    expect(docs).toHaveLength(1)
    expect((docs[0] as AgentraMarker).key).toBe(AGENTRA_CORE_MARKER_KEY)
    expect(docs[0]._class).toBe(agentraCore.class.AgentraMarker)
    // The deterministic id is what makes this safe under concurrency, so assert
    // it explicitly: a regression back to generateId() must fail the suite.
    expect(docs[0]._id).toBe(agentraCore.ids.BootstrapMarker)
  })

  it('produces the same id on a fresh workspace every time', async () => {
    const first = makeMigrationClient()
    const second = makeMigrationClient()

    await ensureAgentraMarker(first.client)
    await ensureAgentraMarker(second.client)

    expect(first.docs[0]._id).toBe(second.docs[0]._id)
  })

  it('is idempotent when run repeatedly', async () => {
    const { client, docs } = makeMigrationClient()

    await ensureAgentraMarker(client)
    await ensureAgentraMarker(client)
    await ensureAgentraMarker(client)

    expect(docs).toHaveLength(1)
  })

  it('does not duplicate the marker when tryMigrate state is lost', async () => {
    const { client, docs } = makeMigrationClient()

    // First upgrade: tryMigrate records `bootstrap-marker` in DOMAIN_MIGRATION.
    await agentraCoreOperation.migrate(client, 'upgrade')
    expect(docs.filter((it) => it._class === agentraCore.class.AgentraMarker)).toHaveLength(1)

    // Second upgrade with the state table wiped (restored backup, mode switch).
    client.migrateState = new Map<string, Set<string>>()
    await agentraCoreOperation.migrate(client, 'upgrade')

    expect(docs.filter((it) => it._class === agentraCore.class.AgentraMarker)).toHaveLength(1)
  })
})

describe('SYS-005: the Archivable mixin', () => {
  const txes = (): Tx[] => {
    const builder = new Builder()
    createModel(builder)
    return builder.getTxes()
  }

  it('is declared as a MIXIN classifier, not as a class', () => {
    // 🔴 `core.class.Mixin`. A `@Model` would emit `core.class.Class` here and
    // `hierarchy.hasMixin` / `hierarchy.as` would never recognise it — the
    // whole feature would compile and silently do nothing.
    const created = txes().filter(
      (tx) => tx._class === core.class.TxCreateDoc && (tx as TxCreateDoc<Doc>).objectId === agentraCore.mixin.Archivable
    ) as Array<TxCreateDoc<Doc>>
    expect(created).toHaveLength(1)
    expect(created[0].objectClass).toBe(core.class.Mixin)
    expect((created[0].attributes as any).extends).toBe(core.class.Doc)
  })

  it('declares all four attributes and NOT ONE index on them', () => {
    // 🔴 A mixin attribute is stored under `<mixinId>.<attr>`; an index on the
    // bare name would be built over a key no query ever names.
    const attrs = txes().filter(
      (tx) =>
        tx._class === core.class.TxCreateDoc &&
        (tx as TxCreateDoc<Doc>).objectClass === core.class.Attribute &&
        ((tx as TxCreateDoc<Doc>).attributes as any).attributeOf === agentraCore.mixin.Archivable
    ) as Array<TxCreateDoc<Doc>>
    expect(new Set(attrs.map((it) => String((it.attributes as any).name)))).toEqual(
      new Set(['archiveGeneration', 'archived', 'archivedBy', 'archivedOn'])
    )
    for (const attr of attrs) {
      expect((attr.attributes as any).index).toBeUndefined()
    }
  })

  it('adds NO builder.mixin onto Lead / Requirement / Issue / TestCase', () => {
    // 🔴 agentra-core is the FOUNDATION and loads BEFORE those four modules
    // (`models/all/src/index.ts:198` vs :325/:382/:570/:582). `Builder.mixin`
    // calls `hierarchy.tx`, whose `txMixin` does `getClass(objectId)` and
    // THROWS on a classifier that does not exist yet — model building would
    // fail outright. This assertion is what stops that from being re-added.
    const targets = new Set<string>(ARCHIVABLE_CLASSES as unknown as string[])
    const offenders = txes().filter(
      (tx) => tx._class === core.class.TxMixin && targets.has(String((tx as TxMixin<Doc, Doc>).objectId))
    )
    expect(offenders).toHaveLength(0)
  })

  it('pins the persisted key shape', () => {
    expect(agentraCore.mixin.Archivable).toBe('agentra-core:mixin:Archivable')
    expect(archivableKey('archived')).toBe('agentra-core:mixin:Archivable.archived')
  })
})

describe('SYS-005: the archived backfill', () => {
  it('touches every archivable class, filtered to documents that lack the field', async () => {
    const { client, updates } = makeMigrationClient()

    await backfillArchivedFlag(client)

    expect(updates).toHaveLength(ARCHIVABLE_CLASSES.length)
    const lead = updates.find((it) => it.query._class === ARCHIVABLE_LEAD)
    // 🔴 THE FILTER IS THE IDEMPOTENCY. Not a state row, not a counter: a
    // re-run selects zero documents and writes nothing, which still holds on a
    // restored backup where `tryMigrate`'s state table is gone.
    expect(lead?.query[archivableKey('archived')]).toEqual({ $exists: false })
    // Both keys in one update: a generation left undefined would make the
    // archive command's derived ledger id depend on how a reader coerced it.
    expect(lead?.operations).toEqual({
      [archivableKey('archived')]: false,
      [archivableKey('archiveGeneration')]: 0
    })
  })

  it('skips a class the workspace does not have', async () => {
    const { client, updates } = makeMigrationClient()
    client.hierarchy.hasClass = (_class: string) => _class === ARCHIVABLE_LEAD

    await backfillArchivedFlag(client)

    expect(updates).toHaveLength(1)
    expect(updates[0].query._class).toBe(ARCHIVABLE_LEAD)
  })

  it('writes nothing extra when the whole operation is re-run with the state table wiped', async () => {
    const { client, docs } = makeMigrationClient()

    await agentraCoreOperation.migrate(client, 'upgrade')
    client.migrateState = new Map<string, Set<string>>()
    await agentraCoreOperation.migrate(client, 'upgrade')

    // ⚠️ The marker count is the observable: the backfill itself is a filtered
    // `update`, which by construction cannot duplicate anything. What this
    // guards is that adding a second migration step did not break the first
    // one's idempotency.
    expect(docs.filter((it) => it._class === agentraCore.class.AgentraMarker)).toHaveLength(1)
  })
})
