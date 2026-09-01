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

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

import { type AgentraAuth, mintUserToken, resolvePerson } from './agentra'
import { buildAuthorizeUrl, buildSocialKey, exchangeCodeForToken, fetchProfile, isTenantAllowed, type FeishuConfig } from './feishu'

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
 * The state we hand to Feishu.
 *
 * It is HMAC-signed rather than stored, so a callback that did not originate
 * from an /authorize we issued cannot be replayed into one. The signature covers
 * the whole payload including `iat`, which is what bounds the replay window.
 */
function signState (secret: string, payload: object): string {
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url')
  const mac = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}

function verifyState (secret: string, raw: string | undefined): PendingAuthorization {
  if (raw === undefined) throw new Error('missing state')
  const [body, mac] = raw.split('.')
  if (body === undefined || mac === undefined) throw new Error('malformed state')

  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  // Constant-time compare: a length-leaking or short-circuiting comparison here
  // would let an attacker discover a valid MAC byte by byte.
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad state signature')

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
  if (typeof payload.iat !== 'number' || Date.now() - payload.iat > STATE_TTL_MS) {
    throw new Error('state expired')
  }
  return payload as PendingAuthorization
}

class MemoryClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>()

  getClient (clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId)
  }

  registerClient (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000)
    }
    this.clients.set(full.client_id, full)
    return full
  }
}

export class FeishuBackedProvider implements OAuthServerProvider {
  readonly clientsStore = new MemoryClientsStore()

  private readonly codes = new Map<string, IssuedCode>()
  private readonly tokens = new Map<string, IssuedToken>()

  constructor (
    private readonly feishu: FeishuConfig,
    private readonly agentra: AgentraAuth,
    private readonly stateSecret: string
  ) {}

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
    res.redirect(buildAuthorizeUrl(this.feishu, signState(this.stateSecret, pending)))
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

  async challengeForAuthorizationCode (
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const issued = this.codes.get(authorizationCode)
    if (issued === undefined || issued.clientId !== client.client_id) {
      throw new Error('invalid authorization code')
    }
    return issued.codeChallenge
  }

  async exchangeAuthorizationCode (
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
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

  async verifyAccessToken (token: string): Promise<AuthInfo> {
    const issued = this.tokens.get(token)
    if (issued === undefined) throw new Error('invalid access token')
    if (issued.expiresAt * 1000 <= Date.now()) {
      this.tokens.delete(token)
      throw new Error('access token expired')
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
