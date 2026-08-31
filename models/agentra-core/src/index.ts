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

import { type Builder } from '@hcengineering/model'

import { TAgentraMarker, TArchivable } from './types'

export { agentraCoreId } from '@hcengineering/agentra-core'
export { agentraCoreOperation, backfillArchivedFlag, ensureAgentraMarker, AGENTRA_CORE_MARKER_KEY } from './migration'
export { default } from './plugin'
export * from './types'

export function createModel (builder: Builder): void {
  // ⚠️ `TArchivable` IS REGISTERED HERE AND NOWHERE ELSE, and it carries NO
  // `builder.mixin(<Lead|Requirement|Issue|TestCase>, ...)` companion calls.
  //
  // 🔴 THE LOAD ORDER FORBIDS THEM. `models/all/src/index.ts:198` registers
  // `agentraCoreModel` as the Agentra FOUNDATION — before crm-lite (:325),
  // tracker (:382), requirements (:570) and test-management (:582). A
  // `builder.mixin` runs `Builder.mixin -> this.hierarchy.tx(tx)`
  // (`foundations/core/packages/model/src/dsl.ts:378`), whose `txMixin` calls
  // `Hierarchy.getClass(tx.objectId)` and THROWS on a classifier that has not
  // been created yet. Model building would fail outright, not degrade.
  //
  // ℹ️ Nothing is lost. A mixin extending `core.class.Doc` is applicable to
  // every document by construction; `hierarchy.hasMixin` answers per DOCUMENT,
  // not per class, so no per-class registration exists for it to need. The
  // per-class facts SYS-005 does need — which classes offer Archive/Restore in
  // their context menu — live in `view.class.Action` documents, whose `target`
  // is an ordinary field resolved at runtime and therefore order-independent.
  // Those actions are the hand-off item recorded in the Task 19a report: they
  // require `@hcengineering/model-view`, which this package does not depend on.
  builder.createModel(TAgentraMarker, TArchivable)
}
