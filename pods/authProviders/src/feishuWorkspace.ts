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
import { AccountRole, type AccountUuid, type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'

// ---------------------------------------------------------------------------
// AUTH-004 — tenant -> workspace -> default role, driven by deployment config.
//
// Decision D3 (2026-08-26, technical-spec §3.7): the mapping lives in an environment
// variable, not in a workspace-side configuration UI. This module owns parsing that
// variable and performing the assignment; it deliberately does not touch
// `server/account` (upstream hot spot) and calls `AccountDB.assignWorkspace` directly.
// ---------------------------------------------------------------------------

/** Roles that may be handed out by deployment configuration. */
const ASSIGNABLE_ROLES: AccountRole[] = [
  AccountRole.ReadOnlyGuest,
  AccountRole.DocGuest,
  AccountRole.Guest,
  AccountRole.User,
  AccountRole.Maintainer,
  AccountRole.Owner
]

/**
 * `AccountRole.Admin` is intentionally NOT assignable from the mapping: it is a
 * platform-wide privileged role, and an env-var typo must never be able to hand it to
 * every member of a Feishu tenant.
 */
export function parseAssignableRole (raw: string): AccountRole {
  const normalized = raw.trim().toLowerCase()
  const found = ASSIGNABLE_ROLES.find((role) => role.toLowerCase() === normalized)
  if (found === undefined) {
    throw new Error(
      `unknown role '${raw}' (expected one of ${ASSIGNABLE_ROLES.join('|')}; ADMIN cannot be granted by configuration)`
    )
  }

  return found
}

export interface FeishuWorkspaceMapping {
  /** The workspace *slug* — the `workspace.url` column, e.g. `agentra-main`, not an http url. */
  workspaceUrl: string
  role: AccountRole
}

export type FeishuTenantWorkspaceMap = Map<string, FeishuWorkspaceMapping>

export const DEFAULT_MAPPED_ROLE = AccountRole.User

/**
 * Parses `FEISHU_TENANT_WORKSPACE_MAP`.
 *
 * Syntax: a comma-separated list of `tenantKey:workspaceUrl[:ROLE]` entries; `ROLE`
 * defaults to `USER`. Whitespace around any part is ignored, empty entries are ignored.
 *
 *   FEISHU_TENANT_WORKSPACE_MAP=tenantalpha:agentra-main:USER,tenantbeta:agentra-partner:GUEST
 *
 * A colon is used rather than JSON because the value is written into a compose file /
 * secret manager, where JSON needs an extra layer of quoting.
 *
 * Throws — never degrades to a partial or empty map — on: a malformed entry, an unknown
 * role, `ADMIN`, or a duplicated tenant key. See `registerFeishu`: a throw here stops the
 * provider from registering at all, so a typo surfaces at boot instead of turning into
 * "everyone can authenticate but nobody lands anywhere".
 */
export function parseTenantWorkspaceMap (raw: string | undefined): FeishuTenantWorkspaceMap | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined
  }

  const result: FeishuTenantWorkspaceMap = new Map()

  for (const entry of raw.split(',')) {
    if (entry.trim() === '') continue

    const parts = entry.split(':').map((p) => p.trim())
    if (parts.length < 2 || parts.length > 3) {
      throw new Error(`malformed entry '${entry.trim()}' (expected tenantKey:workspaceUrl[:ROLE])`)
    }

    const [tenantKey, workspaceUrl, rawRole] = parts
    if (tenantKey === '' || workspaceUrl === '') {
      throw new Error(`malformed entry '${entry.trim()}' (empty tenant key or workspace url)`)
    }
    if (result.has(tenantKey)) {
      throw new Error(`duplicate tenant key '${tenantKey}'`)
    }

    const role = rawRole === undefined || rawRole === '' ? DEFAULT_MAPPED_ROLE : parseAssignableRole(rawRole)
    result.set(tenantKey, { workspaceUrl, role })
  }

  if (result.size === 0) {
    throw new Error('no usable entries')
  }

  return result
}

/**
 * Parses a strict boolean env var. Anything other than `true`/`false` throws so a typo
 * (`ture`, `yes`, `1`) cannot be silently read as one of the two meanings.
 */
export function parseStrictBoolean (raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback

  const normalized = raw.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false

  throw new Error(`expected 'true' or 'false', got '${raw}'`)
}

// ---------------------------------------------------------------------------
// Audit events
//
// `account_events.event_type` is a plain string column (no DB-level enum), so a
// fork-specific event type can be recorded without touching `server/account`.
// `AccountEventType` in that package is an enum of upstream values only, hence the cast
// at the single insertion point below.
// ---------------------------------------------------------------------------

export enum FeishuAccountEventType {
  WorkspaceAssigned = 'feishu_workspace_assigned',
  WorkspaceApprovalRequired = 'feishu_workspace_approval_required',
  ProfileSynced = 'feishu_profile_synced'
}

/**
 * Appends an audit row. Never throws: an audit write must not be able to fail a login
 * that has otherwise succeeded, nor to mask the real reason for a rejection.
 */
export async function recordFeishuEvent (
  measureCtx: MeasureContext,
  db: AccountDB,
  accountUuid: AccountUuid,
  eventType: FeishuAccountEventType,
  data: Record<string, any>
): Promise<void> {
  try {
    await db.accountEvent.insertOne({
      accountUuid,
      eventType: eventType as any,
      time: Date.now(),
      data
    })
  } catch (err: any) {
    measureCtx.error('Feishu audit event not recorded', { eventType, reason: err.message })
  }
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export interface FeishuWorkspaceTarget {
  workspaceUuid: WorkspaceUuid
  workspaceUrl: string
  role: AccountRole
}

export type FeishuAssignmentOutcome =
  | { kind: 'assigned', role: AccountRole }
  | { kind: 'already-member', role: AccountRole }
  | { kind: 'approval-required' }
  | { kind: 'failed', reason: string }

/**
 * Resolves the configured workspace for a tenant.
 *
 * Runs *before* any account is created so that a tenant which is allow-listed but has no
 * workspace mapping is rejected without leaving a person/account/social id behind, in the
 * same spirit as the tenant allow-list check itself.
 */
export interface FeishuWorkspaceResolutionError {
  error: 'no-mapping' | 'workspace-not-found' | 'lookup-failed'
  workspaceUrl?: string
  reason?: string
}

export async function resolveWorkspaceTarget (
  db: AccountDB,
  map: FeishuTenantWorkspaceMap,
  tenantKey: string
): Promise<FeishuWorkspaceTarget | FeishuWorkspaceResolutionError> {
  const mapping = map.get(tenantKey)
  if (mapping === undefined) {
    return { error: 'no-mapping' }
  }

  let workspace
  try {
    workspace = await db.workspace.findOne({ url: mapping.workspaceUrl })
  } catch (err: any) {
    // A failing lookup must become a diagnosable login rejection, not a 500 out of the
    // callback route.
    return { error: 'lookup-failed', workspaceUrl: mapping.workspaceUrl, reason: err.message }
  }

  if (workspace == null) {
    return { error: 'workspace-not-found', workspaceUrl: mapping.workspaceUrl }
  }

  return { workspaceUuid: workspace.uuid, workspaceUrl: mapping.workspaceUrl, role: mapping.role }
}

/**
 * Assigns the account to the mapped workspace on first login.
 *
 * - An account that is already a member keeps the role it has. The mapping supplies a
 *   *default* role for a first join; it must never overwrite a role a workspace admin has
 *   since changed (AUTH-006: "禁止覆盖 Huly 权限角色").
 * - With `autoProvision === false` nothing is assigned: the account exists and has
 *   authenticated, but is not a member. An audit row records the request so an operator
 *   can find it; the caller is expected to reject the login with a diagnosable reason.
 * - A failing `assignWorkspace` is reported, never swallowed: without a workspace there is
 *   nothing for the user to reach, so the login is rejected rather than half-completed.
 */
export async function assignFeishuWorkspace (
  measureCtx: MeasureContext,
  db: AccountDB,
  accountUuid: AccountUuid,
  target: FeishuWorkspaceTarget,
  tenantKey: string,
  autoProvision: boolean
): Promise<FeishuAssignmentOutcome> {
  let existingRole: AccountRole | null
  try {
    existingRole = await db.getWorkspaceRole(accountUuid, target.workspaceUuid)
  } catch (err: any) {
    measureCtx.error('Feishu workspace membership lookup failed', {
      provider: 'feishu',
      tenantKey,
      workspaceUrl: target.workspaceUrl,
      reason: err.message
    })
    return { kind: 'failed', reason: err.message }
  }

  if (existingRole != null) {
    return { kind: 'already-member', role: existingRole }
  }

  if (!autoProvision) {
    measureCtx.warn('Feishu login is awaiting workspace approval', {
      provider: 'feishu',
      accountUuid,
      tenantKey,
      workspaceUrl: target.workspaceUrl,
      requestedRole: target.role
    })
    await recordFeishuEvent(measureCtx, db, accountUuid, FeishuAccountEventType.WorkspaceApprovalRequired, {
      tenantKey,
      workspaceUuid: target.workspaceUuid,
      workspaceUrl: target.workspaceUrl,
      requestedRole: target.role
    })
    return { kind: 'approval-required' }
  }

  try {
    await db.assignWorkspace(accountUuid, target.workspaceUuid, target.role)
  } catch (err: any) {
    measureCtx.error('Feishu workspace assignment failed', {
      provider: 'feishu',
      accountUuid,
      tenantKey,
      workspaceUrl: target.workspaceUrl,
      reason: err.message
    })
    return { kind: 'failed', reason: err.message }
  }

  measureCtx.info('Feishu workspace assigned', {
    provider: 'feishu',
    accountUuid,
    tenantKey,
    workspaceUrl: target.workspaceUrl,
    role: target.role
  })
  await recordFeishuEvent(measureCtx, db, accountUuid, FeishuAccountEventType.WorkspaceAssigned, {
    tenantKey,
    workspaceUuid: target.workspaceUuid,
    workspaceUrl: target.workspaceUrl,
    role: target.role
  })

  return { kind: 'assigned', role: target.role }
}
