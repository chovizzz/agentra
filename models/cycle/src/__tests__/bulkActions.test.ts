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
  TxOperations,
  updateAttribute,
  type Class,
  type Client,
  type Doc,
  type PersonId,
  type Ref,
  type Tx,
  type TxCreateDoc,
  type TxMixin,
  type TxUpdateDoc
} from '@hcengineering/core'
import {
  checkCycleBulkSelection,
  cycleId,
  cycleStatusOrder,
  isCycleAssignable,
  type Cycle,
  type CycleStatus
} from '@hcengineering/cycle'
import { Builder } from '@hcengineering/model'
import { createModel as createCoreModel } from '@hcengineering/model-core'
import trackerModel, { createModel as createTrackerModel } from '@hcengineering/model-tracker'
import view from '@hcengineering/model-view'
import type { IntlString } from '@hcengineering/platform'
import tracker, { trackerId, type Issue, type Project } from '@hcengineering/tracker'
import { type Action } from '@hcengineering/view'

import { createModel } from '..'
import cycle from '../plugin'

function creates<T extends Doc> (txes: Tx[], _class: Ref<Class<Doc>>): Array<TxCreateDoc<T>> {
  return txes.filter(
    (tx) => tx._class === core.class.TxCreateDoc && (tx as TxCreateDoc<Doc>).objectClass === _class
  ) as Array<TxCreateDoc<T>>
}

let txes: Tx[]
beforeAll(() => {
  const builder = new Builder()
  createModel(builder)
  txes = builder.getTxes()
})

function setCycleAction (): TxCreateDoc<Action> | undefined {
  return creates<Action>(txes, view.class.Action).find((it) => it.objectId === cycle.action.SetCycle)
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Registration
// ────────────────────────────────────────────────────────────────────────────

describe('SetCycle: how the action is registered', () => {
  it('is registered on the model at all', () => {
    // 🔴 The whole feature is a model registration. If the `createAction` call
    // is dropped or renamed, everything below would still typecheck and the
    // menu entry would simply never appear — which is why the very first
    // assertion is that the builder emitted the document.
    expect(setCycleAction()).toBeDefined()
  })

  it('takes `any` input, which IS the bulk mechanism', () => {
    // 🔴 There is no separate batch channel in this platform, and none is
    // written here. `input: 'any'` is what makes `ActionsPopup` /
    // `ActionHandler` hand the WHOLE selection array to the impl
    // (`impl(docs, ...)` for 'selection' | 'any' | 'none'), versus `docs[0]`
    // for 'focus'. `models/tracker`'s `SetPriority` / `SetAssignee` /
    // `SetMilestone` all read exactly this way.
    expect(setCycleAction()?.attributes.input).toBe('any')
  })

  it('targets the upstream Issue, not the Cycle and not the mixin', () => {
    // The rows a user multi-selects are Issues. Targeting the mixin would make
    // the action invisible: `Menu`/`ActionsPopup` resolve candidate actions
    // from the document's own class chain.
    expect(setCycleAction()?.attributes.target).toBe(tracker.class.Issue)
  })

  it('reuses the upstream ValueSelector impl rather than a hand written loop', () => {
    // 🔴 `plugins/view-resources/src/actionImpl.ts`'s `ValueSelector` is typed
    // `(doc: Doc | Doc[], ...)` and `ValueSelector.svelte` normalises with
    // `[...(Array.isArray(value) ? value : [value])]`. Single and multi
    // selection therefore execute the SAME code; a bespoke loop would only give
    // the two behaviours somewhere to diverge.
    expect(setCycleAction()?.attributes.action).toBe(view.actionImpl.ValueSelector)
  })

  it('names the mixin via castRequest, without which the attribute lookup THROWS', () => {
    // 🔴 `cycle` is a MIXIN attribute. `ValueSelector.svelte` otherwise resolves
    // it as `hierarchy.getAttribute(Hierarchy.mixinOrClass(doc), 'cycle')`,
    // which for an Issue that has never been assigned a cycle is
    // `tracker.class.Issue` — an ancestor walk that cannot see a mixin
    // attribute. `findAttribute` returning nothing makes `getAttribute` throw,
    // it does not degrade.
    const props = setCycleAction()?.attributes.actionProps as any
    expect(props.attribute).toBe('cycle')
    expect(props.castRequest).toBe(cycle.mixin.CycleIssue)
    expect(props._class).toBe(cycle.class.Cycle)
  })

  it('hides itself through a visibility tester rather than failing at click time', () => {
    expect(setCycleAction()?.attributes.visibilityTester).toBe(cycle.function.CanSetCycle)
  })

  it('renders the guarded popup on the menu path', () => {
    // `Menu.svelte` (`component: a.actionPopup`) and `ActionsPopup.svelte`
    // (`is={activeAction?.actionPopup}`) render THIS component instead of
    // invoking the impl, so the cross-project explanation is reachable from the
    // context menu and the command palette.
    expect(setCycleAction()?.attributes.actionPopup).toBe(cycle.component.SetCyclePopup)
  })

  it('does not disturb the CompleteCycle action', () => {
    const complete = creates<Action>(txes, view.class.Action).find((it) => it.objectId === cycle.action.CompleteCycle)
    // Still single-target: each completion carries its own rollover decision.
    expect(complete?.attributes.input).toBe('focus')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 2. Literal ids
// ────────────────────────────────────────────────────────────────────────────

describe('SetCycle: the resource ids, pinned to their literal strings', () => {
  // 🔴 WHY LITERALS AND NOT `toBeDefined()`. This package's `main` points at
  // `lib/`, so a test that compares two constants which BOTH resolve to
  // `undefined` from a stale build passes while shipping an empty label. Only a
  // literal on the right-hand side can catch that.
  it('namespaces every new id under the plugin id', () => {
    expect(cycle.string.SetCycle).toBe(`${cycleId}:string:SetCycle`)
    expect(cycle.string.SetCycleCrossProject).toBe(`${cycleId}:string:SetCycleCrossProject`)
    expect(cycle.string.SetCycleForbidden).toBe(`${cycleId}:string:SetCycleForbidden`)
    expect(cycle.string.SetCycleEmpty).toBe(`${cycleId}:string:SetCycleEmpty`)
    expect(cycle.component.SetCyclePopup).toBe(`${cycleId}:component:SetCyclePopup`)
    expect(cycle.function.CanSetCycle).toBe(`${cycleId}:function:CanSetCycle`)
    expect(cycle.action.SetCycle).toBe(`${cycleId}:action:SetCycle`)
  })

  it('gives the action a real label and placeholder', () => {
    expect(setCycleAction()?.attributes.label).toBe(`${cycleId}:string:SetCycle`)
    expect((setCycleAction()?.attributes.actionProps as any).placeholder).toBe(`${cycleId}:string:SetCycle`)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 3. What a multi-selection actually writes
// ────────────────────────────────────────────────────────────────────────────

/**
 * A `Hierarchy` containing this module's classifiers plus stubs for the two
 * upstream ones it hangs off, so the transaction assertions below run against
 * the platform's own resolution code instead of a hand rolled imitation.
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

function recordingOps (hierarchy: Hierarchy): { ops: TxOperations, sent: Tx[] } {
  const sent: Tx[] = []
  const client = {
    getHierarchy: () => hierarchy,
    getModel: () => undefined as any,
    findAll: async () => [] as any,
    findOne: async () => undefined,
    searchFulltext: async () => ({ docs: [] }) as any,
    close: async () => {},
    async tx (tx: Tx): Promise<any> {
      sent.push(tx)
      return {}
    }
  } as unknown as Client
  return { ops: new TxOperations(client, 'tester' as PersonId), sent }
}

function issue (id: string, space: string): Issue {
  return {
    _id: id as Ref<Issue>,
    _class: tracker.class.Issue,
    space: space as Ref<Project>,
    modifiedOn: 0,
    modifiedBy: 'tester' as PersonId
  } as unknown as Issue
}

/**
 * The EXACT sequence `plugins/view-resources/src/components/ValueSelector.svelte`
 * runs in `changeValue`, reduced to the lines that produce transactions —
 * including the `client.apply(...)` batch and the `_id` descending sort, both of
 * which change the SHAPE of what reaches the server.
 *
 * 🔴 IT IS THE SAME SEQUENCE FOR ONE DOC AND FOR MANY, which is the property
 * under test: the component normalises `Doc | Doc[]` into an array first and has
 * no other branch. Reproducing it rather than mounting the component keeps the
 * assertion at the transaction layer, where "N updates, zero creates" is
 * actually decidable.
 */
async function runValueSelector (
  hierarchy: Hierarchy,
  ops: TxOperations,
  value: Issue | Issue[],
  newValue: Ref<Cycle> | null
): Promise<void> {
  const docs = [...(Array.isArray(value) ? value : [value])]
  const changed = (d: Doc): boolean => (d as any).cycle !== newValue
  // 🔴 `client.apply(...)`, NOT a bare loop of `client.update`. Everything below
  // accumulates into ONE `TxApplyIf`, so a bulk edit either lands whole or not
  // at all — asserting against a plain `TxOperations` would have quietly tested
  // a weaker, non-atomic path than the one that ships.
  const apply = ops.apply('value-selector:test')
  // Sorting by `_id` gives every document in the batch the same relative
  // modified order on every run.
  docs.sort((a: Doc, b: Doc) => b._id.localeCompare(a._id))

  for (const it of docs.filter(changed)) {
    const cl = Hierarchy.mixinOrClass(it)
    const attr = hierarchy.getAttribute(cycle.mixin.CycleIssue, 'cycle')
    await updateAttribute(apply, it, cl, { key: 'cycle', attr }, newValue)
  }
  await apply.commit()
}

/**
 * The mutations inside whatever `commit()` produced.
 *
 * ⚠️ `ApplyOperations.commit` HAS TWO SHAPES and both are correct: a single
 * transaction is sent bare (the "individual update, no need for apply"
 * short-circuit), while two or more are wrapped in one `TxApplyIf`. A test that
 * only understood one of them would either miss the batching or report a
 * single-row edit as broken.
 */
function mutations (sent: Tx[]): Tx[] {
  return sent.flatMap((tx) => (tx._class === core.class.TxApplyIf ? ((tx as any).txes as Tx[]) : [tx]))
}

describe('SetCycle: what a multi-selection writes', () => {
  let hierarchy: Hierarchy
  beforeAll(() => {
    hierarchy = buildHierarchy()
  })

  it('emits exactly one update transaction per selected issue, and creates nothing', async () => {
    const { ops, sent } = recordingOps(hierarchy)
    const selection = [issue('i1', 'p1'), issue('i2', 'p1'), issue('i3', 'p1'), issue('i4', 'p1')]

    await runValueSelector(hierarchy, ops, selection, 'c1' as Ref<Cycle>)

    // One atomic envelope reaches the server, not four independent writes.
    expect(sent).toHaveLength(1)
    expect(sent[0]._class).toBe(core.class.TxApplyIf)

    const inner = mutations(sent)

    // 🔴 THE TRANSACTIONS ARE `TxMixin`, NOT `TxUpdateDoc`, and that is a
    // consequence of `cycle` being a mixin attribute rather than a defect:
    // `updateAttribute` (foundations/core/.../operations.ts) branches on
    // `hierarchy.isMixin(attr.attributeOf)` and calls `client.updateMixin`.
    // Asserting `TxUpdateDoc` here would be asserting that the field was moved
    // onto upstream `tracker.class.Issue` — the one thing this module must
    // never do.
    const updates = inner.filter((tx) => tx._class === core.class.TxMixin) as Array<TxMixin<Doc, Doc>>
    expect(updates).toHaveLength(selection.length)
    expect(inner.filter((tx) => tx._class === core.class.TxUpdateDoc) as TxUpdateDoc<Doc>[]).toHaveLength(0)
    // A bulk EDIT never creates. A stray create here would mean the mixin was
    // being materialised as a separate document.
    expect(inner.filter((tx) => tx._class === core.class.TxCreateDoc)).toHaveLength(0)
    expect(inner).toHaveLength(selection.length)

    expect(updates.map((tx) => tx.objectId).sort()).toEqual(['i1', 'i2', 'i3', 'i4'])
    for (const tx of updates) {
      expect(tx.mixin).toBe(cycle.mixin.CycleIssue)
      expect((tx.attributes as any).cycle).toBe('c1')
      // The host class stays the upstream Issue; the mixin is additive.
      expect(tx.objectClass).toBe(tracker.class.Issue)
    }
  })

  it('takes the identical path for a single document', async () => {
    const { ops, sent } = recordingOps(hierarchy)
    await runValueSelector(hierarchy, ops, issue('solo', 'p1'), 'c1' as Ref<Cycle>)
    // ⚠️ Bare, not wrapped: `ApplyOperations.commit` short-circuits a lone
    // transaction ("individual update, no need for apply"). Same call, same
    // loop, one fewer envelope — which is exactly the equivalence being claimed.
    expect(sent).toHaveLength(1)
    expect(sent[0]._class).toBe(core.class.TxMixin)
    expect(mutations(sent)).toHaveLength(1)
  })

  it('clearing the cycle is an update too, never a delete', async () => {
    const { ops, sent } = recordingOps(hierarchy)
    await runValueSelector(hierarchy, ops, [issue('i1', 'p1'), issue('i2', 'p1')], null)
    const inner = mutations(sent)
    expect(inner).toHaveLength(2)
    expect(inner.every((tx) => tx._class === core.class.TxMixin)).toBe(true)
    expect(inner.filter((tx) => tx._class === core.class.TxRemoveDoc)).toHaveLength(0)
  })

  it('batches every document into ONE atomic envelope', async () => {
    // 🔴 ATOMICITY IS PART OF THE CONTRACT, not an implementation detail. If
    // `client.apply` were dropped for a plain loop, a bulk edit could half
    // succeed — leaving the user with the "some rows moved" state that the
    // cross-project and permission guards exist to prevent.
    const { ops, sent } = recordingOps(hierarchy)
    await runValueSelector(
      hierarchy,
      ops,
      [issue('i1', 'p1'), issue('i2', 'p1'), issue('i3', 'p1')],
      'c1' as Ref<Cycle>
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]._class).toBe(core.class.TxApplyIf)
    expect(mutations(sent)).toHaveLength(3)
  })

  it('orders the batch by descending _id, so the modified order is stable', async () => {
    const { ops, sent } = recordingOps(hierarchy)
    await runValueSelector(
      hierarchy,
      ops,
      [issue('i1', 'p1'), issue('i3', 'p1'), issue('i2', 'p1')],
      'c1' as Ref<Cycle>
    )
    expect((mutations(sent) as Array<TxMixin<Doc, Doc>>).map((tx) => tx.objectId)).toEqual(['i3', 'i2', 'i1'])
  })

  it('would throw without castRequest, which is why the action passes it', () => {
    // 🔴 The failure mode this documents is a CRASH, not a blank field:
    // `getAttribute` throws when the ancestor walk finds nothing, and a mixin
    // attribute is never on the host class's own chain.
    expect(() => hierarchy.getAttribute(tracker.class.Issue, 'cycle')).toThrow()
    expect(() => hierarchy.getAttribute(cycle.mixin.CycleIssue, 'cycle')).not.toThrow()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 4. Cross-project selections
// ────────────────────────────────────────────────────────────────────────────

describe('SetCycle: a selection spanning two projects is refused WHOLE', () => {
  const canEditAll = (): boolean => true

  it('refuses rather than filtering down to the matching subset', () => {
    const docs = [issue('i1', 'p1'), issue('i2', 'p2'), issue('i3', 'p1')]
    const result = checkCycleBulkSelection(docs, canEditAll)
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.reason).toBe('cross-project')
    // 🔴 The refusal carries NO document list and NO count. "2 of 3 updated"
    // would be the silent-skip failure this test exists to prevent: the user
    // would believe every selected issue moved.
    expect((result as any).docs).toBeUndefined()
    expect((result as any).space).toBeUndefined()
  })

  it('admits a single-project selection and reports the project', () => {
    const docs = [issue('i1', 'p1'), issue('i2', 'p1')]
    const result = checkCycleBulkSelection(docs, canEditAll)
    expect(result.ok).toBe(true)
    expect(result.ok ? result.space : undefined).toBe('p1')
    expect(result.ok ? result.docs : []).toHaveLength(2)
  })

  it('refuses an empty selection instead of running a no-op batch', () => {
    const result = checkCycleBulkSelection([], canEditAll)
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.reason).toBe('empty')
  })

  it('carries the same guard on the keybinding path, via docMatches', () => {
    // 🔴 `ActionHandler.svelte` invokes the `actionImpl` DIRECTLY and never
    // renders `actionPopup`, so `SetCyclePopup`'s own guard is not reached from
    // a keyboard shortcut. `docMatches: ['space']` is what refuses the batch
    // there: `ValueSelector.svelte` sets `docMatch = false` and renders
    // `DontMatchCriteria` INSTEAD of the picker, so no document is touched.
    const props = setCycleAction()?.attributes.actionProps as any
    expect(props.docMatches).toEqual(['space'])
    // And `fillQuery` is what keeps a foreign project's cycle out of the
    // candidate list in the first place — for a multi-selection it builds
    // `{ space: { $in: [...] } }`, which without `docMatches` would happily
    // offer a cycle belonging to only some of the selected issues.
    expect(props.fillQuery).toEqual({ space: 'space' })
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 5. Permission
// ────────────────────────────────────────────────────────────────────────────

describe('SetCycle: an issue the caller may not edit sinks the whole batch', () => {
  it('returns false — it does not return a filtered list', () => {
    const docs = [issue('i1', 'p1'), issue('secret', 'p1'), issue('i3', 'p1')]
    const forbidden = new Set(['secret'])
    const result = checkCycleBulkSelection(docs, (it) => !forbidden.has(it._id))

    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.reason).toBe('forbidden')
    // 🔴 THE COUNT IS THE SIDE CHANNEL, which is why there is no count. A "2 of
    // 3 updated" answer tells the caller that a third object exists behind the
    // wall; refusing whole tells them nothing they did not already select.
    expect((result as any).docs).toBeUndefined()
    expect(Object.keys(result)).toEqual(['ok', 'reason'])
  })

  it('reports cross-project BEFORE forbidden, so the reason leaks nothing', () => {
    // Both faults present. Answering "forbidden" first would let a caller probe
    // which foreign projects hold objects they cannot see; the shape of their
    // own selection is something they already know.
    const docs = [issue('i1', 'p1'), issue('secret', 'p2')]
    const result = checkCycleBulkSelection(docs, (it) => it._id !== 'secret')
    expect(result.ok ? undefined : result.reason).toBe('cross-project')
  })

  it('admits the batch only when every member passes', () => {
    const docs = [issue('i1', 'p1'), issue('i2', 'p1')]
    expect(checkCycleBulkSelection(docs, () => true).ok).toBe(true)
    expect(checkCycleBulkSelection(docs, (it) => it._id === 'i1').ok).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 6. Saved View: the `alias` mounting point
// ────────────────────────────────────────────────────────────────────────────

describe('Saved View: every Application this module rides on has a non-empty alias', () => {
  // 🔴 `alias` IS THE ONLY MOUNTING POINT. `Navigator.svelte:175` renders
  // `<SavedView alias={currentApplication?.alias} />`, and `SavedView.svelte`
  // queries `view.class.FilteredView` by `attachedTo: alias`. An Application
  // with no alias yields `attachedTo: undefined`: the section renders nothing
  // and NOTHING FAILS — compile clean, feature silently absent.
  it('declares no Application of its own — Cycles ride inside upstream Tracker', () => {
    // Established by `defineNavigation`: an `ApplicationNavModel` that extends
    // `tracker.app.Tracker`. Riding an upstream Application is what makes this
    // module structurally incapable of being the one that forgets an alias —
    // it inherits Tracker's, which upstream sets to `trackerId`.
    expect(creates<Doc>(txes, 'workbench:class:Application' as Ref<Class<Doc>>)).toHaveLength(0)
    const navModels = creates<Doc>(txes, 'workbench:class:ApplicationNavModel' as Ref<Class<Doc>>)
    expect(navModels).toHaveLength(1)
    expect((navModels[0].attributes as any).extends).toBe(trackerModel.app.Tracker)
    expect(trackerModel.app.Tracker).toBe(`${trackerId}:app:Tracker`)
  })

  it('and Tracker — the Application it actually rides — carries a non-empty alias', () => {
    // 🔴 BUILT FROM THE REAL UPSTREAM MODEL, not asserted from memory and not
    // asserted as a constant. `models/tracker` writes `alias: trackerId` on its
    // Application; this reads the transaction that call produces.
    //
    // ⚠️ `createCoreModel` FIRST IS MANDATORY. `defineNotifications` ->
    // `generateClassNotificationTypes` walks `hierarchy.getAncestors(...)`, so a
    // Builder that has never seen `core:class:Doc` throws "ancestors not found"
    // — which reads exactly like "tracker's model is broken".
    const builder = new Builder()
    createCoreModel(builder)
    createTrackerModel(builder)

    const apps = creates<any>(builder.getTxes(), 'workbench:class:Application' as Ref<Class<Doc>>).filter(
      (it) => it.objectId === trackerModel.app.Tracker
    )
    expect(apps).toHaveLength(1)

    const alias = apps[0].attributes.alias
    expect(typeof alias).toBe('string')
    // 🔴 NON-EMPTY, NOT MERELY DEFINED, and the difference is the whole test.
    // `SavedView.svelte` skips the query only when alias is `undefined`; an
    // EMPTY STRING passes that guard and queries `{ attachedTo: '' }`, which
    // matches nothing and renders no section — the same silent disappearance,
    // reached by a different route.
    expect(alias.length).toBeGreaterThan(0)
    expect(alias).toBe(trackerId)
  })

  it('would fail the day this module DOES declare one without an alias', () => {
    // 🔴 THE REGRESSION GUARD, not a tautology. The loop is empty today. The
    // moment someone adds `builder.createDoc(workbench.class.Application, ...)`
    // here, this test starts demanding the field whose absence is otherwise
    // invisible: `Navigator.svelte:175` passes `currentApplication?.alias` to
    // `SavedView`, which queries `FilteredView` by `attachedTo: alias` — an
    // undefined alias yields an empty section and no error anywhere.
    for (const app of creates<any>(txes, 'workbench:class:Application' as Ref<Class<Doc>>)) {
      const alias = app.attributes.alias
      expect(typeof alias).toBe('string')
      expect(String(alias).length).toBeGreaterThan(0)
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 7. Saved View: the frozen-enum hazard
// ────────────────────────────────────────────────────────────────────────────

/**
 * A stand-in for what `FilterSave.svelte` persists: `JSON.stringify($filterStore)`,
 * i.e. the selected ENUM VALUES frozen as literals inside a string. Nothing in
 * the platform ever revisits it, so it is only as durable as the vocabulary it
 * captured.
 */
function savedFilter (key: string, values: string[]): string {
  return JSON.stringify([{ key: { key }, value: values, mode: 'view:filter:FilterObjectIn' }])
}

function applySavedFilter<T extends { status: string }> (filters: string, rows: T[]): T[] {
  const parsed = JSON.parse(filters) as Array<{ key: { key: string }, value: string[] }>
  return rows.filter((row) => parsed.every((f) => f.value.includes((row as any)[f.key.key])))
}

describe('Saved View: a filter survives an enum APPEND and only an append', () => {
  const rows = [
    { _id: 'a', status: 'planned' as CycleStatus },
    { _id: 'b', status: 'active' as CycleStatus },
    { _id: 'c', status: 'completed' as CycleStatus }
  ]
  const saved = savedFilter('status', ['planned', 'active'])

  it('still matches exactly the original rows after a new value is appended', () => {
    // The append: a hypothetical fifth status added at the END of the
    // vocabulary, the way `TestRunStatus.Skipped = 4` was added.
    const widened = [...rows, { _id: 'd', status: 'deferred' as CycleStatus }]
    expect(applySavedFilter(saved, widened).map((it) => it._id)).toEqual(['a', 'b'])
  })

  it('matches ZERO rows if a value is renamed — silently, with no error', () => {
    // 🔴 THE WHOLE REASON `CycleStatus` IS APPEND-ONLY. This is what a rename
    // does to every saved view in every workspace: no exception, no warning,
    // just an empty list the user reads as "nothing matches".
    const renamed = rows.map((it) => ({ ...it, status: it.status === 'planned' ? 'scheduled' : it.status }))
    expect(applySavedFilter(saved, renamed).map((it) => it._id)).toEqual(['b'])
    expect(applySavedFilter(savedFilter('status', ['scheduled']), rows)).toHaveLength(0)
  })

  it('keeps the vocabulary in the order the persisted filters were written against', () => {
    // Reordering is as damaging as renaming for anything that stored an INDEX;
    // this module stores strings, so the guarantee to keep is that the existing
    // prefix never moves.
    expect(cycleStatusOrder.slice(0, 4)).toEqual(['planned', 'active', 'completed', 'cancelled'])
  })

  it('derives the assignable set from the vocabulary rather than a literal list', () => {
    // So that appending a non-terminal status makes it selectable in the picker
    // without anyone editing `SetCyclePopup.svelte` — and so a saved view built
    // on the old set keeps working.
    expect(cycleStatusOrder.filter((it) => isCycleAssignable({ status: it }))).toEqual(['planned', 'active'])
  })
})
