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

import core, {
  type WithLookup,
  type Client,
  type Ref,
  type Space,
  checkPermission,
  getCurrentAccount
} from '@hcengineering/core'
import { getClient } from '@hcengineering/presentation'
import { showPopup } from '@hcengineering/ui'
import { type KeyFilter } from '@hcengineering/view'
import documents from '@hcengineering/controlled-documents'
import products, { isFrozenProductVersionState, type Product, type ProductVersion } from '@hcengineering/products'

import { canReleaseProductVersionState } from './release'
import CreateProductVersion from './components/product-version/CreateProductVersion.svelte'
import ReleaseProductVersionPopup from './components/product-version/ReleaseProductVersionPopup.svelte'

export function getProductVersionVersion (doc: ProductVersion): string {
  const codename = doc.codename ?? ''
  const version = `${doc.major}.${doc.minor}.${doc.patch}`

  return codename !== '' ? `${version} ${codename}` : version
}

export function getProductVersionName (doc: ProductVersion, product: Product): string {
  const version = getProductVersionVersion(doc)
  return `${product.name} ${version}`
}

export async function getVisibleFilters (filters: KeyFilter[], space?: Ref<Space>): Promise<KeyFilter[]> {
  return filters.filter((f) => f.key !== core.role.Admin)
}

export async function canEditProduct (doc?: Product): Promise<boolean> {
  if (doc === null || doc === undefined) {
    return false
  }

  if ((doc.owners ?? []).includes(getCurrentAccount().uuid)) {
    return true
  }

  const client = getClient()

  if (await checkPermission(client, core.permission.UpdateObject, core.space.Space)) {
    return true
  }

  if (await checkPermission(client, core.permission.UpdateSpace, doc._id)) {
    return true
  }

  return false
}

export async function canEditProductVersion (doc?: WithLookup<ProductVersion>): Promise<boolean> {
  if (doc === null || doc === undefined) {
    return false
  }

  // ⚠️ `Archived` freezes a version just as `Released` does. It is what
  // `CreateProductVersion.svelte` now stamps on a parent when a child is forked
  // off it (its documents have already been copied forward), so editing it
  // would edit a line that has been superseded.
  if (isFrozenProductVersionState(doc.state)) {
    return false
  }

  const product = await getClient().findOne(products.class.Product, { _id: doc.space })
  if (product === undefined) {
    return false
  }
  return await canEditProduct(product)
}

export async function canCreateProductVersion (doc?: Product | Product[]): Promise<boolean> {
  if (doc === null || doc === undefined) {
    return false
  }

  if (Array.isArray(doc)) {
    return false
  }

  if (doc.archived) {
    return false
  }

  return await canEditProduct(doc)
}

export async function createProductVersion (doc?: Product | Product[]): Promise<void> {
  if (doc === null || doc === undefined) {
    return
  }

  const product = Array.isArray(doc) ? doc[0] : doc
  if (product === undefined) {
    return
  }

  showPopup(CreateProductVersion, { space: product._id }, 'top')
}

export async function canDeleteProductVersion (doc?: ProductVersion | ProductVersion[]): Promise<boolean> {
  if (doc === null || doc === undefined) {
    return false
  }

  if (Array.isArray(doc)) {
    return false
  }

  if (isFrozenProductVersionState(doc.state)) {
    return false
  }

  const client = getClient()

  const anychild = await client.findOne(products.class.ProductVersion, { parent: doc._id })
  if (anychild !== undefined) {
    return false
  }

  const anydoc = await client.findOne(documents.class.ProjectDocument, { project: doc._id, initial: doc._id })
  if (anydoc !== undefined) {
    return false
  }

  const product = await client.findOne(products.class.Product, { _id: doc.space })
  if (product !== undefined) {
    return await canEditProduct(product)
  }

  return false
}

export async function productIdentifierProvider (client: Client, ref: Ref<Product>, doc?: Product): Promise<string> {
  const object = doc ?? (await client.findOne(products.class.Product, { _id: ref }))

  if (object === undefined) {
    return ''
  }

  return object.name
}

// ───────────────────────────────────────────────────────────────────────────
// REL-003 / REL-004: the release action.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Whether to offer "Release version" on this document.
 *
 * 🔴 A VISIBILITY TEST, NOT AN AUTHORISATION CHECK. It hides an action that
 * would certainly be refused; the gate, the state transition and the permission
 * are all re-decided on the server, which answers `illegal-transition` or
 * `gate-failed`. Never read a `true` here as "this release is allowed".
 *
 * ⚠️ Single selection only. Releasing several versions from one click would
 * fire N independent commands whose partial failure has no sensible rendering,
 * and each one needs its own gate report on screen.
 *
 * @public
 */
export async function canReleaseProductVersion (doc?: ProductVersion | ProductVersion[]): Promise<boolean> {
  if (doc === null || doc === undefined || Array.isArray(doc)) {
    return false
  }
  if (!canReleaseProductVersionState(doc.state)) {
    return false
  }
  const product = await getClient().findOne(products.class.Product, { _id: doc.space })
  if (product === undefined) {
    return false
  }
  return await canEditProduct(product)
}

/**
 * Open the release popup.
 *
 * 🔴 THE POPUP IS THE ONLY CLIENT ENTRY TO `ReleaseProductVersion`, and it is
 * where the idempotency key is derived — from the version, so that reopening it
 * is the same intent rather than a second one. Nothing in this package writes
 * `ProductVersionState.Released` directly.
 *
 * @public
 */
export async function releaseProductVersionAction (doc?: ProductVersion | ProductVersion[]): Promise<void> {
  if (doc === null || doc === undefined) {
    return
  }
  const version = Array.isArray(doc) ? doc[0] : doc
  if (version === undefined) {
    return
  }
  showPopup(ReleaseProductVersionPopup, { value: version }, 'top')
}
