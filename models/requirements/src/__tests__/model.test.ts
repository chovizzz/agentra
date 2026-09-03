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
import activity from '@hcengineering/model-activity'
import view from '@hcengineering/model-view'
import type { IntlString } from '@hcengineering/platform'
import products from '@hcengineering/products'
import requirementsPlugin, {
  canTransitionRequirement,
  isTerminalRequirementStatus,
  requirementsId,
  requirementStatusOrder,
  type RequirementStatus
} from '@hcengineering/requirements'
import { type Viewlet } from '@hcengineering/view'

import { createModel } from '..'
import { ensureRequirementsSpace, requirementsOperation, seedRequirementsSpaceOwners } from '../migration'
import requirements from '../plugin'

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

function requirementAttributes (txes: Tx[]): Array<TxCreateDoc<AnyAttribute>> {
  return creates<AnyAttribute>(txes, core.class.Attribute).filter(
    (tx) => (tx.attributes as any).attributeOf === requirements.masterTag.Requirement
  )
}

let txes: Tx[]
beforeAll(() => {
  txes = build()
})

describe('requirements model: Requirement is a MasterTag', () => {
  it('builds without throwing and emits transactions', () => {
    expect(txes.length).toBeGreaterThan(0)
  })

  it('creates Requirement as a MasterTag extending card.class.Card', () => {
    const tags = creates(txes, card.class.MasterTag).filter((tx) => tx.objectId === requirements.masterTag.Requirement)
    expect(tags).toHaveLength(1)
    // 🔴 A Tag would be a Mixin<Card> and could never be a document's `_class`,
    // nor take part in card versioning (`classHierarchyMixin` walks `extends`
    // only). Regressing this back to a Tag must fail the suite.
    expect((tags[0].attributes as any).extends).toBe(card.class.Card)
    expect(tags[0].objectId.startsWith(`${requirementsId}:`)).toBe(true)
  })

  it('declares every business field as an attribute of the Requirement tag', () => {
    const names = requirementAttributes(txes)
      .map((tx) => (tx.attributes as any).name as string)
      .sort()
    expect(names).toEqual(['acceptanceCriteria', 'owner', 'priority', 'product', 'status', 'targetVersion'].sort())
  })

  it('never marks a business field `isCustom`', () => {
    // `isCustom: true` would let a user delete the field from the settings page
    // and makes the server skip index generation for it.
    for (const attr of requirementAttributes(txes)) {
      expect((attr.attributes as any).isCustom).toBeUndefined()
    }
  })

  it('types status and priority with the plugin Type subclasses', () => {
    const byName = new Map(
      requirementAttributes(txes).map((tx) => [(tx.attributes as any).name as string, tx.attributes as any])
    )
    expect(byName.get('status')?.type._class).toBe(requirements.class.TypeRequirementStatus)
    expect(byName.get('status')?.defaultValue).toBe('Draft')
    expect(byName.get('priority')?.type._class).toBe(requirements.class.TypeRequirementPriority)
    // Deterministic attribute ids, same convention as the `@Prop` decorator.
    const status = requirementAttributes(txes).find((tx) => (tx.attributes as any).name === 'status')
    expect(status?.objectId).toBe(`${requirements.masterTag.Requirement}_status`)
  })

  it('models product and targetVersion as plain TypeRef attributes, not relations', () => {
    // 🔴 This is what makes REQ-006 ("group by product version") possible:
    // `viewOptions.groupBy` takes attribute keys, and a relation has none.
    const byName = new Map(
      requirementAttributes(txes).map((tx) => [(tx.attributes as any).name as string, tx.attributes as any])
    )
    expect(byName.get('product')?.type._class).toBe(core.class.RefTo)
    expect(byName.get('product')?.type.to).toBe(products.class.Product)
    expect(byName.get('targetVersion')?.type._class).toBe(core.class.RefTo)
    expect(byName.get('targetVersion')?.type.to).toBe(products.class.ProductVersion)
  })

  it('references contact.mixin.Employee for the owner instead of a new table', () => {
    const byName = new Map(
      requirementAttributes(txes).map((tx) => [(tx.attributes as any).name as string, tx.attributes as any])
    )
    expect(byName.get('owner')?.type.to).toBe('contact:mixin:Employee')
  })

  it('hangs activity.mixin.ActivityDoc on the tag so field level history is recorded', () => {
    // Technical Spec §3.3.2 item 2: change history for V1 is the field level
    // Activity stream and nothing more.
    expect(mixins(txes, requirements.masterTag.Requirement, activity.mixin.ActivityDoc)).toHaveLength(1)
  })
})

describe('requirements model: view registration', () => {
  const ours = (): Array<TxCreateDoc<Viewlet>> =>
    creates<Viewlet>(txes, view.class.Viewlet).filter(
      (tx) =>
        tx.objectId === requirements.viewlet.TableRequirement || tx.objectId === requirements.viewlet.ListRequirement
    )

  it('registers a Table and a List viewlet on the Requirement tag', () => {
    const found = ours()
    expect(found).toHaveLength(2)
    for (const tx of found) {
      // SpecialView refuses to render when `viewlet.attachTo !== _class`, and
      // card's Main.svelte passes the MasterTag id as `_class`.
      expect((tx.attributes as any).attachTo).toBe(requirements.masterTag.Requirement)
      // Cards are versioned: without this every historical version is a row.
      expect((tx.attributes as any).baseQuery.isLatest).toBe(true)
    }
    const descriptors = new Set(found.map((tx) => (tx.attributes as any).descriptor))
    expect(descriptors).toEqual(new Set([view.viewlet.List, view.viewlet.Table]))
  })

  it('registers the Roadmap viewlet under its OWN descriptor', () => {
    // 🔴 Its own descriptor because there is nothing to reuse: `models/view`
    // ships Table / RelationshipTable / List / MasterDetail / Tree / Document
    // and `models/task` adds Kanban. No roadmap, timeline or dashboard
    // descriptor exists anywhere upstream.
    const descriptors = creates<any>(txes, view.class.ViewletDescriptor).filter(
      (tx) => tx.objectId === requirements.viewletDescriptor.Roadmap
    )
    expect(descriptors).toHaveLength(1)
    expect(String(descriptors[0].objectId)).toBe('requirements:viewletDescriptor:Roadmap')
    expect((descriptors[0].attributes as any).component).toBe(requirements.component.RequirementRoadmap)
    expect(requirements.component.RequirementRoadmap).toBe('requirements:component:RequirementRoadmap')

    const roadmap = creates<Viewlet>(txes, view.class.Viewlet).filter(
      (tx) => tx.objectId === requirements.viewlet.RoadmapRequirement
    )
    expect(roadmap).toHaveLength(1)
    const attrs = roadmap[0].attributes as any
    expect(attrs.attachTo).toBe(requirements.masterTag.Requirement)
    expect(attrs.descriptor).toBe(requirements.viewletDescriptor.Roadmap)
    expect(attrs.baseQuery.isLatest).toBe(true)
    // 🔴 LOAD BEARING. `RequirementRoadmap` reads the product version out of
    // `$lookup.targetVersion` and never names `products.class.ProductVersion`,
    // which is what keeps `@hcengineering/products` out of the resources
    // package. Without the lookup every requirement lands in "unscheduled".
    expect(attrs.options.lookup.targetVersion).toBeDefined()
  })

  it('registers no Kanban viewlet (out of scope for this task)', () => {
    for (const tx of creates<Viewlet>(txes, view.class.Viewlet)) {
      expect(String((tx.attributes as any).descriptor)).not.toContain('Kanban')
    }
  })

  it('offers product and targetVersion as groupBy options (PRD REQ-006)', () => {
    for (const tx of ours()) {
      const groupBy = (tx.attributes as any).viewOptions.groupBy as string[]
      expect(groupBy).toContain('product')
      expect(groupBy).toContain('targetVersion')
      expect(groupBy[0]).toBe('status')
    }
  })

  it('only ever groups by keys that are declared attributes', () => {
    // A groupBy key with no attribute behind it is resolved through
    // `hierarchy.getAttribute` and blows up at render time.
    const declared = new Set(requirementAttributes(txes).map((tx) => (tx.attributes as any).name as string))
    for (const tx of ours()) {
      for (const key of (tx.attributes as any).viewOptions.groupBy as string[]) {
        expect(declared.has(key)).toBe(true)
      }
    }
  })

  it('hangs SortFuncs, AllValuesFunc and AttributePresenter on the status and priority TYPE classes', () => {
    // Grouping resolves the attribute's `attrClass`, so all three must sit on
    // the Type subclass, not on the Requirement tag.
    for (const cls of [requirements.class.TypeRequirementStatus, requirements.class.TypeRequirementPriority]) {
      expect(mixins(txes, cls, view.mixin.SortFuncs)).toHaveLength(1)
      expect(mixins(txes, cls, view.mixin.AllValuesFunc)).toHaveLength(1)
      // `getAttributePresenter` THROWS when this one is missing, which would
      // take the whole column / group header down rather than degrade.
      expect(mixins(txes, cls, view.mixin.AttributePresenter)).toHaveLength(1)
    }
  })

  it('registers AttributeFilter on both TYPE classes so the fields filter by value', () => {
    // `buildFilterKey` (plugins/view-resources/src/filter.ts) returns undefined
    // without this mixin, and `FilterSection` then silently degrades to a bare
    // count — no error, just a field nobody can filter on.
    for (const cls of [requirements.class.TypeRequirementStatus, requirements.class.TypeRequirementPriority]) {
      const filterMixins = mixins(txes, cls, view.mixin.AttributeFilter)
      expect(filterMixins).toHaveLength(1)
      expect((filterMixins[0] as any).attributes.component).toBe(view.component.ValueFilter)
    }
  })
})

describe('requirements state machine', () => {
  it('walks Draft -> Reviewing -> Approved -> InDelivery -> Validating -> Released', () => {
    const happy: RequirementStatus[] = ['Draft', 'Reviewing', 'Approved', 'InDelivery', 'Validating', 'Released']
    for (let i = 0; i + 1 < happy.length; i++) {
      expect(canTransitionRequirement(happy[i], happy[i + 1])).toBe(true)
    }
    expect(canTransitionRequirement('Draft', 'Released')).toBe(false)
    expect(canTransitionRequirement('Approved', 'Validating')).toBe(false)
  })

  it('allows Rejected out of review and Cancelled out of anything unreleased', () => {
    expect(canTransitionRequirement('Reviewing', 'Rejected')).toBe(true)
    expect(canTransitionRequirement('Rejected', 'Draft')).toBe(true)
    for (const from of ['Draft', 'Reviewing', 'Approved', 'InDelivery', 'Validating'] as RequirementStatus[]) {
      expect(canTransitionRequirement(from, 'Cancelled')).toBe(true)
    }
    expect(canTransitionRequirement('Released', 'Cancelled')).toBe(false)
  })

  it('treats Released and Cancelled as terminal', () => {
    expect(isTerminalRequirementStatus('Released')).toBe(true)
    expect(isTerminalRequirementStatus('Cancelled')).toBe(true)
    expect(isTerminalRequirementStatus('Draft')).toBe(false)
  })

  it('keeps the enum append-only and PascalCase (Technical Spec §3.9)', () => {
    // `In Delivery` is the display text; `InDelivery` is what is persisted.
    expect(requirementStatusOrder).toEqual([
      'Draft',
      'Reviewing',
      'Approved',
      'InDelivery',
      'Validating',
      'Released',
      'Rejected',
      'Cancelled'
    ])
  })
})

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

describe('requirements migration: Requirements CardSpace', () => {
  it('creates a dedicated CardSpace that lists the Requirement tag in `types`', async () => {
    const { client, spaces } = makeUpgradeClient()
    await ensureRequirementsSpace(client)

    const space = spaces.get(requirements.space.Requirements) as CardSpace
    expect(space).toBeDefined()
    expect(space._class).toBe(card.class.CardSpace)
    // 🔴 Nothing adds a new MasterTag to an existing space's `types`; each
    // module writes its own tag in.
    expect(space.types).toContain(requirements.masterTag.Requirement)
    // Reuses the single upstream SpaceType — a private one would be rewritten
    // back by card's `migrateRolesToBaseRole`.
    expect(space.type).toBe(card.spaceType.SpaceType)
    // Never `card.space.Default`, which is autoJoin: true. Visibility is gated
    // by membership, so the space starts empty (mirrors crm-lite exactly).
    expect(space._id).not.toBe(card.space.Default)
    expect((space as any).autoJoin).toBe(false)
    expect(space.members).toEqual([])
  })

  it('is a second space, distinct from the CRM one', () => {
    expect(requirements.space.Requirements.startsWith(`${requirementsId}:space:`)).toBe(true)
  })

  it('is idempotent and tops `types` up when the tag is missing', async () => {
    const { client, spaces } = makeUpgradeClient()
    await ensureRequirementsSpace(client)
    await ensureRequirementsSpace(client)
    await ensureRequirementsSpace(client)
    expect(spaces.size).toBe(1)

    const space = spaces.get(requirements.space.Requirements) as CardSpace
    spaces.set(requirements.space.Requirements, { ...space, types: [] })
    await ensureRequirementsSpace(client)
    expect((spaces.get(requirements.space.Requirements) as CardSpace).types).toContain(
      requirements.masterTag.Requirement
    )
  })

  it('does not duplicate when the tryUpgrade state table is lost', async () => {
    const { client, spaces } = makeUpgradeClient()
    const factory = async (): Promise<any> => client
    // `tryUpgrade` records its own MigrationState row through the same client;
    // that is bookkeeping, not a duplicated business document, so count only
    // the CardSpaces.
    const cardSpaces = (): any[] => [...spaces.values()].filter((it) => it._class === card.class.CardSpace)

    await requirementsOperation.upgrade(new Map<string, Set<string>>(), factory, 'upgrade')
    expect(cardSpaces()).toHaveLength(1)

    // Restored backup / MigrateMode switch: `tryUpgrade`'s state table is a
    // performance guard, not a correctness guard, so the migration itself has
    // to be idempotent.
    await requirementsOperation.upgrade(new Map<string, Set<string>>(), factory, 'upgrade')
    expect(cardSpaces()).toHaveLength(1)
    expect((spaces.get(requirements.space.Requirements) as CardSpace).types).toEqual([
      requirements.masterTag.Requirement
    ])
  })
})

describe('requirements plugin descriptor', () => {
  it('namespaces every id under the plugin id', () => {
    expect(requirementsPlugin.masterTag.Requirement.startsWith(`${requirementsId}:`)).toBe(true)
    expect(requirementsPlugin.space.Requirements.startsWith(`${requirementsId}:`)).toBe(true)
    expect(requirementsId).toBe('requirements')
  })
})

const OWNER_A = 'owner-a' as AccountUuid
const OWNER_B = 'owner-b' as AccountUuid
const PLAIN_USER = 'plain-user' as AccountUuid

/** Minimal MigrationClient: only what the migration actually touches. */
function makeMigrationClient (opts: { owners?: AccountUuid[], spaces?: any[] } = {}): {
  client: any
  spaces: Map<Ref<Doc>, any>
} {
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
      // Requirements has no domain of its own — a Requirement IS a Card — so
      // the space collection is the only thing the migration may read.
      expect(domain).toBe(DOMAIN_SPACE)
      return [...spaces.values()].filter((doc) => matches(doc, query))
    },
    async update (domain: Domain, query: Record<string, any>, operations: Record<string, any>): Promise<void> {
      expect(domain).toBe(DOMAIN_SPACE)
      for (const doc of [...spaces.values()].filter((it) => matches(it, query))) {
        spaces.set(doc._id, { ...doc, ...operations })
      }
    }
  }
  return { client, spaces }
}

/** The Requirements space as `ensureRequirementsSpace` leaves it, plus members. */
function requirementsSpaceDoc (members: AccountUuid[] = []): any {
  return {
    _id: requirements.space.Requirements,
    _class: card.class.CardSpace,
    space: core.space.Space,
    name: 'Requirements',
    private: false,
    archived: false,
    autoJoin: false,
    members,
    types: [requirements.masterTag.Requirement]
  }
}

describe('requirements migration: seeding the workspace Owner into the Requirements space', () => {
  it('adds every workspace Owner as a member, and nobody else', async () => {
    const { client, spaces } = makeMigrationClient({
      owners: [OWNER_A, OWNER_B],
      spaces: [requirementsSpaceDoc()]
    })
    await seedRequirementsSpaceOwners(client)

    const members: AccountUuid[] = spaces.get(requirements.space.Requirements).members
    expect(new Set(members)).toEqual(new Set([OWNER_A, OWNER_B]))
    // 🔴 The whole point of a separate space is read isolation: a plain USER
    // must NOT be seeded. Admins add the rest by hand in the UI.
    expect(members).not.toContain(PLAIN_USER)
  })

  it('is idempotent — repeated runs add no duplicates', async () => {
    const { client, spaces } = makeMigrationClient({ owners: [OWNER_A], spaces: [requirementsSpaceDoc()] })
    await seedRequirementsSpaceOwners(client)
    await seedRequirementsSpaceOwners(client)
    await seedRequirementsSpaceOwners(client)

    expect(spaces.get(requirements.space.Requirements).members).toEqual([OWNER_A])
  })

  it('appends to manually added members instead of overwriting them', async () => {
    const manual = 'added-by-admin' as AccountUuid
    const { client, spaces } = makeMigrationClient({ owners: [OWNER_A], spaces: [requirementsSpaceDoc([manual])] })
    await seedRequirementsSpaceOwners(client)

    const members: AccountUuid[] = spaces.get(requirements.space.Requirements).members
    // 🔴 Regressing this to a wholesale `members: owners` write would silently
    // revoke access for everyone an administrator had added.
    expect(members).toContain(manual)
    expect(members).toContain(OWNER_A)
    expect(members).toHaveLength(2)
  })

  it('does nothing, and does not call the account service, when the space is absent', async () => {
    const { client } = makeMigrationClient({ owners: [OWNER_A] })
    await seedRequirementsSpaceOwners(client)
    expect(client.accountClient.getWorkspaceMembers).not.toHaveBeenCalled()
  })

  it('never fails the workspace upgrade when the account service is down', async () => {
    const { client, spaces } = makeMigrationClient({ owners: [OWNER_A], spaces: [requirementsSpaceDoc()] })
    client.accountClient.getWorkspaceMembers = jest.fn(async () => {
      throw new Error('account service unavailable')
    })
    await expect(seedRequirementsSpaceOwners(client)).resolves.toBeUndefined()
    expect(client.logger.error).toHaveBeenCalled()
    expect(spaces.get(requirements.space.Requirements).members).toEqual([])
  })

  it('runs from `migrate` on every pass, not once behind the state table', async () => {
    const { client, spaces } = makeMigrationClient({ owners: [OWNER_A], spaces: [requirementsSpaceDoc()] })
    await requirementsOperation.migrate(client, 'upgrade')
    expect(spaces.get(requirements.space.Requirements).members).toEqual([OWNER_A])

    // A second Owner is promoted after the first upgrade; the state table would
    // have made the step a no-op forever, so it is deliberately not used.
    client.accountClient.getWorkspaceMembers = jest.fn(async () => [
      { person: OWNER_A, role: AccountRole.Owner },
      { person: OWNER_B, role: AccountRole.Owner }
    ])
    await requirementsOperation.migrate(client, 'upgrade')
    expect(new Set<AccountUuid>(spaces.get(requirements.space.Requirements).members)).toEqual(
      new Set([OWNER_A, OWNER_B])
    )
  })
})

describe('requirements model: inline status / priority editing', () => {
  it('registers view.mixin.AttributeEditor on both TYPE classes', () => {
    // 🔴 Not cosmetic. `AttributeBarEditor` (packages/presentation) wraps its
    // whole body in `{#if editor}` and resolves that editor through
    // `classHierarchyMixin(attrClass, view.mixin.AttributeEditor)`. Without this
    // mixin the status / priority rows do not render read only — they do not
    // render at all.
    const status = mixins(txes, requirements.class.TypeRequirementStatus, view.mixin.AttributeEditor)
    expect(status).toHaveLength(1)
    expect((status[0].attributes as any).inlineEditor).toBe(requirements.component.RequirementStatusEditor)

    const priority = mixins(txes, requirements.class.TypeRequirementPriority, view.mixin.AttributeEditor)
    expect(priority).toHaveLength(1)
    expect((priority[0].attributes as any).inlineEditor).toBe(requirements.component.RequirementPriorityEditor)
  })

  it('keeps the presenter mixins alongside the editors', () => {
    expect(mixins(txes, requirements.class.TypeRequirementStatus, view.mixin.AttributePresenter)).toHaveLength(1)
    expect(mixins(txes, requirements.class.TypeRequirementPriority, view.mixin.AttributePresenter)).toHaveLength(1)
  })
})

describe('requirements model: traceability section on the Requirement detail page', () => {
  function sections (): Array<TxCreateDoc<CardSection>> {
    return creates<CardSection>(txes, card.class.CardSection).filter(
      (tx) => tx.objectId === requirements.section.RequirementTraceLinks
    )
  }

  function coverage (): Array<TxCreateDoc<CardSection>> {
    return creates<CardSection>(txes, card.class.CardSection).filter(
      (tx) => tx.objectId === requirements.section.RequirementCoverage
    )
  }

  function delivery (): Array<TxCreateDoc<CardSection>> {
    return creates<CardSection>(txes, card.class.CardSection).filter(
      (tx) => tx.objectId === requirements.section.RequirementDelivery
    )
  }

  function timeline (): Array<TxCreateDoc<CardSection>> {
    return creates<CardSection>(txes, card.class.CardSection).filter(
      (tx) => tx.objectId === requirements.section.RequirementTraceTimeline
    )
  }

  function acceptanceCriteria (): Array<TxCreateDoc<CardSection>> {
    return creates<CardSection>(txes, card.class.CardSection).filter(
      (tx) => tx.objectId === requirements.section.RequirementAcceptanceCriteria
    )
  }

  function dashboard (): Array<TxCreateDoc<CardSection>> {
    return creates<CardSection>(txes, card.class.CardSection).filter(
      (tx) => tx.objectId === requirements.section.RequirementDeliveryDashboard
    )
  }

  it('registers exactly six CardSections, each under a fixed id', () => {
    // Fixed ids so a migration can re-point or remove a section, rather than
    // re-creating it under a generated id on every model build.
    const all = creates<CardSection>(txes, card.class.CardSection)
    expect(all).toHaveLength(6)
    expect(sections()).toHaveLength(1)
    expect(coverage()).toHaveLength(1)
    expect(delivery()).toHaveLength(1)
    expect(timeline()).toHaveLength(1)
    expect(dashboard()).toHaveLength(1)
    expect(acceptanceCriteria()).toHaveLength(1)
    // Pinned literals: a renamed id silently orphans the section a migration
    // would target, and the model rebuild would create a second one.
    expect(all.map((tx) => tx.objectId).sort()).toEqual(
      [
        'requirements:section:RequirementTraceLinks',
        'requirements:section:RequirementCoverage',
        'requirements:section:RequirementDelivery',
        'requirements:section:RequirementTraceTimeline',
        'requirements:section:RequirementDeliveryDashboard',
        'requirements:section:RequirementAcceptanceCriteria'
      ].sort()
    )
  })

  it('gives `acceptanceCriteria` its own editable section, scoped to Requirement', () => {
    // 🔴 THE ONLY EDIT SURFACE FOR THE FIELD. `acceptanceCriteria` is a
    // `TypeCollaborativeDoc`, and `models/view` registers no
    // `view.mixin.AttributeEditor` for that type, so `AttributeBarEditor`
    // resolves no editor and the card properties panel renders no row at all.
    const attrs = acceptanceCriteria()[0].attributes as any
    expect(attrs.component).toBe(requirements.component.RequirementAcceptanceCriteriaSection)
    expect(attrs.label).toBe(requirements.string.AcceptanceCriteria)
    // 🔴 A CardSection has no `attachTo`; without this the editor lands on every
    // card of every type in the workspace.
    expect(attrs.checkVisibility).toBe(requirements.function.CheckRequirementTraceLinksVisibility)
    // Body text, so it sits with the description rather than with the
    // traceability roll-ups.
    expect(attrs.order).toBeLessThan((dashboard()[0].attributes as any).order)
  })

  it('scopes the two Task 20 sections and orders them around the edge list', () => {
    const timelineAttrs = timeline()[0].attributes as any
    const dashboardAttrs = dashboard()[0].attributes as any

    expect(timelineAttrs.component).toBe(requirements.component.RequirementTraceTimelineSection)
    expect(dashboardAttrs.component).toBe(requirements.component.RequirementDeliveryDashboardSection)
    expect(timelineAttrs.label).toBe(requirements.string.TraceTimeline)
    expect(dashboardAttrs.label).toBe(requirements.string.DeliveryDashboard)
    // 🔴 A CardSection has no `attachTo`; without this callback both blocks land
    // on every card of every type in the workspace.
    expect(timelineAttrs.checkVisibility).toBe(requirements.function.CheckRequirementTraceLinksVisibility)
    expect(dashboardAttrs.checkVisibility).toBe(requirements.function.CheckRequirementTraceLinksVisibility)

    // Roll-up first, then the verdict, then the raw edges, then the history.
    expect(dashboardAttrs.order).toBeLessThan((coverage()[0].attributes as any).order)
    expect(timelineAttrs.order).toBeGreaterThan((sections()[0].attributes as any).order)
  })

  it('pins the two Task 20 component ids as literals', () => {
    // The bodies live in `traceability-resources` and are published under these
    // Requirement ids by `requirements-resources`; a rename on either side is a
    // blank section at runtime, not a build error.
    expect(requirements.component.RequirementTraceTimelineSection).toBe(
      'requirements:component:RequirementTraceTimelineSection'
    )
    expect(requirements.component.RequirementDeliveryDashboardSection).toBe(
      'requirements:component:RequirementDeliveryDashboardSection'
    )
  })

  it('registers the delivery section as implements entry point 1', () => {
    const attrs = delivery()[0].attributes as any
    expect(attrs.component).toBe(requirements.component.RequirementDeliverySection)
    expect(attrs.label).toBe(requirements.string.Delivery)
    // 🔴 A CardSection has no `attachTo`; losing this callback puts the block on
    // every card of every type in the workspace.
    expect(attrs.checkVisibility).toBe(requirements.function.CheckRequirementTraceLinksVisibility)
    // Coverage (is it tested) reads before delivery (who is building it), and
    // both read before the unfiltered edge list.
    expect(attrs.order).toBeGreaterThan((coverage()[0].attributes as any).order)
    expect(attrs.order).toBeLessThan((sections()[0].attributes as any).order)
  })

  it('scopes the coverage section too, and puts it above the raw edge list', () => {
    const attrs = coverage()[0].attributes as any
    expect(attrs.component).toBe(requirements.component.RequirementCoverageSection)
    expect(attrs.label).toBe(requirements.string.Coverage)
    // 🔴 A CardSection has no `attachTo`; losing this callback puts the block on
    // every card of every type in the workspace.
    expect(attrs.checkVisibility).toBe(requirements.function.CheckRequirementTraceLinksVisibility)
    // The verdict reads before the evidence.
    expect(attrs.order).toBeLessThan((sections()[0].attributes as any).order)
  })

  it('points the section at the Requirement wrapper component, not at the raw block', () => {
    // ⚠️ `EditCardTableOfContents.svelte` passes the card as `doc`, while
    // `traceability:component:TraceLinksSection` declares `object`. Pointing
    // this straight at the traceability component would leave `object`
    // undefined and throw on first render, so the wrapper is the contract.
    const attrs = sections()[0].attributes as any
    expect(attrs.component).toBe(requirements.component.RequirementTraceLinksSection)
    expect(attrs.label).toBe(requirements.string.Traceability)
  })

  it('scopes the section to Requirements via checkVisibility', () => {
    // 🔴 `card.class.CardSection` has no `attachTo`: `getCardSections`
    // (plugins/card-resources/src/card.ts) reads EVERY section document and
    // filters only on this callback. Losing it puts the traceability block on
    // every card of every type in the workspace.
    const attrs = sections()[0].attributes as any
    expect(attrs.checkVisibility).toBe(requirements.function.CheckRequirementTraceLinksVisibility)
  })

  it('orders the section after Relations and before the message stream', () => {
    const attrs = sections()[0].attributes as any
    expect(attrs.order).toBeGreaterThan(500)
    expect(attrs.order).toBeLessThan(1000)
  })
})

describe('requirements: the filter surface a Saved View is built from', () => {
  function classFilters (): Record<string, any> | undefined {
    const found = mixins(txes, requirements.masterTag.Requirement, view.mixin.ClassFilters)
    return found.length === 1 ? (found[0].attributes as any) : undefined
  }

  it('registers ClassFilters on the Requirement tag', () => {
    // 🔴 No ClassFilters -> no FilterBar -> no FilterSave -> no Saved View.
    // Compiles clean, feature simply absent.
    expect(classFilters()).toBeDefined()
  })

  it('lists exactly the keys whose presenter resolves', () => {
    // 🔴 A `RefTo` key is NOT dropped for want of an `AttributeFilter` on the
    // target class — `buildFilterKey` falls back to `core.class.RefTo`, which
    // supplies the generic `ObjectFilter` (`models/view/src/index.ts:1113`).
    // What that fallback needs is an `ObjectPresenter`, and `getPresenter`
    // THROWS without one. `Employee`, `Product` and `ProductVersion` all have
    // one; no `Space` class does.
    expect((classFilters()?.filters as string[]).slice().sort()).toEqual([
      'createdBy',
      'modifiedBy',
      'owner',
      'priority',
      'product',
      'status',
      'targetVersion'
    ])
  })

  it('offers no key whose presenter would THROW', () => {
    expect(classFilters()?.filters as string[]).not.toContain('space')
  })

  it("re-declares card's ignoreKeys, because a nearer mixin REPLACES it", () => {
    // `classHierarchyMixin` stops at the first hit; it does not merge. Anything
    // card's own ClassFilters excluded has to be excluded again here.
    expect(classFilters()?.ignoreKeys).toContain('parent')
  })

  it('is NOT strict, so a deployment Tag stays filterable', () => {
    expect(classFilters()?.strict).not.toBe(true)
  })

  it('declares no Application of its own — Requirement is a MasterTag in Cards', () => {
    // 🔴 Saved Views group by `currentApplication.alias`
    // (`plugins/workbench-resources/src/components/Navigator.svelte`). This
    // module owns no Application, so its saved views hang off the upstream
    // Cards app, whose alias already exists. Declaring one here would add a
    // duplicate navigation entry.
    //
    // ⚠️ Grepping for `workbench.class.Application` FALSE-POSITIVES on
    // `workbench:class:ApplicationNavModel`, a superstring — both are asserted.
    expect(creates<Doc>(txes, 'workbench:class:Application' as Ref<Class<Doc>>)).toHaveLength(0)
    expect(creates<Doc>(txes, 'workbench:class:ApplicationNavModel' as Ref<Class<Doc>>)).toHaveLength(0)
  })

  it('would fail the day this module DOES declare an Application without an alias', () => {
    // Regression guard, vacuous today by construction.
    for (const app of creates<any>(txes, 'workbench:class:Application' as Ref<Class<Doc>>)) {
      // 🔴 NON-EMPTY, not merely defined: `SavedView.svelte` skips its query
      // only for `undefined`; an empty string sails through and queries
      // `{ attachedTo: '' }`, matching nothing and rendering no section.
      expect(String(app.attributes.alias ?? '').length).toBeGreaterThan(0)
    }
  })
})
