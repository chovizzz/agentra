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

import type { Class, Ref } from '@hcengineering/core'
import type { Asset, IntlString, Plugin, Resource } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'

import type { LinkImplementsFn, LinkImplementsPairsFn, UnlinkImplementsFn } from './commands'
import type { TraceLink } from './types'

export * from './closingReferences'
export * from './commands'
export * from './coverage'
export * from './links'
export * from './sha256'
export * from './types'

/**
 * @public
 */
export const traceabilityId = 'traceability' as Plugin

/**
 * @public
 */
const traceability = plugin(traceabilityId, {
  class: {
    TraceLink: '' as Ref<Class<TraceLink>>
  },
  string: {
    Traceability: '' as IntlString,
    ConfigLabel: '' as IntlString,
    ConfigDescription: '' as IntlString,
    TraceLink: '' as IntlString,
    TraceLinks: '' as IntlString,
    Source: '' as IntlString,
    Target: '' as IntlString,
    Kind: '' as IntlString,
    State: '' as IntlString,
    // Kinds
    KindConvertedTo: '' as IntlString,
    KindImplements: '' as IntlString,
    KindVerifies: '' as IntlString,
    KindDefectOf: '' as IntlString,
    KindFixedBy: '' as IntlString,
    KindDeliveredIn: '' as IntlString,
    // States
    StateActive: '' as IntlString,
    StateOrphaned: '' as IntlString,
    StateRevoked: '' as IntlString,
    // Permission-filtered placeholder. Deliberately says nothing about the
    // object beyond the fact that a link exists.
    RestrictedLink: '' as IntlString,
    // `verifies` creation entry points (Task 15)
    LinkVerifies: '' as IntlString,
    LinkVerifiesToRequirement: '' as IntlString,
    LinkVerifiesFromRequirement: '' as IntlString,
    VerifiesLinked: '' as IntlString,
    VerifiesPartiallyFailed: '' as IntlString,
    // `implements` creation entry points (Task 12 / 12a). ONE popup, both
    // directions — the two "…ToRequirement" / "…FromRequirement" strings differ
    // only in which end the user pinned.
    LinkImplements: '' as IntlString,
    LinkImplementsToRequirement: '' as IntlString,
    LinkImplementsFromRequirement: '' as IntlString,
    ImplementsLinked: '' as IntlString,
    // `implements` WITHDRAWAL copy (Task 12a).
    //
    // 🔴 DECLARED HERE, not in `traceability-resources/src/plugin.ts` where they
    // started. `mergeIds` would fold them into the same
    // `traceability:string:*` namespace either way — the lang keys are
    // identical — but only a declaration in THIS package is visible to a caller
    // that does not import `traceability-resources`, and the withdrawal entry
    // point now has such callers.
    UnlinkImplements: '' as IntlString,
    UnlinkImplementsTitle: '' as IntlString,
    // ⚠️ The confirmation says THREE things on purpose: the row survives, it
    // stops counting towards delivery, and both endpoints become deletable
    // again. That last one is a real privilege change (the server's archivable
    // guard only blocks deletes for NON-revoked edges) and a user cannot be
    // expected to infer it from the word "unlink".
    UnlinkImplementsConfirm: '' as IntlString,
    ImplementsUnlinked: '' as IntlString,
    ImplementsAlreadyUnlinked: '' as IntlString,
    UnlinkImplementsFailed: '' as IntlString,
    // Requirement delivery summary
    Delivery: '' as IntlString,
    DeliveryNone: '' as IntlString,
    // Requirement coverage summary
    Coverage: '' as IntlString,
    CoverageNone: '' as IntlString,
    CoverageSuperseded: '' as IntlString,
    CoverageCovered: '' as IntlString,
    CoveragePassed: '' as IntlString,
    CoverageFailed: '' as IntlString,
    CoverageBlocked: '' as IntlString,
    CoverageSkipped: '' as IntlString,
    CoverageUntested: '' as IntlString,
    CoverageStale: '' as IntlString,
    // Delivery timeline (Task 20). One anchor object, its edges in the order
    // the linked artefacts appeared.
    Timeline: '' as IntlString,
    TimelineEmpty: '' as IntlString,
    // 🔴 "the server cannot answer" — NOT "there are no links". Shared by the
    // timeline and the dashboard because both degrade the same way.
    TimelineUnavailable: '' as IntlString,
    // Delivery dashboard (Task 20).
    Dashboard: '' as IntlString,
    DashboardEmpty: '' as IntlString,
    DashboardOutgoing: '' as IntlString,
    DashboardIncoming: '' as IntlString,
    // defect-of creation entry points
    CreateDefect: '' as IntlString,
    OpenDefect: '' as IntlString,
    DefectFailed: '' as IntlString
  },
  icon: {
    Traceability: '' as Asset,
    TraceLink: '' as Asset
  },
  //
  // 🔴 THE COMMANDS, ADDRESSABLE WITHOUT A DEPENDENCY ON THE IMPLEMENTATION.
  //
  // `traceability-resources` registers the real functions under exactly these
  // keys (`plugins/traceability-resources/src/index.ts`), and `addLocation`
  // supplies that module at runtime, so `await getResource(traceability.function
  // .LinkImplements)` works from any package that depends only on THIS one.
  //
  // ⚠️ THE KEY SPELLING IS THE CONTRACT. `identify()` mints the id as
  // `traceability:function:<key>`, and `getResource` looks the very same string
  // up in the resources module's `function` record — a key that differs by one
  // character compiles cleanly on both sides and throws only when a user clicks.
  // Any change here must be made in the `function:` block of
  // `plugins/traceability-resources/src/index.ts` in the same edit.
  //
  function: {
    LinkImplements: '' as Resource<LinkImplementsFn>,
    LinkImplementsPairs: '' as Resource<LinkImplementsPairsFn>,
    UnlinkImplements: '' as Resource<UnlinkImplementsFn>
  }
})

/**
 * @public
 */
export default traceability
