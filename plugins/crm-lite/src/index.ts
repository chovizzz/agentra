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

import type { CardSpace, MasterTag } from '@hcengineering/card'
import type { Class, Ref } from '@hcengineering/core'
import type { Asset, IntlString, Plugin } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'

import type { CrmPipeline, LeadSource } from './types'

export * from './types'
export * from './intake'

/**
 * @public
 */
export const crmLiteId = 'crm-lite' as Plugin

/**
 * @public
 */
const crmLite = plugin(crmLiteId, {
  masterTag: {
    // Lead is a MasterTag, NOT a Tag. `Tag extends MasterTag, Mixin<Card>` is a
    // mixin and therefore cannot determine a document's `_class`; on top of that
    // `classHierarchyMixin` only walks the `extends` chain, so a Tag can never
    // participate in card versioning. The tag itself is produced by
    // `createSystemType()` in `models/crm-lite`.
    Lead: '' as Ref<MasterTag>
  },
  class: {
    // `Type` subclasses. They exist purely so that view mixins (SortFuncs,
    // AllValuesFunc, AttributePresenter) have a class to hang off — grouping
    // resolves the attribute's `attrClass`, not the owning class.
    TypeLeadStatus: '' as Ref<Class<any>>,
    TypeLeadPriority: '' as Ref<Class<any>>,
    CrmPipeline: '' as Ref<Class<CrmPipeline>>,
    LeadSource: '' as Ref<Class<LeadSource>>
  },
  space: {
    // A dedicated global CardSpace for CRM.
    //
    // 🔴 Deliberately NOT `card.space.Default`: that space is created with
    // `private: false, autoJoin: true`, which would make every lead readable by
    // the whole workspace.
    //
    // 🔴 It also deliberately reuses the single upstream `card.spaceType.SpaceType`
    // instead of declaring its own SpaceType: `models/card/src/migration.ts`
    // (`migrateRolesToBaseRole`) rewrites every Role whose `attachedTo` is not
    // `card.spaceType.SpaceType` back to it, so a private SpaceType would be
    // silently undone.
    //
    // ⚠️ `CardSpace.types` is a CLIENT-SIDE allow-list only — `createCard` does
    // not validate it server side. It is not a security boundary.
    Crm: '' as Ref<CardSpace>
  },
  ids: {
    // Deterministic ids for every singleton the migration creates. A
    // find-then-create with `generateId()` only looks idempotent in a serial
    // test: two migrators racing both find nothing and both insert. With a fixed
    // id they collide on the primary key instead.
    DefaultPipeline: '' as Ref<CrmPipeline>,
    SourceInbound: '' as Ref<LeadSource>,
    SourceOutbound: '' as Ref<LeadSource>,
    SourceReferral: '' as Ref<LeadSource>,
    SourceEvent: '' as Ref<LeadSource>,
    SourcePartner: '' as Ref<LeadSource>
  },
  string: {
    CrmLite: '' as IntlString,
    ConfigLabel: '' as IntlString,
    ConfigDescription: '' as IntlString,
    Lead: '' as IntlString,
    Leads: '' as IntlString,
    CrmSpace: '' as IntlString,
    CrmSpaceDescription: '' as IntlString,
    Account: '' as IntlString,
    Contact: '' as IntlString,
    Source: '' as IntlString,
    Pipeline: '' as IntlString,
    Owner: '' as IntlString,
    Status: '' as IntlString,
    Priority: '' as IntlString,
    NextActionAt: '' as IntlString,
    DisqualifyReason: '' as IntlString,
    Name: '' as IntlString,
    Description: '' as IntlString,
    Order: '' as IntlString,
    Stages: '' as IntlString,
    StatusNew: '' as IntlString,
    StatusContacted: '' as IntlString,
    StatusQualifying: '' as IntlString,
    StatusConverted: '' as IntlString,
    StatusDisqualified: '' as IntlString,
    PriorityNoPriority: '' as IntlString,
    PriorityUrgent: '' as IntlString,
    PriorityHigh: '' as IntlString,
    PriorityMedium: '' as IntlString,
    PriorityLow: '' as IntlString,
    DefaultPipeline: '' as IntlString,
    SourceInbound: '' as IntlString,
    SourceOutbound: '' as IntlString,
    SourceReferral: '' as IntlString,
    SourceEvent: '' as IntlString,
    SourcePartner: '' as IntlString,
    More: '' as IntlString,

    // ── Lead → Requirement conversion (CRM-T005 / CRM-T006) ────────────────
    // The three reply families of `agentra-command` must be distinguishable in
    // the UI, so each carries its own string rather than one generic failure.
    ConvertToRequirement: '' as IntlString,
    ConvertLeadHint: '' as IntlString,
    Convert: '' as IntlString,
    ConvertSucceeded: '' as IntlString,
    ConvertReplayed: '' as IntlString,
    OpenRequirement: '' as IntlString,
    ConvertInProgress: '' as IntlString,
    ConvertRefused: '' as IntlString,
    ConvertUnavailable: '' as IntlString,
    ConvertErrored: '' as IntlString,
    ReasonLeadNotFound: '' as IntlString,
    ReasonIllegalTransition: '' as IntlString,
    ReasonConvertedWithoutLink: '' as IntlString,
    ReasonInvalidTraceLink: '' as IntlString,
    ReasonRequirementIdTaken: '' as IntlString,
    ReasonMalformedInput: '' as IntlString,
    ReasonUnknown: '' as IntlString,

    // ── Disqualification (PRD §5.1) ────────────────────────────────────────
    // `Disqualified` is the one status that carries a MANDATORY payload, so it
    // gets its own action and its own dialog rather than riding the inline
    // status dropdown. The server refuses a reasonless write outright; these
    // strings exist so the user is asked BEFORE that refusal rather than after.
    Disqualify: '' as IntlString,
    DisqualifyLead: '' as IntlString,
    DisqualifyHint: '' as IntlString,
    DisqualifyReasonPlaceholder: '' as IntlString,
    DisqualifyNotAllowed: '' as IntlString,
    DisqualifyFailed: '' as IntlString,

    // ── Required-field completeness (Task 7 form validation) ───────────────
    // 🔴 EXPERIENCE LAYER ONLY. `LeadGuardMiddleware` enforces the state
    // machine, the command-only `Converted` and the mandatory disqualification
    // reason; it says NOTHING about account / contact / owner / nextActionAt.
    // These strings therefore describe a checklist the user is shown, never a
    // rule a write is refused by — see `validateLeadFields` in
    // `crm-lite-resources/src/utils.ts` for why that asymmetry is deliberate.
    RequiredFields: '' as IntlString,
    RequiredFieldsComplete: '' as IntlString,
    RequiredFieldsMissing: '' as IntlString,
    ConvertedReadonly: '' as IntlString,

    // ── Anonymous intake (PRD CRM-008) ─────────────────────────────────────
    // 🔴 THERE IS EXACTLY ONE FAILURE STRING, `IntakeFailed`, AND THAT IS A
    // SECURITY DECISION. The server distinguishes `intake-wrong-space`,
    // `intake-duplicate`, `intake-rate-limited` and `intake-empty-submission`
    // because an operator reading the logs needs to; the submitter must not be
    // able to tell them apart, or the public form becomes a probe with a
    // readout. `IntakeTitleRequired` is the one exception and it is safe: it is
    // decided entirely on the client, before any request, and states a fact
    // about the submitter's own empty box.
    IntakeFormTitle: '' as IntlString,
    IntakeHint: '' as IntlString,
    IntakeSubject: '' as IntlString,
    IntakeSubjectPlaceholder: '' as IntlString,
    // 🔴 TWO WORDINGS PER FIELD, FOR TWO AUDIENCES, AND THEY MUST NOT BE
    // MERGED. `Intake*` is what the STRANGER sees on the public form ("Your
    // name"); `LeadIntake*` is the attribute label the SALESPERSON sees on the
    // lead, and it carries "(unverified)" — the caveat that everything below is
    // self-declared by someone nobody has authenticated. Reusing the form
    // wording on the attribute would quietly drop that caveat exactly where it
    // is acted upon; reusing the attribute wording on the form would show a
    // visitor a form that distrusts them out loud.
    IntakeName: '' as IntlString,
    IntakeNamePlaceholder: '' as IntlString,
    IntakeEmail: '' as IntlString,
    IntakeEmailPlaceholder: '' as IntlString,
    IntakeMessage: '' as IntlString,
    IntakeMessagePlaceholder: '' as IntlString,
    LeadIntakeName: '' as IntlString,
    LeadIntakeEmail: '' as IntlString,
    LeadIntakeMessage: '' as IntlString,
    IntakeSubmit: '' as IntlString,
    IntakeThanks: '' as IntlString,
    IntakeSubmitAnother: '' as IntlString,
    IntakeTitleRequired: '' as IntlString,
    IntakeFailed: '' as IntlString
  },
  icon: {
    CrmLite: '' as Asset,
    Lead: '' as Asset
  }
})

/**
 * @public
 */
export default crmLite
