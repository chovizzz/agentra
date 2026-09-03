//
// Copyright © 2026 Agentra
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
import { type AccountDB } from '@hcengineering/account'
import { type AccountUuid, type MeasureContext, type PersonUuid } from '@hcengineering/core'

import { FeishuAccountEventType, recordFeishuEvent } from './feishuWorkspace'

// ---------------------------------------------------------------------------
// AUTH-006 — optional profile sync, gated on FEISHU_SYNC_PROFILE=true.
//
// SCOPE, and what was deliberately left out:
//
//   * name (first/last)  — synced. The account database's `person` row is the only
//                          profile storage reachable from this pod.
//   * avatar             — NOT written. `Person` in the account DB is
//                          `{ uuid, firstName, lastName }`; the avatar lives on the
//                          `contact:class:Person` document inside each workspace, which
//                          needs a transactor client this pod does not have and must not
//                          grow. The URL Feishu returns is recorded in the audit event so
//                          a later workspace-side job can pick it up.
//   * department         — NOT fetched. `/open-apis/authen/v1/user_info` does not return
//                          it; it requires `/open-apis/contact/v3/users/:id` with a
//                          tenant_access_token and contact scopes — a second credential
//                          flow and a second unverified endpoint. Out of scope here, and
//                          the account DB has nowhere to put it either.
//   * employment status  — NOT fetched, same endpoint/credential problem. A resigned or
//                          frozen tenant member cannot complete Feishu's own
//                          authorization step, so the primary enforcement is upstream.
//                          TODO(需外部核实): confirm that a resigned user is in fact
//                          refused by the authorize endpoint before relying on this.
//
// The whole sync is best-effort: PRD AUTH-006 requires that a sync failure never blocks a
// login that has already succeeded, so every path here returns instead of throwing.
// It never touches roles or workspace membership.
// ---------------------------------------------------------------------------

export interface FeishuSyncableProfile {
  firstName: string
  lastName: string
  avatarUrl?: string
  tenantKey: string
}

export interface ProfileSyncResult {
  updated: boolean
  reason?: string
}

export async function syncFeishuProfile (
  measureCtx: MeasureContext,
  db: AccountDB,
  accountUuid: AccountUuid,
  profile: FeishuSyncableProfile
): Promise<ProfileSyncResult> {
  try {
    const person = await db.person.findOne({ uuid: accountUuid as PersonUuid })
    if (person == null) {
      measureCtx.warn('Feishu profile sync skipped: no person row', { provider: 'feishu', accountUuid })
      return { updated: false, reason: 'person not found' }
    }

    // A user_info response without a usable `name` must not blank out a name the user (or
    // an admin) already has: an empty upstream field means "nothing to sync", not "clear it".
    const hasUsableName = profile.firstName !== ''
    const nameChanged =
      hasUsableName && (person.firstName !== profile.firstName || person.lastName !== profile.lastName)
    if (nameChanged) {
      await db.person.update(
        { uuid: accountUuid as PersonUuid },
        { firstName: profile.firstName, lastName: profile.lastName }
      )
    }

    await recordFeishuEvent(measureCtx, db, accountUuid, FeishuAccountEventType.ProfileSynced, {
      tenantKey: profile.tenantKey,
      nameChanged,
      nameSkipped: !hasUsableName,
      // Recorded, not applied — see the note above on avatar storage.
      avatarUrl: profile.avatarUrl
    })

    return { updated: nameChanged }
  } catch (err: any) {
    // Never rethrown: AUTH-006 requires a failing sync to leave the session intact.
    measureCtx.error('Feishu profile sync failed', { provider: 'feishu', accountUuid, reason: err.message })
    return { updated: false, reason: err.message }
  }
}
