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

import { ARCHIVABLE_CLASSES, agentraCoreId, archivableKey, type AgentraMarker } from '@hcengineering/agentra-core'
import { tryMigrate, type MigrateOperation, type MigrationClient } from '@hcengineering/model'
import core from '@hcengineering/model-core'

import agentraCore from './plugin'
import { DOMAIN_AGENTRA_CORE } from './types'

/**
 * Stable identity of the single marker document this module maintains.
 *
 * @public
 */
export const AGENTRA_CORE_MARKER_KEY = 'agentra-core:bootstrap'

/**
 * Idempotent by construction, in two layers:
 *
 *  1. The document carries a DETERMINISTIC `_id` (`agentraCore.ids.BootstrapMarker`),
 *     not a `generateId()`. This is the layer that actually holds: two migrators
 *     racing each other collide on the primary key instead of both inserting.
 *  2. The `find` below is only a cheap fast path so the common re-run does no write.
 *
 * A find-then-create with a random `_id` is NOT idempotent — it merely looks
 * idempotent in a serial test. Every Agentra module's migration must use a
 * deterministic id (or a unique constraint) for any singleton it creates: the
 * `tryMigrate` state table is a performance guard, not a correctness guard, and
 * it is lost on restored backups and mode switches.
 *
 * @public
 */
export async function ensureAgentraMarker (client: MigrationClient): Promise<void> {
  const existing = await client.find<AgentraMarker>(DOMAIN_AGENTRA_CORE, {
    _id: agentraCore.ids.BootstrapMarker
  })
  if (existing.length > 0) {
    return
  }

  const now = Date.now()
  const marker: AgentraMarker = {
    _id: agentraCore.ids.BootstrapMarker,
    _class: agentraCore.class.AgentraMarker,
    space: core.space.Workspace,
    modifiedBy: core.account.System,
    modifiedOn: now,
    createdBy: core.account.System,
    createdOn: now,
    key: AGENTRA_CORE_MARKER_KEY,
    producedOn: now
  }
  await client.create(DOMAIN_AGENTRA_CORE, marker)
}

/**
 * SYS-005: give every pre-existing Lead / Requirement / Issue / TestCase an
 * explicit `archived: false`.
 *
 * 🔴 IDEMPOTENT BY FILTER, NOT BY BOOKKEEPING. The query is
 * `{ <mixin>.archived: { $exists: false } }`, so a re-run selects zero rows and
 * writes nothing — exactly the shape `models/test-management`'s
 * `version: { $exists: false }` backfill uses. `tryMigrate`'s state table is
 * only a fast path on top of that: it is lost across restored backups and mode
 * switches, so a migration whose correctness DEPENDED on it would silently
 * double-apply there.
 *
 * ⚠️ DO NOT hand-write a `MigrationState` document to "record" this. The
 * platform's own size-based idempotency probes count those, and an extra row
 * makes an otherwise-clean re-run look like it changed something.
 *
 * ⚠️ `MigrationClient.create` IS AN UPSERT on some adapters, so "create the
 * marker if missing" is not a safe idiom either — which is why
 * {@link ensureAgentraMarker} leans on a deterministic `_id` instead.
 *
 * ⚠️ THE FLAG IS NEVER REQUIRED TO BE PRESENT. Documents created after this
 * migration carry no `Archivable` mixin at all, and every reader treats absence
 * as "not archived" (`archived !== true`). The backfill exists so that a
 * migrated workspace can be QUERIED uniformly, not because absence is a bug —
 * a guard or list filter that demanded the field would break every new
 * document.
 *
 * ⚠️ Classes are resolved through the hierarchy and SKIPPED when absent. The
 * four modules are optional plugins; `findDomain` on an unknown classifier
 * would throw and take the whole migration down with it.
 *
 * @public
 */
export async function backfillArchivedFlag (client: MigrationClient): Promise<void> {
  const key = archivableKey('archived')
  const generationKey = archivableKey('archiveGeneration')
  for (const _class of ARCHIVABLE_CLASSES) {
    if (!client.hierarchy.hasClass(_class)) {
      continue
    }
    const domain = client.hierarchy.findDomain(_class)
    if (domain === undefined) {
      continue
    }
    await client.update(
      domain,
      { _class, [key]: { $exists: false } },
      // Both keys in ONE update. Writing `archived` alone would leave
      // `archiveGeneration` undefined, and the archive command's claim is keyed
      // on the generation — `undefined` there would make the derived ledger id
      // depend on how a reader coerced it.
      { [key]: false, [generationKey]: 0 }
    )
  }
}

/**
 * @public
 */
export const agentraCoreOperation: MigrateOperation = {
  async migrate (client: MigrationClient, mode): Promise<void> {
    await tryMigrate(mode, client, agentraCoreId, [
      {
        state: 'bootstrap-marker',
        func: ensureAgentraMarker
      },
      {
        state: 'archivable-backfill-v1',
        func: backfillArchivedFlag
      }
    ])
  },
  // No high level upgrade steps: the skeleton keeps everything in `migrate`.
  async upgrade (): Promise<void> {}
}
