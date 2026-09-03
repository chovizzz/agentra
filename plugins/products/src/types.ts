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

import { type Document, ExternalSpace, Project } from '@hcengineering/controlled-documents'
import { Attachment } from '@hcengineering/attachment'
import { type CollectionSize, type Ref, type Timestamp, Markup } from '@hcengineering/core'
import { IconProps } from '@hcengineering/view'

/**
 * Lifecycle of one product version.
 *
 * 🔴 A NUMERIC enum whose values are PERSISTED VERBATIM in
 * `ProductVersion.state`. Every member spells its number out, and the Agentra
 * members are APPENDED at the end (Technical Spec §3.6, decision D5):
 *
 * - reordering or deleting a member silently rewrites history — every stored
 *   `Released` would read back as something else, with no error anywhere;
 * - relying on implicit auto-increment lets a later contributor insert a member
 *   in the middle and shift everything after it, in a diff that looks harmless.
 *
 * Appending at 2..4 needs no data migration at all.
 *
 * ⚠️ The lifecycle order is `Planning -> Active -> ReleaseCandidate -> Released
 * -> Archived` and has NOTHING to do with the numeric order. Never decide
 * whether a transition is legal by comparing these numbers.
 *
 * @public
 */
export enum ProductVersionState {
  // ── Upstream members. The numbers are load bearing; do not touch. ──
  Active = 0,
  Released = 1,
  // ── Appended by Agentra (D5). ──
  Planning = 2,
  ReleaseCandidate = 3,
  Archived = 4
}

/** @public */
export const productVersionStates = [
  ProductVersionState.Planning,
  ProductVersionState.Active,
  ProductVersionState.ReleaseCandidate,
  ProductVersionState.Released,
  ProductVersionState.Archived
]

/**
 * The states a HUMAN may pick from the state editor.
 *
 * 🔴 `Released` IS DELIBERATELY ABSENT. `ProductVersionStateEditor` is
 * registered as the `AttributeEditor` for `TypeProductVersionState`
 * (`models/products/src/index.ts`), so before this list existed anyone with
 * write access to a version could pick `Released` out of a dropdown and ship it
 * with the readiness gate, the approval and the audit record all skipped — the
 * same hole as the `CreateProductVersion.svelte` one, through a different door.
 * `Released` is reached only by the server-side `ReleaseProductVersion`
 * command.
 *
 * ⚠️ THIS IS DEFENCE IN DEPTH, NOT THE BOUNDARY. It narrows the UI; it does not
 * stop a hand-written `TxUpdateDoc`. The enforcing check belongs in a server
 * trigger over `products.class.ProductVersion` that rejects any transition into
 * `Released` not carrying the command's marker. Until that lands, the UI list
 * is what stops the accidental case, which is the common one.
 *
 * @public
 */
export const userSelectableProductVersionStates: ProductVersionState[] = productVersionStates.filter(
  (state) => state !== ProductVersionState.Released
)

/**
 * The state a PARENT version is moved to when a child version is forked off it.
 *
 * 🔴 THIS EXISTS BECAUSE IT USED TO BE `Released`, AND THAT WAS A RELEASE-GATE
 * BYPASS. `CreateProductVersion.svelte` freezes the parent when a child is
 * created; it used to freeze it by setting `state: Released`, which meant
 * ANYONE who could create a child version could mark the parent released
 * without the `ReleaseProductVersion` command, the readiness gate, the
 * approval or the audit record ever running (PRD REL-003, Technical Spec §3.6).
 *
 * `Archived` carries the intended meaning — "this line is closed, work moved on
 * to the child" — and is NOT a release. `Released` is now reachable only
 * through the server command.
 *
 * ⚠️ Referenced by name rather than inlined so that the constant, its rationale
 * and the test that pins it stay in one place. `products/src/__tests__` asserts
 * it is not `Released`; that assertion is a security regression test, not a
 * style check.
 *
 * @public
 */
export const parentStateOnChildVersion: ProductVersionState = ProductVersionState.Archived

/**
 * States in which a version is frozen: no edits, no deletion.
 *
 * `Released` is frozen because it is a shipped fact; `Archived` is frozen
 * because a child version has superseded it and its documents were already
 * copied forward.
 *
 * @public
 */
export const frozenProductVersionStates: ProductVersionState[] = [
  ProductVersionState.Released,
  ProductVersionState.Archived
]

/** @public */
export function isFrozenProductVersionState (state: ProductVersionState): boolean {
  return frozenProductVersionStates.includes(state)
}

/** @public */
export interface Product extends ExternalSpace, IconProps {
  fullDescription?: Markup
  attachments?: CollectionSize<Attachment>
}

/** @public */
export interface ProductVersion extends Project<Product> {
  major: number
  minor: number
  patch: number
  codename?: string
  description: Markup
  state: ProductVersionState
  parent: Ref<ProductVersion>
  changeControl?: Ref<Document>
  /**
   * REL-005. The release notes body, generated then hand edited.
   *
   * ⚠️ APPENDED, AND OPTIONAL. Every ProductVersion written before this build
   * has neither field; a required one would make every stored row invalid and
   * `undefined` is the honest reading of "never generated".
   *
   * 🔴 NOT a derived view of the scope. Once generated the body is EDITABLE,
   * so it stops tracking the scope by design — which is the whole point of
   * REL-005 ("自动生成可编辑"). Anything that wants the live scope must ask the
   * gate, never read this.
   */
  releaseNotes?: Markup
  /**
   * When {@link ProductVersion.releaseNotes} was last generated.
   *
   * 🔴 GENERATED, NOT MODIFIED. `modifiedOn` moves on every unrelated edit to
   * the version, so it cannot say when the body last came out of the generator.
   * This field is the "as of" stamp the release page shows, and it is what
   * makes the snapshot nature of the notes visible: the body describes the
   * scope AT THIS INSTANT, and `delivered-in` edges added later do not rewrite
   * it (Task 18a — the edge does not inherit on revision).
   *
   * ⚠️ IT IS NOT THE OVERWRITE GUARD. Knowing when generation happened does not
   * tell you whether a human edited the body afterwards, so
   * {@link releaseNotesNeedConfirmation} asks about the BODY instead.
   */
  releaseNotesGeneratedOn?: Timestamp
}
