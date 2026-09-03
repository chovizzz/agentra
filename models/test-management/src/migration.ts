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

import { INITIAL_TEST_CASE_VERSION, testManagementId } from '@hcengineering/test-management'
import {
  tryMigrate,
  type MigrateOperation,
  type MigrationClient,
  type MigrationUpgradeClient
} from '@hcengineering/model'

import testManagement from './plugin'
import { DOMAIN_TEST_MANAGEMENT } from './types'

/**
 * Give every pre-existing test case an explicit revision number.
 *
 * Idempotent by construction: the filter is `version: { $exists: false }`, so a
 * second run matches nothing. `tryMigrate`'s state table is only a performance
 * guard — restored backups and `MigrateMode` switches replay migrations — so
 * the filter, not the ledger, is what makes re-running safe.
 *
 * ℹ️ Readers must not depend on this having run: `currentTestCaseVersion`
 * treats a missing `version` as {@link INITIAL_TEST_CASE_VERSION}, which keeps
 * snapshot deduplication correct on a workspace mid-upgrade.
 *
 * ⚠️ There is deliberately NO migration for `TestRunStatus.Skipped`. It was
 * APPENDED to a numeric enum, so every value already stored keeps its meaning
 * and there is nothing to rewrite; a no-op migration would only be noise in a
 * file that is a merge hotspot.
 *
 * @public
 */
export async function setInitialTestCaseVersion (client: MigrationClient): Promise<void> {
  await client.update(
    DOMAIN_TEST_MANAGEMENT,
    {
      _class: testManagement.class.TestCase,
      version: { $exists: false }
    },
    {
      version: INITIAL_TEST_CASE_VERSION
    }
  )
}

/**
 * @public
 */
export const testManagementOperation: MigrateOperation = {
  async migrate (client: MigrationClient, mode): Promise<void> {
    await tryMigrate(mode, client, testManagementId, [
      {
        state: 'test-case-initial-version',
        func: setInitialTestCaseVersion
      }
    ])
  },
  async upgrade (state: Map<string, Set<string>>, client: () => Promise<MigrationUpgradeClient>): Promise<void> {}
}
