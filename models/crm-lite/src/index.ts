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
import { LEAD_INTAKE_ALIAS, LEAD_INTAKE_SPECIAL, type Lead } from '@hcengineering/crm-lite'
import core, {
  SortingOrder,
  type Attribute,
  type Class,
  type Doc,
  type FindOptions,
  type Ref,
  type Type
} from '@hcengineering/core'
import { TypeRef, TypeString, TypeTimestamp, type Builder } from '@hcengineering/model'
import card, { createSystemType } from '@hcengineering/model-card'
import task from '@hcengineering/model-task'
import view, { classPresenter, createAction } from '@hcengineering/model-view'
import type { IntlString } from '@hcengineering/platform'
import { PaletteColorIndexes } from '@hcengineering/ui/src/colors'
import { type ViewOptionsModel } from '@hcengineering/view'

import crmLite from './plugin'
import {
  TCrmPipeline,
  TLeadSource,
  TTypeLeadPriority,
  TTypeLeadStatus,
  TypeLeadPriority,
  TypeLeadStatus
} from './types'

export { crmLiteId } from '@hcengineering/crm-lite'
export { crmLiteOperation, ensureCrmDefaults, ensureCrmSpace } from './migration'
export { default } from './plugin'
export * from './types'

/**
 * Attribute ids follow the same convention the `@Prop` decorator uses for
 * `@Model` classes (`dsl.ts`: `${classId}_${propertyName}`). Hand written
 * attributes get the same deterministic shape so a model rebuild does not churn
 * ids and so tests can assert on them.
 */
function attributeId (name: string): Ref<Attribute<any>> {
  return `${crmLite.masterTag.Lead}_${name}` as Ref<Attribute<any>>
}

function leadAttribute (
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
      attributeOf: crmLite.masterTag.Lead,
      name,
      label,
      type,
      ...extra
    },
    attributeId(name)
  )
}

function defineLead (builder: Builder): void {
  // Lead is a MasterTag, produced exactly the way `models/contact` produces
  // `contact.class.UserProfile` and `models/chat` produces `chat.masterTag.Thread`.
  //
  // 🔴 It is deliberately NOT a `Tag`: `Tag extends MasterTag, Mixin<Card>` is a
  // mixin, so it can never be a document's `_class`, and `classHierarchyMixin`
  // walks only the `extends` chain (never the mixins a doc carries), which means
  // a Tag can never opt into card versioning.
  createSystemType(
    builder,
    crmLite.masterTag.Lead,
    crmLite.icon.Lead,
    crmLite.string.Lead,
    crmLite.string.Leads,
    {
      defaultSection: card.section.Content
    },
    PaletteColorIndexes.Blueberry
  )

  // Accounts and contacts are NOT re-modelled: they are plain references into
  // the upstream contact module (Technical Spec §3.1).
  leadAttribute(builder, 'account', crmLite.string.Account, TypeRef(contact.class.Organization))
  leadAttribute(builder, 'contact', crmLite.string.Contact, TypeRef(contact.class.Person))
  leadAttribute(builder, 'owner', crmLite.string.Owner, TypeRef(contact.mixin.Employee))
  // Pipeline and source are references to configuration documents, not baked in
  // enums, so a deployment can add its own without a migration.
  leadAttribute(builder, 'pipeline', crmLite.string.Pipeline, TypeRef(crmLite.class.CrmPipeline))
  leadAttribute(builder, 'source', crmLite.string.Source, TypeRef(crmLite.class.LeadSource))

  // The kanban grouping attribute. Its TYPE class (not this class) is what
  // carries SortFuncs / AllValuesFunc / AttributePresenter.
  leadAttribute(builder, 'status', crmLite.string.Status, TypeLeadStatus(), {
    defaultValue: 'New'
  })
  leadAttribute(builder, 'priority', crmLite.string.Priority, TypeLeadPriority(), {
    defaultValue: 'NoPriority'
  })
  leadAttribute(builder, 'nextActionAt', crmLite.string.NextActionAt, TypeTimestamp())
  // Required whenever `status` moves to `Disqualified` (enforced by the UI in
  // Task 7 and by the conversion command in Task 9; the model only stores it).
  leadAttribute(builder, 'disqualifyReason', crmLite.string.DisqualifyReason, TypeString())

  // ── What the public intake form collects (PRD CRM-008 follow-up) ─────────
  //
  // 🔴 PLAIN `TypeString()`, ALL THREE, AND THAT IS THE DESIGN RATHER THAN
  // LAZINESS. These are the only Lead attributes an UNAUTHENTICATED stranger
  // can write (`INTAKE_ALLOWED_FIELDS`), so every extra capability given to
  // their type is a capability given to that stranger:
  //   - a `TypeRef` would let them name a document — the `account` / `contact`
  //     attack the whitelist already refuses;
  //   - a custom `Type` subclass would need its own `AttributePresenter` and
  //     `AttributeEditor` (see `defineStatusType`: `getAttributePresenter`
  //     THROWS without one) and would buy nothing — there is no vocabulary and
  //     no state machine here, only text;
  //   - `TypeString` resolves to the upstream `StringPresenter` /
  //     `StringEditor` that `models/view` already registers on
  //     `core.class.TypeString`, so `card.section.Properties` renders all three
  //     rows with no further wiring.
  //
  // 🔴 THE `intake` PREFIX AND THE "(unverified)" IN THE LABELS ARE LOAD
  // BEARING. `intakeEmail` in particular is NOT a contact channel: it is not a
  // `contact.class.Channel`, nothing mails it and nothing resolves a person
  // from it (see `INTAKE_EMAIL_IS_UNVERIFIED`). The label is what carries that
  // caveat to the salesperson who will act on it.
  //
  // ℹ️ No `@Index(IndexKind.FullText)`, matching every other Lead attribute:
  // pushing a stranger's self-declared address into the fulltext index is a
  // second copy of unverified personal data in a second store, for a search
  // nobody has asked for yet.
  leadAttribute(builder, 'intakeName', crmLite.string.LeadIntakeName, TypeString())
  leadAttribute(builder, 'intakeEmail', crmLite.string.LeadIntakeEmail, TypeString())
  leadAttribute(builder, 'intakeMessage', crmLite.string.LeadIntakeMessage, TypeString())
}

function defineStatusType (builder: Builder): void {
  // `groupByCategory` (plugins/view-resources/src/utils.ts) resolves the
  // attribute's `attrClass` and looks up view mixins on THAT class. Both mixins
  // below are therefore mandatory for a usable kanban:
  //   - SortFuncs     -> column order (otherwise the columns come out in
  //                      whatever order the data happened to produce)
  //   - AllValuesFunc -> `getGroupByValues`/"show empty groups" can render a
  //                      column for a status nothing is in yet
  // Precedent outside the Task domain: models/controlled-documents/src/index.ts
  // hangs the same pair on `TypeDocumentState`.
  builder.mixin(crmLite.class.TypeLeadStatus, core.class.Class, view.mixin.SortFuncs, {
    func: crmLite.function.LeadStatusSort
  })
  builder.mixin(crmLite.class.TypeLeadStatus, core.class.Class, view.mixin.AllValuesFunc, {
    func: crmLite.function.GetAllLeadStatuses
  })
  builder.mixin(crmLite.class.TypeLeadPriority, core.class.Class, view.mixin.SortFuncs, {
    func: crmLite.function.LeadPrioritySort
  })
  builder.mixin(crmLite.class.TypeLeadPriority, core.class.Class, view.mixin.AllValuesFunc, {
    func: crmLite.function.GetAllLeadPriorities
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
  builder.mixin(crmLite.class.TypeLeadStatus, core.class.Class, view.mixin.AttributeFilter, {
    component: view.component.ValueFilter
  })
  builder.mixin(crmLite.class.TypeLeadPriority, core.class.Class, view.mixin.AttributeFilter, {
    component: view.component.ValueFilter
  })

  // 🔴 Not optional either. `KanbanView.svelte`'s `getHeader` calls
  // `getPresenter(...)`, and `getAttributePresenter` THROWS when no
  // `AttributePresenter` is registered for the attribute's class — the column
  // headers would silently come out blank.
  //
  // 🔴 The fourth argument is `view.mixin.AttributeEditor.inlineEditor`, and it
  // is what makes these two rows EXIST in the properties panel — not merely what
  // makes them writable. `AttributeBarEditor` (packages/presentation) wraps its
  // whole body in `{#if editor}` and resolves that editor through
  // `findAttributeEditorByAttribute` -> `classHierarchyMixin(attrClass,
  // view.mixin.AttributeEditor)`. With `AttributePresenter` alone the lookup
  // returns undefined and `status` / `priority` render as nothing at all.
  //
  // 🔴 The state machine is enforced INSIDE `LeadStatusEditor`, which is
  // possible only because `AttributeBarEditor` hands the editor the current
  // `value` alongside `onChange`: the component can therefore compare `from` and
  // `to` through `canTransitionLead` and decline to call `onChange`. Priority
  // has no state machine and gets a plain dropdown.
  classPresenter(
    builder,
    crmLite.class.TypeLeadStatus,
    crmLite.component.LeadStatusPresenter,
    crmLite.component.LeadStatusEditor
  )
  classPresenter(
    builder,
    crmLite.class.TypeLeadPriority,
    crmLite.component.LeadPriorityPresenter,
    crmLite.component.LeadPriorityEditor
  )
}

/**
 * Hangs the traceability block on the Lead detail page.
 *
 * 🔴 `card.class.CardSection` is the mechanism, and it is the ONLY one: this
 * fork has no `view.mixin.ObjectEditorSection`, and a Lead is a `MasterTag`
 * whose panel is `EditCardTableOfContents.svelte` — that component reads
 * `getCardSections(doc)` and renders nothing else. Registering the block
 * anywhere else would register it somewhere nothing looks.
 *
 * 🔴 A CardSection has NO `attachTo`: `getCardSections` reads every section
 * document in the model and filters only on `checkVisibility`. That callback is
 * therefore the whole of the scoping, which is why it is mandatory here — the
 * default is "on every card of every type".
 *
 * ⚠️ `component` is a WRAPPER, not `traceability:component:TraceLinksSection`
 * itself. The panel passes the card as `doc`; `TraceLinksSection` declares
 * `object`. Pointing this at the traceability component directly would leave
 * `object` undefined and throw on first render. `LeadTraceLinksSection.svelte`
 * exists exactly to bridge that one prop name, and forwards nothing else — the
 * server's per-endpoint filter and the component's "restricted link"
 * degradation are left untouched.
 *
 * `order` puts it after Relations (500) and before the message stream (1000),
 * so the traceability edges sit next to the generic relations they generalise.
 */
/**
 * The filter surface of the Lead list — and therefore, transitively, what a
 * Saved View can be built out of.
 *
 * 🔴 WITHOUT THIS MIXIN THERE IS NOTHING TO SAVE. `FilterBar` only renders when
 * the viewlet's class resolves a `ClassFilters`, and `FilterSave.svelte` — the
 * "save this filter" affordance — lives inside that bar. Lead would otherwise
 * inherit the generic `card.class.Card` registration, whose only recommended key
 * is `space`; a saved "my qualified leads this week" view is not reachable from
 * that.
 *
 * ⚠️ DELIBERATELY NOT `strict: true`, unlike `cycle.class.Cycle`. `strict` hides
 * every attribute except the listed ones, which would also hide any Tag a
 * deployment mixes onto Lead. Upstream `card.class.Card` and
 * `tracker.class.Issue` are both non-strict for the same reason, and the "custom
 * attribute with no `AttributeFilter`" hazard does not apply: `buildFilterKey`
 * returns undefined for such an attribute, so `FilterTypePopup` never offers it.
 *
 * 🔴 A `RefTo` KEY IS NOT DROPPED WHEN ITS TARGET CLASS HAS NO
 * `AttributeFilter` — IT FALLS BACK. `buildRefFilterKey` does look the mixin up
 * on the TARGET class and returns `undefined` when it is absent
 * (`plugins/view-resources/src/filter.ts:227-241`), but `buildFilterKey` then
 * retries against `attribute.type._class`, and `core.class.RefTo` itself
 * carries `AttributeFilter -> ObjectFilter` (`models/view/src/index.ts:1113`).
 * So the target-class mixin only decides WHICH filter component is used, never
 * WHETHER the key is offered.
 *
 * 🔴 THE REAL GATE IS `ObjectPresenter` ON THE TARGET CLASS. The generic
 * `ObjectFilter` resolves one to render its rows, and `getPresenter` THROWS
 * rather than degrading when there is none. That is what actually rules keys in
 * and out here:
 *
 *   - `account` / `contact` — IN. `contact.class.Organization`
 *     (`models/contact/src/index.ts:1017`) and `contact.class.Person` (`:1000`)
 *     both register `ObjectPresenter`, so both filter through `ObjectFilter`.
 *   - `owner` — IN, and better than the other two: `contact.mixin.Employee` is
 *     the one contact class with its own `AttributeFilter`
 *     (`models/contact/src/index.ts:759`), so it gets the Employee-specific
 *     filter instead of the generic one.
 *   - `space` — OUT. No `Space` class registers an `ObjectPresenter`, so the
 *     fallback would throw when the filter is opened.
 *   - `pipeline` / `source` — IN, but only because `defineConfigPresenters`
 *     above gives `TCrmPipeline` / `TLeadSource` an `ObjectPresenter`. They
 *     extend `TDoc` directly and inherit nothing. 🔴 REMOVING THAT REGISTRATION
 *     WITHOUT REMOVING THESE TWO KEYS CRASHES THE FILTER BAR ON OPEN.
 *
 * `status` / `priority` filter through their Type classes' `ValueFilter`
 * (registered in `defineStatusType` above); `createdBy` / `modifiedBy` through
 * `core.class.TypePersonId` (`models/view/src/index.ts:1424`).
 *
 * ⚠️ `ignoreKeys` repeats card's own — a nearer `ClassFilters` REPLACES the
 * inherited one (`classHierarchyMixin` walks up and stops at the first hit), it
 * does not merge with it, so anything card excluded has to be excluded again.
 *
 * 🔴 THE PERSISTED FILTER FREEZES ENUM VALUES. `FilteredView.filters` is a JSON
 * STRING holding the literal `status` / `priority` values that were selected, so
 * `LeadStatus` and `LeadPriority` are append-only for the lifetime of every
 * saved view: renaming, reordering or removing a member makes existing saved
 * views match ZERO rows, silently and with no error anywhere.
 */
/**
 * `view.mixin.ObjectPresenter` for the two configuration classes.
 *
 * 🔴 THIS IS THE PREREQUISITE FOR FILTERING LEADS BY PIPELINE OR SOURCE, and
 * the reason is not obvious. A `RefTo` filter key is NOT dropped when its
 * target class lacks `view.mixin.AttributeFilter`: `buildRefFilterKey` returns
 * undefined, but `buildFilterKey` then retries against `attribute.type._class`
 * and `core.class.RefTo` carries `AttributeFilter -> ObjectFilter`
 * (`plugins/view-resources/src/filter.ts:243-265`, `models/view/src/index.ts:1113`).
 * The generic `ObjectFilter` resolves an `ObjectPresenter` for the target class
 * to draw its rows, and `getPresenter` THROWS when there is none — so the
 * presenter, not the filter mixin, is what decides whether these keys are
 * usable or fatal.
 */
function defineConfigPresenters (builder: Builder): void {
  for (const _class of [crmLite.class.CrmPipeline, crmLite.class.LeadSource]) {
    builder.mixin(_class, core.class.Class, view.mixin.ObjectPresenter, {
      presenter: crmLite.component.CrmConfigPresenter
    })
  }
}

function defineFilters (builder: Builder): void {
  builder.mixin(crmLite.masterTag.Lead, core.class.Class, view.mixin.ClassFilters, {
    filters: ['status', 'priority', 'owner', 'account', 'contact', 'pipeline', 'source', 'createdBy', 'modifiedBy'],
    ignoreKeys: ['parent']
  })
}

function defineTraceLinksSection (builder: Builder): void {
  builder.createDoc(
    card.class.CardSection,
    core.space.Model,
    {
      label: crmLite.string.Traceability,
      component: crmLite.component.LeadTraceLinksSection,
      order: 550,
      navigation: [],
      checkVisibility: crmLite.function.CheckLeadTraceLinksVisibility
    },
    crmLite.section.LeadTraceLinks
  )
}

/**
 * Hangs Task 7's required-field checklist on the Lead detail page.
 *
 * 🔴 IT IS NOT A SECOND FIELD EDITOR. `card.section.Properties` already renders
 * every Lead attribute through `CardAttributeEditor` — including `status` and
 * `priority`, which is exactly what the `AttributeEditor` mixins above buy. This
 * section only NAMES what is still missing, so `order` puts it directly after
 * Properties (100) and before Content (200): a checklist that sat below the
 * message stream would be read after the fields it is about.
 *
 * 🔴 The fields it lists (`account` / `contact` / `owner` / `nextActionAt`) are
 * OPTIONAL attributes and `LeadGuardMiddleware` never inspects them. Nothing —
 * here or in the component — refuses a write over them; leads legitimately
 * arrive incomplete from the import tool and from any API caller. See
 * `validateLeadFields` in `crm-lite-resources/src/utils.ts`.
 *
 * ⚠️ Same two traps as the traceability section: a `CardSection` has NO
 * `attachTo`, so `checkVisibility` is the whole of the scoping; and the panel
 * passes the card as `doc`, so the component must declare `doc`.
 */
function defineFieldsSection (builder: Builder): void {
  builder.createDoc(
    card.class.CardSection,
    core.space.Model,
    {
      label: crmLite.string.RequiredFields,
      component: crmLite.component.LeadFieldsSection,
      order: 150,
      navigation: [],
      checkVisibility: crmLite.function.CheckLeadFieldsVisibility
    },
    crmLite.section.LeadFields
  )
}

function defineKanban (builder: Builder): void {
  // Route A (Technical Spec §3.1.1): reuse the upstream Kanban viewlet
  // descriptor instead of writing our own.
  //
  // ℹ️ `createSystemType` already registers Table / List / CardGrid viewlets for
  // the tag, so this Kanban shows up as one more option in the view switcher.
  // It is NOT the initial view: `ViewletSelector` falls back to `viewlets[0]`
  // and card's `Main.svelte` passes no `defaultViewletDescriptor`. The user's
  // choice is then persisted as a ViewletPreference.
  //
  // The three hard prerequisites are all met by Card:
  //   1. the host class has `rank`   -> `Card.rank` (plugins/card/src/index.ts)
  //   2. there is a groupable attr   -> `status`, defined above
  //   3. `task.mixin.KanbanCard`     -> registered right below
  // `packages/kanban` has zero dependency on `@hcengineering/task`, and
  // `Viewlet.attachTo` is an unconstrained `Ref<Class<Doc>>`.
  //
  // ⚠️ Two accepted, deliberately un-fixed degradations (Technical Spec §3.1.1):
  //   1. `KanbanView.svelte` hard codes `lookup: { space: task.class.Project,
  //      status: core.class.Status, ... }`. A Lead's space is a `CardSpace` and
  //      its `status` holds a `LeadStatus` string, never a `Ref<Status>`, so
  //      those lookups simply resolve to nothing: `$lookup.*` is `undefined`
  //      plus three wasted JOINs. No error.
  //   2. `KanbanDragDone.svelte` queries `task.class.Project` and finds nothing,
  //      so the "done" bar renders empty. The product decision is that there is
  //      NO done bar: Converted / Disqualified are ordinary status columns. Do
  //      not build any "drag to the done area" interaction on top of this.
  //
  // Switching to a self-written descriptor later changes exactly one constant
  // (`descriptor`); everything else here stays as is.
  const leadViewOptions: ViewOptionsModel = {
    groupBy: ['status', 'priority', 'owner'],
    orderBy: [
      ['rank', SortingOrder.Ascending],
      ['modifiedOn', SortingOrder.Descending],
      ['createdOn', SortingOrder.Descending],
      ['nextActionAt', SortingOrder.Ascending]
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

  const lookupLeadOptions: FindOptions<Lead> = {
    lookup: {
      account: contact.class.Organization,
      contact: contact.class.Person,
      owner: contact.mixin.Employee
    }
  }

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: crmLite.masterTag.Lead,
      descriptor: task.viewlet.Kanban,
      viewOptions: {
        ...leadViewOptions,
        groupDepth: 1
      },
      // Our own lookups survive: `KanbanView.svelte` spreads `options.lookup`
      // first and only then adds its own hard coded keys.
      options: lookupLeadOptions,
      config: ['account', 'status', 'priority', 'owner', 'nextActionAt'],
      configOptions: {
        strict: true
      },
      baseQuery: {
        isLatest: true
      }
    },
    crmLite.viewlet.KanbanLead
  )

  builder.mixin(crmLite.masterTag.Lead, core.class.Class, task.mixin.KanbanCard, {
    card: crmLite.component.KanbanCard
  })
}

/**
 * The client entry point for `AgentraCommandRequestMiddleware`.
 *
 * 🔴 NO `query` FILTER, deliberately. The obvious `{ status: 'Qualifying' }`
 * would hide the action on an already `Converted` lead — exactly the lead for
 * which CRM-T005 requires the button to open the ORIGINAL requirement rather
 * than build a second one. Legality is the server's `canTransitionLead` check,
 * and its refusal is rendered as a specific 400 reason; hiding the entry point
 * would replace that explanation with silence.
 */
function defineActions (builder: Builder): void {
  createAction(
    builder,
    {
      action: view.actionImpl.ShowPopup,
      actionProps: {
        component: crmLite.component.ConvertLeadPopup,
        element: 'top',
        fillProps: {
          _object: 'value'
        }
      },
      label: crmLite.string.ConvertToRequirement,
      icon: crmLite.icon.Lead,
      input: 'focus',
      category: view.category.General,
      target: crmLite.masterTag.Lead,
      context: {
        // `editor` puts it on the lead's detail panel, `context` on the kanban
        // card's context menu, `browser` in the list view's action bar.
        mode: ['editor', 'context', 'browser'],
        group: 'associate'
      }
    },
    crmLite.action.ConvertLeadToRequirement
  )

  // 🔴 NO `query` FILTER HERE EITHER, and for the mirror-image reason. Hiding
  // the action on a `Converted` lead would leave the user with no explanation
  // of why a legal-looking move is impossible; the popup states it instead
  // (`DisqualifyNotAllowed`) and offers no Save button.
  //
  // ⚠️ This action, not the inline status dropdown, is the supported way into
  // `Disqualified`. `LeadGuardMiddleware` refuses a reasonless write on every
  // path, so a dropdown pick that skipped the reason would surface as a raw
  // server error; `LeadStatusEditor` therefore routes that one pick into this
  // same popup.
  createAction(
    builder,
    {
      action: view.actionImpl.ShowPopup,
      actionProps: {
        component: crmLite.component.DisqualifyLeadPopup,
        element: 'top',
        fillProps: {
          _object: 'value'
        }
      },
      label: crmLite.string.Disqualify,
      icon: crmLite.icon.Lead,
      input: 'focus',
      category: view.category.General,
      target: crmLite.masterTag.Lead,
      context: {
        mode: ['editor', 'context', 'browser'],
        group: 'edit'
      }
    },
    crmLite.action.DisqualifyLead
  )
}

/**
 * Wire constant for the one `workbench` class this module needs.
 *
 * 🔴 DECLARED, NOT IMPORTED. `models/crm-lite/package.json` declares neither
 * `@hcengineering/workbench` nor `@hcengineering/model-workbench`, and adding
 * them means a `rush update` and a rewritten `pnpm-lock.yaml`. `models/cycle`
 * takes the same trade-off for `workbench:class:ApplicationNavModel` and
 * documents it at length; this is the same pattern, one class over.
 *
 * ⚠️ WHAT MAKES IT SAFE. `Builder.createDoc`
 * (`foundations/core/packages/model/src/dsl.ts`) does not validate that the
 * class exists — it only builds a `TxCreateDoc` — and `models/all` always loads
 * the workbench model, so the class is in the hierarchy by the time the
 * transaction is applied. The id is `plugin()` output and is therefore
 * `'<pluginId>:<kind>:<name>'` by construction.
 *
 * ⚠️ WHAT IS NOT PROTECTED. An upstream rename would not fail to compile here.
 * The model test asserts the literal string, which is the most a package that
 * cannot import it can do.
 */
const workbenchClassApplication = 'workbench:class:Application' as Ref<Class<Doc>>

/**
 * THE PUBLIC INTAKE FORM'S ADDRESS (PRD CRM-008).
 *
 * `LeadIntakeForm` had no way to be reached at all. This gives it one:
 * `[workbench, <workspace>, 'lead-intake', 'form']`.
 *
 * ─── WHY AN APPLICATION AND NOT AN `ApplicationNavModel` ON CARDS ──────────
 *
 * 🔴 THE OBVIOUS DESIGN — hang a special off the upstream Cards application the
 * way `models/cycle` hangs "Cycles" off Tracker — IS A WORKSPACE-WIDE
 * REGRESSION, and it is worth writing down so nobody "simplifies" this back
 * into it. `buildNavModel` (`plugins/workbench-resources/src/utils.ts:179-206`)
 * merges an `ApplicationNavModel` by REBUILDING the model as
 * `{ spaces, specials }` — it never copies `groups` or `hideStarred`. The Cards
 * application's own `navigatorModel` (`models/card/src/index.ts:671-687`) is
 * built on `groups: [{ id: 'types', component: TypesNavigator }]` plus
 * `hideStarred: true`. So the mere EXISTENCE of any nav model extending
 * `card.app.Card` deletes the master-tag navigator from the Cards app for every
 * account in the workspace. `models/cycle` does not hit this because Tracker's
 * navigator is `spaces`-based.
 *
 * A standalone application has no such interaction: with no `ApplicationNavModel`
 * extending it, `buildNavModel`'s loop body never runs and the `navigatorModel`
 * below is used verbatim.
 *
 * ─── WHY `hidden: true` ───────────────────────────────────────────────────
 *
 * `hidden` controls the LEFT RAIL, not routing. `Workbench.svelte:163` builds
 * the rail from `findAllSync(Application, { hidden: false, … })`, while the
 * router at `Workbench.svelte:490` resolves an app by `{ alias }` with NO
 * `hidden` filter. Hidden therefore means exactly "reachable by link, absent
 * from every employee's sidebar" — which is what a form for strangers wants.
 *
 * ─── WHY NO `accessLevel` ─────────────────────────────────────────────────
 *
 * 🔴 LOAD BEARING, AND `undefined` IS NOT AN OVERSIGHT. `isAllowedToRole`
 * (`workbench-resources/src/utils.ts:145-148`) and `getSpecialComponent`
 * (`Workbench.svelte:641`) both read `undefined` as "every role", guests
 * included; the router's check at `Workbench.svelte:493` is written the same
 * way. Setting `accessLevel: AccountRole.User` here would lock out precisely
 * the sessions the form exists for — `server-plugins/crm-lite/src/intake.ts`
 * classifies a submission as intake by `!hasAccountRole(account, AccountRole.User)`.
 * Setting `AccountRole.Guest` would be equivalent to `undefined` for guests but
 * is left off so the intent reads as "no gate here" rather than "a gate that
 * happens to pass".
 *
 * ⚠️ WHAT THIS DOES **NOT** DO, and what still has to be solved elsewhere:
 *
 *   1. NOTHING HERE MINTS A LINK. The address exists; handing it to a stranger
 *      requires `createAccessLink(AccountRole.Guest, { navigateUrl })`
 *      (`server/account/src/operations.ts:743`), which lives behind
 *      `@hcengineering/account-client` + `@hcengineering/login` — two packages
 *      `plugins/crm-lite-resources` does not depend on. See that package's
 *      `plugin.ts` for the full trace.
 *   2. 🔴 THE ONE EXISTING LINK BUTTON IS NOT SAFE FOR THIS. Upstream's
 *      `GetIndividualPublicLink` on `card.class.CardSpace`
 *      (`models/card/src/actions.ts:36-51`) — which DOES appear on
 *      `crmLite.space.Crm`, a `CardSpace` — calls `getSpaceAccessPublicLink`
 *      (`card-resources/src/utils.ts:813-828`) with `spaces: [space._id]`. That
 *      grant is copied into the guest's space membership by `OnEmployeeCreate`
 *      (`server-plugins/contact-resources/src/index.ts:161-176`, via
 *      `getGrantSpaces`, which waves through any non-private space), and
 *      membership is what gates lead reads (`spaceSecurity.ts:527-543`; the
 *      space's `private: false` does NOT grant data reads, because
 *      `getAllAllowedSpaces` sets `ignorePublicSpaces` for data domains). An
 *      admin who uses that button to publish intake hands every link holder
 *      READ ACCESS TO EVERY LEAD. The intake link must be minted WITHOUT
 *      `spaces`.
 *
 *      ⚠️ AND THE BUTTON CANNOT BE HIDDEN FROM HERE. Suppressing an action for
 *      a class means `view.mixin.IgnoreActions`, which names actions by `Ref`
 *      — and `createAction` is called for this one with no id
 *      (`models/card/src/actions.ts:36-51`), so `TxFactory.createTxCreateDoc`
 *      gives it `objectId ?? generateId()` (`foundations/core/packages/core/src/tx.ts:487`),
 *      i.e. a fresh random id on every model build. There is no stable `Ref` to
 *      put in an ignore list. Hiding it requires editing `models/card`.
 *
 *      🔴 SO IT IS DEFENDED AT THE PIPELINE INSTEAD. `LeadGuardMiddleware` now
 *      (a) drops any transaction that would make a below-`User` session a
 *      member of `crmLite.space.Crm`, and (b) rewrites every query from such a
 *      session so it cannot return a document out of that space. Both live in
 *      `server-plugins/crm-lite/src/guestScope.ts`, whose header carries the
 *      full five-link trace and the reasons the fix could not go anywhere else.
 *      The button therefore still appears, and still mints a grant — the grant
 *      simply no longer buys anything.
 *   3. THE OPEN QUESTION FROM (1), NOW ANSWERED: **yes, a guest with no
 *      `spaces` grant can still submit.** Nothing on the write path checks
 *      space membership.
 *        - `SpaceSecurityMiddleware.tx` (`spaceSecurity.ts:427-436`) only walks
 *          the batch to maintain its caches and broadcast targets; every
 *          membership test in that file is on the READ path (`mergeQuery`,
 *          `getAllAllowedSpaces`).
 *        - `SpacePermissionsMiddleware.checkPermission` (`spacePermissions.ts:171-201`)
 *          finds no permissions for a guest and no `withoutMatch`, then returns
 *          `true` at line 201 because `crmLite.space.Crm` is not `restricted`.
 *          ⚠️ Which is why `ensureCrmSpace` must never set `restricted: true`
 *          as a "tightening": that flag closes the intake write path and
 *          changes nothing about reads.
 *        - `GuestPermissionsMiddleware` (`guestPermissions.ts:137-160`) judges
 *          the CLASS, never the space, and the class is allowed: upstream's
 *          `card.ids.GuestCardClassPermission` has `targetClass: card.class.Card`
 *          and is enabled for `AccountRole.Guest`
 *          (`models/card/src/index.ts:1017-1039`), so every master tag is
 *          guest-creatable.
 *      The other half of "can submit" is that the form needs no reads at all:
 *      `LeadIntakeForm.svelte` calls `client.createDoc` and nothing else, so
 *      the read scoping in (2) cannot break it.
 */
function defineIntakeApp (builder: Builder): void {
  builder.createDoc(
    workbenchClassApplication,
    core.space.Model,
    {
      label: crmLite.string.IntakeFormTitle,
      icon: crmLite.icon.Lead,
      alias: LEAD_INTAKE_ALIAS,
      hidden: true,
      navigatorModel: {
        // `NavigatorModel.spaces` is required by the type and is meaningless
        // here: the form is not scoped to a space the visitor can pick.
        spaces: [],
        specials: [
          {
            id: LEAD_INTAKE_SPECIAL,
            label: crmLite.string.IntakeFormTitle,
            icon: crmLite.icon.Lead,
            component: crmLite.component.LeadIntakeForm
          }
        ]
      }
    } as any,
    crmLite.app.LeadIntake
  )
}

export function createModel (builder: Builder): void {
  builder.createModel(TTypeLeadStatus, TTypeLeadPriority, TCrmPipeline, TLeadSource)

  defineLead(builder)
  defineStatusType(builder)
  defineConfigPresenters(builder)
  defineFilters(builder)
  defineKanban(builder)
  defineTraceLinksSection(builder)
  defineFieldsSection(builder)
  defineActions(builder)
  defineIntakeApp(builder)
}
