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
import { mergeIds, type IntlString, type Resource } from '@hcengineering/platform'
import requirements, { requirementsId } from '@hcengineering/requirements'
import type { AnyComponent } from '@hcengineering/ui/src/types'
import type { GetAllValuesFunc, SortFunc } from '@hcengineering/view'

export default mergeIds(requirementsId, requirements, {
  component: {
    RequirementStatusPresenter: '' as AnyComponent,
    RequirementPriorityPresenter: '' as AnyComponent,
    // `inlineEditor` of `view.mixin.AttributeEditor`. Without these two the
    // status / priority rows do not render READ ONLY in the properties panel —
    // `AttributeBarEditor` is wrapped in `{#if editor}`, so they do not render
    // at all.
    RequirementStatusEditor: '' as AnyComponent,
    RequirementPriorityEditor: '' as AnyComponent,
    // Body of the `card.class.CardSection` that carries the traceability block
    // on a Requirement's detail page.
    RequirementTraceLinksSection: '' as AnyComponent,
    // Body of the `card.class.CardSection` that carries the editable acceptance
    // criteria. It is a SECTION rather than a properties row because
    // `acceptanceCriteria` is a `TypeCollaborativeDoc` and `models/view` hangs no
    // `view.mixin.AttributeEditor` on that type — see the component header.
    RequirementAcceptanceCriteriaSection: '' as AnyComponent,
    // Body of the `card.class.CardSection` that carries the coverage summary
    // and `verifies` entry point 2.
    RequirementCoverageSection: '' as AnyComponent,
    // Body of the `card.class.CardSection` that carries the delivery summary
    // and `implements` entry point 1.
    RequirementDeliverySection: '' as AnyComponent,
    // Body of the Roadmap `view.class.ViewletDescriptor` (Task 20). NOT a card
    // section: it receives `ViewletContentView`'s props (`_class` / `query` /
    // `space` / `options` / …), never the panel's `doc`.
    RequirementRoadmap: '' as AnyComponent,
    // 🔴 The next two are IMPLEMENTED IN `traceability-resources` and merely
    // published under a Requirement id. `models/requirements` already depends on
    // `requirements-resources`; pointing it at `traceability:component:*` would
    // have meant adding `@hcengineering/traceability{,-resources}` to the model
    // package for two `Ref`s and nothing else.
    RequirementTraceTimelineSection: '' as AnyComponent,
    RequirementDeliveryDashboardSection: '' as AnyComponent
  },
  string: {
    // Placeholder shown inside the empty acceptance-criteria editor. Declared
    // here rather than in `models/requirements` because the section component is
    // its only consumer; the model names only the section LABEL, which is the
    // already existing `requirements:string:AcceptanceCriteria`.
    AcceptanceCriteriaPlaceholder: '' as IntlString,
    // Roadmap body copy. Declared HERE rather than in `models/requirements`
    // because the component is the only consumer; the model declares only the
    // labels IT needs (the descriptor label and the two section headings).
    RoadmapEmpty: '' as IntlString,
    RoadmapUnscheduled: '' as IntlString,
    // Copy of the "split into work items" dialog (PM-006). Declared here for the
    // same reason as the two above: `SplitWorkItemsPopup` is the only consumer
    // and the model never names any of these.
    SplitIntoWorkItems: '' as IntlString,
    SplitHint: '' as IntlString,
    SplitCreate: '' as IntlString,
    SplitRetry: '' as IntlString,
    SplitProject: '' as IntlString,
    SplitPickProject: '' as IntlString,
    // The project list could not be READ — see `projectsUnavailable` in
    // `SplitWorkItemsPopup`. Deliberately distinct from "no projects yet".
    SplitProjectsUnavailable: '' as IntlString,
    SplitWorkItemTitle: '' as IntlString,
    SplitAddWorkItem: '' as IntlString,
    SplitRemoveWorkItem: '' as IntlString,
    SplitFrozen: '' as IntlString,
    SplitSucceeded: '' as IntlString,
    SplitInProgress: '' as IntlString,
    SplitRefused: '' as IntlString,
    SplitRefusedPartial: '' as IntlString,
    SplitErrored: '' as IntlString,
    SplitUnavailable: '' as IntlString,
    SplitReasonRequirementNotFound: '' as IntlString,
    SplitReasonRequirementNotLatest: '' as IntlString,
    SplitReasonProjectNotFound: '' as IntlString,
    SplitReasonTaskTypeNotFound: '' as IntlString,
    SplitReasonNoItems: '' as IntlString,
    SplitReasonIssueIdTaken: '' as IntlString,
    SplitReasonSequenceUnavailable: '' as IntlString,
    SplitReasonUnknown: '' as IntlString
  },
  function: {
    // Hung on `requirements.class.TypeRequirementStatus` via
    // `view.mixin.SortFuncs` / `view.mixin.AllValuesFunc`. Without the pair,
    // grouped list/table sections come out in arbitrary order and a status
    // nothing is in yet gets no group at all.
    RequirementStatusSort: '' as SortFunc,
    GetAllRequirementStatuses: '' as GetAllValuesFunc,
    RequirementPrioritySort: '' as SortFunc,
    GetAllRequirementPriorities: '' as GetAllValuesFunc,
    // `checkVisibility` of the traceability CardSection. A CardSection is
    // global, so this callback is the ONLY thing scoping the block to
    // Requirements.
    CheckRequirementTraceLinksVisibility: '' as Resource<(doc: Card) => Promise<boolean>>
  }
})
