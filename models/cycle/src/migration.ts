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

import { cycleId, type Cycle } from '@hcengineering/cycle'
import {
  tryMigrate,
  type MigrateOperation,
  type MigrationClient,
  type MigrationUpgradeClient
} from '@hcengineering/model'

import cyclePlugin from './plugin'
import { DOMAIN_CYCLE } from './types'

const cycleClass = cyclePlugin.class.Cycle

/**
 * Fills in the two non-optional Cycle fields for any row that predates them.
 *
 * 🔴 There is deliberately NOTHING to seed here. A Cycle belongs to a tracker
 * Project (`space: Ref<Project>`), so unlike `crm-lite` / `requirements` this
 * module creates no space of its own; and unlike `crm-lite` it has no
 * configuration documents, because the status vocabulary is CODE
 * (`plugins/cycle/src/types.ts`), not documents. Seeding a cycle into an
 * existing project would be inventing user data.
 *
 * What this step does is the one thing a migration for an additive model must
 * do: make rows written by an older build satisfy the current class. It is a
 * pure `update`, never a `create`, so no amount of re-running it can produce a
 * duplicate object.
 *
 * ⚠️ `MigrationClient.update` takes a query, and `$exists` is the upstream way
 * of finding rows missing a field (`models/board/src/migration.ts:72`,
 * `models/card/src/migration.ts:356`).
 *
 * @public
 */
export async function backfillCycleDefaults (client: MigrationClient): Promise<void> {
  // ⚠️ `_class` is pinned even though `DOMAIN_CYCLE` holds nothing else today:
  // the moment a second class joins this domain, a domain-only query would
  // start rewriting its rows too.
  //
  // ⚠️ Known adapter difference, harmless here: Postgres translates
  // `$exists: false` to `IS NULL`, so an explicit JSON null and a missing field
  // are the same row to it; Mongo means strictly "missing". Both readings want
  // the same repair, which is why this step is written as a repair rather than
  // as a one-shot.
  await client.update<Cycle>(DOMAIN_CYCLE, { _class: cycleClass, status: { $exists: false } }, { status: 'planned' })
  await client.update<Cycle>(DOMAIN_CYCLE, { _class: cycleClass, sequence: { $exists: false } }, { sequence: 0 })
}

/**
 * ⚠️ Registered in `models/all/src/migration.ts` AFTER `tracker`: the Issue
 * mixin extends `tracker.class.Issue` and a Cycle's `space` is a
 * `tracker.class.Project`, so tracker's own migration must have run first.
 *
 * ⚠️ `tryMigrate` writes a `MigrationState` DOCUMENT of its own for every step
 * it completes. Idempotency must therefore never be asserted by counting a
 * whole collection — filter by `_class` first.
 *
 * @public
 */
export const cycleOperation: MigrateOperation = {
  async migrate (client: MigrationClient, mode): Promise<void> {
    await tryMigrate(mode, client, cycleId, [
      {
        state: 'cycle-backfill-defaults',
        func: backfillCycleDefaults
      }
    ])
  },
  async upgrade (
    _state: Map<string, Set<string>>,
    _client: () => Promise<MigrationUpgradeClient>,
    _mode
  ): Promise<void> {
    // Nothing to create in the model space: no dedicated space (cycles live in
    // tracker Projects), no configuration documents, no default cycle.
  }
}
