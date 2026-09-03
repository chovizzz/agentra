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

import type { CardSection } from '@hcengineering/card'
import type { Ref } from '@hcengineering/core'
import { mergeIds, type IntlString } from '@hcengineering/platform'
import { requirementsId } from '@hcengineering/requirements'
import requirements from '@hcengineering/requirements-resources/src/plugin'
import type { Viewlet, ViewletDescriptor } from '@hcengineering/view'

export default mergeIds(requirementsId, requirements, {
  viewlet: {
    // `createSystemType` already registers a generic Table / List / CardGrid
    // trio for the tag. These two are the Requirement-specific ones: they carry
    // the business columns and the `groupBy` list REQ-006 needs.
    TableRequirement: '' as Ref<Viewlet>,
    ListRequirement: '' as Ref<Viewlet>,
    // Task 20's roadmap. Its own viewlet AND its own descriptor: upstream ships
    // Table / RelationshipTable / List / MasterDetail / Tree / Document and
    // `task` adds Kanban, but there is no roadmap, timeline or dashboard
    // descriptor anywhere in the tree to reuse.
    RoadmapRequirement: '' as Ref<Viewlet>
  },
  viewletDescriptor: {
    Roadmap: '' as Ref<ViewletDescriptor>
  },
  string: {
    // Label of the traceability CardSection. Declared model side because the
    // model is its only consumer; the text itself lives in
    // `requirements-assets/lang/{en,ru,zh}.json` under
    // `requirements:string:Traceability`.
    Traceability: '' as IntlString,
    // Label of the coverage CardSection.
    Coverage: '' as IntlString,
    // Label of the delivery CardSection. Declared model side for the same
    // reason as the two above: the model is its only consumer, and the id it
    // needs is `requirements:string:Delivery`. The section BODY reads its own
    // labels out of `traceability-assets`; only this label is ours.
    Delivery: '' as IntlString,
    // Label of the Roadmap viewlet descriptor (Task 20).
    Roadmap: '' as IntlString,
    // Labels of the two Task 20 sections whose BODIES live in
    // `traceability-resources`; only the section headings are ours.
    TraceTimeline: '' as IntlString,
    DeliveryDashboard: '' as IntlString
  },
  section: {
    // Fixed id so the section can be re-pointed (or removed) by a migration
    // instead of being re-created under a generated id on every model build.
    RequirementTraceLinks: '' as Ref<CardSection>,
    RequirementAcceptanceCriteria: '' as Ref<CardSection>,
    RequirementCoverage: '' as Ref<CardSection>,
    RequirementDelivery: '' as Ref<CardSection>,
    RequirementTraceTimeline: '' as Ref<CardSection>,
    RequirementDeliveryDashboard: '' as Ref<CardSection>
  }
})
