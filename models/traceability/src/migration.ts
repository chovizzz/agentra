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

import { DOMAIN_RELATION } from '@hcengineering/core'
import { tryMigrate, type MigrateOperation, type MigrationClient } from '@hcengineering/model'
import { traceabilityId, type TraceLink } from '@hcengineering/traceability'

import traceability from './plugin'

/**
 * Backfills `state` on edges written before the field existed.
 *
 * Idempotent by construction: the query only selects rows where `state` is
 * missing, so a re-run matches nothing. It creates no documents at all, which is
 * the strongest form of idempotence available here.
 *
 * 🔴 Every write is scoped by `_class: traceability.class.TraceLink`. This is
 * NOT optional: `DOMAIN_RELATION` is shared with upstream `core.class.Relation`
 * rows, and a migration client's `update` is a RAW domain operation with no
 * class filtering of its own. Dropping the `_class` clause would rewrite
 * upstream relation documents.
 *
 * @public
 */
export async function backfillTraceLinkState (client: MigrationClient): Promise<void> {
  await client.update<TraceLink>(
    DOMAIN_RELATION,
    {
      _class: traceability.class.TraceLink,
      state: { $exists: false }
    },
    { state: 'active' }
  )
}

/**
 * Backfills the redundant version-normalisation fields.
 *
 * `normId(doc) = doc.baseId ?? doc._id`, and that rule holds for unversioned
 * objects too — so for an edge written before these fields existed, seeding them
 * from the concrete endpoint ids is correct for every unversioned endpoint and
 * is the only defensible default for versioned ones (the historical `baseId` is
 * not recoverable from the edge itself).
 *
 * Idempotent for the same reason as above: `$exists: false` stops matching after
 * the first pass. `bulk` keeps the two field backfills in one round trip while
 * preserving the per-field `$exists` guard — a single combined update would
 * overwrite one field whenever only the other was missing.
 *
 * @public
 */
export async function backfillTraceLinkBaseIds (client: MigrationClient): Promise<void> {
  const links = await client.find<TraceLink>(DOMAIN_RELATION, {
    _class: traceability.class.TraceLink,
    $or: [{ sourceBaseId: { $exists: false } }, { targetBaseId: { $exists: false } }]
  } as any)

  if (links.length === 0) {
    return
  }

  // 🔴 The `$exists: false` guard must be carried into the WRITE filter, not
  // just the read. Between the find above and the bulk below, another migrator
  // (or a live command) may have written a real baseId; a filter of only
  // `_class + _id` would clobber it with our fallback. Keeping the guard makes
  // each write a compare-and-set, so a concurrent run is a no-op rather than a
  // regression. One operation per field, since only the missing one may be set.
  const operations: Array<{ filter: any, update: any }> = []
  for (const link of links) {
    if (link.sourceBaseId === undefined) {
      operations.push({
        filter: { _class: traceability.class.TraceLink, _id: link._id, sourceBaseId: { $exists: false } },
        update: { sourceBaseId: link.docA }
      })
    }
    if (link.targetBaseId === undefined) {
      operations.push({
        filter: { _class: traceability.class.TraceLink, _id: link._id, targetBaseId: { $exists: false } },
        update: { targetBaseId: link.docB }
      })
    }
  }

  if (operations.length === 0) {
    return
  }

  await client.bulk<TraceLink>(DOMAIN_RELATION, operations)
}

/**
 * 🔴 The `tryMigrate` state table (`DOMAIN_MIGRATION`) is a PERFORMANCE guard,
 * not a correctness guard — a restored backup, a `MigrateMode` switch or a lost
 * state row all replay these steps. Every step above must therefore be safe to
 * run an arbitrary number of times on its own merits, and each one is: they
 * select on `$exists: false` and create nothing.
 *
 * @public
 */
export const traceabilityOperation: MigrateOperation = {
  async migrate (client: MigrationClient, mode): Promise<void> {
    await tryMigrate(mode, client, traceabilityId, [
      {
        state: 'backfill-trace-link-state',
        func: backfillTraceLinkState
      },
      {
        state: 'backfill-trace-link-base-ids',
        func: backfillTraceLinkBaseIds
      }
    ])
  },
  async upgrade (): Promise<void> {}
}
