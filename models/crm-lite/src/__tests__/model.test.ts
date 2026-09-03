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

import card, { type CardSection, type CardSpace } from '@hcengineering/card'
import crmLitePlugin, {
  canTransitionLead,
  crmLiteId,
  LEAD_INTAKE_ALIAS,
  LEAD_INTAKE_SPECIAL,
  leadStatusOrder,
  requiresDisqualifyReason,
  type CrmPipeline,
  type LeadSource,
  type LeadStatus
} from '@hcengineering/crm-lite'
import core, {
  AccountRole,
  ClassifierKind,
  DOMAIN_SPACE,
  type AccountUuid,
  type AnyAttribute,
  type Class,
  type Doc,
  type Domain,
  type Mixin,
  type Ref,
  type Tx,
  type TxCreateDoc,
  type TxMixin
} from '@hcengineering/core'
import { Builder } from '@hcengineering/model'
import cardModel, { createModel as createCardModel } from '@hcengineering/model-card'
import { createModel as createCoreModel } from '@hcengineering/model-core'
import type { IntlString } from '@hcengineering/platform'
import task from '@hcengineering/model-task'
import view from '@hcengineering/model-view'
import { type Viewlet } from '@hcengineering/view'

import { createModel } from '..'
import { crmLiteOperation, ensureCrmDefaults, ensureCrmSpace, seedCrmSpaceOwners } from '../migration'
import crmLite from '../plugin'
import { DOMAIN_CRM_LITE } from '../types'

/**
 * `createSystemType` mixes onto upstream classes (`card.class.Card`) and creates
 * the tag as a `card.class.MasterTag` document, so a bare `new Builder()` has no
 * hierarchy to resolve them against. Rather than pulling the whole card model
 * (and its dozen transitive model packages) into this unit test, seed the four
 * classifiers those calls actually touch.
 */
function seedUpstreamClassifiers (builder: Builder): void {
  const stub = (_id: Ref<Class<Doc>>, ext?: Ref<Class<Doc>>): void => {
    builder.createDoc(
      core.class.Class,
      core.space.Model,
      { kind: ClassifierKind.CLASS, label: '' as IntlString, extends: ext } as any,
      _id
    )
  }
  stub(core.class.Doc)
  stub(core.class.Class, core.class.Doc)
  stub(card.class.Card, core.class.Doc)
  // MasterTag must be derived from core.class.Class, otherwise Hierarchy would
  // not treat `createSystemType`'s tag document as a classifier at all.
  stub(card.class.MasterTag, core.class.Class)
}

function build (): Tx[] {
  const builder = new Builder()
  seedUpstreamClassifiers(builder)
  createModel(builder)
  return builder.getTxes()
}

function creates<T extends Doc> (txes: Tx[], _class: Ref<Class<Doc>>): Array<TxCreateDoc<T>> {
  return txes.filter(
    (tx) => tx._class === core.class.TxCreateDoc && (tx as TxCreateDoc<Doc>).objectClass === _class
  ) as Array<TxCreateDoc<T>>
}

function mixins (txes: Tx[], objectId: Ref<Doc>, mixin: Ref<Mixin<Doc>>): Array<TxMixin<Doc, Doc>> {
  return txes.filter(
    (tx) =>
      tx._class === core.class.TxMixin &&
      (tx as TxMixin<Doc, Doc>).objectId === objectId &&
      (tx as TxMixin<Doc, Doc>).mixin === mixin
  ) as Array<TxMixin<Doc, Doc>>
}

let txes: Tx[]
beforeAll(() => {
  txes = build()
})

describe('crm-lite model: Lead is a MasterTag', () => {
  it('builds without throwing and emits transactions', () => {
    expect(txes.length).toBeGreaterThan(0)
  })

  it('creates Lead as a MasterTag extending card.class.Card', () => {
    const tags = creates(txes, card.class.MasterTag).filter((tx) => tx.objectId === crmLite.masterTag.Lead)
    expect(tags).toHaveLength(1)
    // 🔴 A Tag would be a Mixin<Card> and could never be a document's `_class`,
    // nor take part in card versioning (`classHierarchyMixin` walks `extends`
    // only). Regressing this back to a Tag must fail the suite.
    expect((tags[0].attributes as any).extends).toBe(card.class.Card)
    expect(tags[0].objectId.startsWith(`${crmLiteId}:`)).toBe(true)
  })

  it('declares every CRM business field as an attribute of the Lead tag', () => {
    const attrs = creates<AnyAttribute>(txes, core.class.Attribute).filter(
      (tx) => (tx.attributes as any).attributeOf === crmLite.masterTag.Lead
    )
    const names = attrs.map((tx) => (tx.attributes as any).name as string).sort()
    expect(names).toEqual(
      [
        'account',
        'contact',
        'disqualifyReason',
        'intakeEmail',
        'intakeMessage',
        'intakeName',
        'nextActionAt',
        'owner',
        'pipeline',
        'priority',
        'source',
        'status'
      ].sort()
    )
  })

  it('models the three anonymous-intake fields as plain strings and nothing else', () => {
    // 🔴 These are the ONLY Lead attributes an unauthenticated stranger can
    // write (`INTAKE_ALLOWED_FIELDS`), so their type is part of the attack
    // surface. A `TypeRef` would let a stranger name a document — precisely the
    // `account` / `contact` attack the intake whitelist refuses — and a custom
    // Type subclass would need presenter/editor mixins this model does not
    // register, which makes `getAttributePresenter` throw at render time.
    const attrs = creates<AnyAttribute>(txes, core.class.Attribute)
    const byName = new Map(attrs.map((tx) => [(tx.attributes as any).name as string, tx.attributes as any]))
    for (const name of ['intakeName', 'intakeEmail', 'intakeMessage']) {
      const attr = byName.get(name)
      expect(attr).toBeDefined()
      expect(attr?.attributeOf).toBe(crmLite.masterTag.Lead)
      expect(attr?.type?._class).toBe(core.class.TypeString)
      expect(attr?.type?.to).toBeUndefined()
      // No fulltext index: a stranger's self-declared address does not get a
      // second copy in a second store for a search nobody asked for.
      expect(attr?.index).toBeUndefined()
    }
  })

  it('labels the intake email as unverified rather than as a contact channel', () => {
    // 🔴 The label is the caveat's only carrier at the point the salesperson
    // acts on the value. `crm-lite-assets` translates it; this pins that the
    // attribute uses the STAFF-facing string, not the form's "Your email".
    const attrs = creates<AnyAttribute>(txes, core.class.Attribute)
    const byName = new Map(attrs.map((tx) => [(tx.attributes as any).name as string, tx.attributes as any]))
    expect(byName.get('intakeName')?.label).toBe(crmLite.string.LeadIntakeName)
    expect(byName.get('intakeEmail')?.label).toBe(crmLite.string.LeadIntakeEmail)
    expect(byName.get('intakeMessage')?.label).toBe(crmLite.string.LeadIntakeMessage)
  })

  it('reuses contact.Organization / contact.Person instead of new tables', () => {
    const attrs = creates<AnyAttribute>(txes, core.class.Attribute)
    const byName = new Map(attrs.map((tx) => [(tx.attributes as any).name as string, tx.attributes as any]))
    expect(byName.get('account')?.type?.to).toBe('contact:class:Organization')
    expect(byName.get('contact')?.type?.to).toBe('contact:class:Person')
  })

  it('types the grouping attribute with crmLite.class.TypeLeadStatus', () => {
    const attrs = creates<AnyAttribute>(txes, core.class.Attribute)
    const status = attrs.find((tx) => (tx.attributes as any).name === 'status')
    expect(status).toBeDefined()
    expect((status?.attributes as any).type._class).toBe(crmLite.class.TypeLeadStatus)
    // Deterministic attribute id, same convention as the `@Prop` decorator.
    expect(status?.objectId).toBe(`${crmLite.masterTag.Lead}_status`)
  })
})

describe('crm-lite model: kanban wiring (route A)', () => {
  it('registers a Viewlet on the Lead tag with the upstream Kanban descriptor', () => {
    const viewlets = creates<Viewlet>(txes, view.class.Viewlet).filter(
      (tx) => (tx.attributes as any).descriptor === task.viewlet.Kanban
    )
    expect(viewlets).toHaveLength(1)
    expect((viewlets[0].attributes as any).attachTo).toBe(crmLite.masterTag.Lead)
    // SpecialView refuses to render when `viewlet.attachTo !== _class`, and
    // card's Main.svelte passes the MasterTag id as `_class`.
    expect(viewlets[0].objectId).toBe(crmLite.viewlet.KanbanLead)
  })

  it('groups the kanban by the status attribute', () => {
    const viewlets = creates<Viewlet>(txes, view.class.Viewlet).filter(
      (tx) => (tx.attributes as any).descriptor === task.viewlet.Kanban
    )
    expect((viewlets[0].attributes as any).viewOptions.groupBy[0]).toBe('status')
  })

  it('hangs task.mixin.KanbanCard on the Lead tag', () => {
    // Without this mixin KanbanView.svelte cannot resolve a card presenter and
    // the board renders nothing at all.
    const found = mixins(txes, crmLite.masterTag.Lead, task.mixin.KanbanCard)
    expect(found).toHaveLength(1)
    expect((found[0].attributes as any).card).toBe(crmLite.component.KanbanCard)
  })

  it('hangs SortFuncs, AllValuesFunc and AttributePresenter on the status TYPE class', () => {
    // Grouping resolves the attribute's `attrClass`, so all three must sit on
    // TypeLeadStatus, not on the Lead tag.
    expect(mixins(txes, crmLite.class.TypeLeadStatus, view.mixin.SortFuncs)).toHaveLength(1)
    expect(mixins(txes, crmLite.class.TypeLeadStatus, view.mixin.AllValuesFunc)).toHaveLength(1)
    // `getAttributePresenter` THROWS when this one is missing, which would leave
    // the kanban column headers blank.
    expect(mixins(txes, crmLite.class.TypeLeadStatus, view.mixin.AttributePresenter)).toHaveLength(1)
  })

  it('registers AttributeFilter on both TYPE classes so the fields filter by value', () => {
    // `buildFilterKey` (plugins/view-resources/src/filter.ts) returns undefined
    // without this mixin, and `FilterSection` then silently degrades to a bare
    // count — no error, just a field nobody can filter on.
    for (const cls of [crmLite.class.TypeLeadStatus, crmLite.class.TypeLeadPriority]) {
      const filterMixins = mixins(txes, cls, view.mixin.AttributeFilter)
      expect(filterMixins).toHaveLength(1)
      expect((filterMixins[0] as any).attributes.component).toBe(view.component.ValueFilter)
    }
  })
})

describe('crm-lite state machine', () => {
  it('walks New -> Contacted -> Qualifying -> Converted', () => {
    expect(canTransitionLead('New', 'Contacted')).toBe(true)
    expect(canTransitionLead('Contacted', 'Qualifying')).toBe(true)
    expect(canTransitionLead('Qualifying', 'Converted')).toBe(true)
    expect(canTransitionLead('New', 'Converted')).toBe(false)
  })

  it('lets any non-Converted state be disqualified, and requires a reason', () => {
    for (const from of ['New', 'Contacted', 'Qualifying'] as LeadStatus[]) {
      expect(canTransitionLead(from, 'Disqualified')).toBe(true)
    }
    expect(canTransitionLead('Converted', 'Disqualified')).toBe(false)
    expect(requiresDisqualifyReason('Disqualified')).toBe(true)
    expect(requiresDisqualifyReason('Converted')).toBe(false)
  })

  it('keeps the enum append-only and PascalCase (Technical Spec §3.9)', () => {
    expect(leadStatusOrder).toEqual(['New', 'Contacted', 'Qualifying', 'Converted', 'Disqualified'])
  })
})

const OWNER_A = 'owner-a' as AccountUuid
const OWNER_B = 'owner-b' as AccountUuid
const PLAIN_USER = 'plain-user' as AccountUuid

/** Minimal MigrationClient: only what the migration actually touches. */
function makeMigrationClient (opts: { owners?: AccountUuid[], spaces?: any[] } = {}): {
  client: any
  docs: Doc[]
  spaces: Map<Ref<Doc>, any>
} {
  const docs: Doc[] = []
  const spaces = new Map<Ref<Doc>, any>((opts.spaces ?? []).map((it) => [it._id, it]))
  const matches = (doc: any, query: Record<string, any>): boolean =>
    Object.entries(query).every(([key, value]) => doc[key] === value)
  const client = {
    migrateState: new Map<string, Set<string>>(),
    logger: { log: jest.fn(), error: jest.fn() },
    accountClient: {
      // Roles live in the account service, never in the workspace database —
      // this is the only source the migration can read them from.
      getWorkspaceMembers: jest.fn(async () => [
        ...(opts.owners ?? []).map((person) => ({ person, role: AccountRole.Owner })),
        { person: PLAIN_USER, role: AccountRole.User }
      ])
    },
    async find (domain: Domain, query: Record<string, any>): Promise<Doc[]> {
      if (domain === DOMAIN_SPACE) {
        return [...spaces.values()].filter((doc) => matches(doc, query))
      }
      // Apart from the shared space collection the migration must only ever
      // read its own domain.
      expect(domain).toBe(DOMAIN_CRM_LITE)
      return docs.filter((doc) => matches(doc, query))
    },
    async create (domain: Domain, doc: Doc | Doc[]): Promise<void> {
      docs.push(...(Array.isArray(doc) ? doc : [doc]))
    },
    async update (domain: Domain, query: Record<string, any>, operations: Record<string, any>): Promise<void> {
      // The only collection this migration ever patches is the space one.
      expect(domain).toBe(DOMAIN_SPACE)
      for (const doc of [...spaces.values()].filter((it) => matches(it, query))) {
        spaces.set(doc._id, { ...doc, ...operations })
      }
    }
  }
  return { client, docs, spaces }
}

/** The CRM space as `ensureCrmSpace` leaves it, plus whatever members. */
function crmSpaceDoc (members: AccountUuid[] = []): any {
  return {
    _id: crmLite.space.Crm,
    _class: card.class.CardSpace,
    space: core.space.Space,
    name: 'CRM',
    private: false,
    archived: false,
    autoJoin: false,
    members,
    types: [crmLite.masterTag.Lead]
  }
}

/** Minimal MigrationUpgradeClient sufficient for TxOperations create/update. */
function makeUpgradeClient (): { client: any, spaces: Map<Ref<Doc>, any> } {
  const spaces = new Map<Ref<Doc>, any>()
  const hierarchy = {
    isDerived: () => false,
    findDomain: () => DOMAIN_SPACE,
    getClass: () => ({}),
    isMixin: () => false
  }
  const client = {
    getHierarchy: () => hierarchy,
    getModel: () => ({}),
    async findOne (_class: Ref<Class<Doc>>, query: Record<string, any>): Promise<any> {
      return [...spaces.values()].find((doc) => Object.entries(query).every(([key, value]) => doc[key] === value))
    },
    async findAll (): Promise<any[]> {
      return []
    },
    async tx (tx: any): Promise<any> {
      if (tx._class === core.class.TxCreateDoc) {
        spaces.set(tx.objectId, {
          _id: tx.objectId,
          _class: tx.objectClass,
          space: tx.objectSpace,
          ...tx.attributes
        })
      } else if (tx._class === core.class.TxUpdateDoc) {
        const existing = spaces.get(tx.objectId)
        if (existing !== undefined) {
          spaces.set(tx.objectId, { ...existing, ...tx.operations })
        }
      }
      return {}
    },
    async close (): Promise<void> {}
  }
  return { client, spaces }
}

describe('crm-lite migration: defaults', () => {
  it('creates the default pipeline and the configurable sources', async () => {
    const { client, docs } = makeMigrationClient()
    await ensureCrmDefaults(client)

    const pipelines = docs.filter((it) => it._class === crmLite.class.CrmPipeline) as CrmPipeline[]
    const sources = docs.filter((it) => it._class === crmLite.class.LeadSource) as LeadSource[]

    expect(pipelines).toHaveLength(1)
    expect(pipelines[0]._id).toBe(crmLite.ids.DefaultPipeline)
    expect(pipelines[0].stages).toEqual(leadStatusOrder)
    // Sources are documents, not a baked in enum, so a deployment can add more.
    expect(sources.length).toBeGreaterThan(1)
    expect(sources.map((it) => it._id)).toContain(crmLite.ids.SourceInbound)
  })

  it('uses deterministic ids, so a concurrent migrator collides instead of duplicating', async () => {
    const first = makeMigrationClient()
    const second = makeMigrationClient()
    await ensureCrmDefaults(first.client)
    await ensureCrmDefaults(second.client)
    expect(first.docs.map((it) => it._id)).toEqual(second.docs.map((it) => it._id))
  })

  it('is idempotent when run repeatedly', async () => {
    const { client, docs } = makeMigrationClient()
    await ensureCrmDefaults(client)
    const after = docs.length
    await ensureCrmDefaults(client)
    await ensureCrmDefaults(client)
    expect(docs).toHaveLength(after)
  })

  it('does not duplicate when the tryMigrate state table is lost', async () => {
    const { client, docs } = makeMigrationClient()
    const crmDocs = (): Doc[] =>
      docs.filter((it) => it._class === crmLite.class.CrmPipeline || it._class === crmLite.class.LeadSource)

    await crmLiteOperation.migrate(client, 'upgrade')
    const after = crmDocs().length
    expect(after).toBeGreaterThan(0)

    // Restored backup / MigrateMode switch: `tryMigrate`'s state table is a
    // performance guard, not a correctness guard, so the migration itself has to
    // be idempotent. (tryMigrate re-records its own MigrationState row here —
    // that is its bookkeeping, not a duplicated business document.)
    client.migrateState = new Map<string, Set<string>>()
    await crmLiteOperation.migrate(client, 'upgrade')
    expect(crmDocs()).toHaveLength(after)
  })
})

describe('crm-lite migration: CRM CardSpace', () => {
  it('creates a dedicated CardSpace that lists the Lead tag in `types`', async () => {
    const { client, spaces } = makeUpgradeClient()
    await ensureCrmSpace(client)

    const space = spaces.get(crmLite.space.Crm) as CardSpace
    expect(space).toBeDefined()
    expect(space._class).toBe(card.class.CardSpace)
    // 🔴 Nothing adds a new MasterTag to an existing space's `types`; each
    // module writes its own tag in.
    expect(space.types).toContain(crmLite.masterTag.Lead)
    // Reuses the single upstream SpaceType — a private one would be rewritten
    // back by card's `migrateRolesToBaseRole`.
    expect(space.type).toBe(card.spaceType.SpaceType)
    // Never `card.space.Default`, which is autoJoin: true.
    expect(space._id).not.toBe(card.space.Default)
    expect((space as any).autoJoin).toBe(false)
  })

  it('is idempotent and tops `types` up when the tag is missing', async () => {
    const { client, spaces } = makeUpgradeClient()
    await ensureCrmSpace(client)
    await ensureCrmSpace(client)
    expect(spaces.size).toBe(1)

    const space = spaces.get(crmLite.space.Crm) as CardSpace
    spaces.set(crmLite.space.Crm, { ...space, types: [] })
    await ensureCrmSpace(client)
    expect((spaces.get(crmLite.space.Crm) as CardSpace).types).toContain(crmLite.masterTag.Lead)
  })
})

describe('crm-lite plugin descriptor', () => {
  it('namespaces every id under the plugin id', () => {
    expect(crmLitePlugin.masterTag.Lead.startsWith(`${crmLiteId}:`)).toBe(true)
    expect(crmLitePlugin.space.Crm.startsWith(`${crmLiteId}:`)).toBe(true)
    expect(DOMAIN_CRM_LITE).toBe('crm-lite')
  })
})

describe('crm-lite migration: seeding the workspace Owner into the CRM space', () => {
  it('adds every workspace Owner as a member, and nobody else', async () => {
    const { client, spaces } = makeMigrationClient({ owners: [OWNER_A, OWNER_B], spaces: [crmSpaceDoc()] })
    await seedCrmSpaceOwners(client)

    const members: AccountUuid[] = spaces.get(crmLite.space.Crm).members
    expect(new Set(members)).toEqual(new Set([OWNER_A, OWNER_B]))
    // 🔴 The whole point of a separate space is read isolation: a plain USER
    // must NOT be seeded. Admins add the rest by hand in the UI.
    expect(members).not.toContain(PLAIN_USER)
  })

  it('is idempotent — repeated runs add no duplicates and write nothing', async () => {
    const { client, spaces } = makeMigrationClient({ owners: [OWNER_A], spaces: [crmSpaceDoc()] })
    await seedCrmSpaceOwners(client)
    await seedCrmSpaceOwners(client)
    await seedCrmSpaceOwners(client)

    expect(spaces.get(crmLite.space.Crm).members).toEqual([OWNER_A])
  })

  it('appends to manually added members instead of overwriting them', async () => {
    const manual = 'added-by-admin' as AccountUuid
    const { client, spaces } = makeMigrationClient({ owners: [OWNER_A], spaces: [crmSpaceDoc([manual])] })
    await seedCrmSpaceOwners(client)

    const members: AccountUuid[] = spaces.get(crmLite.space.Crm).members
    // 🔴 Regressing this to a wholesale `members: owners` write would silently
    // revoke access for everyone an administrator had added.
    expect(members).toContain(manual)
    expect(members).toContain(OWNER_A)
    expect(members).toHaveLength(2)
  })

  it('keeps a manually added member even when they are already an Owner', async () => {
    const { client, spaces } = makeMigrationClient({ owners: [OWNER_A], spaces: [crmSpaceDoc([OWNER_A])] })
    await seedCrmSpaceOwners(client)
    expect(spaces.get(crmLite.space.Crm).members).toEqual([OWNER_A])
  })

  it('does nothing, and does not call the account service, when the space is absent', async () => {
    const { client } = makeMigrationClient({ owners: [OWNER_A] })
    await seedCrmSpaceOwners(client)
    expect(client.accountClient.getWorkspaceMembers).not.toHaveBeenCalled()
  })

  it('never fails the workspace upgrade when the account service is down', async () => {
    const { client, spaces } = makeMigrationClient({ owners: [OWNER_A], spaces: [crmSpaceDoc()] })
    client.accountClient.getWorkspaceMembers = jest.fn(async () => {
      throw new Error('account service unavailable')
    })
    await expect(seedCrmSpaceOwners(client)).resolves.toBeUndefined()
    expect(client.logger.error).toHaveBeenCalled()
    // Nothing was written, so the next upgrade retries from a clean state.
    expect(spaces.get(crmLite.space.Crm).members).toEqual([])
  })

  it('runs from `migrate` on every pass, not once behind the state table', async () => {
    const { client, spaces } = makeMigrationClient({ owners: [OWNER_A], spaces: [crmSpaceDoc()] })
    await crmLiteOperation.migrate(client, 'upgrade')
    expect(spaces.get(crmLite.space.Crm).members).toEqual([OWNER_A])

    // A second Owner is promoted after the first upgrade; the state table would
    // have made the step a no-op forever, so it is deliberately not used.
    client.accountClient.getWorkspaceMembers = jest.fn(async () => [
      { person: OWNER_A, role: AccountRole.Owner },
      { person: OWNER_B, role: AccountRole.Owner }
    ])
    await crmLiteOperation.migrate(client, 'upgrade')
    expect(new Set<AccountUuid>(spaces.get(crmLite.space.Crm).members)).toEqual(new Set([OWNER_A, OWNER_B]))
  })
})

describe('crm-lite model: inline status / priority editing', () => {
  it('registers view.mixin.AttributeEditor on both TYPE classes', () => {
    // 🔴 Not cosmetic. `AttributeBarEditor` (packages/presentation) wraps its
    // whole body in `{#if editor}` and resolves that editor through
    // `classHierarchyMixin(attrClass, view.mixin.AttributeEditor)`. Without this
    // mixin the status / priority rows do not render read only — they do not
    // render at all.
    const status = mixins(txes, crmLite.class.TypeLeadStatus, view.mixin.AttributeEditor)
    expect(status).toHaveLength(1)
    expect((status[0].attributes as any).inlineEditor).toBe(crmLite.component.LeadStatusEditor)

    const priority = mixins(txes, crmLite.class.TypeLeadPriority, view.mixin.AttributeEditor)
    expect(priority).toHaveLength(1)
    expect((priority[0].attributes as any).inlineEditor).toBe(crmLite.component.LeadPriorityEditor)
  })

  it('keeps the presenter mixins alongside the editors', () => {
    // `classPresenter` writes both; a regression that dropped the presenter
    // would make `getAttributePresenter` throw in list / kanban headers.
    expect(mixins(txes, crmLite.class.TypeLeadPriority, view.mixin.AttributePresenter)).toHaveLength(1)
  })
})

describe('crm-lite model: traceability section on the Lead detail page', () => {
  function sections (): Array<TxCreateDoc<CardSection>> {
    return creates<CardSection>(txes, card.class.CardSection).filter(
      (tx) => tx.objectId === crmLite.section.LeadTraceLinks
    )
  }

  it('registers exactly one traceability CardSection under a fixed id', () => {
    const found = sections()
    expect(found).toHaveLength(1)
    expect(found[0].objectId).toBe(crmLite.section.LeadTraceLinks)
  })

  it('is one of exactly two sections this model contributes, each under a fixed id', () => {
    // 🔴 Every section this model registers must carry a hand written id, so a
    // later migration can re-point or remove it. A `generateId()` section is
    // re-created under a new id on every model build and becomes unreachable.
    const all = creates<CardSection>(txes, card.class.CardSection)
    expect(all.map((tx) => tx.objectId).sort()).toEqual(
      [crmLite.section.LeadTraceLinks, crmLite.section.LeadFields].sort()
    )
  })

  it('points the section at the Lead wrapper component, not at the raw block', () => {
    // ⚠️ `EditCardTableOfContents.svelte` passes the card as `doc`, while
    // `traceability:component:TraceLinksSection` declares `object`. Pointing
    // this straight at the traceability component would leave `object`
    // undefined and throw on first render, so the wrapper is the contract.
    const attrs = sections()[0].attributes as any
    expect(attrs.component).toBe(crmLite.component.LeadTraceLinksSection)
    expect(attrs.label).toBe(crmLite.string.Traceability)
  })

  it('scopes the section to Leads via checkVisibility', () => {
    // 🔴 `card.class.CardSection` has no `attachTo`: `getCardSections`
    // (plugins/card-resources/src/card.ts) reads EVERY section document and
    // filters only on this callback. Losing it puts the traceability block on
    // every card of every type in the workspace.
    const attrs = sections()[0].attributes as any
    expect(attrs.checkVisibility).toBe(crmLite.function.CheckLeadTraceLinksVisibility)
  })

  it('orders the section after Relations and before the message stream', () => {
    const attrs = sections()[0].attributes as any
    expect(attrs.order).toBeGreaterThan(500)
    expect(attrs.order).toBeLessThan(1000)
  })
})

describe('crm-lite model: required-field checklist on the Lead detail page', () => {
  function section (): TxCreateDoc<CardSection> {
    const found = creates<CardSection>(txes, card.class.CardSection).filter(
      (tx) => tx.objectId === crmLite.section.LeadFields
    )
    expect(found).toHaveLength(1)
    return found[0]
  }

  it('resolves every id it registers to a real string', () => {
    // 🔴 THIS IS THE STALE-`lib/` TRAP, AND IT IS INVISIBLE WITHOUT THIS TEST.
    // `@hcengineering/crm-lite`'s `main` points at `lib/`, so a string added to
    // its `src` is `undefined` here until the package is rebuilt — and the
    // obvious assertion (`expect(attrs.label).toBe(crmLite.string.RequiredFields)`)
    // passes anyway, because both sides read the same `undefined`. The section
    // would ship with no label and no visibility callback.
    expect(crmLite.string.RequiredFields).toBe(`${crmLiteId}:string:RequiredFields`)
    expect(crmLite.component.LeadFieldsSection).toBe(`${crmLiteId}:component:LeadFieldsSection`)
    expect(crmLite.function.CheckLeadFieldsVisibility).toBe(`${crmLiteId}:function:CheckLeadFieldsVisibility`)
    expect(crmLite.section.LeadFields).toBe(`${crmLiteId}:section:LeadFields`)
  })

  it('points at the wrapper component that declares `doc`', () => {
    // ⚠️ `EditCardTableOfContents.svelte` renders every section with
    // `props={{ doc, readonly, hidden, ... }}`. A component declaring `object`
    // would not merely render empty, it would throw on first render.
    const attrs = section().attributes as any
    expect(attrs.component).toBe(crmLite.component.LeadFieldsSection)
    expect(attrs.label).toBe(crmLite.string.RequiredFields)
  })

  it('scopes itself to Leads via checkVisibility', () => {
    // 🔴 A CardSection has no `attachTo`; `getCardSections` reads every section
    // document there is and filters only on this callback. Without it the
    // checklist appears on every card of every type in the workspace.
    const attrs = section().attributes as any
    expect(attrs.checkVisibility).toBe(crmLite.function.CheckLeadFieldsVisibility)
  })

  it('uses a checkVisibility resource of its own, not the traceability one', () => {
    const attrs = section().attributes as any
    expect(attrs.checkVisibility).not.toBe(crmLite.function.CheckLeadTraceLinksVisibility)
  })

  it('sits between Properties and Content, so it is read next to the fields it is about', () => {
    // Upstream orders: Properties 100, Content 200, Attachments 300,
    // Children 400, Relations 500, messages 1000 (models/card/src/index.ts).
    const attrs = section().attributes as any
    expect(attrs.order).toBeGreaterThan(100)
    expect(attrs.order).toBeLessThan(200)
  })

  it('declares no navigation entries', () => {
    expect((section().attributes as any).navigation).toEqual([])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Task 12b: the filter surface, and the Application a Saved View hangs off
// ────────────────────────────────────────────────────────────────────────────

describe('crm-lite model: the Lead filter surface (Saved View prerequisite)', () => {
  function classFilters (): Record<string, any> | undefined {
    const found = mixins(txes, crmLite.masterTag.Lead, view.mixin.ClassFilters)
    return found.length === 1 ? (found[0].attributes as any) : undefined
  }

  it('registers ClassFilters on the Lead tag', () => {
    // 🔴 WITHOUT IT THERE IS NOTHING TO SAVE. `FilterBar` only renders when the
    // viewlet's class resolves a `ClassFilters`, and `FilterSave.svelte` — the
    // affordance that writes a `view.class.FilteredView` — lives INSIDE that
    // bar. No ClassFilters, no filter bar, no Saved View: compile clean,
    // feature absent.
    expect(classFilters()).toBeDefined()
  })

  it('recommends every key a lead is actually triaged by', () => {
    const filters = classFilters()?.filters as string[]
    // `status` / `priority` via their Type classes' `ValueFilter`; `owner` via
    // `contact.mixin.Employee`'s own `AttributeFilter`; `account` / `contact`
    // via the generic `ObjectFilter` that `core.class.RefTo` supplies; the two
    // PersonId audit fields via `core.class.TypePersonId`.
    expect(filters.slice().sort()).toEqual([
      'account',
      'contact',
      'createdBy',
      'modifiedBy',
      'owner',
      'pipeline',
      'priority',
      'source',
      'status'
    ])
  })

  it('offers no filter key whose presenter would THROW', () => {
    // 🔴 A `RefTo` key is NOT dropped when its target class lacks
    // `view.mixin.AttributeFilter`: `buildFilterKey` falls back to
    // `attribute.type._class`, and `core.class.RefTo` carries
    // `AttributeFilter -> ObjectFilter` (`models/view/src/index.ts:1113`). So
    // the only thing that keeps a bad key out is the presenter lookup, which
    // THROWS rather than degrading to a blank chip.
    //
    // No `Space` class registers an `ObjectPresenter`, so `space` stays out.
    const filters = classFilters()?.filters as string[]
    expect(filters).not.toContain('space')
  })

  it('backs every self-owned RefTo filter key with an ObjectPresenter', () => {
    // 🔴 THE INVARIANT, NOT THE LIST. `pipeline` and `source` point at classes
    // this module owns, so nothing upstream will ever supply their presenter.
    // Deleting `defineConfigPresenters` while leaving the keys in place would
    // compile, pass every other test, and crash the filter bar the moment a
    // user opened the "add filter" popup — this is the test that catches it.
    const presented = new Set(
      txes
        .filter(
          (tx) => tx._class === core.class.TxMixin && (tx as TxMixin<Doc, Doc>).mixin === view.mixin.ObjectPresenter
        )
        .map((tx) => (tx as TxMixin<Doc, Doc>).objectId as string)
    )
    expect(presented).toContain(crmLite.class.CrmPipeline)
    expect(presented).toContain(crmLite.class.LeadSource)

    const filters = classFilters()?.filters as string[]
    for (const key of ['pipeline', 'source']) {
      expect(filters).toContain(key)
    }
  })

  it('keeps `account` / `contact`, which the RefTo fallback does resolve', () => {
    // ⚠️ AN EARLIER VERSION OF THIS FILE ASSERTED THE OPPOSITE, on the theory
    // that `buildRefFilterKey` returning undefined means `FilterTypePopup`
    // drops the key. It does not: `buildFilterKey` retries against
    // `attribute.type._class` and `core.class.RefTo` supplies
    // `AttributeFilter -> ObjectFilter`
    // (`plugins/view-resources/src/filter.ts:243-265`,
    // `models/view/src/index.ts:1113`). `Organization` / `Person` having only
    // `AttributeFilterPresenter` costs them the bespoke filter component, not
    // the filter itself. Dropping these two removed working, and for a CRM
    // fairly essential, filters.
    const filters = classFilters()?.filters as string[]
    expect(filters).toContain('account')
    expect(filters).toContain('contact')
  })

  it("re-declares card's own ignoreKeys, because a nearer mixin REPLACES it", () => {
    // `classHierarchyMixin` walks up and stops at the FIRST hit — it does not
    // merge. Anything `card.class.Card`'s ClassFilters excluded has to be
    // excluded again here or it silently comes back.
    expect(classFilters()?.ignoreKeys).toContain('parent')
  })
})

describe('crm-lite model: Saved Views hang off the UPSTREAM Cards application', () => {
  it('declares exactly one Application, and it is the HIDDEN intake app', () => {
    // 🔴 THE PREMISE THAT HAD TO BE CHECKED RATHER THAN ASSUMED. Leads are a
    // MasterTag inside upstream Cards, and the Saved View section groups under
    // THAT application's alias — so the app asserted here must NOT become a
    // second home for leads. It is a hidden, single-purpose address for the
    // public intake form and nothing else.
    //
    // ⚠️ Grepping for `workbench.class.Application` gives a FALSE POSITIVE on
    // `workbench:class:ApplicationNavModel`, which is a superstring. Both are
    // asserted separately.
    const apps = creates<any>(txes, 'workbench:class:Application' as Ref<Class<Doc>>)
    expect(apps).toHaveLength(1)
    expect(apps[0].objectId).toBe(crmLite.app.LeadIntake)
    expect(apps[0].attributes.alias).toBe(LEAD_INTAKE_ALIAS)

    // 🔴 `hidden: true` is what keeps it out of every employee's left rail
    // (`Workbench.svelte:163` builds the rail from `{ hidden: false }`) while
    // leaving it routable (`Workbench.svelte:490` resolves by `alias` only).
    // Flipping this to `false` silently adds a CRM icon to everyone's sidebar.
    expect(apps[0].attributes.hidden).toBe(true)

    // 🔴 NO `accessLevel`, ANYWHERE. `isAllowedToRole`
    // (`workbench-resources/src/utils.ts:145`) and `getSpecialComponent`
    // (`Workbench.svelte:641`) read `undefined` as 'every role'; any value here
    // — `AccountRole.User` above all — locks out precisely the guest sessions
    // that `server-plugins/crm-lite/src/intake.ts` identifies submissions by.
    expect(apps[0].attributes.accessLevel).toBeUndefined()

    const specials = apps[0].attributes.navigatorModel.specials
    expect(specials).toHaveLength(1)
    expect(specials[0].id).toBe(LEAD_INTAKE_SPECIAL)
    expect(specials[0].accessLevel).toBeUndefined()
    expect(specials[0].component).toBe(crmLite.component.LeadIntakeForm)
  })

  it('registers NO ApplicationNavModel — one would break the Cards navigator', () => {
    // 🔴 THIS ZERO IS A BUG AVOIDED, NOT AN ABSENCE. `buildNavModel`
    // (`workbench-resources/src/utils.ts:179-206`) merges an ApplicationNavModel
    // by REBUILDING the model as `{ spaces, specials }` — it never copies
    // `groups` or `hideStarred`. The Cards application's navigator IS its
    // `groups: [{ id: 'types', component: TypesNavigator }]`
    // (`models/card/src/index.ts:671-687`), so ANY nav model extending
    // `card.app.Card` deletes the master-tag navigator for the whole workspace.
    // That is why intake got its own hidden Application instead.
    expect(creates<Doc>(txes, 'workbench:class:ApplicationNavModel' as Ref<Class<Doc>>)).toHaveLength(0)
  })

  it('and the Cards application carries a non-empty alias', () => {
    // 🔴 BUILT FROM THE REAL UPSTREAM MODEL rather than asserted as a constant.
    // `Navigator.svelte:175` renders `<SavedView alias={currentApplication?.alias} />`
    // and `SavedView.svelte` queries `FilteredView` by `attachedTo: alias`, so
    // this value IS the mounting point for every Lead Saved View.
    //
    // ⚠️ `createCoreModel` first: card's model resolves ancestors through the
    // Builder's hierarchy, and a Builder that has never seen `core:class:Doc`
    // throws "ancestors not found" in a way that reads like a broken card model.
    const builder = new Builder()
    createCoreModel(builder)
    createCardModel(builder)

    const apps = creates<any>(builder.getTxes(), 'workbench:class:Application' as Ref<Class<Doc>>).filter(
      (it) => it.objectId === cardModel.app.Card
    )
    expect(apps).toHaveLength(1)

    const alias = apps[0].attributes.alias
    expect(typeof alias).toBe('string')
    // 🔴 NON-EMPTY, not merely defined. `SavedView.svelte` skips its query only
    // for `undefined`; an EMPTY STRING sails past that guard and queries
    // `{ attachedTo: '' }`, matching nothing and rendering no section — the same
    // silent disappearance by a different route.
    expect(alias.length).toBeGreaterThan(0)
  })

  it('would fail the day this module DOES declare an Application without an alias', () => {
    // A regression guard, empty today by construction. See the note above about
    // why an Application here would be the wrong shape in the first place.
    for (const app of creates<any>(txes, 'workbench:class:Application' as Ref<Class<Doc>>)) {
      expect(typeof app.attributes.alias).toBe('string')
      expect(String(app.attributes.alias).length).toBeGreaterThan(0)
    }
  })
})
