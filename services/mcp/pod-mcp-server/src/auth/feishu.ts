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

import { concatLink } from '@hcengineering/core'

// A deliberately thin wrapper over the two Feishu endpoints this service needs.
//
// ⚠️ `pods/authProviders/src/feishu.ts` has equivalent helpers, but importing that
// module drags `@hcengineering/account` (and its database drivers) into this
// service at runtime. What is duplicated here is only the *shape of two HTTP
// calls*, not a security control: the HMAC-signed state lives in `provider.ts`
// and carries a different payload (the MCP client's redirect_uri and PKCE
// challenge), so it could not have been shared anyway.
//
// Keep the paths below in sync with that file if Feishu changes its API.

const AUTHORIZE_PATH = '/open-apis/authen/v1/authorize'
const TOKEN_PATH = '/open-apis/authen/v2/oauth/token'
const USER_INFO_PATH = '/open-apis/authen/v1/user_info'

export const DEFAULT_AUTH_BASE_URL = 'https://open.feishu.cn'
export const DEFAULT_API_BASE_URL = 'https://open.feishu.cn'

export interface FeishuConfig {
  clientId: string
  clientSecret: string
  redirectUrl: string
  allowedTenantKeys: string[]
  authBaseUrl: string
  apiBaseUrl: string
  scope: string
}

export interface FeishuProfile {
  openId: string
  tenantKey: string
  name: string
  firstName: string
  lastName: string
}

export function buildAuthorizeUrl (config: FeishuConfig, state: string): string {
  const url = new URL(concatLink(config.authBaseUrl, AUTHORIZE_PATH))
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', state)
  if (config.scope !== '') {
    url.searchParams.set('scope', config.scope)
  }
  return url.toString()
}

/**
 * ⚠️ THE HTTP STATUS ALONE IS NOT DIAGNOSABLE. Feishu answers every configuration
 * mistake with a flat 400 and puts the cause in the body — "redirect_uri mismatch",
 * "code already used" and "app not enabled" are indistinguishable without it.
 *
 * 🔴 Only `code` / `error` / `error_description` are read, never the whole body:
 * a success body carries `access_token`, and blanket-logging the response would
 * put a live credential in the log the moment Feishu returns a token alongside a
 * non-2xx status. Error bodies carry no secret.
 */
export async function exchangeCodeForToken (config: FeishuConfig, code: string): Promise<string> {
  const res = await fetch(concatLink(config.apiBaseUrl, TOKEN_PATH), {
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

  const body: any = await res.json().catch(() => ({}))
  if (res.status < 200 || res.status >= 300) {
    const detail = [body?.code, body?.error, body?.error_description].filter((v) => v != null).join(' ')
    throw new Error(`Feishu token exchange failed (${res.status})${detail !== '' ? ': ' + detail : ''}`)
  }
  const token: unknown = body?.access_token
  if (typeof token !== 'string' || token === '') {
    throw new Error('Feishu token response is missing access_token')
  }
  return token
}

export async function fetchProfile (config: FeishuConfig, accessToken: string): Promise<FeishuProfile> {
  const res = await fetch(concatLink(config.apiBaseUrl, USER_INFO_PATH), {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  const body: any = await res.json().catch(() => ({}))
  if (res.status < 200 || res.status >= 300) {
    const detail = [body?.code, body?.msg].filter((v) => v != null).join(' ')
    throw new Error(`Feishu user_info failed (${res.status})${detail !== '' ? ': ' + detail : ''}`)
  }

  const data = body?.data ?? {}
  const openId: unknown = data.open_id
  const tenantKey: unknown = data.tenant_key
  if (typeof openId !== 'string' || openId === '') throw new Error('Feishu user info is missing open_id')
  if (typeof tenantKey !== 'string' || tenantKey === '') throw new Error('Feishu user info is missing tenant_key')

  const name: string = typeof data.name === 'string' ? data.name : ''
  const parts = name.split(' ')
  return { openId, tenantKey, name, firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') }
}

/**
 * Same separator rule as the login provider's `buildFeishuSocialValue`: the social
 * key is `feishu:<tenantKey>.<openId>`, so neither part may contain `:` or `.` or
 * the key becomes ambiguous and could collide with another identity.
 */
export function buildSocialKey (tenantKey: string, openId: string): string {
  if ([tenantKey, openId].some((part) => part === '' || part.includes(':') || part.includes('.'))) {
    throw new Error('Feishu identifiers contain an unsupported separator character')
  }
  return `feishu:${tenantKey}.${openId}`
}

/**
 * The tenant allow-list is checked BEFORE anything is minted — the same order the
 * login provider uses, so a stranger's Feishu account never reaches the account
 * service at all.
 */
export function isTenantAllowed (config: FeishuConfig, tenantKey: string): boolean {
  return config.allowedTenantKeys.includes(tenantKey)
}

export function parseAllowedTenantKeys (raw: string | undefined): string[] {
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '')
}
