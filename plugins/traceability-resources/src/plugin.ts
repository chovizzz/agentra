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

import { mergeIds, type IntlString, type Resource } from '@hcengineering/platform'
import traceability, { traceabilityId, type TraceLinkKind } from '@hcengineering/traceability'
import type { AnyComponent } from '@hcengineering/ui/src/types'

export default mergeIds(traceabilityId, traceability, {
  //
  // 🔴 NO `string:` BLOCK ANY MORE. The `implements` withdrawal copy used to be
  // declared here; it now lives in `@hcengineering/traceability` alongside every
  // other `traceability:string:*` id, because `RequirementDeliverySection`
  // renders that copy and reaches the ids through the descriptor package.
  // Re-declaring any of them here would not shadow the descriptor — `identify()`
  // THROWS `'identify' overwrites '<key>'` on a key the namespace already has.
  //
  component: {
    /**
     * The traceability block for an object detail page. Takes `object` and
     * renders both directions; `models/traceability` hangs it on the endpoint
     * classes via `view.mixin.ObjectEditorSection` (or the module's own panel).
     */
    TraceLinksSection: '' as AnyComponent,
    /** One edge, including the "restricted link" degradation. */
    TraceLinkPresenter: '' as AnyComponent,
    /** The `kind` chip of an edge. */
    TraceLinkKindPresenter: '' as AnyComponent,
    /** The server-computed visible / restricted counts. */
    TraceCoveragePresenter: '' as AnyComponent,
    /**
     * The ONE picker behind all three `verifies` entry points. Registered so a
     * model in another module can open it by platform id without taking a
     * build-time dependency on this package.
     */
    LinkVerifiesPopup: '' as AnyComponent,
    /**
     * The ONE picker behind BOTH `implements` entry points. Registered so a
     * model in another module (notably a `view.class.Action` on
     * `tracker.class.Issue`) can open it by platform id without taking a
     * build-time dependency on this package.
     */
    LinkImplementsPopup: '' as AnyComponent,
    /** Raise (or open) the `defect-of` bug for a result, case or requirement. */
    DefectButton: '' as AnyComponent,
    /**
     * The ONE withdrawal entry point for an `implements` edge. Registered so a
     * model in another module can place it by platform id without taking a
     * build-time dependency on this package.
     */
    UnlinkImplementsButton: '' as AnyComponent,
    /**
     * Task 20 delivery views. Both take the CARD SECTION contract (`doc` /
     * `hidden` / `readonly` and a `loaded` event), so a model in another module
     * can hang them on a `card.class.CardSection` directly — which is what
     * `models/requirements` does, under its own component ids, because THAT
     * model already depends on `requirements-resources` and adding a second
     * resources dependency to it would be a new cross-package edge for two
     * `Ref`s.
     */
    TraceTimeline: '' as AnyComponent,
    DeliveryDashboard: '' as AnyComponent
  },
  function: {
    /** `TraceLinkKind` -> its `IntlString`. Exposed so models can label chips. */
    TraceLinkKindLabel: '' as Resource<(kind: TraceLinkKind) => IntlString>
  }
})
