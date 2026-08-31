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

import core, { type Class, type Doc, type Ref, SortingOrder } from '@hcengineering/core'
import { type Builder } from '@hcengineering/model'
import activity from '@hcengineering/model-activity'
import trackerModel from '@hcengineering/model-tracker'
import view, { classPresenter, createAction } from '@hcengineering/model-view'
import { type BuildModelKey, type ViewOptionsModel } from '@hcengineering/view'

// ⚠️ A VALUE import from `cycle-resources`, which is safe ONLY because
// `utils.ts` has no Svelte in it — this model already imports that package's
// `plugin.ts` the same way (see `./plugin`). Re-using the constant is what
// keeps the label the action registers and the label the popup renders from
// drifting apart.
import { LINK_IMPLEMENTS_TO_REQUIREMENT } from '@hcengineering/cycle-resources/src/utils'

import cycle from './plugin'
import { TCycle, TCycleIssue, TTypeCycleStatus } from './types'

export { cycleId } from '@hcengineering/cycle'
export { backfillCycleDefaults, cycleOperation } from './migration'
export { default } from './plugin'
export * from './types'

function defineCycle (builder: Builder): void {
  // Field level change history. It is not decoration: Technical Spec §3.4 says
  // velocity / burndown / rollover are COMPUTED from Activity and Issue
  // snapshots rather than stored in hand maintained fields, and this mixin is
  // what makes the cycle's own status/date changes part of that record.
  builder.mixin(cycle.class.Cycle, core.class.Class, activity.mixin.ActivityDoc, {})

  // Renders a Cycle document (list rows, mentions).
  builder.mixin(cycle.class.Cycle, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: cycle.component.CyclePresenter
  })

  // 🔴 Both of the next two mixins are about the ISSUE side, not the cycle
  // list. For a `RefTo` attribute — which is exactly what the
  // `cycle.mixin.CycleIssue.cycle` attribute is — the presenter AND the filter
  // component are resolved on the TARGET class (`buildRefFilterKey` /
  // `getAttributePresenter` in `plugins/view-resources`). Without
  // AttributePresenter a `cycle` column throws rather than degrading; without
  // AttributeFilter the attribute never becomes a usable filter key at all.
  builder.mixin(cycle.class.Cycle, core.class.Class, view.mixin.AttributePresenter, {
    presenter: cycle.component.CycleRefPresenter
  })
  builder.mixin(cycle.class.Cycle, core.class.Class, view.mixin.AttributeFilter, {
    component: view.component.ObjectFilter
  })

  // 🔴 THE THIRD MEMBER OF THAT SAME FAMILY, and the one whose absence is
  // silent. `getAttrEditor` (packages/presentation) resolves the attribute's
  // `attrClass` exactly the way the presenter lookup does — for a `RefTo` that
  // is the TARGET class — and `AttributeBarEditor` wraps its ENTIRE body in
  // `{#if editor}`. Without this mixin an Issue's `cycle` field is not
  // read-only, it is INVISIBLE: no label, no value, no row.
  builder.mixin(cycle.class.Cycle, core.class.Class, view.mixin.AttributeEditor, {
    inlineEditor: cycle.component.CycleEditor
  })

  builder.mixin(cycle.class.Cycle, core.class.Class, view.mixin.ClassFilters, {
    filters: ['status'],
    strict: true
  })
}

function defineTypeClasses (builder: Builder): void {
  // `groupByCategory` (plugins/view-resources/src/utils.ts) resolves the
  // attribute's `attrClass` and looks up view mixins on THAT class. Both mixins
  // below are therefore mandatory for usable grouping:
  //   - SortFuncs     -> group order
  //   - AllValuesFunc -> a status nothing is in yet still gets a group
  builder.mixin(cycle.class.TypeCycleStatus, core.class.Class, view.mixin.SortFuncs, {
    func: cycle.function.CycleStatusSort
  })
  builder.mixin(cycle.class.TypeCycleStatus, core.class.Class, view.mixin.AllValuesFunc, {
    func: cycle.function.GetAllCycleStatuses
  })

  // Without `AttributeFilter` the status is not filterable BY VALUE at all:
  // `buildFilterKey` returns undefined when the attribute's type class carries
  // no such mixin. `ValueFilter` is the upstream component for a closed
  // vocabulary stored inline — the same choice upstream makes for
  // `TypeMilestoneStatus`.
  builder.mixin(cycle.class.TypeCycleStatus, core.class.Class, view.mixin.AttributeFilter, {
    component: view.component.ValueFilter
  })

  // 🔴 Not optional. `getAttributePresenter` THROWS when no `AttributePresenter`
  // is registered for the attribute's class, so a `status` column — and every
  // group header built from one — would blow up rather than degrade.
  //
  // 🔴 THE FOURTH ARGUMENT IS NOT OPTIONAL IN PRACTICE. `classPresenter` only
  // emits `view.mixin.AttributeEditor` when an `editor` is supplied, and
  // `AttributeBarEditor` renders NOTHING when that mixin is missing. A
  // three-argument call therefore produces a `status` field that is absent from
  // the generic `EditDoc` panel rather than one that is merely not editable.
  //
  // ⚠️ The editor enforces `cycleTransitions`; see `CycleStatusEditor.svelte`
  // for why `completed` is deliberately not among the values it offers.
  classPresenter(
    builder,
    cycle.class.TypeCycleStatus,
    cycle.component.CycleStatusPresenter,
    cycle.component.CycleStatusEditor
  )
}

const cycleViewOptions: ViewOptionsModel = {
  groupBy: ['status', 'createdBy', 'modifiedBy'],
  orderBy: [
    ['startDate', SortingOrder.Descending],
    ['sequence', SortingOrder.Descending],
    ['modifiedOn', SortingOrder.Descending]
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

function defineViewlets (builder: Builder): void {
  // ℹ️ These are attached to `cycle.class.Cycle` only. Nothing here touches the
  // upstream Issue viewlets: `Builder` has no `updateDoc`, so adding `cycle` to
  // the tracker viewlets' `groupBy` would mean editing `models/tracker`, which
  // this module deliberately does not do. See the note on `CycleIssue` about
  // what a mixin attribute can and cannot do in the stock Issue views.
  const tableConfig: Array<BuildModelKey | string> = [
    { key: '', props: { shrink: true } },
    'status',
    'startDate',
    'endDate',
    'capacity',
    'modifiedOn'
  ]

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: cycle.class.Cycle,
      descriptor: view.viewlet.Table,
      viewOptions: cycleViewOptions,
      config: tableConfig,
      configOptions: {
        hiddenKeys: ['goal'],
        sortable: true
      }
    },
    cycle.viewlet.TableCycle
  )

  const listConfig: Array<BuildModelKey | string> = [
    { key: '' },
    { key: '', displayProps: { grow: true } },
    { key: 'status', displayProps: { key: 'status' } },
    { key: 'startDate', displayProps: { key: 'startDate', optional: true } },
    { key: 'endDate', displayProps: { key: 'endDate', optional: true } },
    {
      key: 'modifiedOn',
      displayProps: { fixed: 'right', key: 'modifiedOn', dividerBefore: true }
    }
  ]

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: cycle.class.Cycle,
      descriptor: view.viewlet.List,
      viewOptions: cycleViewOptions,
      config: listConfig,
      configOptions: {
        hiddenKeys: ['goal']
      }
    },
    cycle.viewlet.ListCycle
  )
}

/**
 * Wire constants for the two `workbench` resources this module needs.
 *
 * 🔴 DECLARED, NOT IMPORTED, and that is a deliberate trade-off rather than a
 * shortcut. Importing `@hcengineering/workbench` would add a dependency to
 * `models/cycle/package.json`, which means a `rush update` and a rewritten
 * `pnpm-lock.yaml`. `crm-lite-resources` and `traceability-resources` copy
 * their wire types for the same reason.
 *
 * ⚠️ WHAT MAKES THIS SAFE HERE. `Builder.createDoc`
 * (`foundations/core/packages/model/src/dsl.ts`) does NOT validate that the
 * class exists — it only builds a `TxCreateDoc` — and `models/all` always loads
 * the workbench model, so the class is present in the hierarchy by the time the
 * transaction is applied. The ids themselves are `plugin()` output and are
 * therefore `'<pluginId>:<kind>:<name>'` by construction.
 *
 * ⚠️ WHAT IS NOT PROTECTED. A rename upstream would not fail to compile here.
 * The model test asserts the literal strings against the shape `plugin()`
 * produces, which is the most a package that cannot import them can do.
 */
const workbenchClassApplicationNavModel = 'workbench:class:ApplicationNavModel' as Ref<Class<Doc>>

/**
 * Cycles as a per-project entry inside the UPSTREAM Tracker application.
 *
 * 🔴 NO UPSTREAM FILE IS TOUCHED. `buildNavModel`
 * (`plugins/workbench-resources/src/utils.ts`) loads every
 * `ApplicationNavModel` whose `extends` matches the application being opened
 * and merges it into that application's own `navigatorModel`: for a `spaces`
 * entry it matches on `id` and CONCATENATES the `specials` arrays. Tracker's
 * own spaces entry is `id: 'projects'` (`models/tracker/src/index.ts`), so
 * declaring the same id here appends "Cycles" under every project without
 * `models/tracker` or `plugins/tracker` changing by one character.
 *
 * Precedent: `services/github/model-github/src/index.ts` adds its "Pull
 * requests" special to Tracker exactly this way.
 *
 * 🔴 THE COMPONENT IS `cycle.component.CyclesView`, NOT
 * `workbench.component.SpecialView`, AND THAT IS NOT A STYLE CHOICE.
 * `SpecialView` accepts a `space` prop but never puts it in the query it runs
 * (`SpecialView.svelte` builds the query from `baseQuery` + the `BaseQuery`
 * mixin + the viewlet's baseQuery; `List.svelte` uses it verbatim and treats
 * `space` only as the create affordance's default). Pointing the special
 * straight at it yields a per-project "Cycles" page listing EVERY project's
 * cycles. `CyclesView` is the thin wrapper that supplies
 * `baseQuery: { space }` from the RUNTIME space — which is the only place it
 * can come from, since `Workbench.svelte` renders a special with
 * `{ ...componentProps, currentSpace, space: currentSpace }` and those two win
 * over anything declared here.
 *
 * Upstream agrees by example: Tracker's own per-project Milestones special
 * points at a bespoke `Milestones.svelte` whose whole body is
 * `query={{ space: currentSpace }}`.
 *
 * ⚠️ THE VIEWLETS ARE WHAT MAKE IT NON-EMPTY. `SpecialView` — reached through
 * the wrapper — resolves its viewlets from `attachTo === _class`;
 * `defineViewlets` above registers a table and a list against
 * `cycle.class.Cycle`, so this entry has something to draw.
 */
function defineNavigation (builder: Builder): void {
  builder.createDoc(workbenchClassApplicationNavModel, core.space.Model, {
    extends: trackerModel.app.Tracker,
    spaces: [
      {
        id: 'projects',
        spaceClass: trackerModel.class.Project,
        specials: [
          {
            id: 'cycles',
            label: cycle.string.Cycles,
            icon: cycle.icon.Cycles,
            component: cycle.component.CyclesView
          }
        ]
      }
    ]
  } as any)
}

function defineActions (builder: Builder): void {
  // The only way to reach `completed` from the UI. `CycleStatusEditor`
  // deliberately refuses to write that status inline, because completing a
  // cycle also has to roll issues over and record a snapshot — see §4.
  createAction(
    builder,
    {
      action: cycle.actionImpl.CompleteCycle,
      label: cycle.string.CompleteCycle,
      icon: cycle.icon.Cycle,
      // `single`: the command is keyed on ONE cycle and each completion carries
      // its own rollover decision.
      input: 'focus',
      category: view.category.General,
      target: cycle.class.Cycle,
      visibilityTester: cycle.function.CanCompleteCycle,
      context: {
        mode: ['context', 'browser'],
        group: 'edit'
      }
    },
    cycle.action.CompleteCycle
  )

  // ── Bulk edit ────────────────────────────────────────────────────────────
  //
  // 🔴 `input: 'any'` IS THE WHOLE BULK MECHANISM. There is no separate batch
  // channel in this platform and none is written here: `view.actionImpl.
  // ValueSelector` is typed `(doc: Doc | Doc[], ...)` and
  // `ValueSelector.svelte` normalises with
  // `[...(Array.isArray(value) ? value : [value])]`, then calls
  // `updateAttribute` once per document inside a single `client.apply(...)`
  // batch. One row and fifty rows therefore execute the SAME code; a bespoke
  // loop here would only create a second place for the two to diverge. Shape
  // copied from `models/tracker/src/actions.ts`'s `SetPriority`.
  //
  // ⚠️ THE TRANSACTIONS ARE `TxMixin`, NOT `TxUpdateDoc`, and that follows from
  // `cycle` being a mixin attribute: `updateAttribute`
  // (foundations/core/.../operations.ts) branches on
  // `hierarchy.isMixin(attr.attributeOf)` and calls `client.updateMixin`. One
  // per document, and no `TxCreateDoc` at all — a bulk edit never creates.
  //
  // 🔴 `castRequest` IS LOAD BEARING. Without it `ValueSelector.svelte` resolves
  // the attribute on `Hierarchy.mixinOrClass(doc)`, which for an Issue that has
  // never been assigned a cycle is `tracker.class.Issue` — an ancestor walk that
  // cannot see a mixin attribute and THROWS rather than returning undefined.
  //
  // 🔴 `docMatches: ['space']` IS THE CROSS-PROJECT GUARD ON THE KEYBINDING
  // PATH. `ActionHandler` invokes the `actionImpl` directly and never renders
  // `actionPopup`, so `SetCyclePopup`'s own guard is not reached there. When the
  // selected issues disagree on `space`, `ValueSelector.svelte` sets
  // `docMatch = false` and renders `DontMatchCriteria` INSTEAD of the picker —
  // the whole batch is refused and nothing is written. Without it, `fillQuery`
  // would build a `{ $in: [...] }` over several projects and happily offer a
  // cycle from a project some of the selected issues are not in.
  createAction(
    builder,
    {
      action: view.actionImpl.ValueSelector,
      // The menu / command-palette path renders this component; it repeats the
      // cross-project refusal with a cycle-specific explanation instead of the
      // generic "doesn't match criteria".
      actionPopup: cycle.component.SetCyclePopup,
      actionProps: {
        attribute: 'cycle',
        _class: cycle.class.Cycle,
        castRequest: cycle.mixin.CycleIssue,
        // Scopes the candidate cycles to the project the selected issues are in.
        fillQuery: { space: 'space' },
        docMatches: ['space'],
        searchField: 'name',
        placeholder: cycle.string.SetCycle
      },
      label: cycle.string.SetCycle,
      icon: cycle.icon.Cycle,
      input: 'any',
      category: view.category.General,
      target: trackerModel.class.Issue,
      // Whole-batch: false as soon as ANY selected issue is out of bounds, so
      // no partial count is ever produced. See `canSetCycle`.
      visibilityTester: cycle.function.CanSetCycle,
      context: {
        mode: ['context', 'browser'],
        application: trackerModel.app.Tracker,
        group: 'edit'
      }
    },
    cycle.action.SetCycle
  )

  // ── "Link requirements" ───────────────────────────────────────────────────
  //
  // 🔴 NOT `view.actionImpl.ShowPopup`. The popup's `fixed` prop is
  // `Array<Ref<Doc>>`, and `ShowPopup.fillProps` special-cases only `_object`
  // and `_objects` — every other key is copied verbatim off the document
  // (`plugins/view-resources/src/actionImpl.ts:479-488`). `{ _id: 'fixed' }`
  // would therefore hand the popup a bare string, whose `for…of` iterates
  // CHARACTERS and sends one junk pair per character to the `linkImplements`
  // command. Nothing catches it at compile time. The dedicated impl in
  // `cycle-resources` builds the array instead.
  //
  // 🔴 THE LABEL IS A `traceability:string:*` LITERAL, and that is not a
  // shortcut. This model depends on `tracker / model-tracker / model-view` and
  // has no traceability dependency; the alternative — a fresh key in
  // `plugins/cycle` + `cycle-assets` — would duplicate copy that already exists
  // in three languages, and this one names the ISSUE side specifically
  // ("select requirements this work item implements"). The
  // `traceabilityId` strings loader is registered unconditionally in
  // `dev/prod/src/platform.ts`, so it resolves wherever this action is shown.
  //
  // ⚠️ NO ICON, deliberately: the fitting one lives in `traceability-assets`
  // and `Action.icon` is optional. A cycle icon here would be a lie.
  //
  // ⚠️ `input: 'focus'` — single target. The popup builds a `fixed × picked`
  // matrix, so a multi-select would link EVERY selected issue to EVERY picked
  // requirement, which is not what a context menu implies.
  createAction(
    builder,
    {
      action: cycle.actionImpl.LinkRequirements,
      label: LINK_IMPLEMENTS_TO_REQUIREMENT,
      input: 'focus',
      category: view.category.General,
      target: trackerModel.class.Issue,
      // 🔴 THE ONLY READ-ONLY / PERMISSION GATE ON THIS PATH. A context menu in
      // a list never renders `EditIssue`, so its `effectiveReadonly` guard does
      // not apply here. See `canLinkRequirements`.
      visibilityTester: cycle.function.CanLinkRequirements,
      context: {
        mode: ['context', 'browser'],
        application: trackerModel.app.Tracker,
        group: 'associate'
      }
    },
    cycle.action.LinkRequirements
  )
}

export function createModel (builder: Builder): void {
  builder.createModel(TTypeCycleStatus, TCycle, TCycleIssue)

  defineCycle(builder)
  defineTypeClasses(builder)
  defineViewlets(builder)
  defineNavigation(builder)
  defineActions(builder)
}
