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

import { type Resources } from '@hcengineering/platform'
import { DeliveryDashboard, TraceTimeline } from '@hcengineering/traceability-resources'

import RequirementPriorityEditor from './components/RequirementPriorityEditor.svelte'
import RequirementPriorityPresenter from './components/RequirementPriorityPresenter.svelte'
import RequirementStatusEditor from './components/RequirementStatusEditor.svelte'
import RequirementStatusPresenter from './components/RequirementStatusPresenter.svelte'
import RequirementAcceptanceCriteriaSection from './components/RequirementAcceptanceCriteriaSection.svelte'
import RequirementCoverageSection from './components/RequirementCoverageSection.svelte'
import RequirementDeliverySection from './components/RequirementDeliverySection.svelte'
import RequirementRoadmap from './components/RequirementRoadmap.svelte'
import RequirementTraceLinksSection from './components/RequirementTraceLinksSection.svelte'
import { checkRequirementTraceLinksVisibility } from './sections'
import {
  getAllRequirementPriorities,
  getAllRequirementStatuses,
  sortRequirementPriorities,
  sortRequirementStatuses
} from './utils'

export default async (): Promise<Resources> => ({
  component: {
    RequirementStatusPresenter,
    RequirementPriorityPresenter,
    RequirementStatusEditor,
    RequirementPriorityEditor,
    RequirementTraceLinksSection,
    RequirementAcceptanceCriteriaSection,
    RequirementCoverageSection,
    RequirementDeliverySection,
    RequirementRoadmap,
    // Implemented in `traceability-resources`, published under a Requirement id
    // so `models/requirements` needs no dependency on that package.
    RequirementTraceTimelineSection: TraceTimeline,
    RequirementDeliveryDashboardSection: DeliveryDashboard
  },
  function: {
    RequirementStatusSort: sortRequirementStatuses,
    GetAllRequirementStatuses: getAllRequirementStatuses,
    RequirementPrioritySort: sortRequirementPriorities,
    GetAllRequirementPriorities: getAllRequirementPriorities,
    CheckRequirementTraceLinksVisibility: checkRequirementTraceLinksVisibility
  }
})
