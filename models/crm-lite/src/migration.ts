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
import { crmLiteId, leadStatusOrder, type CrmPipeline, type LeadSource } from '@hcengineering/crm-lite'
import { AccountRole, DOMAIN_SPACE, TxOperations, type AccountUuid, type Ref } from '@hcengineering/core'
import {
  createDefaultSpace,
  tryMigrate,
  tryUpgrade,
  type MigrateOperation,
  type MigrationClient,
  type MigrationUpgradeClient
} from '@hcengineering/model'
import core from '@hcengineering/model-core'

import crmLite from './plugin'
import { DOMAIN_CRM_LITE } from './types'

/**
 * Seeds the configurable pipeline / source documents.
 *
 * Idempotent in two layers, and the order matters:
 *
 *  1. Every document carries a DETERMINISTIC `_id` taken from the plugin
 *     descriptor (`crmLite.ids.*`). THIS is the layer that actually holds: two
 *     migrators racing each other collide on the primary key instead of both
 *     inserting. `find`-then-`create` with `generateId()` is NOT idempotent — it
 *     only looks idempotent in a serial test.
 *  2. The `find` below is a cheap fast path so a normal re-run does no write.
 *
 * `tryMigrate`'s state table is a performance guard, not a correctness guard:
 * restored backups and `MigrateMode` switches replay it.
 *
 * @public
 */
export async function ensureCrmDefaults (client: MigrationClient): Promise<void> {
  const now = Date.now()
  const base = {
    space: core.space.Workspace,
    modifiedBy: core.account.System,
    modifiedOn: now,
    createdBy: core.account.System,
    createdOn: now
  }

  const pipelines: CrmPipeline[] = [
    {
      ...base,
      _id: crmLite.ids.DefaultPipeline,
      _class: crmLite.class.CrmPipeline,
      name: 'Default',
      description: 'Default lead pipeline',
      // The stage list mirrors the state machine in `plugins/crm-lite/src/types.ts`.
      stages: [...leadStatusOrder],
      order: 0,
      isDefault: true
    }
  ]

  const sources: Array<[Ref<LeadSource>, string, number]> = [
    [crmLite.ids.SourceInbound, 'Inbound', 0],
    [crmLite.ids.SourceOutbound, 'Outbound', 1],
    [crmLite.ids.SourceReferral, 'Referral', 2],
    [crmLite.ids.SourceEvent, 'Event', 3],
    [crmLite.ids.SourcePartner, 'Partner', 4]
  ]

  for (const pipeline of pipelines) {
    const existing = await client.find<CrmPipeline>(DOMAIN_CRM_LITE, { _id: pipeline._id })
    if (existing.length === 0) {
      await client.create(DOMAIN_CRM_LITE, pipeline)
    }
  }

  for (const [_id, name, order] of sources) {
    const existing = await client.find<LeadSource>(DOMAIN_CRM_LITE, { _id })
    if (existing.length > 0) continue
    await client.create<LeadSource>(DOMAIN_CRM_LITE, {
      ...base,
      _id,
      _class: crmLite.class.LeadSource,
      name,
      order
    })
  }
}

/**
 * Creates the global CRM `CardSpace` and makes sure the Lead MasterTag is listed
 * in its `types`.
 *
 * 🔴 Three things here are load bearing:
 *
 *  1. The space reuses the single upstream `card.spaceType.SpaceType`. Declaring
 *     a private SpaceType would be silently undone: `migrateRolesToBaseRole` in
 *     `models/card/src/migration.ts` rewrites every Role whose `attachedTo` is
 *     not `card.spaceType.SpaceType` back to it.
 *  2. Leads deliberately do NOT go into `card.space.Default`, which is created
 *     `private: false, autoJoin: true` — the autoJoin trigger adds every
 *     activated employee to it, so every lead would be readable workspace wide.
 *     ⚠️ Verified: for DATA domains `getAllAllowedSpaces` is called with
 *     `isData: true`, which drops public spaces
 *     (foundations/server/packages/middleware/src/spaceSecurity.ts:539). So it
 *     is MEMBERSHIP, not the `private` flag, that gates lead visibility.
 *     `private: false` is kept only so the space itself stays visible in space
 *     administration.
 *
 *     🔵 DECIDED (membership policy): the space is created with `members: []`
 *     and `autoJoin: false`, and the workspace OWNERS are seeded separately by
 *     `seedCrmSpaceOwners` in the migrate phase. Everyone else is added by an
 *     administrator in the UI. `autoJoin: true` was rejected on purpose: it
 *     adds every activated employee, which would destroy the read isolation
 *     that having two separate spaces exists for in the first place (sales must
 *     not see requirement bodies, product must not see lead amounts). Seeding
 *     only the Owners keeps that isolation while making sure the board is not
 *     invisible to literally everyone in a fresh workspace.
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
export async function ensureCrmSpace (client: MigrationUpgradeClient): Promise<void> {
  await createDefaultSpace(
    client,
    crmLite.space.Crm,
    {
      name: 'CRM',
      description: 'Leads and CRM records',
      private: false,
      archived: false,
      members: [],
      autoJoin: false,
      type: card.spaceType.SpaceType,
      types: [crmLite.masterTag.Lead]
    },
    card.class.CardSpace
  )

  const tx = new TxOperations(client, core.account.System)
  const space = await tx.findOne(card.class.CardSpace, { _id: crmLite.space.Crm })
  if (space !== undefined && !space.types.includes(crmLite.masterTag.Lead)) {
    // `updateDoc` rather than `update`: this runs against a bare
    // MigrationUpgradeClient, and the mixin-splitting `update` path would drag
    // the whole hierarchy in for a plain array append.
    await tx.updateDoc(card.class.CardSpace, space.space, space._id, {
      types: [...space.types, crmLite.masterTag.Lead]
    })
  }
}

/**
 * Adds every workspace Owner to the CRM space's `members`.
 *
 * 🔴 Why this lives in the MIGRATE phase and not next to `ensureCrmSpace`:
 * `MigrationUpgradeClient` is a bare `Client` (foundations/core/packages/model/
 * src/migration.ts:127) and has no way to reach the account service, while
 * `MigrationClient` carries `accountClient`
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
 * — that is where `ensureCrmSpace` creates the space, with no account service
 * in reach — and then, at the end, calls `upgradeWorkspaceWith(..., 'create')`
 * → `upgradeModel`, which runs the FULL preMigrate → migrate → upgrade cycle
 * with an `accountClient`. So by the time this function runs the space already
 * exists, on the create path as well as on every later upgrade.
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
export async function seedCrmSpaceOwners (client: MigrationClient): Promise<void> {
  try {
    const spaces = await client.find<CardSpace>(DOMAIN_SPACE, { _id: crmLite.space.Crm })
    const space = spaces[0]
    if (space === undefined) return

    const wsMembers = await client.accountClient.getWorkspaceMembers()
    const owners = wsMembers.filter((it) => it.role === AccountRole.Owner).map((it) => it.person)

    const current: AccountUuid[] = space.members ?? []
    const known = new Set<AccountUuid>(current)
    const missing = owners.filter((it) => !known.has(it))
    if (missing.length === 0) return

    await client.update<CardSpace>(DOMAIN_SPACE, { _id: space._id }, { members: [...current, ...missing] })
    client.logger.log('seeded workspace owners into the CRM space', { space: space._id, added: missing.length })
  } catch (err: any) {
    // Never fail the whole workspace upgrade over this: the account service is
    // a separate process. Because the step is not guarded by `tryMigrate`, the
    // next upgrade simply tries again.
    client.logger.error('failed to seed workspace owners into the CRM space', { err })
  }
}

/**
 * @public
 */
export const crmLiteOperation: MigrateOperation = {
  async migrate (client: MigrationClient, mode): Promise<void> {
    await tryMigrate(mode, client, crmLiteId, [
      {
        state: 'crm-defaults',
        func: ensureCrmDefaults
      }
    ])
    // Outside `tryMigrate` on purpose — see `seedCrmSpaceOwners`.
    await seedCrmSpaceOwners(client)
  },
  async upgrade (state: Map<string, Set<string>>, client: () => Promise<MigrationUpgradeClient>, mode): Promise<void> {
    await tryUpgrade(mode, state, client, crmLiteId, [
      {
        state: 'crm-space',
        func: ensureCrmSpace
      }
    ])
  }
}
