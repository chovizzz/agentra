<!--
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
-->
<!--
  `Action.actionPopup` for `cycle.action.SetCycle`.

  🔴 IT DOES NOT IMPLEMENT A BATCH LOOP, AND THAT IS THE POINT. The body of this
  component is the UPSTREAM `view.component.ValueSelector`, reached through the
  platform's component indirection rather than an import, so a multi-selection
  and a single row travel EXACTLY the same code path: `ValueSelector.svelte`
  spreads `value` into `docs = [...Array.isArray(value) ? value : [value]]` and
  calls `updateAttribute` once per document. Writing a second, bulk-only channel
  here would be a second place for the two behaviours to drift apart.

  🔴 `castRequest` IS MANDATORY, NOT AN OPTIMISATION. `cycle` is a MIXIN
  attribute. Without `castRequest`, `ValueSelector.svelte` resolves it with
  `hierarchy.getAttribute(Hierarchy.mixinOrClass(doc), 'cycle')` — which for an
  Issue that has not been mixed in yet is `tracker.class.Issue`, an ancestor walk
  that never sees a mixin attribute and THROWS. Naming the mixin makes
  `updateAttribute` take its `isMixin` branch and emit a `TxMixin`.

  🔴 THE GUARD IS WHOLE-BATCH. `checkCycleBulkSelection` refuses the entire
  selection rather than filtering it down to the rows that qualify: a bulk edit
  that silently drops rows leaves the user believing work was re-scheduled when
  it was not, and an "n of m updated" count is itself a side channel about
  objects behind a permission wall. On refusal the picker is never rendered, so
  there is nothing to click and no document is touched.

  ⚠️ The upstream `docMatches: ['space']` on the same action is the SECOND half
  of that guard, not a duplicate of it: `ActionHandler`'s keybinding path invokes
  `view.actionImpl.ValueSelector` directly and never reaches this component, and
  `docMatches` is what makes that path refuse a cross-project batch too (it
  renders `DontMatchCriteria` and updates nothing).
-->
<script lang="ts">
  import {
    checkCycleBulkSelection,
    cycleStatusOrder,
    isCycleAssignable,
    type Cycle,
    type CycleBulkRefusal
  } from '@hcengineering/cycle'
  import core, { type Doc, type Ref, type Space } from '@hcengineering/core'
  import { type IntlString } from '@hcengineering/platform'
  import { createQuery } from '@hcengineering/presentation'
  import { Component, Label, Loading, resizeObserver } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import { createEventDispatcher } from 'svelte'

  import cyclePlugin from '../plugin'

  export let value: Doc | Doc[]
  export let width: 'medium' | 'large' | 'full' = 'large'
  export let size: 'small' | 'medium' | 'large' = 'small'
  export let embedded: boolean = false

  const dispatch = createEventDispatcher()

  // 🔴 DERIVED FROM THE VOCABULARY, NEVER SPELLED OUT AS A LITERAL LIST. A
  // status appended to `cycleStatusOrder` later is classified by
  // `isCycleAssignable`, so a new non-terminal status becomes selectable without
  // anyone remembering to edit this file — and, just as importantly, a hardcoded
  // `['planned', 'active']` here could not be kept in step with an already
  // persisted Saved View filter.
  const openStatuses = cycleStatusOrder.filter((it) => isCycleAssignable({ status: it }))

  const refusalLabels: Record<CycleBulkRefusal, IntlString> = {
    empty: cyclePlugin.string.SetCycleEmpty,
    'cross-project': cyclePlugin.string.SetCycleCrossProject,
    forbidden: cyclePlugin.string.SetCycleForbidden
  }

  $: docs = (Array.isArray(value) ? value : [value]) as Array<Doc & { space: Cycle['space'] }>

  // The caller's writable spaces, resolved through the client rather than
  // guessed. Space security is enforced SERVER SIDE: a space the caller may not
  // see simply does not come back, and `archived` is the platform's own
  // read-only flag. That makes this a real permission signal without
  // `cycle-resources` taking a dependency on `view-resources` (whose
  // `canChangeAttribute` would otherwise be the tool) — a new cross-package
  // dependency would rewrite `pnpm-lock.yaml`.
  const spaceQuery = createQuery()
  let writable: Set<Ref<Space>> | undefined
  $: spaceQuery.query(
    core.class.Space,
    { _id: { $in: [...new Set(docs.map((it) => it.space as Ref<Space>))] } },
    (res) => {
      writable = new Set(res.filter((it) => !it.archived).map((it) => it._id))
    }
  )

  // ⚠️ Until the space query has answered, `writable` is `undefined` and the
  // selection is treated as NOT yet admissible. Defaulting to "allowed" would
  // flash a usable picker for a batch that is about to be refused.
  $: admission = checkCycleBulkSelection(docs, (doc) => writable?.has(doc.space as Ref<Space>) ?? false)

  // 🔴 THE STRUCTURAL REFUSALS DO NOT WAIT FOR THE QUERY. `empty` and
  // `cross-project` are decidable from the selection alone, so they are shown
  // immediately; only `forbidden` can be an artefact of `writable` not having
  // arrived yet, and that one is held behind the spinner below.
  $: structural = checkCycleBulkSelection(docs, () => true)

  $: selectorProps = admission.ok
    ? {
        value,
        attribute: 'cycle',
        _class: cyclePlugin.class.Cycle,
        // See the header: without this the attribute lookup throws.
        castRequest: cyclePlugin.mixin.CycleIssue,
        // Same project, and never a cycle that is already closed — filing work
        // into a terminal cycle hides it rather than scheduling it.
        query: {
          space: admission.space,
          status: { $in: openStatuses }
        },
        docMatches: ['space'],
        searchField: 'name',
        placeholder: cyclePlugin.string.SetCycle,
        width,
        size,
        embedded
      }
    : undefined
</script>

<!--
  ⚠️ `on:changeContent` IS DELIBERATELY NOT FORWARDED THROUGH `<Component>`.
  `packages/ui/src/components/Component.svelte` re-dispatches a fixed list
  (change / close / open / click / delete / action / valid / validate / submit /
  select / loaded) and `changeContent` is not on it, so writing `on:changeContent`
  here would compile and silently do nothing. The refusal branch below dispatches
  it itself, via `resizeObserver`, which is the only branch whose height this
  component actually owns.
-->
{#if selectorProps !== undefined}
  <Component
    is={view.component.ValueSelector}
    props={selectorProps}
    on:close={(evt) => {
      dispatch('close', evt.detail)
    }}
  />
{:else if !structural.ok}
  <div class="selectPopup" use:resizeObserver={() => dispatch('changeContent')}>
    <div class="flex-center p-4 max-w-60">
      <Label label={refusalLabels[structural.reason]} />
    </div>
  </div>
{:else if writable !== undefined}
  <div class="selectPopup" use:resizeObserver={() => dispatch('changeContent')}>
    <div class="flex-center p-4 max-w-60">
      <Label label={refusalLabels[admission.ok ? 'empty' : admission.reason]} />
    </div>
  </div>
{:else}
  <!--
    🔴 A SPINNER, NOT AN EMPTY BRANCH. `createQuery` never invokes its callback
    when the underlying find REJECTS — the query layer logs and returns — so
    `writable` can stay `undefined` forever. With no branch here the popup
    rendered as a zero-height nothing: the user clicks "Set cycle" and gets a
    blank rectangle with no way to tell a slow query from a dead one.
  -->
  <div class="selectPopup" use:resizeObserver={() => dispatch('changeContent')}>
    <div class="flex-center p-4 max-w-60"><Loading /></div>
  </div>
{/if}
