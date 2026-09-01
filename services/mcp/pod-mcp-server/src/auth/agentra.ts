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

import { getClient as getAccountClient } from '@hcengineering/account-client'
import type { PersonUuid, WorkspaceUuid } from '@hcengineering/core'
import { generateToken } from '@hcengineering/server-token'

/**
 * Turn a verified Feishu identity into an Agentra token for that same person.
 *
 * 🔴 This is why the service holds `SERVER_SECRET`, and it is the one genuinely
 * privileged thing it does: with that secret it could mint a token for anybody.
 * The narrowing that makes it acceptable is upstream, not here — the caller has
 * already checked the Feishu tenant allow-list, and the social key it passes is
 * derived from a Feishu-verified `open_id`, never from user input.
 *
 * The alternative (a single static API token shared by every agent) is strictly
 * worse: it makes every action look like one account and cannot be attributed.
 */
export interface AgentraAuth {
  accountsUrl: string
  serverSecret: string
  workspaceUuid: WorkspaceUuid
  /** How long a minted token stays valid, in seconds. */
  tokenTtlSec: number
}

/** A system token, used only to look the social id up in the account service. */
function systemToken (auth: AgentraAuth): string {
  return generateToken('' as PersonUuid, auth.workspaceUuid, { service: 'mcp' }, auth.serverSecret)
}

export async function resolvePerson (auth: AgentraAuth, socialKey: string): Promise<PersonUuid | undefined> {
  const client = getAccountClient(auth.accountsUrl, systemToken(auth))
  const socialId = await client.findFullSocialIdBySocialKey(socialKey)
  return socialId?.personUuid
}

export function mintUserToken (auth: AgentraAuth, person: PersonUuid): { token: string, expiresAt: number } {
  const exp = Math.floor(Date.now() / 1000) + auth.tokenTtlSec
  // An expiry is what keeps a leaked MCP access token from being useful forever.
  // The platform has no revocation list for tokens minted this way, so a bounded
  // lifetime is the only brake — keep it short and let the client re-authorize.
  const token = generateToken(person, auth.workspaceUuid, {}, auth.serverSecret, { exp })
  return { token, expiresAt: exp }
}
