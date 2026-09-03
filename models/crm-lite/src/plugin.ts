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

import { crmLiteId } from '@hcengineering/crm-lite'
import crmLite from '@hcengineering/crm-lite-resources/src/plugin'
import { mergeIds, type IntlString } from '@hcengineering/platform'
import type { CardSection } from '@hcengineering/card'
import type { Doc, Ref } from '@hcengineering/core'
import type { Action, Viewlet } from '@hcengineering/view'

export default mergeIds(crmLiteId, crmLite, {
  viewlet: {
    KanbanLead: '' as Ref<Viewlet>
  },
  string: {
    // Label of the traceability CardSection. Declared model side because the
    // model is its only consumer; the text itself lives in
    // `crm-lite-assets/lang/{en,ru,zh}.json` under `crm-lite:string:Traceability`.
    Traceability: '' as IntlString
  },
  section: {
    // Fixed id so the section can be re-pointed (or removed) by a migration
    // instead of being re-created under a generated id on every model build.
    LeadTraceLinks: '' as Ref<CardSection>,
    // Task 7's required-field checklist. Fixed id for the same reason.
    LeadFields: '' as Ref<CardSection>
  },
  action: {
    // Given a fixed id so the action can be referenced (and removed) by a later
    // migration instead of being re-created under a generated id on every build.
    ConvertLeadToRequirement: '' as Ref<Action<Doc, any>>,
    DisqualifyLead: '' as Ref<Action<Doc, any>>
  },
  app: {
    // The HIDDEN workbench application that carries the public intake form.
    // Typed `Ref<Doc>` rather than `Ref<Application>` because this package
    // cannot import `@hcengineering/workbench` — see `defineIntakeApp` in
    // `./index.ts` for the whole argument.
    //
    // Fixed id for the usual reason (a migration must be able to find it), and
    // ALSO because `Workbench.svelte` resolves an application by `alias`, so a
    // churning `_id` would strand any `HiddenApplication` preference pointing
    // at the previous one.
    LeadIntake: '' as Ref<Doc>
  }
})
