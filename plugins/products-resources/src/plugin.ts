//
// Copyright © 2024 Hardcore Engineering Inc.
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

import products, { productsId } from '@hcengineering/products'
import { type Ref, type Space } from '@hcengineering/core'
import { type IntlString, type Resource, mergeIds } from '@hcengineering/platform'
import { type ObjectSearchCategory, type ObjectSearchFactory } from '@hcengineering/presentation/src/types'
import { type AnyComponent } from '@hcengineering/ui/src/types'
import { type KeyFilter } from '@hcengineering/view'

export default mergeIds(productsId, products, {
  completion: {
    ProductQuery: '' as Resource<ObjectSearchFactory>,
    ProductQueryCategory: '' as Ref<ObjectSearchCategory>
  },
  function: {
    GetVisibleFilters: '' as Resource<(filters: KeyFilter[], space?: Ref<Space>) => Promise<KeyFilter[]>>
  },
  string: {
    Product: '' as IntlString,
    Products: '' as IntlString,
    ProductsApplication: '' as IntlString,
    ProductNamePlaceholder: '' as IntlString,
    ProductDescriptionPlaceholder: '' as IntlString,
    ProductVersion: '' as IntlString,
    ProductVersions: '' as IntlString,
    ProductVersionDescriptionPlaceholder: '' as IntlString,
    ProductVersionParent: '' as IntlString,
    ProductVersionState: '' as IntlString,
    SearchProduct: '' as IntlString,
    CreateProduct: '' as IntlString,
    CreateProductVersion: '' as IntlString,
    NoProductVersionParent: '' as IntlString,
    NoProductVersions: '' as IntlString,
    CreateDialogClose: '' as IntlString,
    CreateDialogCloseNote: '' as IntlString,
    Description: '' as IntlString,
    Icon: '' as IntlString,
    Color: '' as IntlString,
    Major: '' as IntlString,
    Minor: '' as IntlString,
    Patch: '' as IntlString,
    Codename: '' as IntlString,
    Private: '' as IntlString,
    Public: '' as IntlString,
    Members: '' as IntlString,
    ProductVersionStateActive: '' as IntlString,
    ProductVersionStateReleased: '' as IntlString,
    ProductVersionStatePlanning: '' as IntlString,
    ProductVersionStateReleaseCandidate: '' as IntlString,
    ProductVersionStateArchived: '' as IntlString,
    ChangeControl: '' as IntlString,
    ChangeSeverity: '' as IntlString,

    // ── REL-003 / REL-004 / REL-006: the release command and its gate. ─────
    ReleaseProductVersion: '' as IntlString,
    Release: '' as IntlString,
    ReleaseGate: '' as IntlString,
    ReleaseGatePassed: '' as IntlString,
    ReleaseGateFailed: '' as IntlString,
    ReleaseGateWaived: '' as IntlString,
    ReleaseBlockers: '' as IntlString,
    BlockerRequirementNotReady: '' as IntlString,
    BlockerWorkItemOpen: '' as IntlString,
    BlockerBlockingDefect: '' as IntlString,
    BlockerTestRunMissing: '' as IntlString,
    BlockerTestRunNoVerdicts: '' as IntlString,
    BlockerTestRunBelowThreshold: '' as IntlString,
    BlockerApprovalMissing: '' as IntlString,
    BlockerRestricted: '' as IntlString,
    BlockerUnknown: '' as IntlString,
    PassRate: '' as IntlString,
    // 🔴 THREE SEPARATE STRINGS FOR ONE ABSENT NUMBER. `passRate` is omitted in
    // two different situations and neither is "0%"; see `passRateDisplay`.
    PassRateNoVerdicts: '' as IntlString,
    PassRateRestricted: '' as IntlString,
    PassRateThreshold: '' as IntlString,
    NotEvaluated: '' as IntlString,
    WaiverReason: '' as IntlString,
    WaiverReasonPlaceholder: '' as IntlString,
    ReasonVersionNotFound: '' as IntlString,
    ReasonIllegalTransition: '' as IntlString,
    ReasonGateFailed: '' as IntlString,
    ReasonWaiverWithoutReason: '' as IntlString,
    ReasonMalformedInput: '' as IntlString,
    ReasonUnknown: '' as IntlString,
    ReleaseInProgress: '' as IntlString,
    ReleaseUnavailable: '' as IntlString,
    ReleaseErrored: '' as IntlString,
    ReleaseDone: '' as IntlString,
    ReleaseAlreadyDone: '' as IntlString,
    ReleaseWriteBackIncomplete: '' as IntlString,
    // ── §7.5: the READ-ONLY gate preview. ─────────────────────────────────
    GatePreviewLoading: '' as IntlString,
    GatePreviewUnavailable: '' as IntlString,
    RefreshGate: '' as IntlString,

    // ── REL-005: release notes. ───────────────────────────────────────────
    ReleaseNotes: '' as IntlString,
    ReleaseNotesGeneratedOn: '' as IntlString,
    GenerateReleaseNotes: '' as IntlString,
    RegenerateReleaseNotes: '' as IntlString,
    ReleaseNotesOverwriteTitle: '' as IntlString,
    ReleaseNotesOverwriteConfirm: '' as IntlString,
    ReleaseNotesReadonly: '' as IntlString,
    ReleaseNotesEmpty: '' as IntlString,
    ReleaseNotesRestricted: '' as IntlString,
    SectionRequirements: '' as IntlString,
    SectionImprovements: '' as IntlString,
    SectionBugFixes: '' as IntlString,
    SectionOther: '' as IntlString
  },
  component: {
    EditProduct: '' as AnyComponent,
    EditProductVersion: '' as AnyComponent,
    ReleaseProductVersionPopup: '' as AnyComponent,
    ReleaseNotesEditor: '' as AnyComponent
  }
})
