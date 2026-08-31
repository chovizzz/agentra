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

import { canTransitionCycle, checkCycleBulkSelection, type Cycle } from '@hcengineering/cycle'
import core, { AccountRole, getCurrentAccount, type Doc, type Ref, type Space } from '@hcengineering/core'
import { type Resources } from '@hcengineering/platform'
import { getClient } from '@hcengineering/presentation'
import { showPopup } from '@hcengineering/ui'

import CompleteCyclePopup from './components/CompleteCyclePopup.svelte'
import CreateCycle from './components/CreateCycle.svelte'
import CycleEditor from './components/CycleEditor.svelte'
import CyclePresenter from './components/CyclePresenter.svelte'
import CycleRefPresenter from './components/CycleRefPresenter.svelte'
import CycleStatusEditor from './components/CycleStatusEditor.svelte'
import CycleStatusPresenter from './components/CycleStatusPresenter.svelte'
import CyclesView from './components/CyclesView.svelte'
import SetCyclePopup from './components/SetCyclePopup.svelte'
import {
  getAllCycleStatuses,
  linkRequirementsPopupProps,
  LINK_IMPLEMENTS_POPUP,
  REQUIREMENT_MASTER_TAG,
  sortCycleStatuses
} from './utils'

/**
 * `Action.action` for "Complete cycle".
 *
 * ⚠️ Takes the first document only. The command is keyed on ONE cycle
 * (`completeCycleIdempotencyKey`) and each completion needs its own rollover
 * decision, so a multi-select would have to open one dialog per cycle — which
 * is worse than making the action single-target and letting the menu offer it
 * per row.
 */
async function completeCycleAction (doc?: Doc | Doc[]): Promise<void> {
  const cycle = (Array.isArray(doc) ? doc[0] : doc) as Cycle | undefined
  if (cycle === undefined) return
  showPopup(CompleteCyclePopup, { value: cycle }, 'top')
}

/**
 * `Action.visibilityTester`.
 *
 * 🔴 Reads the state machine rather than restating it: only a cycle for which
 * `planned/active -> completed` is legal may be offered the action. The command
 * refuses the rest anyway; this keeps the menu from advertising a click that is
 * guaranteed to fail.
 */
async function canCompleteCycle (doc?: Doc | Doc[]): Promise<boolean> {
  // A multi-selection is refused outright rather than silently acting on the
  // first row: each completion carries its own rollover decision.
  if (Array.isArray(doc) && doc.length !== 1) {
    return false
  }
  const cycle = (Array.isArray(doc) ? doc[0] : doc) as Cycle | undefined
  if (cycle?.status === undefined) {
    return false
  }
  return canTransitionCycle(cycle.status, 'completed')
}

/**
 * `Action.visibilityTester` for "Set cycle".
 *
 * 🔴 WHOLE-BATCH, AND DELIBERATELY NOT A FILTER. It answers a single yes/no for
 * the entire selection. The alternative — offer the action and quietly act on
 * the subset the caller may write — is worse twice over: the user believes every
 * selected issue moved, and the resulting "n of m updated" count reports how
 * many objects exist behind a wall they are not allowed to see. Refusing the
 * whole selection produces no count at all.
 *
 * 🔴 `space` IS THE PERMISSION BOUNDARY, and asking the client for it is what
 * makes this a real check rather than a restatement of the UI's own state.
 * `SpaceSecurityMiddleware` intersects an `_id: { $in: [...] }` query with the
 * account's permitted spaces SERVER SIDE, and the query layer does not answer
 * this shape from the local cache (`Refs.findFromDocs` short-circuits only a
 * plain string `_id` or `limit: 1`) — so a space that does not come back is one
 * the caller genuinely cannot see. `archived` is the platform's read-only flag.
 *
 * 🔴 READABLE IS NOT WRITABLE, WHICH IS WHY THE ROLE IS CHECKED SEPARATELY. A
 * `ReadOnlyGuest` / `DocGuest` IS a member of the spaces they browse, so the
 * query above returns those spaces happily; every transaction they then send is
 * refused by `guestPermissions`. Without this guard the action would be offered
 * and fail only on click. `SavedView.svelte` gates on exactly these two roles
 * for the same reason.
 *
 * ⚠️ STILL NOT THE ENFORCEMENT, AND NOT CLAIMED TO BE. Per-attribute permission
 * lives in `canChangeAttribute` (`plugins/view-resources/src/permissions.ts`),
 * which this package cannot reach without depending on `view-resources` and
 * rewriting `pnpm-lock.yaml`. The transactor is the real gate; this keeps the
 * menu honest about the cases it can see from here.
 */
async function canSetCycle (doc?: Doc | Doc[]): Promise<boolean> {
  const docs = (doc === undefined ? [] : Array.isArray(doc) ? doc : [doc]) as Array<Doc & { space: Ref<Space> }>
  // Cheap structural refusals first, so a cross-project selection never causes a
  // query that would tell the caller which foreign spaces exist.
  const structural = checkCycleBulkSelection(docs, () => true)
  if (!structural.ok) {
    return false
  }
  const role = getCurrentAccount().role
  if (role === AccountRole.ReadOnlyGuest || role === AccountRole.DocGuest) {
    return false
  }
  const spaces = await getClient().findAll(core.class.Space, {
    _id: { $in: [...new Set(docs.map((it) => it.space))] }
  })
  const writable = new Set(spaces.filter((it) => !it.archived).map((it) => it._id))
  return checkCycleBulkSelection(docs, (it) => writable.has(it.space)).ok
}

/**
 * `Action.action` for "Link requirements" on an Issue.
 *
 * 🔴 THE `_id` IS WRAPPED IN AN ARRAY BY {@link linkRequirementsPopupProps},
 * and it must never be built inline here: `LinkImplementsPopup.fixed` is
 * `Array<Ref<Doc>>` and a bare `Ref` is a string, which its `for…of` would
 * iterate one CHARACTER at a time straight into the `linkImplements` command.
 * `showPopup` types `props` as `any`, so nothing catches that at compile time.
 *
 * ⚠️ Single-target (`input: 'focus'`). The popup accepts several fixed
 * documents, but the pair matrix it builds is `fixed × picked`, so a
 * multi-select would silently link every selected issue to every picked
 * requirement — a very different intent from the one a context menu implies.
 *
 * ⚠️ The popup is addressed BY ID, not imported. That is what keeps this
 * package free of a `traceability-resources` dependency; see the constants in
 * `utils.ts`.
 */
async function linkRequirementsAction (doc?: Doc | Doc[]): Promise<void> {
  const issue = Array.isArray(doc) ? doc[0] : doc
  if (issue === undefined) return
  showPopup(LINK_IMPLEMENTS_POPUP, linkRequirementsPopupProps(issue._id), 'top')
}

/**
 * `Action.visibilityTester` for "Link requirements".
 *
 * 🔴 THIS IS THE ONLY READ-ONLY GATE THE ACTION HAS. `EditIssue.svelte` guards
 * its own body with `effectiveReadonly`, but a context menu opened from a list
 * row never goes through that component — `ActionHandler` resolves the action
 * from the model and calls `visibilityTester` and nothing else. Anything this
 * function fails to refuse is offered.
 *
 * 🔴 THE SPACE QUERY IS DELIBERATELY `$in`, NOT A PLAIN `_id`. `Refs.findFromDocs`
 * short-circuits a plain string `_id` out of the local cache, which would answer
 * from documents the client happens to hold rather than from the server — and it
 * is `SpaceSecurityMiddleware`'s intersection with the account's permitted
 * spaces that makes this a real check. `canSetCycle` uses the same shape for the
 * same reason.
 *
 * 🔴 READABLE IS NOT WRITABLE. A `ReadOnlyGuest` / `DocGuest` IS a member of the
 * spaces they browse, so the query above returns their spaces happily while
 * every transaction they send is refused by `guestPermissions`. Creating a trace
 * edge is a write.
 *
 * ⚠️ `hasClass` KEEPS THE ACTION OFF A WORKSPACE WITHOUT THE REQUIREMENTS
 * MODULE. `requirements:masterTag:Requirement` is created by `createSystemType`
 * as a `ClassifierKind.CLASS` classifier, so this answers `false` exactly when
 * the module is absent — where the popup would otherwise open over a class that
 * lists nothing.
 *
 * ⚠️ NOT THE ENFORCEMENT, and not claimed to be. The `linkImplements` command
 * re-checks on the server; this only keeps the menu from advertising a click
 * that is guaranteed to fail.
 */
async function canLinkRequirements (doc?: Doc | Doc[]): Promise<boolean> {
  const docs = (doc === undefined ? [] : Array.isArray(doc) ? doc : [doc]) as Array<Doc & { space: Ref<Space> }>
  // Single-target, matching `input: 'focus'`. See `linkRequirementsAction`.
  if (docs.length !== 1) {
    return false
  }
  const role = getCurrentAccount().role
  if (role === AccountRole.ReadOnlyGuest || role === AccountRole.DocGuest) {
    return false
  }
  const client = getClient()
  if (!client.getHierarchy().hasClass(REQUIREMENT_MASTER_TAG)) {
    return false
  }
  const spaces = await client.findAll(core.class.Space, { _id: { $in: [docs[0].space] } })
  return spaces.some((it) => !it.archived)
}

export default async (): Promise<Resources> => ({
  component: {
    CycleStatusPresenter,
    CycleStatusEditor,
    CyclePresenter,
    CycleRefPresenter,
    CycleEditor,
    CreateCycle,
    CompleteCyclePopup,
    SetCyclePopup,
    CyclesView
  },
  function: {
    CycleStatusSort: sortCycleStatuses,
    GetAllCycleStatuses: getAllCycleStatuses,
    CanCompleteCycle: canCompleteCycle,
    CanSetCycle: canSetCycle,
    CanLinkRequirements: canLinkRequirements
  },
  actionImpl: {
    CompleteCycle: completeCycleAction,
    LinkRequirements: linkRequirementsAction
  }
})
