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

import type { Plugin, Resource } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'
import type { ObjectDDParticipantFunc } from '@hcengineering/server-core'

export * from './releaseGuard'

/**
 * @public
 */
export const serverProductsId = 'server-products' as Plugin

/**
 * Server side descriptor for Products.
 *
 * ⚠️ WHAT ACTUALLY LOADS THE RELEASE GUARD. The guard is a pipeline
 * MIDDLEWARE, and `server/server-pipeline` reaches it by a direct `import` of
 * `@hcengineering/server-products-resources` — NOT through the `addLocation`
 * below. `addLocation` resolves `Resource` ids that a MODEL names, and a
 * middleware is not one. Anyone reading "three registrations, none optional"
 * (Technical Spec §3.6) should read it as three registrations that each do a
 * different job, not as three ways of loading the same code: drop the
 * `server-pipeline` import and the guard silently never runs, however healthy
 * `addLocation` looks.
 *
 * The ids below are what `addLocation` exists for, and they are declared so
 * that registration is a live wire rather than a no-op resolving to `{}` —
 * `models/server-products` mixes {@link ProductVersionRemove} onto
 * `products.class.ProductVersion`, which is what forces the resources bundle to
 * be resolved and imported at runtime.
 *
 * @public
 */
export default plugin(serverProductsId, {
  function: {
    /**
     * Cascade-delete participant for a ProductVersion. It collects nothing
     * today; it is the `builder.mixin`-wired resource that proves
     * `addLocation(serverProductsId, ...)` resolves this package.
     */
    ProductVersionRemove: '' as Resource<ObjectDDParticipantFunc>
  }
})
