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

import type { Card } from '@hcengineering/card'
import crmLite, { crmLiteId, type LeadPriority, type LeadStatus } from '@hcengineering/crm-lite'
import { mergeIds, type Resource } from '@hcengineering/platform'
import type { AnyComponent } from '@hcengineering/ui/src/types'
import type { SortFunc } from '@hcengineering/view'

export default mergeIds(crmLiteId, crmLite, {
  component: {
    KanbanCard: '' as AnyComponent,
    LeadStatusPresenter: '' as AnyComponent,
    // `view.mixin.ObjectPresenter` for BOTH configuration classes
    // (`CrmPipeline`, `LeadSource`). It is what lets those two be used as
    // filter keys at all — see the component for why the generic `ObjectFilter`
    // throws without one.
    CrmConfigPresenter: '' as AnyComponent,
    LeadPriorityPresenter: '' as AnyComponent,
    // `inlineEditor` of `view.mixin.AttributeEditor`. Without these two the
    // status / priority rows do not render READ ONLY in the properties panel —
    // `AttributeBarEditor` is wrapped in `{#if editor}`, so they do not render
    // at all.
    LeadStatusEditor: '' as AnyComponent,
    LeadPriorityEditor: '' as AnyComponent,
    // Body of the `card.class.CardSection` that carries the traceability block
    // on a Lead's detail page.
    LeadTraceLinksSection: '' as AnyComponent,
    // Opened by the `ConvertLeadToRequirement` action via
    // `view.actionImpl.ShowPopup`. The popup — not the action — is where the
    // idempotency key is bound, so one opened dialog is one unit of intent.
    ConvertLeadPopup: '' as AnyComponent,
    // Opened by the `DisqualifyLead` action, and ALSO by `LeadStatusEditor`
    // when the inline dropdown pick is `Disqualified` — see that component for
    // why the dropdown hands off instead of writing.
    DisqualifyLeadPopup: '' as AnyComponent,
    // Body of the `card.class.CardSection` that carries Task 7's required-field
    // checklist. It reports what is missing; it never blocks a write — the
    // fields it names are optional in the model and unguarded on the server.
    LeadFieldsSection: '' as AnyComponent,
    // The public intake form (PRD CRM-008). Declared here rather than in the
    // contract package for the same reason as every other component id: models
    // reference it by `Ref` and `addLocation` supplies the implementation.
    //
    // 🔴 It is NOT mounted by `models/crm-lite`, and the reason recorded here
    // used to be "a public form has to be reached WITHOUT a workbench session,
    // i.e. from a route in `dev/prod`". THAT WAS WRONG, and it sent at least one
    // attempt down a route that needed `@hcengineering/client` and
    // `@hcengineering/login` in this package. The correct mechanism, traced end
    // to end in the code, is a GUEST-ROLE WORKBENCH SESSION:
    //
    //   1. `server/account/src/operations.ts:743` `createAccessLink` mints a
    //      `GUEST_ACCOUNT` token carrying `grant { workspace, role, spaces }`
    //      and returns `<front>/login/auth?token=…&navigateUrl=…`. The caller
    //      must already be >= `AccountRole.User` (`verifyAllowedRole`, :807).
    //   2. `plugins/login-resources/src/components/Auth.svelte:71` forwards that
    //      `navigateUrl` to `navigateToWorkspace` (`login-resources/src/utils.ts:518`),
    //      which honours ANY location whose `path[1]` is the workspace url
    //      (:534-544) and otherwise falls back to the workbench root.
    //   3. The workbench serves guests: `SpecialNavModel.accessLevel` is
    //      OPTIONAL, and `isAllowedToRole` (`workbench-resources/src/utils.ts:145`)
    //      plus `getSpecialComponent` (`Workbench.svelte:641`) both treat
    //      `undefined` as "every role", `AccountRole.Guest` included.
    //
    // So the target this component wants is a `workbench` SPECIAL on an
    // application, addressed by `[workbenchId, wsUrl, <alias>, <specialId>]`.
    //
    // 🔴 WHY IT STILL IS NOT MOUNTED: creating that special means
    // `builder.createDoc(workbench.class.Application | ApplicationNavModel, …)`,
    // and `models/crm-lite/package.json` declares NEITHER
    // `@hcengineering/workbench` NOR `@hcengineering/model-workbench` (compare
    // `models/card/package.json`, which declares both and is why
    // `models/card/src/index.ts:606` can register the Card application). Adding
    // those two dependencies is the single blocker, and it is a deliberate,
    // owner-level decision rather than a drive-by edit.
    //
    // ⚠️ AND IT IS NOT SUFFICIENT ON ITS OWN. The one admin entry point that
    // already exists — `models/card/src/actions.ts:36-51`
    // `GetIndividualPublicLink` on `card.class.CardSpace`, which
    // `crmLite.space.Crm` is an instance of — calls `getSpaceAccessPublicLink`
    // (`card-resources/src/utils.ts:813`) with `spaces: [space._id]`, i.e. it
    // hands the guest the WHOLE CRM SPACE, every existing Lead included, and
    // points `navigateUrl` at the Card app root rather than at any form. A link
    // for intake must therefore be minted separately, with a `navigateUrl`
    // aimed at the special and WITHOUT granting `spaces`. Ship neither half
    // alone: a special with no link is unreachable, a link with today's
    // `spaces` grant is a pipeline leak.
    LeadIntakeForm: '' as AnyComponent
  },
  function: {
    // Hung on `crmLite.class.TypeLeadStatus` via `view.mixin.SortFuncs` /
    // `view.mixin.AllValuesFunc`. Without the pair, kanban columns come out in
    // arbitrary order and empty statuses get no column at all.
    LeadStatusSort: '' as SortFunc,
    GetAllLeadStatuses: '' as Resource<() => Promise<LeadStatus[]>>,
    LeadPrioritySort: '' as SortFunc,
    GetAllLeadPriorities: '' as Resource<() => Promise<LeadPriority[]>>,
    // `checkVisibility` of the traceability CardSection. A CardSection is
    // global, so this callback is the ONLY thing scoping the block to Leads.
    CheckLeadTraceLinksVisibility: '' as Resource<(doc: Card) => Promise<boolean>>,
    // Ditto for the required-field checklist: a CardSection carries no
    // `attachTo`, so this callback is the only thing keeping the block off every
    // other card class in the workspace.
    CheckLeadFieldsVisibility: '' as Resource<(doc: Card) => Promise<boolean>>
  }
})
