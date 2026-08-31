//
// Copyright © 2024 Hardcore Engineering Inc.
//
//

import core, { type Class, type Doc } from '@hcengineering/core'
import { type Builder } from '@hcengineering/model'
import products from '@hcengineering/products'
import serverCore, { type ObjectDDParticipant } from '@hcengineering/server-core'
import serverProducts from '@hcengineering/server-products'

// 🔴 RE-EXPORTED, NOT REDECLARED. The id used to be a local
// `'server-products' as Plugin` here, which meant `addLocation` (in
// `server/server-pipeline`) and this model could drift apart by one typo and
// nothing would fail to compile — the resource would simply never resolve at
// runtime. `@hcengineering/server-products` now owns it; `models/all` keeps
// importing it from this package.
export { serverProductsId } from '@hcengineering/server-products'

export function createModel (builder: Builder): void {
  builder.mixin(products.class.Product, core.class.Class, serverCore.mixin.SearchPresenter, {
    iconConfig: {
      component: products.component.ProductSearchIcon,
      fields: [['icon'], ['color']]
    },
    title: [['name']]
  })

  // 🔴 THIS MIXIN IS WHAT MAKES `addLocation(serverProductsId, ...)` LOAD
  // ANYTHING. A server plugin registration with no resource named by any model
  // resolves to nothing and is dead scaffolding; naming
  // `serverProducts.function.ProductVersionRemove` here is what forces
  // `@hcengineering/server-products-resources` to be imported at runtime, so a
  // broken registration surfaces as a resolution error instead of silence.
  //
  // ⚠️ It does NOT load the release guard. That is
  // `ProductVersionReleaseGuardMiddleware`, which `server/server-pipeline`
  // imports directly — see Technical Spec §3.6 and the descriptor comment in
  // `@hcengineering/server-products`.
  builder.mixin<Class<Doc>, ObjectDDParticipant>(
    products.class.ProductVersion,
    core.class.Class,
    serverCore.mixin.ObjectDDParticipant,
    {
      collectDocs: serverProducts.function.ProductVersionRemove
    }
  )
}
