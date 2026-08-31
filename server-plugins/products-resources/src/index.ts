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

import type { Doc } from '@hcengineering/core'

export * from './releaseGuardMiddleware'

/**
 * Cascade-delete participant for a ProductVersion.
 *
 * A ProductVersion owns no documents whose removal the platform cannot already
 * derive, so this collects nothing. It exists as the `builder.mixin`-wired
 * resource behind `serverProducts.function.ProductVersionRemove`, which is what
 * makes `addLocation(serverProductsId, ...)` a live wire rather than a
 * registration that resolves to nothing — the same role
 * `agentraMarkerRemove` plays for `server-agentra-core-resources`.
 *
 * ⚠️ NOT how the release guard loads. That is a middleware, imported directly
 * by `server/server-pipeline`; see the descriptor comment in
 * `@hcengineering/server-products`.
 *
 * @public
 */
export async function productVersionRemove (doc: Doc): Promise<Doc[]> {
  return []
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  function: {
    ProductVersionRemove: productVersionRemove
  }
})
