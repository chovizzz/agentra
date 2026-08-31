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

import { ProductVersionState } from '@hcengineering/products'
import { type IntlString } from '@hcengineering/platform'

import products from './plugin'

/**
 * ⚠️ EXHAUSTIVE BY TYPE. `Record<ProductVersionState, IntlString>` is what makes
 * appending a state to the enum a COMPILE error here rather than an
 * `undefined` label rendered as a blank chip at runtime. Keep it a `Record`.
 */
export const productVersionStateLabels: Record<ProductVersionState, IntlString> = {
  [ProductVersionState.Planning]: products.string.ProductVersionStatePlanning,
  [ProductVersionState.Active]: products.string.ProductVersionStateActive,
  [ProductVersionState.ReleaseCandidate]: products.string.ProductVersionStateReleaseCandidate,
  [ProductVersionState.Released]: products.string.ProductVersionStateReleased,
  [ProductVersionState.Archived]: products.string.ProductVersionStateArchived
}
