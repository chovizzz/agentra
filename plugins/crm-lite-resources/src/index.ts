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

import ConvertLeadPopup from './components/ConvertLeadPopup.svelte'
import CrmConfigPresenter from './components/CrmConfigPresenter.svelte'
import DisqualifyLeadPopup from './components/DisqualifyLeadPopup.svelte'
import LeadFieldsSection from './components/LeadFieldsSection.svelte'
import LeadIntakeForm from './components/LeadIntakeForm.svelte'
import KanbanCard from './components/KanbanCard.svelte'
import LeadPriorityEditor from './components/LeadPriorityEditor.svelte'
import LeadPriorityPresenter from './components/LeadPriorityPresenter.svelte'
import LeadStatusEditor from './components/LeadStatusEditor.svelte'
import LeadStatusPresenter from './components/LeadStatusPresenter.svelte'
import LeadTraceLinksSection from './components/LeadTraceLinksSection.svelte'
import { checkLeadFieldsVisibility, checkLeadTraceLinksVisibility } from './sections'
import { getAllLeadPriorities, getAllLeadStatuses, sortLeadPriorities, sortLeadStatuses } from './utils'

export default async (): Promise<Resources> => ({
  component: {
    KanbanCard,
    LeadStatusPresenter,
    CrmConfigPresenter,
    LeadPriorityPresenter,
    LeadStatusEditor,
    LeadPriorityEditor,
    LeadTraceLinksSection,
    LeadFieldsSection,
    LeadIntakeForm,
    ConvertLeadPopup,
    DisqualifyLeadPopup
  },
  function: {
    LeadStatusSort: sortLeadStatuses,
    GetAllLeadStatuses: getAllLeadStatuses,
    LeadPrioritySort: sortLeadPriorities,
    GetAllLeadPriorities: getAllLeadPriorities,
    CheckLeadTraceLinksVisibility: checkLeadTraceLinksVisibility,
    CheckLeadFieldsVisibility: checkLeadFieldsVisibility
  }
})
