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

import { linkImplements, linkImplementsPairs, unlinkImplements } from './commands'
import DefectButton from './components/DefectButton.svelte'
import DeliveryDashboard from './components/DeliveryDashboard.svelte'
import LinkImplementsPopup from './components/LinkImplementsPopup.svelte'
import LinkVerifiesPopup from './components/LinkVerifiesPopup.svelte'
import TraceCoveragePresenter from './components/TraceCoveragePresenter.svelte'
import TraceLinkKindPresenter from './components/TraceLinkKindPresenter.svelte'
import TraceLinkPresenter from './components/TraceLinkPresenter.svelte'
import TraceLinksSection from './components/TraceLinksSection.svelte'
import TraceTimeline from './components/TraceTimeline.svelte'
import UnlinkImplementsButton from './components/UnlinkImplementsButton.svelte'
import { traceLinkKindLabel } from './utils'

export { default as DefectButton } from './components/DefectButton.svelte'
// 🔴 Re-exported as VALUES, not just registered as resources: `models/requirements`
// hangs them on `card.class.CardSection` under `requirements:component:*` ids,
// and `requirements-resources` resolves those ids by importing them from here.
export { default as TraceTimeline } from './components/TraceTimeline.svelte'
export { default as DeliveryDashboard } from './components/DeliveryDashboard.svelte'
export { default as TraceLinksSection } from './components/TraceLinksSection.svelte'
export { default as LinkVerifiesPopup } from './components/LinkVerifiesPopup.svelte'
export { default as LinkImplementsPopup } from './components/LinkImplementsPopup.svelte'
export { default as UnlinkImplementsButton } from './components/UnlinkImplementsButton.svelte'
// One EDGE row, with its own withdrawal entry point and the "restricted link"
// degradation. Exported as a value so a section that renders its own list of
// edges (`RequirementDeliverySection`) reuses the visibility rules instead of
// restating them — and gets the `unlinked` / `failed` events, which `Component`
// does NOT forward (it forwards a fixed list: change/close/open/click/delete/
// action/valid/validate/submit/select/loaded).
export { default as TraceLinkPresenter } from './components/TraceLinkPresenter.svelte'
export * from './commands'
export * from './types'
export * from './utils'

export default async (): Promise<Resources> => ({
  component: {
    TraceLinksSection,
    TraceLinkPresenter,
    TraceLinkKindPresenter,
    TraceCoveragePresenter,
    TraceTimeline,
    DeliveryDashboard,
    LinkVerifiesPopup,
    LinkImplementsPopup,
    DefectButton,
    UnlinkImplementsButton
  },
  //
  // ⚠️ EVERY KEY HERE IS SPELLED IN `plugins/traceability/src/index.ts` TOO.
  // `getResource('traceability:function:X')` looks `X` up in this record; a
  // mismatch is invisible to the compiler on both sides and throws only at the
  // moment a user clicks. Change the two blocks in one edit.
  //
  function: {
    TraceLinkKindLabel: traceLinkKindLabel,
    LinkImplements: linkImplements,
    LinkImplementsPairs: linkImplementsPairs,
    UnlinkImplements: unlinkImplements
  }
})
