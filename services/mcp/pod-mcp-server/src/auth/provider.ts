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

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

import { type AgentraAuth, mintUserToken, resolvePerson } from './agentra'
import {
  buildAuthorizeUrl,
  buildSocialKey,
  exchangeCodeForToken,
  fetchProfile,
  isTenantAllowed,
  type FeishuConfig
} from './feishu'

const STATE_TTL_MS = 10 * 60 * 1000
const CODE_TTL_MS = 60 * 1000

/** What we need to remember between /authorize and the Feishu callback. */
interface PendingAuthorization {
  clientId: string
  redirectUri: string
  codeChallenge: string
  state?: string
  scopes: string[]
}

interface IssuedCode extends PendingAuthorization {
  agentraToken: string
  expiresAt: number
  createdAt: number
}

interface IssuedToken {
  clientId: string
  agentraToken: string
  scopes: string[]
  expiresAt: number
}

/**
 * HMAC-sign a payload into a self-contained string.
 *
 * Used for both the Feishu `state` and the OAuth `client_id`: signing instead of
 * storing means neither depends on server memory, so a restart cannot orphan
 * them. The signature covers `iat`, which is what lets a reader impose a TTL.
 */
function sign (secret: string, payload: object): string {
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url')
  const mac = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}

function verify (secret: string, raw: string | undefined, ttlMs?: number): any {
  if (raw === undefined) throw new Error('missing value')
  const [body, mac] = raw.split('.')
  if (body === undefined || mac === undefined) throw new Error('malformed value')

  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  // Constant-time compare: a length-leaking or short-circuiting comparison here
  // would let an attacker discover a valid MAC byte by byte.
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad signature')

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
  if (ttlMs !== undefined && (typeof payload.iat !== 'number' || Date.now() - payload.iat > ttlMs)) {
    throw new Error('expired')
  }
  return payload
}

function verifyState (secret: string, raw: string | undefined): PendingAuthorization {
  try {
    return verify(secret, raw, STATE_TTL_MS) as PendingAuthorization
  } catch (err) {
    // Keep the wording the callback reports, so a rejected state is still
    // distinguishable from a Feishu-side failure in the browser.
    throw new Error(`${err instanceof Error ? err.message : 'invalid'}`.replace('value', 'state'))
  }
}

/**
 * Stateless dynamic client registration: the `client_id` IS the signed client
 * metadata, so nothing is stored and nothing is lost on restart.
 *
 * 🔴 An in-memory registry looks fine until the first redeploy, and then it fails
 * in the worst possible way: the MCP client has cached its `client_id`, the server
 * no longer knows it, and every attempt dies with `invalid_client` — with no way
 * for the user to recover short of re-adding the server. Re-authorizing after a
 * restart is acceptable; being locked out is not.
 */
class StatelessClientsStore implements OAuthRegisteredClientsStore {
  constructor (private readonly secret: string) {}

  getClient (clientId: string): OAuthClientInformationFull | undefined {
    try {
      const { iat, ...client } = verify(this.secret, clientId)
      const full: OAuthClientInformationFull = { ...client, client_id: clientId }
      return full
    } catch {
      return undefined
    }
  }

  registerClient (
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>
  ): OAuthClientInformationFull {
    return {
      ...client,
      client_id: sign(this.secret, client),
      client_id_issued_at: Math.floor(Date.now() / 1000)
    }
  }
}

export class FeishuBackedProvider implements OAuthServerProvider {
  readonly clientsStore: StatelessClientsStore

  private readonly codes = new Map<string, IssuedCode>()
  private readonly tokens = new Map<string, IssuedToken>()

  constructor (
    private readonly feishu: FeishuConfig,
    private readonly agentra: AgentraAuth,
    private readonly stateSecret: string
  ) {
    this.clientsStore = new StatelessClientsStore(stateSecret)
  }

  /**
   * Send the browser to Feishu, carrying everything needed to finish the MCP
   * authorization in the (signed) state — nothing is stored server-side yet, so a
   * flow that is never completed leaves nothing behind.
   */
  async authorize (client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const pending: PendingAuthorization = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? []
    }
    res.redirect(buildAuthorizeUrl(this.feishu, sign(this.stateSecret, pending)))
  }

  /**
   * The Feishu callback. Mounted by `index.ts` on the redirect URI registered with
   * the Feishu app, and the only place a Feishu identity becomes an Agentra token.
   */
  async handleCallback (req: Request, res: Response): Promise<void> {
    let pending: PendingAuthorization
    try {
      pending = verifyState(this.stateSecret, req.query.state as string | undefined)
    } catch (err) {
      // Nothing verified means no trustworthy redirect target, so fail here rather
      // than bouncing the browser to a URI an attacker could have supplied.
      res.status(400).send(`authorization state rejected: ${err instanceof Error ? err.message : 'invalid'}`)
      return
    }

    const fail = (reason: string): void => {
      const url = new URL(pending.redirectUri)
      url.searchParams.set('error', 'access_denied')
      url.searchParams.set('error_description', reason)
      if (pending.state !== undefined) url.searchParams.set('state', pending.state)
      res.redirect(url.toString())
    }

    try {
      const code = req.query.code
      if (typeof code !== 'string' || code === '') {
        fail('feishu did not return a code')
        return
      }

      const accessToken = await exchangeCodeForToken(this.feishu, code)
      const profile = await fetchProfile(this.feishu, accessToken)

      // Tenant gate first, before anything is looked up or minted — the same order
      // the login provider uses, so an outside tenant never reaches the account
      // service and leaves no trace behind.
      if (!isTenantAllowed(this.feishu, profile.tenantKey)) {
        fail('tenant not allowed')
        return
      }

      const person = await resolvePerson(this.agentra, buildSocialKey(profile.tenantKey, profile.openId))
      if (person === undefined) {
        // Deliberately NOT provisioning an account here. Creating people is the
        // login flow's job, where the workspace mapping and role rules live; doing
        // it from an agent-facing endpoint would be a second, weaker door into
        // account creation.
        fail('no Agentra account for this Feishu identity — sign in to Agentra once first')
        return
      }

      const minted = mintUserToken(this.agentra, person)
      const authCode = randomBytes(32).toString('base64url')
      this.codes.set(authCode, {
        ...pending,
        agentraToken: minted.token,
        expiresAt: minted.expiresAt,
        createdAt: Date.now()
      })

      const url = new URL(pending.redirectUri)
      url.searchParams.set('code', authCode)
      if (pending.state !== undefined) url.searchParams.set('state', pending.state)
      res.redirect(url.toString())
    } catch (err) {
      fail(err instanceof Error ? err.message : 'authorization failed')
    }
  }

  async challengeForAuthorizationCode (client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const issued = this.codes.get(authorizationCode)
    if (issued === undefined || issued.clientId !== client.client_id) {
      throw new Error('invalid authorization code')
    }
    return issued.codeChallenge
  }

  async exchangeAuthorizationCode (client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
    const issued = this.codes.get(authorizationCode)
    // Single use, always: deleting before any other check means a replayed code is
    // dead even if the checks below throw.
    this.codes.delete(authorizationCode)

    if (issued === undefined || issued.clientId !== client.client_id) {
      throw new Error('invalid authorization code')
    }
    if (Date.now() - issued.createdAt > CODE_TTL_MS) {
      throw new Error('authorization code expired')
    }

    const accessToken = randomBytes(32).toString('base64url')
    this.tokens.set(accessToken, {
      clientId: issued.clientId,
      agentraToken: issued.agentraToken,
      scopes: issued.scopes,
      expiresAt: issued.expiresAt
    })

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(0, issued.expiresAt - Math.floor(Date.now() / 1000)),
      scope: issued.scopes.join(' ')
    }
  }

  async exchangeRefreshToken (): Promise<OAuthTokens> {
    // No refresh tokens on purpose. The Agentra token behind an MCP session has a
    // fixed expiry we cannot extend without minting a new one, and silently
    // re-minting would defeat the bounded lifetime that is the only brake we have.
    throw new Error('refresh tokens are not supported; re-authorize instead')
  }

  /**
   * 🔴 Must throw `InvalidTokenError`, not a plain `Error`.
   *
   * `requireBearerAuth` maps only that type to 401; anything else becomes a 500,
   * and a 500 does not tell the client to re-authorize — it reads as "the server
   * is broken". Since access tokens live in memory, every redeploy invalidates
   * them, so this is the normal path, not an edge case: getting the status wrong
   * strands the user on a server that is actually healthy.
   */
  async verifyAccessToken (token: string): Promise<AuthInfo> {
    const issued = this.tokens.get(token)
    if (issued === undefined) throw new InvalidTokenError('unknown access token; re-authorize')
    if (issued.expiresAt * 1000 <= Date.now()) {
      this.tokens.delete(token)
      throw new InvalidTokenError('access token expired; re-authorize')
    }
    return {
      token,
      clientId: issued.clientId,
      scopes: issued.scopes,
      expiresAt: issued.expiresAt,
      // The Agentra token never leaves the server: it rides in `extra` so the
      // request handler can build a platform client as *this* person.
      extra: { agentraToken: issued.agentraToken }
    }
  }
}
