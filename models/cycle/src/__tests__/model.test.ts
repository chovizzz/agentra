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
import cyclePlugin, {
  canTransitionCycle,
  cycleId,
  cycleStatusOrder,
  isTerminalCycleStatus,
  type CycleStatus
} from '@hcengineering/cycle'
import { Builder } from '@hcengineering/model'
import activity from '@hcengineering/model-activity'
import view from '@hcengineering/model-view'
import tracker from '@hcengineering/tracker'
import type { IntlString } from '@hcengineering/platform'
import { type Viewlet, type Action } from '@hcengineering/view'

import { createModel } from '..'
import { backfillCycleDefaults, cycleOperation } from '../migration'
import cycle from '../plugin'
import { DOMAIN_CYCLE } from '../types'

function build (): Tx[] {
  const builder = new Builder()
  createModel(builder)
  return builder.getTxes()
}

function creates<T extends Doc> (txes: Tx[], _class: Ref<Class<Doc>>): Array<TxCreateDoc<T>> {
  return txes.filter(
    (tx) => tx._class === core.class.TxCreateDoc && (tx as TxCreateDoc<Doc>).objectClass === _class
  ) as Array<TxCreateDoc<T>>
}

function classTx (txes: Tx[], objectId: Ref<Doc>): TxCreateDoc<Class<Doc>> | undefined {
  return creates<Class<Doc>>(txes, core.class.Class).find((tx) => tx.objectId === objectId)
}

/**
 * ⚠️ A mixin classifier is created as a `core.class.Mixin` document, NOT a
 * `core.class.Class` one (`dsl.ts` maps `ClassifierKind.MIXIN -> core.class.Mixin`).
 * Looking for it among the classes is how you conclude "the mixin was never
 * registered" while staring at a model that registers it.
 */
function mixinClassTx (txes: Tx[], objectId: Ref<Doc>): TxCreateDoc<Mixin<Doc>> | undefined {
  return creates<Mixin<Doc>>(txes, core.class.Mixin).find((tx) => tx.objectId === objectId)
}

function mixins (txes: Tx[], objectId: Ref<Doc>, mixin: Ref<Mixin<Doc>>): Array<TxMixin<Doc, Doc>> {
  return txes.filter(
    (tx) =>
      tx._class === core.class.TxMixin &&
      (tx as TxMixin<Doc, Doc>).objectId === objectId &&
      (tx as TxMixin<Doc, Doc>).mixin === mixin
  ) as Array<TxMixin<Doc, Doc>>
}

function attributesOf (txes: Tx[], classifier: Ref<Class<Doc>> | Ref<Mixin<Doc>>): Array<TxCreateDoc<AnyAttribute>> {
  return creates<AnyAttribute>(txes, core.class.Attribute).filter(
    (tx) => (tx.attributes as any).attributeOf === classifier
  )
}

let txes: Tx[]
beforeAll(() => {
  txes = build()
})

describe('cycle model: the Cycle class', () => {
  it('builds without throwing and emits transactions', () => {
    expect(txes.length).toBeGreaterThan(0)
  })

  it('creates Cycle as a plain Doc class in its own domain', () => {
    const tx = classTx(txes, cycle.class.Cycle)
    expect(tx).toBeDefined()
    expect(tx?.attributes.kind).toBe(ClassifierKind.CLASS)
    // 🔴 A Tracker EXTENSION object, not a Card and not a Task.
    expect(tx?.attributes.extends).toBe(core.class.Doc)
    expect(tx?.attributes.domain).toBe(DOMAIN_CYCLE)
    expect(DOMAIN_CYCLE).toBe('cycle' as Domain)
    expect(String(cycle.class.Cycle).startsWith(`${cycleId}:`)).toBe(true)
  })

  it('declares every field of Technical Spec §3.4, and no hand maintained metric field', () => {
    const attrs = attributesOf(txes, cycle.class.Cycle)
    const names = attrs.map((it) => it.attributes.name)
    for (const expected of ['name', 'goal', 'status', 'startDate', 'endDate', 'capacity', 'sequence']) {
      expect(names).toContain(expected)
    }
    // 🔴 §3.4: velocity / burndown / rollover are COMPUTED from Activity and
    // Issue snapshots. A stored field for any of them would become a second,
    // divergent source of truth.
    for (const forbidden of ['velocity', 'burndown', 'completedPoints', 'rolledOver']) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('routes `status` through the dedicated Type class', () => {
    const status = attributesOf(txes, cycle.class.Cycle).find((it) => it.attributes.name === 'status')
    expect(status?.attributes.type._class).toBe(cycle.class.TypeCycleStatus)
  })

  it('never marks its attributes as custom', () => {
    // `isCustom: true` makes a field user-deletable in settings and makes the
    // server skip index generation for it.
    for (const attr of attributesOf(txes, cycle.class.Cycle)) {
      expect((attr.attributes as any).isCustom).toBeUndefined()
    }
  })

  it('is an ActivityDoc, which is where burndown/velocity history comes from', () => {
    expect(mixins(txes, cycle.class.Cycle, activity.mixin.ActivityDoc)).toHaveLength(1)
  })
})

describe('cycle model: the Issue mixin', () => {
  it('adds `cycle` to the upstream Issue as a MIXIN, not as a patch to tracker', () => {
    const tx = mixinClassTx(txes, cycle.mixin.CycleIssue)
    expect(tx).toBeDefined()
    expect(tx?.attributes.kind).toBe(ClassifierKind.MIXIN)
    expect(tx?.attributes.extends).toBe(tracker.class.Issue)
    // Nothing in this model may create or re-create an upstream tracker class.
    expect(classTx(txes, tracker.class.Issue)).toBeUndefined()
  })

  it('carries exactly one attribute, a Ref to Cycle', () => {
    const attrs = attributesOf(txes, cycle.mixin.CycleIssue)
    expect(attrs.map((it) => it.attributes.name)).toEqual(['cycle'])
    expect(attrs[0].attributes.type._class).toBe(core.class.RefTo)
    expect(attrs[0].attributes.type.to).toBe(cycle.class.Cycle)
    expect(attrs[0].attributes.attributeOf).toBe(cycle.mixin.CycleIssue)
  })

  it('does not collide with an attribute name Issue already owns', () => {
    // `FilterTypePopup.getOwnTypes` only surfaces a mixin attribute when the
    // base class has no attribute of the same name (`!allAttributes.has(k)`),
    // and `makeFilterQuery` would otherwise write the wrong key.
    expect(attributesOf(txes, cycle.mixin.CycleIssue).map((it) => it.attributes.name)).not.toContain('milestone')
  })

  it('registers the target-class mixins the Issue side needs to be consumable', () => {
    // For a `RefTo` attribute, both the presenter and the filter component are
    // resolved on the TARGET class, not on the mixin that owns the attribute.
    expect(mixins(txes, cycle.class.Cycle, view.mixin.AttributePresenter)).toHaveLength(1)
    expect(mixins(txes, cycle.class.Cycle, view.mixin.AttributeFilter)).toHaveLength(1)
    expect(mixins(txes, cycle.class.Cycle, view.mixin.ObjectPresenter)).toHaveLength(1)
  })
})

describe('cycle model: view registration', () => {
  it('registers SortFuncs / AllValuesFunc / AttributeFilter on the status Type class', () => {
    expect(mixins(txes, cycle.class.TypeCycleStatus, view.mixin.SortFuncs)).toHaveLength(1)
    expect(mixins(txes, cycle.class.TypeCycleStatus, view.mixin.AllValuesFunc)).toHaveLength(1)
    expect(mixins(txes, cycle.class.TypeCycleStatus, view.mixin.AttributeFilter)).toHaveLength(1)
  })

  it('registers an AttributePresenter for the status Type class', () => {
    // 🔴 `getAttributePresenter` THROWS without it — a missing presenter is a
    // crash, not a blank cell.
    const presenter = mixins(txes, cycle.class.TypeCycleStatus, view.mixin.AttributePresenter)
    expect(presenter).toHaveLength(1)
    expect((presenter[0].attributes as any).presenter).toBe(cycle.component.CycleStatusPresenter)
  })

  it('registers a table and a list viewlet attached to Cycle', () => {
    const viewlets = creates<Viewlet>(txes, view.class.Viewlet)
    expect(viewlets.map((it) => it.objectId).sort()).toEqual([cycle.viewlet.ListCycle, cycle.viewlet.TableCycle].sort())
    for (const viewlet of viewlets) {
      expect(viewlet.attributes.attachTo).toBe(cycle.class.Cycle)
      expect(viewlet.attributes.viewOptions?.groupBy).toContain('status')
    }
  })

  it('attaches no viewlet to an upstream tracker class', () => {
    for (const viewlet of creates<Viewlet>(txes, view.class.Viewlet)) {
      expect(viewlet.attributes.attachTo).not.toBe(tracker.class.Issue)
    }
  })
})

describe('cycle vocabulary', () => {
  it('keeps the lowercase spelling Technical Spec §3.9 mandates', () => {
    expect(cycleStatusOrder).toEqual(['planned', 'active', 'completed', 'cancelled'])
    expect(Object.keys(cyclePlugin.string)).toContain('StatusPlanned')
  })

  it('models planned -> active -> completed, with cancel available until completion', () => {
    expect(canTransitionCycle('planned', 'active')).toBe(true)
    expect(canTransitionCycle('active', 'completed')).toBe(true)
    expect(canTransitionCycle('planned', 'completed')).toBe(false)
    expect(canTransitionCycle('active', 'cancelled')).toBe(true)
    expect(canTransitionCycle('completed', 'active')).toBe(false)
    expect(isTerminalCycleStatus('completed')).toBe(true)
    expect(isTerminalCycleStatus('cancelled')).toBe(true)
    for (const status of cycleStatusOrder) {
      expect(canTransitionCycle(status, status)).toBe(true)
    }
  })
})

/** Minimal MigrationClient: only what the migration actually touches. */
function makeMigrationClient (rows: Array<Record<string, any>> = []): {
  client: any
  docs: Array<Record<string, any>>
  bookkeeping: Array<Record<string, any>>
  updates: number
} {
  const docs = [...rows]
  // 🔴 `tryMigrate` writes its own `MigrationState` document for every step it
  // completes — into DOMAIN_MIGRATION, never into the module's own table. A
  // mock that ignores the domain argument drops that row into `docs`, where the
  // next `{ status: { $exists: false } }` pass happily "backfills" it. That is a
  // mock bug that looks exactly like a broken migration.
  const bookkeeping: Array<Record<string, any>> = []
  const state = { updates: 0 }
  const matches = (doc: any, query: Record<string, any>): boolean =>
    Object.entries(query).every(([key, value]) => {
      if (value !== null && typeof value === 'object' && '$exists' in value) {
        return (doc[key] !== undefined) === value.$exists
      }
      return doc[key] === value
    })
  const client = {
    migrateState: new Map<string, Set<string>>(),
    logger: { log: jest.fn(), error: jest.fn() },
    async find (domain: Domain, query: Record<string, any>): Promise<Doc[]> {
      expect(domain).toBe(DOMAIN_CYCLE)
      return docs.filter((doc) => matches(doc, query)) as Doc[]
    },
    async create (domain: Domain, doc: Doc | Doc[]): Promise<void> {
      const added = Array.isArray(doc) ? doc : [doc]
      if (domain === DOMAIN_CYCLE) {
        docs.push(...added)
      } else {
        bookkeeping.push(...added)
      }
    },
    async update (domain: Domain, query: Record<string, any>, operations: Record<string, any>): Promise<void> {
      // The module owns exactly one table and must never write outside it.
      expect(domain).toBe(DOMAIN_CYCLE)
      for (const doc of docs.filter((it) => matches(it, query))) {
        state.updates++
        Object.assign(doc, operations)
      }
    }
  }
  return {
    client,
    docs,
    bookkeeping,
    get updates () {
      return state.updates
    }
  }
}

describe('cycle migration', () => {
  const legacyRow = (): Record<string, any> => ({
    _id: 'cycle-1' as Ref<Doc>,
    _class: cycle.class.Cycle,
    space: 'project-1',
    name: 'Sprint 1'
  })

  it('backfills the fields a pre-existing row is missing', async () => {
    const { client, docs } = makeMigrationClient([legacyRow()])
    await backfillCycleDefaults(client)
    expect(docs[0].status).toBe('planned' as CycleStatus)
    expect(docs[0].sequence).toBe(0)
  })

  it('creates no document at all, so repeating it cannot duplicate anything', async () => {
    const { client, docs } = makeMigrationClient([legacyRow()])
    const before = docs.length
    await cycleOperation.migrate(client, 'upgrade')
    await cycleOperation.migrate(client, 'upgrade')
    // The only document `tryMigrate` itself writes is its own MigrationState
    // bookkeeping row, and it lands in DOMAIN_MIGRATION, not here.
    expect(docs.filter((it) => it._class === cycle.class.Cycle)).toHaveLength(before)
    expect(docs).toHaveLength(before)
  })

  it('is idempotent when the tryMigrate state table is lost', async () => {
    const harness = makeMigrationClient([legacyRow()])
    await cycleOperation.migrate(harness.client, 'upgrade')
    const afterFirst = harness.updates

    // Restored backup / MigrateMode switch: the state table is a performance
    // guard, not a correctness guard.
    harness.client.migrateState = new Map<string, Set<string>>()
    await cycleOperation.migrate(harness.client, 'upgrade')
    // Two MigrationState rows, one business row: counting a whole collection
    // for an idempotency assertion is exactly the false red this guards.
    expect(harness.bookkeeping).toHaveLength(2)
    // Second pass matches nothing — every row already has both fields.
    expect(harness.updates).toBe(afterFirst)
    expect(harness.docs.filter((it) => it._class === cycle.class.Cycle)).toHaveLength(1)
  })

  it('only ever touches its own class, never the whole domain', async () => {
    const foreign = { _id: 'other-1' as Ref<Doc>, _class: 'other:class:Thing', space: 'project-1' }
    const { client, docs } = makeMigrationClient([legacyRow(), foreign])
    await backfillCycleDefaults(client)
    expect(docs[1]).toEqual(foreign)
  })

  it('leaves an already-populated row untouched', async () => {
    const populated = { ...legacyRow(), status: 'active' as CycleStatus, sequence: 7 }
    const { client, docs } = makeMigrationClient([populated])
    await backfillCycleDefaults(client)
    expect(docs[0].status).toBe('active')
    expect(docs[0].sequence).toBe(7)
  })

  it('has an upgrade half that creates nothing', async () => {
    const upgradeClient = jest.fn(async () => ({}) as any)
    await cycleOperation.upgrade(new Map<string, Set<string>>(), upgradeClient, 'upgrade')
    // No space, no configuration documents: there is nothing to create, and the
    // upgrade client is never even asked for.
    expect(upgradeClient).not.toHaveBeenCalled()
  })
})

/**
 * Builds a real `Hierarchy` out of this module's transactions plus stubs for the
 * two upstream classifiers it touches, so the claims about what the Tracker
 * views can and cannot do with the mixin are asserted against the platform's own
 * resolution code instead of being asserted in a comment.
 */
function buildHierarchy (): Hierarchy {
  const builder = new Builder()
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
  stub(tracker.class.Issue, core.class.Doc)
  createModel(builder)

  const hierarchy = new Hierarchy()
  for (const tx of builder.getTxes()) {
    hierarchy.tx(tx)
  }
  return hierarchy
}

describe('cycle model: what the Tracker views can actually do with the mixin', () => {
  let hierarchy: Hierarchy
  beforeAll(() => {
    hierarchy = buildHierarchy()
  })

  it('is a mixin descendant of Issue, which is how the filter popup finds it', () => {
    // `FilterTypePopup.getOwnTypes` (plugins/view-resources) iterates
    // `hierarchy.getDescendants(Issue)`, keeps the MIXIN ones, and offers their
    // own attributes as filter keys. `tracker.class.Issue` carries
    // `view.mixin.ClassFilters` WITHOUT `strict`, so that branch is reached.
    const descendants = hierarchy.getDescendants(tracker.class.Issue)
    expect(descendants).toContain(cycle.mixin.CycleIssue)
    expect(hierarchy.isMixin(cycle.mixin.CycleIssue)).toBe(true)
    expect([...hierarchy.getOwnAttributes(cycle.mixin.CycleIssue).keys()]).toEqual(['cycle'])
  })

  it('produces the mixin-prefixed query key filtering relies on', () => {
    // Mirrors `makeFilterQuery` (plugins/view-resources/src/filter/query-builder.ts):
    //   if (hierarchy.isMixin(attr.attributeOf)) key = attr.attributeOf + '.' + key
    const attr = hierarchy.getAttribute(cycle.mixin.CycleIssue, 'cycle')
    expect(hierarchy.isMixin(attr.attributeOf)).toBe(true)
    expect(`${attr.attributeOf as string}.cycle`).toBe(`${cycle.mixin.CycleIssue as string}.cycle`)
  })

  it('cannot be grouped by from an Issue viewlet — documented, not accidental', () => {
    // `groupByCategory` does `hierarchy.getAttribute(_class, key)` with `_class`
    // = the viewlet's `attachTo` (Issue), and `findAttribute` walks ancestors
    // only, never the mixins a class is extended BY. Grouping issues by cycle
    // therefore needs either a real Issue attribute (which would mean patching
    // upstream tracker) or a dedicated grouping component — Task 11 UI work.
    expect(() => hierarchy.getAttribute(tracker.class.Issue, 'cycle')).toThrow()
  })
})

describe('cycle model: the attribute EDITORS, without which the fields do not render', () => {
  it('registers an AttributeEditor for the status Type class', () => {
    // 🔴 NOT COSMETIC. `AttributeBarEditor` (packages/presentation) wraps its
    // ENTIRE body in `{#if editor}`, and `editor` comes from `getAttrEditor`,
    // which reads THIS mixin off the attribute's `attrClass`. Registering only
    // a presenter yields a `status` field that is INVISIBLE in `EditDoc`, not
    // one that is read-only — which is exactly the bug this test exists to
    // prevent from coming back.
    const editors = mixins(txes, cycle.class.TypeCycleStatus, view.mixin.AttributeEditor)
    expect(editors).toHaveLength(1)
    expect((editors[0].attributes as any).inlineEditor).toBe(cycle.component.CycleStatusEditor)
  })

  it('registers an AttributeEditor on the Cycle class, which is where a RefTo editor is looked up', () => {
    // ⚠️ `getAttributePresenterClass` rewrites a `RefTo` attribute's `attrClass`
    // to `type.to`, so the editor for `CycleIssue.cycle` resolves on
    // `cycle.class.Cycle` — the same rule that already forced
    // `AttributePresenter` and `AttributeFilter` onto the target class.
    const editors = mixins(txes, cycle.class.Cycle, view.mixin.AttributeEditor)
    expect(editors).toHaveLength(1)
    expect((editors[0].attributes as any).inlineEditor).toBe(cycle.component.CycleEditor)
    // And NOT on the mixin that owns the attribute, where nothing would find it.
    expect(mixins(txes, cycle.mixin.CycleIssue, view.mixin.AttributeEditor)).toHaveLength(0)
  })
})

describe('cycle model: navigation', () => {
  const navModelClass = 'workbench:class:ApplicationNavModel' as Ref<Class<Doc>>

  function navModels (): Array<TxCreateDoc<Doc>> {
    return creates<Doc>(txes, navModelClass)
  }

  it('extends the UPSTREAM Tracker application instead of declaring one of its own', () => {
    // 🔴 `buildNavModel` (plugins/workbench-resources/src/utils.ts) loads every
    // `ApplicationNavModel` whose `extends` matches the application being
    // opened. That is the whole mechanism, and it is why no upstream file is
    // touched. Precedent: `services/github/model-github`.
    const models = navModels()
    expect(models).toHaveLength(1)
    expect((models[0].attributes as any).extends).toBe('tracker:app:Tracker')
    // Nothing here may create a second Application.
    expect(creates<Doc>(txes, 'workbench:class:Application' as Ref<Class<Doc>>)).toHaveLength(0)
  })

  it('appends its special to the spaces entry Tracker actually declares', () => {
    // 🔴 `buildNavModel` merges a `spaces` entry by MATCHING ON `id` and
    // concatenating the `specials` arrays. `models/tracker/src/index.ts`
    // declares `id: 'projects'`; any other string here would add a SECOND,
    // empty navigator section instead of a "Cycles" item under each project,
    // and nothing would fail — it would just silently not appear.
    const spaces = (navModels()[0].attributes as any).spaces
    expect(spaces).toHaveLength(1)
    expect(spaces[0].id).toBe('projects')
    expect(spaces[0].spaceClass).toBe(tracker.class.Project)

    const specials = spaces[0].specials
    expect(specials).toHaveLength(1)
    expect(specials[0].id).toBe('cycles')
    expect(specials[0].label).toBe(cycle.string.Cycles)
  })

  it("does NOT point straight at the generic SpecialView, which would list every project's cycles", () => {
    // 🔴 `workbench.component.SpecialView` takes a `space` prop and never puts
    // it in the query it runs: the query comes from `baseQuery` + the
    // `BaseQuery` mixin + the viewlet's baseQuery, and `List.svelte` uses it
    // verbatim (`space` only seeds the create affordance). Registering it here
    // directly produces a per-project page that lists EVERY project's cycles —
    // and the rollover-target picker would then offer a foreign cycle.
    // `CyclesView` is the wrapper that supplies `baseQuery: { space }` from the
    // RUNTIME space, which is the only place it can come from.
    const special = (navModels()[0].attributes as any).spaces[0].specials[0]
    expect(special.component).toBe(cycle.component.CyclesView)
    expect(special.component).not.toBe('workbench:component:SpecialView')
    // The wrapper owns `_class` / `createComponent`, so nothing here may
    // override them: `Workbench.svelte` spreads `componentProps` FIRST and then
    // `space`, so a model-side `baseQuery` could never see the open project.
    expect(special.componentProps).toBeUndefined()
  })

  it('targets a class that HAS viewlets, so the page is not blank', () => {
    // The wrapper hands `_class: cycle.class.Cycle` to `SpecialView`, which
    // resolves its viewlets from `attachTo === _class`.
    const attached = creates<Viewlet>(txes, view.class.Viewlet).map((it) => it.attributes.attachTo)
    expect(attached).toContain(cycle.class.Cycle)
  })
})

describe('cycle model: the CompleteCycle action', () => {
  function action (): TxCreateDoc<Action> | undefined {
    return creates<Action>(txes, view.class.Action).find((it) => it.objectId === cycle.action.CompleteCycle)
  }

  it('is the only UI route to `completed`', () => {
    const tx = action()
    expect(tx).toBeDefined()
    expect(tx?.attributes.target).toBe(cycle.class.Cycle)
    expect(tx?.attributes.action).toBe(cycle.actionImpl.CompleteCycle)
    // One cycle at a time: the command is keyed on ONE cycle and each
    // completion carries its own rollover decision.
    expect(tx?.attributes.input).toBe('focus')
  })

  it('is hidden on a cycle that cannot legally be completed', () => {
    // The command refuses those anyway; this keeps the menu from advertising a
    // click that is guaranteed to fail.
    expect(action()?.attributes.visibilityTester).toBe(cycle.function.CanCompleteCycle)
  })
})

describe('cycle model: the LinkRequirements action', () => {
  function action (): TxCreateDoc<Action> | undefined {
    return creates<Action>(txes, view.class.Action).find((it) => it.objectId === cycle.action.LinkRequirements)
  }

  it('hangs off Issue and runs the DEDICATED impl', () => {
    const tx = action()
    expect(tx).toBeDefined()
    expect(tx?.attributes.target).toBe(tracker.class.Issue)
    // 🔴 THE POINT OF THIS ASSERTION IS THE `not`. `view.actionImpl.ShowPopup`
    // would be the obvious registration, and it is the broken one: its
    // `fillProps` special-cases only `_object` / `_objects` and copies every
    // other key verbatim off the document, so `fixed` would arrive as the bare
    // `_id` STRING. The popup's `for…of` then iterates characters. Compiles
    // cleanly, breaks on the first click.
    expect(tx?.attributes.action).toBe(cycle.actionImpl.LinkRequirements)
    expect(tx?.attributes.action).not.toBe(view.actionImpl.ShowPopup)
    // Single target: the popup builds a `fixed × picked` matrix, so a
    // multi-select would link every selected issue to every picked requirement.
    expect(tx?.attributes.input).toBe('focus')
  })

  it('carries a visibilityTester, which is the ONLY read-only gate it has', () => {
    // A right-click in a list never renders `EditIssue`, so that component's
    // `effectiveReadonly` guard does not protect this path. Whatever the tester
    // fails to refuse is offered.
    expect(action()?.attributes.visibilityTester).toBe(cycle.function.CanLinkRequirements)
  })

  it('borrows its label from traceability rather than minting a fourth copy', () => {
    // ⚠️ A literal, because this model has no traceability dependency. The
    // `traceabilityId` strings loader is registered unconditionally in
    // `dev/prod/src/platform.ts`, and the key exists in en/zh/ru.
    expect(action()?.attributes.label).toBe('traceability:string:LinkImplementsToRequirement')
  })
})
