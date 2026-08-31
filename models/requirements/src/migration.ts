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

import card, { type CardSpace } from '@hcengineering/card'
import { AccountRole, DOMAIN_SPACE, TxOperations, type AccountUuid } from '@hcengineering/core'
import {
  createDefaultSpace,
  tryUpgrade,
  type MigrateOperation,
  type MigrationClient,
  type MigrationUpgradeClient
} from '@hcengineering/model'
import core from '@hcengineering/model-core'
import { requirementsId } from '@hcengineering/requirements'

import requirements from './plugin'

/**
 * Creates the global Requirements `CardSpace` and makes sure the Requirement
 * MasterTag is listed in its `types`.
 *
 * This is the SECOND global CardSpace in the fork; `crm-lite` owns the first
 * one. They are deliberately separate so the product requirement lifecycle is
 * not coupled to CRM (Technical Spec §3.3).
 *
 * 🔴 Three things here are load bearing:
 *
 *  1. The space reuses the single upstream `card.spaceType.SpaceType`. Declaring
 *     a private SpaceType would be silently undone: `migrateRolesToBaseRole` in
 *     `models/card/src/migration.ts` rewrites every Role whose `attachedTo` is
 *     not `card.spaceType.SpaceType` back to it.
 *  2. Requirements deliberately do NOT go into `card.space.Default`, which is
 *     created `private: false, autoJoin: true` — the autoJoin trigger adds every
 *     activated employee to it.
 *     ⚠️ For DATA domains `getAllAllowedSpaces` is called with `isData: true`,
 *     which drops public spaces
 *     (foundations/server/packages/middleware/src/spaceSecurity.ts:539). So it
 *     is MEMBERSHIP, not the `private` flag, that gates visibility. `private:
 *     false` is kept only so the space itself stays visible in space
 *     administration.
 *
 *     🔵 DECIDED (membership policy, identical to `crm-lite` by design): the
 *     space is created with `members: []` and `autoJoin: false`, and the
 *     workspace OWNERS are seeded separately by `seedRequirementsSpaceOwners`
 *     in the migrate phase. Everyone else is added by an administrator in the
 *     UI. `autoJoin: true` was rejected on purpose: it adds every activated
 *     employee, which would destroy the read isolation that having two separate
 *     spaces exists for in the first place (product must not see lead amounts,
 *     sales must not see requirement bodies). Seeding only the Owners keeps
 *     that isolation while making sure the list is not invisible to literally
 *     everyone in a fresh workspace.
 *  3. A newly created MasterTag is NOT added to an existing space's `types` by
 *     anything: `models/card/src/migration.ts` snapshots the tag list once, when
 *     it creates the Default space, and the server only ever REMOVES a tag from
 *     `types` when the tag is deleted. So every module must write its own tag
 *     into its space itself — and keep doing so on upgrade, which is why the
 *     `types` top-up below runs even when the space already exists.
 *
 * ⚠️ `CardSpace.types` has no server side validation (`createCard` does not
 * check it). It is a client side allow-list, never a security boundary.
 *
 * @public
 */
export async function ensureRequirementsSpace (client: MigrationUpgradeClient): Promise<void> {
  await createDefaultSpace(
    client,
    requirements.space.Requirements,
    {
      name: 'Requirements',
      description: 'Product requirements',
      private: false,
      archived: false,
      members: [],
      autoJoin: false,
      type: card.spaceType.SpaceType,
      types: [requirements.masterTag.Requirement]
    },
    card.class.CardSpace
  )

  const tx = new TxOperations(client, core.account.System)
  const space = await tx.findOne(card.class.CardSpace, { _id: requirements.space.Requirements })
  if (space !== undefined && !space.types.includes(requirements.masterTag.Requirement)) {
    // `updateDoc` rather than `update`: this runs against a bare
    // MigrationUpgradeClient, and the mixin-splitting `update` path would drag
    // the whole hierarchy in for a plain array append.
    await tx.updateDoc(card.class.CardSpace, space.space, space._id, {
      types: [...space.types, requirements.masterTag.Requirement]
    })
  }
}

/**
 * Adds every workspace Owner to the Requirements space's `members`.
 *
 * 🔴 Why this lives in the MIGRATE phase and not next to
 * `ensureRequirementsSpace`: `MigrationUpgradeClient` is a bare `Client`
 * (foundations/core/packages/model/src/migration.ts:127) and has no way to
 * reach the account service, while `MigrationClient` carries `accountClient`
 * (foundations/core/packages/model/src/migration.ts:112). Workspace ROLES are
 * not workspace data — nothing in the workspace database records who the Owner
 * is (`contact.mixin.Employee.role` is `'USER' | 'GUEST'`, informational only,
 * plugins/contact/src/index.ts:189) — so `accountClient.getWorkspaceMembers()`
 * is the only source. `models/contact/src/migration.ts:197` uses it the same
 * way.
 *
 * ⚠️ The ordering that makes this work on a BRAND NEW workspace is not
 * obvious. `createWorkspace` (server/workspace-service/src/ws-operations.ts)
 * first calls `updateModel(..., 'create')`, which runs ONLY the `upgrade` half
 * — that is where `ensureRequirementsSpace` creates the space, with no account
 * service in reach — and then, at the end, calls
 * `upgradeWorkspaceWith(..., 'create')` → `upgradeModel`, which runs the FULL
 * preMigrate → migrate → upgrade cycle with an `accountClient`. So by the time
 * this function runs the space already exists, on the create path as well as on
 * every later upgrade.
 *
 * ⚠️ One known gap, verified: `dev/tool create-workspace` builds its account
 * client from `getToolToken()` with NO workspace uuid
 * (server/tool/src/utils.ts:5, dev/tool/src/index.ts:329), so
 * `getWorkspaceMembers` fails there — and that command never assigns an Owner
 * role in the first place (it calls `createWorkspaceRecord` directly, skipping
 * the `db.assignWorkspace(..., AccountRole.Owner)` that
 * server/account/src/operations.ts:626 does on the normal path). There is
 * nothing to seed, the catch below swallows it, and the next
 * `dev/tool upgrade-workspace` — whose token IS workspace scoped — seeds for
 * real. The product path (account service → workspace-service) is unaffected.
 *
 * 🔴 Deliberately NOT registered through `tryMigrate`: it must keep running on
 * every upgrade so a later promoted Owner is picked up too, and so a transient
 * account service failure cannot burn the one shot the state table would give
 * it. It is cheap (one indexed lookup, and the account call only when the space
 * exists) and writes nothing when there is nothing to add.
 *
 * Idempotency: members are APPENDED to whatever is already there, never
 * overwritten — an administrator's manual additions survive, and re-running
 * adds nothing because every Owner is already present.
 *
 * The raw `DOMAIN_SPACE` find/update pair mirrors `migrateSpacesOwner` in
 * models/core/src/migration.ts:126, which patches the very same collection.
 *
 * @public
 */
export async function seedRequirementsSpaceOwners (client: MigrationClient): Promise<void> {
  try {
    const spaces = await client.find<CardSpace>(DOMAIN_SPACE, { _id: requirements.space.Requirements })
    const space = spaces[0]
    if (space === undefined) return

    const wsMembers = await client.accountClient.getWorkspaceMembers()
    const owners = wsMembers.filter((it) => it.role === AccountRole.Owner).map((it) => it.person)

    const current: AccountUuid[] = space.members ?? []
    const known = new Set<AccountUuid>(current)
    const missing = owners.filter((it) => !known.has(it))
    if (missing.length === 0) return

    await client.update<CardSpace>(DOMAIN_SPACE, { _id: space._id }, { members: [...current, ...missing] })
    client.logger.log('seeded workspace owners into the Requirements space', {
      space: space._id,
      added: missing.length
    })
  } catch (err: any) {
    // Never fail the whole workspace upgrade over this: the account service is
    // a separate process. Because the step is not guarded by `tryMigrate`, the
    // next upgrade simply tries again.
    client.logger.error('failed to seed workspace owners into the Requirements space', { err })
  }
}

/**
 * @public
 */
export const requirementsOperation: MigrateOperation = {
  async migrate (client: MigrationClient, _mode): Promise<void> {
    // Nothing to seed in a data domain: a Requirement IS a Card, so it has no
    // table of its own, and the status / priority vocabularies are code
    // (`plugins/requirements/src/types.ts`) rather than documents. The
    // Requirements CardSpace is model data and is created in `upgrade` below.
    //
    // The one thing that DOES need the migrate phase is the Owner seeding: it
    // is the only phase with an `accountClient`. Outside `tryMigrate` on
    // purpose — see `seedRequirementsSpaceOwners`.
    await seedRequirementsSpaceOwners(client)
  },
  async upgrade (state: Map<string, Set<string>>, client: () => Promise<MigrationUpgradeClient>, mode): Promise<void> {
    await tryUpgrade(mode, state, client, requirementsId, [
      {
        state: 'requirements-space',
        func: ensureRequirementsSpace
      }
    ])
  }
}
