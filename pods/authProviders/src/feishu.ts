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
import { type ProviderInfo } from '@hcengineering/account-client'
import {
  type AccountUuid,
  type BrandingMap,
  type MeasureContext,
  concatLink,
  getBranding,
  SocialIdType
} from '@hcengineering/core'
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import type Router from 'koa-router'

import { type Passport } from '.'
import { syncFeishuProfile } from './feishuProfile'
import {
  assignFeishuWorkspace,
  type FeishuTenantWorkspaceMap,
  type FeishuWorkspaceTarget,
  parseStrictBoolean,
  parseTenantWorkspaceMap,
  resolveWorkspaceTarget
} from './feishuWorkspace'
import { type AuthState, getHost, handleProviderAuth } from './utils'

// ---------------------------------------------------------------------------
// Feishu / Lark protocol constants
//
// TODO(需外部核实): the following endpoint paths and payload shapes are taken from
// the Feishu open platform OAuth documentation and have NOT been verified against a
// live tenant in this change. They are deliberately kept as a thin, replaceable
// wrapper (see `FeishuEndpoints`) so a single config object can be corrected:
//   - authorize:  GET  /open-apis/authen/v1/authorize (params: client_id, redirect_uri,
//                 response_type=code, state, scope)
//   - token:      POST /open-apis/authen/v2/oauth/token (JSON body with grant_type=
//                 authorization_code, client_id, client_secret, code, redirect_uri)
//   - user info:  GET  /open-apis/authen/v1/user_info (Bearer user_access_token)
// TODO(需外部核实): whether the authorization `code` is strictly single-use and its TTL.
// TODO(需外部核实): exact semantics of `tenant_key` / `open_id` / `union_id` (open_id is
// documented as app-scoped, union_id as ISV-developer-scoped, tenant_key as the tenant).
// TODO(需外部核实): whether Feishu echoes `state` back verbatim per RFC 6749 (assumed yes).
// TODO(需外部核实): minimal scope string required for `user_info`. Empty scope is sent by
// default because the v1 authorize endpoint historically did not require one.
// ---------------------------------------------------------------------------

const DEFAULT_AUTH_BASE_URL = 'https://open.feishu.cn'
const DEFAULT_API_BASE_URL = 'https://open.feishu.cn'

const AUTHORIZE_PATH = '/open-apis/authen/v1/authorize'
const TOKEN_PATH = '/open-apis/authen/v2/oauth/token'
const USER_INFO_PATH = '/open-apis/authen/v1/user_info'

/** How long a signed state stays valid. */
export const STATE_TTL_MS = 10 * 60 * 1000

export interface FeishuEndpoints {
  authBaseUrl: string
  apiBaseUrl: string
}

export interface FeishuConfig {
  clientId: string
  clientSecret: string
  redirectUrl: string
  allowedTenantKeys: string[]
  scope: string
  endpoints: FeishuEndpoints
}

export interface FeishuUserProfile {
  openId: string
  unionId?: string
  tenantKey: string
  name: string
  firstName: string
  lastName: string
  /**
   * Read for AUTH-006 only; never persisted from this pod (see `feishuProfile.ts` for
   * why the account database has nowhere to store an avatar).
   */
  avatarUrl?: string
  enName?: string
}

export type FetchLike = (input: string, init?: any) => Promise<any>

// ---------------------------------------------------------------------------
// Social id encoding
// ---------------------------------------------------------------------------

/**
 * Encodes the Feishu identity into a SocialId value.
 *
 * A colon MUST NOT appear here: `buildSocialIdString` joins `${type}:${value}` and
 * `parseSocialIdString` splits on ':' taking only the first two segments, so a colon
 * would silently truncate the value. A dot is used as the separator instead.
 */
export function buildFeishuSocialValue (tenantKey: string, openId: string): string {
  if ([tenantKey, openId].some((part) => part === '' || part.includes(':') || part.includes('.'))) {
    throw new Error('Feishu identifiers contain an unsupported separator character')
  }

  return `${tenantKey}.${openId}`
}

// ---------------------------------------------------------------------------
// Signed, replay-protected state
// ---------------------------------------------------------------------------

interface SignedStatePayload extends AuthState {
  nonce: string
  iat: number
}

function b64url (buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url (str: string): Buffer {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function sign (secret: string, body: string): string {
  return b64url(createHmac('sha256', secret).update(body).digest())
}

/**
 * Tracks state nonces that have already been redeemed so a captured callback URL
 * cannot be replayed.
 *
 * TODO: process-local only. With more than one accounts replica a shared store
 * (Redis/DB) is required; a replayed callback could otherwise land on another replica.
 */
export class ConsumedNonceStore {
  private readonly consumed = new Map<string, number>()

  constructor (
    private readonly ttlMs: number = STATE_TTL_MS,
    private readonly maxEntries: number = 100000
  ) {}

  private prune (now: number): void {
    for (const [nonce, expiresAt] of this.consumed) {
      if (expiresAt <= now) {
        this.consumed.delete(nonce)
      }
    }
  }

  /** Returns true if the nonce was unused and is now marked as consumed. */
  consume (nonce: string, now: number = Date.now()): boolean {
    this.prune(now)
    if (this.consumed.has(nonce)) {
      return false
    }
    // Hard cap so a flood of valid-but-unused states cannot grow the map without bound.
    // Map preserves insertion order, so the oldest entry is the first key.
    while (this.consumed.size >= this.maxEntries) {
      const oldest = this.consumed.keys().next()
      if (oldest.done === true) break
      this.consumed.delete(oldest.value)
    }
    this.consumed.set(nonce, now + this.ttlMs)
    return true
  }
}

export interface IssuedState {
  state: string
  nonce: string
}

export function encodeSignedState (secret: string, state: AuthState, now: number = Date.now()): IssuedState {
  const nonce = b64url(randomBytes(18))
  const payload: SignedStatePayload = { ...state, nonce, iat: now }
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))

  return { state: `${body}.${sign(secret, body)}`, nonce }
}

/**
 * Verifies a signed state. Throws on a missing, malformed, tampered, expired, unbound
 * or replayed state — it never falls back to an empty state.
 *
 * `boundNonce` is the nonce this browser was given when the flow started (carried in a
 * signed, httpOnly cookie). Without it an attacker could complete their own Feishu
 * authorization and feed the resulting callback URL to a victim (login CSRF): the HMAC
 * proves the state was issued by us, not that it was issued to *this* browser.
 */
export function verifySignedState (
  secret: string,
  raw: string | undefined,
  nonces: ConsumedNonceStore,
  boundNonce: string | undefined,
  now: number = Date.now()
): AuthState {
  if (raw == null || raw === '') {
    throw new Error('Missing state')
  }

  const sep = raw.lastIndexOf('.')
  if (sep <= 0 || sep === raw.length - 1) {
    throw new Error('Malformed state')
  }

  const body = raw.slice(0, sep)
  const provided = Buffer.from(raw.slice(sep + 1), 'utf8')
  const expected = Buffer.from(sign(secret, body), 'utf8')

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new Error('State signature mismatch')
  }

  let payload: SignedStatePayload
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'))
  } catch {
    throw new Error('Malformed state payload')
  }

  if (typeof payload?.nonce !== 'string' || payload.nonce === '' || typeof payload?.iat !== 'number') {
    throw new Error('Malformed state payload')
  }

  if (now - payload.iat > STATE_TTL_MS || payload.iat - now > STATE_TTL_MS) {
    throw new Error('State expired')
  }

  // Checked before the nonce is consumed so a mismatching request cannot burn it.
  if (boundNonce == null || boundNonce === '' || boundNonce !== payload.nonce) {
    throw new Error('State not bound to this browser')
  }

  if (!nonces.consume(payload.nonce, now)) {
    throw new Error('State replayed')
  }

  const { nonce, iat, ...authState } = payload

  return authState
}

// ---------------------------------------------------------------------------
// Thin Feishu API wrapper
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl (config: FeishuConfig, state: string): string {
  const url = new URL(concatLink(config.endpoints.authBaseUrl, AUTHORIZE_PATH))
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', state)
  if (config.scope !== '') {
    url.searchParams.set('scope', config.scope)
  }

  return url.toString()
}

export async function exchangeCodeForToken (config: FeishuConfig, code: string, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(concatLink(config.endpoints.apiBaseUrl, TOKEN_PATH), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUrl
    })
  })

  if (res.status < 200 || res.status >= 300) {
    // ⚠️ THE STATUS ALONE IS NOT DIAGNOSABLE. Feishu answers every configuration
    // mistake with a flat HTTP 400 and puts the real cause in the BODY as
    // `{ code, error, error_description }` — "redirect_uri mismatch", "code
    // already used", "app not enabled" are all 400. Without the body a
    // misconfigured redirect URI is indistinguishable from a replayed code.
    //
    // 🔴 ONLY THE ERROR FIELDS ARE READ, NEVER THE WHOLE BODY. A success body
    // carries `access_token` / `refresh_token`; blanket-logging the response
    // would put live credentials in the log the moment Feishu returns a
    // non-2xx alongside a token. Error bodies carry no secret.
    let detail = ''
    try {
      const body = await res.json()
      const parts = [body?.code, body?.error, body?.error_description ?? body?.msg].filter(
        (p: unknown) => p !== undefined && p !== null && p !== ''
      )
      if (parts.length > 0) detail = ` (${parts.join(' / ')})`
    } catch {
      // Body absent or not JSON — the status alone is all there is to report.
    }
    throw new Error(`Feishu token endpoint returned HTTP ${res.status as number}${detail}`)
  }

  const json = await res.json()
  if (json?.code !== undefined && json.code !== 0) {
    throw new Error(`Feishu token endpoint returned business code ${json.code as number}`)
  }

  const accessToken = json?.access_token ?? json?.data?.access_token
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('Feishu token endpoint returned no access token')
  }

  return accessToken
}

export async function fetchUserProfile (
  config: FeishuConfig,
  accessToken: string,
  fetchImpl: FetchLike
): Promise<FeishuUserProfile> {
  const res = await fetchImpl(concatLink(config.endpoints.apiBaseUrl, USER_INFO_PATH), {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` }
  })

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Feishu user info endpoint returned HTTP ${res.status as number}`)
  }

  const json = await res.json()
  if (json?.code !== undefined && json.code !== 0) {
    throw new Error(`Feishu user info endpoint returned business code ${json.code as number}`)
  }

  const data = json?.data ?? {}
  const openId: unknown = data.open_id
  const tenantKey: unknown = data.tenant_key

  if (typeof openId !== 'string' || openId === '') {
    throw new Error('Feishu user info is missing open_id')
  }
  if (typeof tenantKey !== 'string' || tenantKey === '') {
    throw new Error('Feishu user info is missing tenant_key')
  }

  const name: string = typeof data.name === 'string' ? data.name : ''
  const nameParts = name.split(' ')

  return {
    openId,
    // TODO: union_id is read but intentionally not persisted yet — the unbinding /
    // offboarding / tenant-migration strategy is undecided.
    unionId: typeof data.union_id === 'string' ? data.union_id : undefined,
    tenantKey,
    name,
    firstName: nameParts[0] ?? '',
    lastName: nameParts.slice(1).join(' '),
    // TODO(需外部核实): `avatar_url` / `en_name` are documented fields of the v1 user_info
    // response but have not been verified against a live tenant in this change.
    avatarUrl: typeof data.avatar_url === 'string' && data.avatar_url !== '' ? data.avatar_url : undefined,
    enName: typeof data.en_name === 'string' && data.en_name !== '' ? data.en_name : undefined
  }
}

export function isTenantAllowed (config: FeishuConfig, tenantKey: string): boolean {
  return config.allowedTenantKeys.includes(tenantKey)
}

/**
 * Read an environment variable, treating blank as ABSENT.
 *
 * 🔴 NOT DEFENSIVE PADDING — `=== undefined` AND `??` BOTH MISS THE EMPTY STRING,
 * AND THE EMPTY STRING IS THE COMMON CASE IN A CONTAINER. `docker-compose`'s
 * `- FOO=${FOO}` sets `FOO` to `""` inside the container when `FOO` is unset on
 * the host; so does a `.env` line reading `FOO=`. Node then reports `""`, not
 * `undefined`. Without this:
 *
 * - `clientId === undefined` is FALSE for `""`, so the provider registers with
 *   an empty client id and every login fails at Feishu with an opaque error
 *   instead of the button simply not appearing;
 * - `process.env.FEISHU_REDIRECT_URL ?? <derived>` yields `""`, so the derived
 *   fallback never runs and the authorize request carries an empty redirect_uri.
 *
 * ⚠️ SCOPE OF THE ACTUAL BUG, verified by reverting each call site one at a time
 * and re-running the suite: the reads that genuinely needed this are
 * `FEISHU_CLIENT_ID`, `FEISHU_CLIENT_SECRET`, `FEISHU_REDIRECT_URL` and
 * `FEISHU_DISPLAY_NAME`. The parser-backed reads (`*_AUTO_PROVISION`,
 * `*_SYNC_PROFILE`, `*_TENANT_WORKSPACE_MAP`, `*_STATE_HMAC_SECRET`) were
 * already blank-safe inside their own parsers and use this only for uniformity.
 * Every read in this file goes through it so that adding the next variable is
 * not a fresh judgement call about which side of that line it falls on.
 *
 * @public
 */
export function envOrUndefined (name: string): string | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  return raw
}

export function parseAllowedTenantKeys (raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '')
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

/**
 * Appends a machine-readable reason to a login redirect so a rejected user never lands on
 * a bare page with nothing to go on, and so the reason is visible in the browser, the
 * access log and the support ticket. Only fixed, non-sensitive reason codes are used.
 */
export function withAuthError (base: string, reason: string): string {
  try {
    const url = new URL(base)
    url.searchParams.set('authError', reason)
    return url.toString()
  } catch {
    return base
  }
}

/** True when both urls address the same origin and path, ignoring the query string. */
function isSameEndpoint (candidate: string, expected: string): boolean {
  try {
    const a = new URL(candidate)
    const b = new URL(expected)
    return a.origin === b.origin && a.pathname === b.pathname
  } catch {
    return false
  }
}

/**
 * True when the redirect actually carries a non-empty token.
 *
 * `handleProviderAuth` builds its query as `encodeURIComponent(qs.stringify({ token }))`,
 * so the whole query string arrives percent-encoded and has to be decoded once before it
 * can be parsed. Matching the endpoint alone is not enough to call a login successful.
 */
function carriesToken (url: string): boolean {
  try {
    const decoded = decodeURIComponent(new URL(url).search.replace(/^\?/, '')).replace(/^\?/, '')
    const token = new URLSearchParams(decoded).get('token')
    return token != null && token !== ''
  } catch {
    return false
  }
}

/** Mirrors `normalizeValue` in server/account, which is applied before a social id is stored. */
function normalizeSocialValue (value: string): string {
  return value.toLowerCase().trim()
}

export function registerFeishu (
  measureCtx: MeasureContext,
  passport: Passport,
  router: Router<any, any>,
  accountsUrl: string,
  dbPromise: Promise<AccountDB>,
  frontUrl: string,
  brandings: BrandingMap,
  signUpDisabled?: boolean,
  serverSecret?: string,
  fetchImpl: FetchLike = ((input: string, init?: any) => (globalThis as any).fetch(input, init)) as FetchLike
): ProviderInfo | undefined {
  const clientId = envOrUndefined('FEISHU_CLIENT_ID')
  const clientSecret = envOrUndefined('FEISHU_CLIENT_SECRET')
  const allowedTenantKeys = parseAllowedTenantKeys(envOrUndefined('FEISHU_ALLOWED_TENANT_KEYS'))
  const name = 'feishu'
  const displayName = envOrUndefined('FEISHU_DISPLAY_NAME')

  const callbackPath = '/auth/feishu/callback'

  if (clientId === undefined || clientSecret === undefined || allowedTenantKeys.length === 0) return

  // A dedicated key is preferred so the OAuth state signature can be rotated without
  // touching the platform-wide SERVER_SECRET, but the shared secret remains a valid
  // fallback: refusing to start without a Feishu-specific key would be a hard break for
  // every deployment that already runs this provider.
  const dedicatedStateSecret = envOrUndefined('FEISHU_STATE_HMAC_SECRET')
  const stateSecret =
    dedicatedStateSecret !== undefined && dedicatedStateSecret.trim() !== '' ? dedicatedStateSecret : serverSecret
  if (stateSecret === undefined || stateSecret === '') {
    measureCtx.error('Feishu provider requires a secret to sign the OAuth state', {})
    return
  }

  // AUTH-004 configuration. A malformed value stops the provider from registering rather
  // than degrading to "no mapping": a silent degrade turns one typo into a deployment
  // where everybody authenticates successfully and nobody reaches a workspace, and the
  // only symptom appears at login time in production.
  let workspaceMap: FeishuTenantWorkspaceMap | undefined
  let autoProvision: boolean
  let syncProfile: boolean
  try {
    // ⚠️ `envOrUndefined` here is FOR UNIFORMITY, NOT A FIX — unlike the reads
    // above, these three parsers already treat a blank string as absent
    // (`parseStrictBoolean` / `parseTenantWorkspaceMap` both short-circuit on
    // `raw.trim() === ''`). Reverting these three to bare `process.env` breaks
    // no test, and that is expected. They go through the helper anyway so this
    // file has ONE rule for reading configuration rather than a per-variable
    // judgement about which parser happens to be blank-safe.
    workspaceMap = parseTenantWorkspaceMap(envOrUndefined('FEISHU_TENANT_WORKSPACE_MAP'))
    // Default false for both: granting workspace membership and rewriting a profile are
    // privileged actions, so they are opt-in.
    autoProvision = parseStrictBoolean(envOrUndefined('FEISHU_AUTO_PROVISION'), false)
    syncProfile = parseStrictBoolean(envOrUndefined('FEISHU_SYNC_PROFILE'), false)
  } catch (err: any) {
    measureCtx.error('Feishu provider not registered: invalid configuration', { provider: name, reason: err.message })
    return
  }

  measureCtx.info('Feishu provider configured', {
    provider: name,
    tenants: allowedTenantKeys.length,
    workspaceMappings: workspaceMap?.size ?? 0,
    autoProvision,
    syncProfile,
    dedicatedStateSecret: stateSecret !== serverSecret
  })

  const config: FeishuConfig = {
    clientId,
    clientSecret,
    redirectUrl: envOrUndefined('FEISHU_REDIRECT_URL') ?? concatLink(accountsUrl, callbackPath),
    allowedTenantKeys,
    scope: envOrUndefined('FEISHU_SCOPE') ?? '',
    endpoints: {
      authBaseUrl: envOrUndefined('FEISHU_AUTH_BASE_URL') ?? DEFAULT_AUTH_BASE_URL,
      apiBaseUrl: envOrUndefined('FEISHU_API_BASE_URL') ?? DEFAULT_API_BASE_URL
    }
  }

  const nonces = new ConsumedNonceStore()
  const stateCookie = 'feishu-auth-state'
  const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, signed: true, path: '/auth/feishu' }

  router.get('/auth/feishu', async (ctx, next) => {
    measureCtx.info('try auth via', { provider: name })

    const host = getHost(ctx.request.headers)
    const authState: AuthState = {
      inviteId: ctx.query?.inviteId,
      branding: host !== undefined ? (brandings[host]?.key ?? undefined) : undefined,
      autoJoin: ctx.query?.autoJoin !== undefined,
      navigateUrl: ctx.query?.navigateUrl
    }

    const issued = encodeSignedState(stateSecret, authState)
    // Binds the flow to this browser; verified at the callback (see verifySignedState).
    ctx.cookies.set(stateCookie, issued.nonce, { ...cookieOptions, maxAge: STATE_TTL_MS })

    ctx.redirect(buildAuthorizeUrl(config, issued.state))
    await next()
  })

  router.get(callbackPath, async (ctx, next) => {
    // The state is verified before anything else: a tampered, missing, expired or
    // replayed state is rejected outright and never degrades to an empty state.
    let authState: AuthState
    let boundNonce: string | undefined
    try {
      boundNonce = ctx.cookies.get(stateCookie, { signed: true })
    } catch {
      boundNonce = undefined
    }
    ctx.cookies.set(stateCookie, null, cookieOptions)

    try {
      authState = verifySignedState(stateSecret, ctx.query?.state, nonces, boundNonce)
    } catch (err: any) {
      measureCtx.error('Feishu auth rejected', { provider: name, reason: err.message })
      ctx.redirect(concatLink(frontUrl, '/login'))
      await next()
      return
    }

    const branding = getBranding(brandings, authState.branding)
    const failureRedirect = concatLink(branding?.front ?? frontUrl, '/login')

    const code = ctx.query?.code
    if (typeof code !== 'string' || code === '') {
      measureCtx.error('Feishu auth rejected', { provider: name, reason: 'missing code' })
      ctx.redirect(failureRedirect)
      await next()
      return
    }

    let profile: FeishuUserProfile
    try {
      const accessToken = await exchangeCodeForToken(config, code, fetchImpl)
      profile = await fetchUserProfile(config, accessToken, fetchImpl)
    } catch (err: any) {
      // Only the message is logged: never the code, the access token or the secret.
      measureCtx.error('Feishu auth failed', { provider: name, reason: err.message })
      ctx.redirect(failureRedirect)
      await next()
      return
    }

    // Tenant allow-list is enforced here, before any account DB call: a disallowed
    // tenant must not create a person, an account or a social id.
    if (!isTenantAllowed(config, profile.tenantKey)) {
      measureCtx.error('Feishu auth rejected', {
        provider: name,
        reason: 'tenant not allowed',
        tenantKey: profile.tenantKey
      })
      ctx.redirect(failureRedirect)
      await next()
      return
    }

    const db = await dbPromise

    // AUTH-004. The tenant -> workspace mapping is resolved *before* the account is
    // created, so a tenant that passes the allow-list but has no mapping (or points at a
    // workspace that does not exist) is turned away without leaving a person, an account
    // or a social id behind — the same rule the allow-list check above follows.
    //
    // An invite link is a separate, already-granted authorization: a workspace admin
    // issued it deliberately, and `handleProviderAuth` routes it to `joinWithProvider`,
    // which joins the *invite's* workspace. The mapping is skipped for those logins so a
    // tenant that has no default workspace (or has auto-provisioning switched off) can
    // still accept invited users. The condition mirrors the branch `handleProviderAuth`
    // itself takes.
    const usesInvite = authState.inviteId != null && authState.inviteId !== '' && authState.autoJoin !== true

    let target: FeishuWorkspaceTarget | undefined
    if (workspaceMap !== undefined && !usesInvite) {
      const resolved = await resolveWorkspaceTarget(db, workspaceMap, profile.tenantKey)
      if ('error' in resolved) {
        const reasons = {
          'no-mapping': ['tenant has no workspace mapping', 'feishu-no-workspace-mapping'],
          'workspace-not-found': ['mapped workspace not found', 'feishu-workspace-missing'],
          'lookup-failed': ['workspace lookup failed', 'feishu-workspace-lookup-failed']
        } as const
        const [logReason, authError] = reasons[resolved.error]
        measureCtx.error('Feishu auth rejected', {
          provider: name,
          reason: logReason,
          tenantKey: profile.tenantKey,
          workspaceUrl: resolved.workspaceUrl,
          cause: resolved.reason
        })
        ctx.redirect(withAuthError(failureRedirect, authError))
        await next()
        return
      }
      target = resolved
    }

    const socialKey = { type: SocialIdType.FEISHU, value: buildFeishuSocialValue(profile.tenantKey, profile.openId) }
    const redirectUrl = await handleProviderAuth(
      measureCtx,
      db,
      brandings,
      frontUrl,
      name,
      // Re-encode the verified state in the plain format the shared helper expects.
      encodeURIComponent(JSON.stringify(authState)),
      undefined,
      // Deliberately empty: upstream silently merges accounts by matching email
      // (server/account/src/utils.ts loginOrSignUpWithProvider), which would let a
      // Feishu login take over an existing account with no confirmation.
      '',
      profile.firstName,
      profile.lastName,
      socialKey,
      signUpDisabled
    )

    // `handleProviderAuth` returns '' on error and the plain /login page when no account
    // could be established; only the /login/auth redirect carries a token. The expected url
    // is rebuilt exactly the way that helper builds it and compared on origin + pathname —
    // not a prefix match, which a hypothetical `/login/authorize` would also satisfy.
    const successUrl = concatLink(branding?.front ?? frontUrl, '/login/auth')
    if (!isSameEndpoint(redirectUrl, successUrl) || !carriesToken(redirectUrl)) {
      if (redirectUrl !== '') {
        ctx.redirect(redirectUrl)
      }
      await next()
      return
    }

    let accountUuid: AccountUuid | undefined
    if (target !== undefined || syncProfile) {
      const socialId = await db.socialId.findOne({
        type: SocialIdType.FEISHU,
        value: normalizeSocialValue(socialKey.value)
      })

      if (socialId == null) {
        // Should be unreachable: the auth above reported success, so the social id exists.
        measureCtx.error('Feishu auth rejected', { provider: name, reason: 'social id not found after auth' })
        ctx.redirect(withAuthError(failureRedirect, 'feishu-account-unavailable'))
        await next()
        return
      }
      accountUuid = socialId.personUuid as AccountUuid
    }

    if (target !== undefined && accountUuid !== undefined) {
      const outcome = await assignFeishuWorkspace(measureCtx, db, accountUuid, target, profile.tenantKey, autoProvision)

      if (outcome.kind === 'approval-required' || outcome.kind === 'failed') {
        // The token minted above is discarded — it is never sent to the browser, so an
        // unapproved user gets no session at all.
        measureCtx.error('Feishu auth rejected', {
          provider: name,
          reason: outcome.kind === 'approval-required' ? 'workspace approval required' : 'workspace assignment failed',
          tenantKey: profile.tenantKey,
          workspaceUrl: target.workspaceUrl
        })
        ctx.redirect(
          withAuthError(
            failureRedirect,
            outcome.kind === 'approval-required' ? 'feishu-approval-required' : 'feishu-assign-failed'
          )
        )
        await next()
        return
      }
    }

    // AUTH-006. Runs only after the workspace decision, only when explicitly enabled, and
    // can never change the outcome of the login: `syncFeishuProfile` swallows and reports
    // its own failures and touches no role or membership.
    if (syncProfile && accountUuid !== undefined) {
      await syncFeishuProfile(measureCtx, db, accountUuid, {
        firstName: profile.firstName,
        lastName: profile.lastName,
        avatarUrl: profile.avatarUrl,
        tenantKey: profile.tenantKey
      })
    }

    ctx.redirect(redirectUrl)

    await next()
  })

  return { name, displayName }
}
