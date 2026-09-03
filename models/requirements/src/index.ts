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

import contact from '@hcengineering/contact'
import core, { SortingOrder, type Attribute, type FindOptions, type Ref, type Type } from '@hcengineering/core'
import { TypeCollaborativeDoc, TypeRef, type Builder } from '@hcengineering/model'
import activity from '@hcengineering/model-activity'
import card, { createSystemType } from '@hcengineering/model-card'
import view, { classPresenter } from '@hcengineering/model-view'
import type { IntlString } from '@hcengineering/platform'
import products from '@hcengineering/products'
import { type Requirement } from '@hcengineering/requirements'
import { PaletteColorIndexes } from '@hcengineering/ui/src/colors'
import { type BuildModelKey, type ViewOptionsModel } from '@hcengineering/view'

import requirements from './plugin'
import {
  TTypeRequirementPriority,
  TTypeRequirementStatus,
  TypeRequirementPriority,
  TypeRequirementStatus
} from './types'

export { requirementsId } from '@hcengineering/requirements'
export { ensureRequirementsSpace, requirementsOperation } from './migration'
export { default } from './plugin'
export * from './types'

/**
 * Attribute ids follow the same convention the `@Prop` decorator uses for
 * `@Model` classes (`dsl.ts`: `${classId}_${propertyName}`). Hand written
 * attributes get the same deterministic shape so a model rebuild does not churn
 * ids and so tests can assert on them.
 */
function attributeId (name: string): Ref<Attribute<any>> {
  return `${requirements.masterTag.Requirement}_${name}` as Ref<Attribute<any>>
}

function requirementAttribute (
  builder: Builder,
  name: string,
  label: IntlString,
  type: Type<any>,
  extra: Record<string, any> = {}
): void {
  builder.createDoc(
    core.class.Attribute,
    core.space.Model,
    {
      attributeOf: requirements.masterTag.Requirement,
      name,
      label,
      type,
      ...extra
    },
    attributeId(name)
  )
}

function defineRequirement (builder: Builder): void {
  // Requirement is a MasterTag, produced exactly the way `models/crm-lite`
  // produces `crm-lite:masterTag:Lead` and `models/chat` produces
  // `chat.masterTag.Thread`.
  //
  // 🔴 It is deliberately NOT a `Tag`: `Tag extends MasterTag, Mixin<Card>` is a
  // mixin, so it can never be a document's `_class`, and `classHierarchyMixin`
  // walks only the `extends` chain (never the mixins a doc carries), which means
  // a Tag can never opt into card versioning.
  //
  // 🔴 It is also deliberately NOT a `ControlledDocument` (Technical Spec
  // §3.3.1): `DocumentState` / `ControlledDocumentState` are upstream TypeScript
  // string enums covering document APPROVAL semantics, and `InDelivery` /
  // `Validating` are DELIVERY lifecycle semantics — supporting them would mean
  // patching those enums and conflicting on every upstream sync.
  createSystemType(
    builder,
    requirements.masterTag.Requirement,
    requirements.icon.Requirement,
    requirements.string.Requirement,
    requirements.string.Requirements,
    {
      defaultSection: card.section.Content
    },
    PaletteColorIndexes.Firework
  )

  // Change history is field level Activity only (Technical Spec §3.3.2, item 2):
  // who changed which field when. No cross-version body diff, no full text
  // search over old versions — both were explicitly ruled out for V1.
  //
  // ℹ️ `card.class.Card` already carries this mixin (models/card/src/index.ts),
  // so this is belt and braces; it is declared here so the requirement that the
  // tag be an ActivityDoc is asserted by this module's own test rather than
  // depending on an upstream file staying the way it is.
  builder.mixin(requirements.masterTag.Requirement, core.class.Class, activity.mixin.ActivityDoc, {})

  // The grouping attributes. Their TYPE classes (not this tag) are what carry
  // SortFuncs / AllValuesFunc / AttributePresenter.
  requirementAttribute(builder, 'status', requirements.string.Status, TypeRequirementStatus(), {
    defaultValue: 'Draft'
  })
  requirementAttribute(builder, 'priority', requirements.string.Priority, TypeRequirementPriority(), {
    defaultValue: 'NoPriority'
  })
  // Employees are NOT re-modelled: this is a plain reference into the upstream
  // contact module.
  requirementAttribute(builder, 'owner', requirements.string.Owner, TypeRef(contact.mixin.Employee))

  // 🔴 `product` and `targetVersion` are plain `TypeRef` ATTRIBUTES, not
  // TraceLink edges. `ViewOptionsModel.groupBy` is a list of ATTRIBUTE KEYS
  // resolved through `hierarchy.getAttribute` — a relation has no attribute key
  // and therefore cannot be grouped by. PRD REQ-006 ("group requirements by
  // product version") is only satisfiable this way. Upstream precedent for
  // grouping on a `TypeRef` attribute: `tracker` groups issues by `component` /
  // `milestone` (models/tracker/src/viewlets.ts), and card's own List viewlet
  // groups by `parent`, itself a `TypeRef(card.class.Card)`.
  //
  // ⚠️ Decided: the `delivered-in` TraceLink edge is NOT double written
  // alongside `targetVersion`. The attribute is the single record of the target
  // version; TraceLink stays reserved for the cross-module relations that have
  // no attribute home (`converted-to` / `implements` / `verifies`).
  requirementAttribute(builder, 'product', requirements.string.Product, TypeRef(products.class.Product))
  requirementAttribute(
    builder,
    'targetVersion',
    requirements.string.TargetVersion,
    TypeRef(products.class.ProductVersion)
  )

  requirementAttribute(builder, 'acceptanceCriteria', requirements.string.AcceptanceCriteria, TypeCollaborativeDoc())
}

function defineTypeClasses (builder: Builder): void {
  // `groupByCategory` (plugins/view-resources/src/utils.ts) resolves the
  // attribute's `attrClass` and looks up view mixins on THAT class. Both mixins
  // below are therefore mandatory for usable grouping:
  //   - SortFuncs     -> group order (otherwise groups come out in whatever
  //                      order the data happened to produce)
  //   - AllValuesFunc -> `getGroupByValues`/"show empty groups" can render a
  //                      group for a status nothing is in yet
  builder.mixin(requirements.class.TypeRequirementStatus, core.class.Class, view.mixin.SortFuncs, {
    func: requirements.function.RequirementStatusSort
  })
  builder.mixin(requirements.class.TypeRequirementStatus, core.class.Class, view.mixin.AllValuesFunc, {
    func: requirements.function.GetAllRequirementStatuses
  })
  builder.mixin(requirements.class.TypeRequirementPriority, core.class.Class, view.mixin.SortFuncs, {
    func: requirements.function.RequirementPrioritySort
  })
  builder.mixin(requirements.class.TypeRequirementPriority, core.class.Class, view.mixin.AllValuesFunc, {
    func: requirements.function.GetAllRequirementPriorities
  })

  // Without `AttributeFilter` these two are not filterable BY VALUE at all:
  // `buildFilterKey` (plugins/view-resources/src/filter.ts) returns undefined
  // when the attribute's type class carries no such mixin, so the field never
  // becomes a usable filter key. `view.component.ValueFilter` is the upstream
  // component for a closed vocabulary stored inline (as opposed to
  // `ObjectFilter`, which is for references) — the same choice
  // `models/tracker/src/index.ts` makes for `TypeMilestoneStatus` /
  // `TypeIssuePriority` and `models/controlled-documents/src/index.ts` makes
  // for `TypeDocumentState`.
  //
  // ℹ️ No `AttributeFilterPresenter` on purpose. It only styles the COLLAPSED
  // chip; without it `FilterSection` falls back to a "N states" count label,
  // which is exactly what upstream `TypeMilestoneStatus` does. The value list
  // inside the dropdown is rendered by `ValueFilter` through `getPresenter`,
  // i.e. by the `AttributePresenter` registered below — so filtering is fully
  // functional and correctly labelled without adding a second component.
  builder.mixin(requirements.class.TypeRequirementStatus, core.class.Class, view.mixin.AttributeFilter, {
    component: view.component.ValueFilter
  })
  builder.mixin(requirements.class.TypeRequirementPriority, core.class.Class, view.mixin.AttributeFilter, {
    component: view.component.ValueFilter
  })

  // 🔴 Not optional. `getAttributePresenter` (plugins/view-resources/src/utils.ts)
  // THROWS when no `AttributePresenter` is registered for the attribute's class,
  // so a `status` / `priority` column — and every group header built from one —
  // would blow up rather than degrade. `product` and `targetVersion` need no
  // equivalent here: for a `RefTo` the presenter is looked up on the TARGET
  // class, and both `products.class.Product` (via `core.class.Space`) and
  // `products.class.ProductVersion` (via `documents.class.Project`) already
  // inherit one.
  //
  // 🔴 The fourth argument is `view.mixin.AttributeEditor.inlineEditor`, and it
  // is what makes these two rows EXIST in the properties panel — not merely what
  // makes them writable. `AttributeBarEditor` (packages/presentation) wraps its
  // whole body in `{#if editor}` and resolves that editor through
  // `findAttributeEditorByAttribute` -> `classHierarchyMixin(attrClass,
  // view.mixin.AttributeEditor)`. With `AttributePresenter` alone the lookup
  // returns undefined and `status` / `priority` render as nothing at all.
  //
  // 🔴 The state machine is enforced INSIDE `RequirementStatusEditor`, which is
  // possible only because `AttributeBarEditor` hands the editor the current
  // `value` alongside `onChange`: the component can therefore compare `from` and
  // `to` through `canTransitionRequirement` and decline to call `onChange`.
  // Priority has no state machine and gets a plain dropdown.
  classPresenter(
    builder,
    requirements.class.TypeRequirementStatus,
    requirements.component.RequirementStatusPresenter,
    requirements.component.RequirementStatusEditor
  )
  classPresenter(
    builder,
    requirements.class.TypeRequirementPriority,
    requirements.component.RequirementPriorityPresenter,
    requirements.component.RequirementPriorityEditor
  )
}

/**
 * Hangs the traceability block on the Requirement detail page.
 *
 * 🔴 `card.class.CardSection` is the mechanism, and it is the ONLY one: this
 * fork has no `view.mixin.ObjectEditorSection`, and a Requirement is a
 * `MasterTag` whose panel is `EditCardTableOfContents.svelte` — that component
 * reads `getCardSections(doc)` and renders nothing else.
 *
 * 🔴 A CardSection has NO `attachTo`: `getCardSections` reads every section
 * document in the model and filters only on `checkVisibility`. That callback is
 * therefore the whole of the scoping, which is why it is mandatory here.
 *
 * ⚠️ `component` is a WRAPPER, not `traceability:component:TraceLinksSection`
 * itself. The panel passes the card as `doc`; `TraceLinksSection` declares
 * `object`. See `RequirementTraceLinksSection.svelte` — it bridges that one prop
 * name and forwards nothing else, so the server's per-endpoint filter and the
 * component's "restricted link" degradation are left untouched.
 *
 * The `order` matches the Lead section (550) so the block sits in the same place
 * on both endpoint classes.
 */
/**
 * The filter surface of the Requirement list — and therefore what a Saved View
 * can be built out of.
 *
 * 🔴 WITHOUT THIS MIXIN THERE IS NOTHING TO SAVE. `FilterBar` renders only when
 * the viewlet's class resolves a `ClassFilters`, and `FilterSave.svelte` — the
 * affordance that writes a `view.class.FilteredView` — lives inside that bar.
 *
 * 🔴 WHAT ADMITS A `RefTo` KEY IS AN `ObjectPresenter` ON THE TARGET CLASS, NOT
 * AN `AttributeFilter`. A missing `AttributeFilter` does not drop the key:
 * `buildRefFilterKey` returns undefined, but `buildFilterKey` then retries
 * against `attribute.type._class`, and `core.class.RefTo` carries
 * `AttributeFilter -> ObjectFilter` (`plugins/view-resources/src/filter.ts:243-265`,
 * `models/view/src/index.ts:1113`). The generic `ObjectFilter` resolves an
 * `ObjectPresenter` to draw its rows and `getPresenter` THROWS when there is
 * none — so the presenter is what decides usable-versus-fatal. Each key here
 * was checked against that rule:
 *   - `owner` -> `contact.mixin.Employee`, which additionally has its own
 *     `AttributeFilter` (`models/contact/src/index.ts:759`), so it gets the
 *     Employee-specific filter rather than the generic one.
 *   - `product` / `targetVersion` -> `products.class.Product`
 *     (`models/products/src/index.ts:188`) and `products.class.ProductVersion`
 *     (`:343`), both of which register `ObjectPresenter`.
 *   - `space` is deliberately absent: no `Space` class registers one.
 *
 * ⚠️ NOT `strict: true`. Strict hides every attribute except the listed ones,
 * including any Tag a deployment mixes on. Upstream `card.class.Card` and
 * `tracker.class.Issue` are both non-strict.
 *
 * ⚠️ `ignoreKeys` repeats card's own — a nearer `ClassFilters` REPLACES the
 * inherited one (`classHierarchyMixin` stops at the first hit), it does not
 * merge with it.
 *
 * 🔴 THE PERSISTED FILTER FREEZES ENUM VALUES. `FilteredView.filters` is a JSON
 * STRING holding the literal `status` / `priority` values that were selected,
 * so `RequirementStatus` and `RequirementPriority` are append-only for the
 * lifetime of every saved view: renaming, reordering or removing a member makes
 * existing saved views match ZERO rows, silently and with no error anywhere.
 */
function defineFilters (builder: Builder): void {
  builder.mixin(requirements.masterTag.Requirement, core.class.Class, view.mixin.ClassFilters, {
    filters: ['status', 'priority', 'owner', 'product', 'targetVersion', 'createdBy', 'modifiedBy'],
    ignoreKeys: ['parent']
  })
}

function defineTraceLinksSection (builder: Builder): void {
  builder.createDoc(
    card.class.CardSection,
    core.space.Model,
    {
      label: requirements.string.Traceability,
      component: requirements.component.RequirementTraceLinksSection,
      order: 550,
      navigation: [],
      checkVisibility: requirements.function.CheckRequirementTraceLinksVisibility
    },
    requirements.section.RequirementTraceLinks
  )

  // 🔴 THE ONLY PLACE `acceptanceCriteria` CAN BE FILLED.
  // The attribute is `TypeCollaborativeDoc()` (see `defineRequirement` above),
  // and `models/view/src/index.ts:575-585` gives that type an
  // `InlineAttributEditor` and an `ActivityAttributePresenter` but NO
  // `view.mixin.AttributeEditor`. `AttributeBarEditor`
  // (packages/presentation/src/components/AttributeBarEditor.svelte) resolves
  // its editor via `findAttributeEditorByAttribute`, whose `default:` branch
  // asks for exactly that missing mixin, and renders nothing at all when it
  // comes back undefined — so the card properties panel silently shows no row.
  // `MarkupProperties.svelte` does not cover it either: it filters on
  // `type._class === core.class.TypeMarkup`, and a collaborative doc is not one.
  //
  // ⚠️ NOT the same thing as the `acceptanceCriteria` entry in the two viewlets'
  // `configOptions.hiddenKeys` below. That list is read only by
  // `ViewletSetting.svelte` — the COLUMN CONFIGURATOR of a list/table viewlet —
  // and stays as it is: a datalake blob pointer is not a usable column.
  //
  // Order 250 puts the block immediately after card's own Content section (200)
  // and before Attachments (300): the criteria are part of the requirement's
  // body text, not an appendix to the traceability blocks (535+).
  builder.createDoc(
    card.class.CardSection,
    core.space.Model,
    {
      label: requirements.string.AcceptanceCriteria,
      component: requirements.component.RequirementAcceptanceCriteriaSection,
      order: 250,
      navigation: [],
      // 🔴 Mandatory — a `card.class.CardSection` has NO `attachTo`, so this
      // callback is the whole of the scoping. Shared with the traceability
      // blocks because the predicate is identical: `isDerived(doc._class,
      // requirements.masterTag.Requirement)`.
      checkVisibility: requirements.function.CheckRequirementTraceLinksVisibility
    },
    requirements.section.RequirementAcceptanceCriteria
  )

  // The coverage block sits ABOVE the raw edge list (540 < 550): a reader wants
  // the verdict first and the evidence second.
  builder.createDoc(
    card.class.CardSection,
    core.space.Model,
    {
      label: requirements.string.Coverage,
      component: requirements.component.RequirementCoverageSection,
      order: 540,
      navigation: [],
      // 🔴 Mandatory. A `card.class.CardSection` has NO `attachTo`;
      // `getCardSections` reads every section document in the model and filters
      // on this callback alone, so without it the block appears on every card of
      // every type in the workspace.
      checkVisibility: requirements.function.CheckRequirementTraceLinksVisibility
    },
    requirements.section.RequirementCoverage
  )

  // Delivery sits between the coverage verdict and the raw edge list (545): the
  // reader wants "is it tested" first, "who is building it" second and the
  // unfiltered edges last.
  builder.createDoc(
    card.class.CardSection,
    core.space.Model,
    {
      label: requirements.string.Delivery,
      component: requirements.component.RequirementDeliverySection,
      order: 545,
      navigation: [],
      // 🔴 Mandatory — a `card.class.CardSection` has NO `attachTo`.
      checkVisibility: requirements.function.CheckRequirementTraceLinksVisibility
    },
    requirements.section.RequirementDelivery
  )

  // The delivery dashboard is the roll-up of the same edges the two blocks above
  // read one kind at a time, so it sits just above them (535).
  builder.createDoc(
    card.class.CardSection,
    core.space.Model,
    {
      label: requirements.string.DeliveryDashboard,
      component: requirements.component.RequirementDeliveryDashboardSection,
      order: 535,
      navigation: [],
      // 🔴 Mandatory — a `card.class.CardSection` has NO `attachTo`.
      checkVisibility: requirements.function.CheckRequirementTraceLinksVisibility
    },
    requirements.section.RequirementDeliveryDashboard
  )

  // The timeline is history rather than state, so it comes AFTER the raw edge
  // list (555) — the last thing on the page, like an activity feed.
  builder.createDoc(
    card.class.CardSection,
    core.space.Model,
    {
      label: requirements.string.TraceTimeline,
      component: requirements.component.RequirementTraceTimelineSection,
      order: 555,
      navigation: [],
      // 🔴 Mandatory — a `card.class.CardSection` has NO `attachTo`.
      checkVisibility: requirements.function.CheckRequirementTraceLinksVisibility
    },
    requirements.section.RequirementTraceTimeline
  )
}

/**
 * Shared by both viewlets. `product` / `targetVersion` are in `groupBy` because
 * that is exactly what PRD REQ-006 asks for.
 */
const requirementViewOptions: ViewOptionsModel = {
  groupBy: ['status', 'priority', 'owner', 'product', 'targetVersion'],
  orderBy: [
    ['modifiedOn', SortingOrder.Descending],
    ['createdOn', SortingOrder.Descending],
    ['rank', SortingOrder.Ascending]
  ],
  other: [
    {
      key: 'shouldShowAll',
      type: 'toggle',
      defaultValue: false,
      actionTarget: 'category',
      action: view.function.ShowEmptyGroups,
      label: view.string.ShowEmptyGroups
    }
  ]
}

const lookupRequirementOptions: FindOptions<Requirement> = {
  lookup: {
    owner: contact.mixin.Employee,
    product: products.class.Product,
    targetVersion: products.class.ProductVersion
  }
}

function defineViewlets (builder: Builder): void {
  // ℹ️ `createSystemType` already registered a generic Table / List / CardGrid
  // trio for this tag. The two below are the Requirement-specific ones.
  // They are NOT the initial view: `ViewletSelector` falls back to
  // `viewlets[0]` and card's `Main.svelte` passes no `defaultViewletDescriptor`,
  // so the generic table stays first until the user picks another one (which is
  // then persisted as a ViewletPreference). Changing that would mean patching
  // upstream, so it is left alone.
  //
  // 🔴 No Kanban here on purpose: the P0 board requirement (CRM-003) is on the
  // Lead side, and a Requirement kanban is out of scope for this task.
  const tableConfig: Array<BuildModelKey | string> = [
    { key: '', props: { shrink: true } },
    'status',
    'priority',
    'owner',
    'product',
    'targetVersion',
    'modifiedOn'
  ]

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: requirements.masterTag.Requirement,
      descriptor: view.viewlet.Table,
      viewOptions: requirementViewOptions,
      options: lookupRequirementOptions,
      config: tableConfig,
      configOptions: {
        hiddenKeys: ['content', 'title', 'acceptanceCriteria'],
        sortable: true
      },
      // Cards are versioned; every list must show the latest version only,
      // otherwise every historical version shows up as its own row.
      baseQuery: {
        isLatest: true
      }
    },
    requirements.viewlet.TableRequirement
  )

  const listConfig: Array<BuildModelKey | string> = [
    { key: '' },
    { key: '', displayProps: { grow: true } },
    { key: 'status', displayProps: { key: 'status' } },
    { key: 'priority', displayProps: { key: 'priority', optional: true } },
    { key: 'product', displayProps: { key: 'product', optional: true } },
    { key: 'targetVersion', displayProps: { key: 'targetVersion', optional: true } },
    {
      key: 'modifiedOn',
      displayProps: { fixed: 'right', key: 'modifiedOn', dividerBefore: true }
    },
    {
      key: 'owner',
      props: { kind: 'list', shouldShowName: false, avatarSize: 'x-small' }
    }
  ]

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: requirements.masterTag.Requirement,
      descriptor: view.viewlet.List,
      viewOptions: requirementViewOptions,
      options: lookupRequirementOptions,
      config: listConfig,
      configOptions: {
        hiddenKeys: ['content', 'title', 'acceptanceCriteria']
      },
      baseQuery: {
        isLatest: true
      }
    },
    requirements.viewlet.ListRequirement
  )

  // 🔴 ITS OWN DESCRIPTOR, because there is nothing upstream to reuse.
  // `models/view` ships Table / RelationshipTable / List / MasterDetail / Tree /
  // Document and `models/task` adds Kanban; a roadmap descriptor exists nowhere
  // in the tree. The Table and List viewlets above DO reuse `view.viewlet.*`,
  // which is why only this one needs a new document.
  builder.createDoc(
    view.class.ViewletDescriptor,
    core.space.Model,
    {
      label: requirements.string.Roadmap,
      icon: view.icon.List,
      component: requirements.component.RequirementRoadmap
    },
    requirements.viewletDescriptor.Roadmap
  )

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: requirements.masterTag.Requirement,
      descriptor: requirements.viewletDescriptor.Roadmap,
      viewOptions: requirementViewOptions,
      // 🔴 LOAD BEARING, not copied for symmetry. `RequirementRoadmap` reads the
      // product version out of `$lookup.targetVersion` and never names
      // `products.class.ProductVersion` itself — that is what keeps
      // `@hcengineering/products` out of `requirements-resources`. Drop this and
      // every requirement lands in the "unscheduled" lane.
      options: lookupRequirementOptions,
      // The roadmap lays out whole requirements rather than columns, so there is
      // nothing for the config selector to offer.
      config: [],
      baseQuery: {
        isLatest: true
      }
    },
    requirements.viewlet.RoadmapRequirement
  )
}

export function createModel (builder: Builder): void {
  builder.createModel(TTypeRequirementStatus, TTypeRequirementPriority)

  defineRequirement(builder)
  defineTypeClasses(builder)
  defineViewlets(builder)
  defineFilters(builder)
  defineTraceLinksSection(builder)
}
