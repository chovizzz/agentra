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
import { systemAccountUuid, type PersonUuid, type WorkspaceUuid } from '@hcengineering/core'
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

/**
 * A system token, used only to look the social id up in the account service.
 *
 * 🔴 The account uuid must be `systemAccountUuid`, not an empty string — the
 * account service rejects a blank one with `Invalid account uuid: ""`, which
 * surfaces to the user as a bare `access_denied` at the end of the Feishu
 * round-trip, long after the actual mistake.
 *
 * No workspace is bound: this token only resolves a social id, and scoping it to
 * a workspace would imply an authority it does not need.
 */
function systemToken (auth: AgentraAuth): string {
  return generateToken(systemAccountUuid, undefined, { service: 'mcp' }, auth.serverSecret)
}

/**
 * socialKey -> PersonId -> PersonUuid, in two calls.
 *
 * 🔴 NOT `findFullSocialIdBySocialKey`, which would do it in one: that endpoint is
 * behind `verifyAllowedServices(['telegram-bot','gmail','tool','workspace',
 * 'google-calendar'])` (server/account/src/serviceOperations.ts), so calling it as
 * `service: 'mcp'` fails with a bare `platform:status:Forbidden` — and that failure
 * only surfaces at the very end of the Feishu round-trip.
 *
 * The two endpoints used here take any decodable token, which is what a service
 * outside that hard-coded list is meant to use. Labelling ourselves `tool` to slip
 * past the list would make the audit trail lie about who called.
 *
 * `requireAccount` is on deliberately: a Feishu identity with a person but no
 * account cannot log in, and minting a token for it would paper over that.
 */
export async function resolvePerson (auth: AgentraAuth, socialKey: string): Promise<PersonUuid | undefined> {
  const client = getAccountClient(auth.accountsUrl, systemToken(auth))
  const socialId = await client.findSocialIdBySocialKey(socialKey)
  if (socialId === undefined) return undefined
  return await client.findPersonBySocialId(socialId, true)
}

export function mintUserToken (auth: AgentraAuth, person: PersonUuid): { token: string, expiresAt: number } {
  const exp = Math.floor(Date.now() / 1000) + auth.tokenTtlSec
  // An expiry is what keeps a leaked MCP access token from being useful forever.
  // The platform has no revocation list for tokens minted this way, so a bounded
  // lifetime is the only brake — keep it short and let the client re-authorize.
  const token = generateToken(person, auth.workspaceUuid, {}, auth.serverSecret, { exp })
  return { token, expiresAt: exp }
}
