//
// Copyright © 2026 Agentra
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'

const loginOrSignUpWithProvider = jest.fn()
const joinWithProvider = jest.fn()

jest.mock('@hcengineering/account', () => ({
  loginOrSignUpWithProvider: (...args: any[]) => loginOrSignUpWithProvider(...args),
  joinWithProvider: (...args: any[]) => joinWithProvider(...args)
}))

const {
  ConsumedNonceStore,
  STATE_TTL_MS,
  buildAuthorizeUrl,
  buildFeishuSocialValue,
  encodeSignedState,
  exchangeCodeForToken,
  fetchUserProfile,
  parseAllowedTenantKeys,
  registerFeishu,
  verifySignedState,
  withAuthError
  // eslint-disable-next-line @typescript-eslint/no-var-requires
} = require('../feishu')

const {
  DEFAULT_MAPPED_ROLE,
  FeishuAccountEventType,
  parseAssignableRole,
  parseStrictBoolean,
  parseTenantWorkspaceMap
  // eslint-disable-next-line @typescript-eslint/no-var-requires
} = require('../feishuWorkspace')

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { syncFeishuProfile } = require('../feishuProfile')

const SECRET = 'test-server-secret'
const CLIENT_SECRET = 'super-secret-client-value'
const CODE = 'one-time-code-abc123'
const ACCESS_TOKEN = 'user-access-token-xyz789'

// ---------------------------------------------------------------------------
// Mock Feishu server
// ---------------------------------------------------------------------------

interface MockServer {
  url: string
  close: () => Promise<void>
  requests: Array<{ method: string, url: string, body: string, auth?: string }>
  tokenStatus: number
  tokenBody: any
  userInfoStatus: number
  userInfoBody: any
  usedCodes: Set<string>
}

async function startMockFeishu (): Promise<MockServer> {
  const state: MockServer = {
    url: '',
    close: async () => {},
    requests: [],
    tokenStatus: 200,
    tokenBody: { code: 0, access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 7200 },
    userInfoStatus: 200,
    userInfoBody: {
      code: 0,
      data: {
        name: 'Mei Ling',
        open_id: 'ou_abcdef0123456789',
        union_id: 'on_abcdef0123456789',
        tenant_key: 'tenantalpha'
      }
    },
    usedCodes: new Set<string>()
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      state.requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body,
        auth: req.headers.authorization
      })

      if ((req.url ?? '').startsWith('/open-apis/authen/v2/oauth/token')) {
        const parsed = body === '' ? {} : JSON.parse(body)
        if (state.tokenStatus === 200 && state.usedCodes.has(parsed.code)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ code: 20021, msg: 'code has been used' }))
          return
        }
        state.usedCodes.add(parsed.code)
        res.writeHead(state.tokenStatus, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(state.tokenBody))
        return
      }

      if ((req.url ?? '').startsWith('/open-apis/authen/v1/user_info')) {
        res.writeHead(state.userInfoStatus, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(state.userInfoBody))
        return
      }

      res.writeHead(404)
      res.end('{}')
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  state.url = `http://127.0.0.1:${addr.port}`
  state.close = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err != null) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  return state
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface LogEntry {
  level: string
  message: string
  params: any
}

function makeMeasureCtx (logs: LogEntry[]): any {
  const push = (level: string) => (message: string, params: any) => {
    logs.push({ level, message, params })
  }
  return { info: push('info'), warn: push('warn'), error: push('error') }
}

type Routes = Record<string, (ctx: any, next: any) => Promise<void>>

function makeRouter (routes: Routes): any {
  return {
    get: (path: string, ...handlers: Array<(ctx: any, next: any) => Promise<void>>) => {
      routes[path] = handlers[handlers.length - 1]
    }
  }
}

// One jar shared by the authorize ctx and the callback ctx, standing in for the browser.
function makeCookieJar (): any {
  const jar = new Map<string, string>()
  return {
    jar,
    cookies: {
      get: (name: string) => jar.get(name),
      set: (name: string, value: string | null) => {
        if (value == null) {
          jar.delete(name)
        } else {
          jar.set(name, value)
        }
      }
    }
  }
}

function makeCtx (query: any = {}, cookies?: any): any {
  const ctx: any = {
    query,
    request: { headers: {} },
    state: {},
    redirectedTo: undefined,
    cookies: cookies ?? makeCookieJar().cookies
  }
  ctx.redirect = (url: string) => {
    ctx.redirectedTo = url
  }
  return ctx
}

const ENV_KEYS = [
  'FEISHU_CLIENT_ID',
  'FEISHU_CLIENT_SECRET',
  'FEISHU_REDIRECT_URL',
  'FEISHU_ALLOWED_TENANT_KEYS',
  'FEISHU_DISPLAY_NAME',
  'FEISHU_SCOPE',
  'FEISHU_AUTH_BASE_URL',
  'FEISHU_API_BASE_URL',
  'FEISHU_AUTO_PROVISION',
  'FEISHU_SYNC_PROFILE',
  'FEISHU_TENANT_WORKSPACE_MAP',
  'FEISHU_STATE_HMAC_SECRET'
]

// ---------------------------------------------------------------------------
// Fake account db, just enough of AccountDB for the workspace/profile paths.
// ---------------------------------------------------------------------------

interface FakeDb {
  db: any
  workspaces: Array<{ uuid: string, url: string }>
  roles: Map<string, string>
  socialIds: any[]
  persons: any[]
  events: any[]
  assignCalls: Array<[string, string, string]>
  assignError?: Error
  workspaceLookupError?: Error
  roleLookupError?: Error
  personUpdateError?: Error
  eventInsertError?: Error
}

function makeFakeDb (overrides: Partial<FakeDb> = {}): FakeDb {
  const state: FakeDb = {
    db: undefined,
    workspaces: [{ uuid: 'ws-uuid-alpha', url: 'agentra-main' }],
    roles: new Map<string, string>(),
    socialIds: [{ type: 'feishu', value: 'tenantalpha.ou_abcdef0123456789', personUuid: 'person-1' }],
    persons: [{ uuid: 'person-1', firstName: 'Old', lastName: 'Name' }],
    events: [],
    assignCalls: [],
    ...overrides
  }

  state.db = {
    workspace: {
      findOne: async (q: any) => {
        if (state.workspaceLookupError != null) throw state.workspaceLookupError
        return state.workspaces.find((w) => w.url === q.url) ?? null
      }
    },
    socialId: {
      findOne: async (q: any) => state.socialIds.find((s: any) => s.type === q.type && s.value === q.value) ?? null
    },
    person: {
      findOne: async (q: any) => state.persons.find((p: any) => p.uuid === q.uuid) ?? null,
      update: async (q: any, ops: any) => {
        if (state.personUpdateError != null) throw state.personUpdateError
        const person = state.persons.find((p: any) => p.uuid === q.uuid)
        if (person != null) Object.assign(person, ops)
      }
    },
    accountEvent: {
      insertOne: async (data: any) => {
        if (state.eventInsertError != null) throw state.eventInsertError
        state.events.push(data)
      }
    },
    getWorkspaceRole: async (account: string, ws: string) => {
      if (state.roleLookupError != null) throw state.roleLookupError
      return state.roles.get(`${account}/${ws}`) ?? null
    },
    assignWorkspace: async (account: string, ws: string, role: string) => {
      if (state.assignError != null) throw state.assignError
      state.assignCalls.push([account, ws, role])
      state.roles.set(`${account}/${ws}`, role)
    }
  }

  return state
}

describe('feishu auth provider', () => {
  let mock: MockServer
  let logs: LogEntry[]
  let routes: Routes
  const savedEnv: Record<string, string | undefined> = {}

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  })

  beforeEach(async () => {
    mock = await startMockFeishu()
    logs = []
    routes = {}
    loginOrSignUpWithProvider.mockReset()
    joinWithProvider.mockReset()
    loginOrSignUpWithProvider.mockResolvedValue({ token: 'huly-token' })

    process.env.FEISHU_CLIENT_ID = 'cli_feishu_app'
    process.env.FEISHU_CLIENT_SECRET = CLIENT_SECRET
    process.env.FEISHU_ALLOWED_TENANT_KEYS = 'tenantalpha, tenantbeta'
    process.env.FEISHU_DISPLAY_NAME = 'Feishu'
    process.env.FEISHU_REDIRECT_URL = 'https://accounts.example.com/auth/feishu/callback'
    process.env.FEISHU_AUTH_BASE_URL = mock.url
    process.env.FEISHU_API_BASE_URL = mock.url
    delete process.env.FEISHU_SCOPE
    delete process.env.FEISHU_AUTO_PROVISION
    delete process.env.FEISHU_SYNC_PROFILE
    delete process.env.FEISHU_TENANT_WORKSPACE_MAP
    delete process.env.FEISHU_STATE_HMAC_SECRET
  })

  afterEach(async () => {
    await mock.close()
  })

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) {
        Reflect.deleteProperty(process.env, k)
      } else {
        process.env[k] = savedEnv[k]
      }
    }
  })

  function register (db?: any): any {
    return registerFeishu(
      makeMeasureCtx(logs),
      {} as any,
      makeRouter(routes),
      'https://accounts.example.com',
      Promise.resolve(db ?? ({} as any)),
      'https://front.example.com',
      {},
      false,
      SECRET
    )
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  it('registers only when fully configured', () => {
    expect(register()).toEqual({ name: 'feishu', displayName: 'Feishu' })
    expect(Object.keys(routes).sort()).toEqual(['/auth/feishu', '/auth/feishu/callback'])

    delete process.env.FEISHU_CLIENT_SECRET
    expect(register()).toBeUndefined()

    process.env.FEISHU_CLIENT_SECRET = CLIENT_SECRET
    process.env.FEISHU_ALLOWED_TENANT_KEYS = '  '
    expect(register()).toBeUndefined()
  })

  // 🔴 THE CONTAINER CASE. `docker-compose`'s `- FOO=${FOO}` sets `FOO` to `""`
  // inside the container when the host has not set it, and so does a `.env` line
  // reading `FOO=`. Node reports `""`, which `=== undefined` and `??` both miss.
  //
  // ⚠️ Only the first three of these fail if `envOrUndefined` is reverted — the
  // boolean/map/secret parsers were already blank-safe on their own (verified by
  // reverting each call site individually). Those cases are kept because they
  // pin behaviour the deployment now depends on, not because they caught a bug.
  describe('blank environment variables count as absent', () => {
    it('refuses to register on a blank client id or secret rather than half-configuring', () => {
      process.env.FEISHU_CLIENT_ID = ''
      expect(register()).toBeUndefined()

      process.env.FEISHU_CLIENT_ID = 'cli_feishu_app'
      process.env.FEISHU_CLIENT_SECRET = '   '
      expect(register()).toBeUndefined()
    })

    it('falls back to the derived redirect url instead of sending an empty redirect_uri', async () => {
      process.env.FEISHU_REDIRECT_URL = ''
      expect(register()).toEqual({ name: 'feishu', displayName: 'Feishu' })

      const jar = makeCookieJar()
      const ctx = makeCtx({}, jar.cookies)
      await routes['/auth/feishu'](ctx, async () => {})

      // Derived from accountsUrl, NOT the empty string.
      expect(new URL(ctx.redirectedTo).searchParams.get('redirect_uri')).toBe(
        'https://accounts.example.com/auth/feishu/callback'
      )
    })

    it('treats a blank boolean as unset rather than refusing to register', () => {
      // Pins the consequence that matters: if a blank value ever DID reach the
      // strict boolean parser it would throw, and a throw here refuses the whole
      // provider — a variable nobody set would silently remove the login button.
      process.env.FEISHU_AUTO_PROVISION = ''
      process.env.FEISHU_SYNC_PROFILE = '  '
      process.env.FEISHU_TENANT_WORKSPACE_MAP = ''
      expect(register()).toEqual({ name: 'feishu', displayName: 'Feishu' })
    })

    it('falls back to the shared secret when the dedicated state key is blank', () => {
      process.env.FEISHU_STATE_HMAC_SECRET = '   '
      expect(register()).toEqual({ name: 'feishu', displayName: 'Feishu' })
    })

    it('uses the component default display name when the variable is blank', () => {
      process.env.FEISHU_DISPLAY_NAME = ''
      // `undefined`, not `''` — the login button falls back to its own default
      // only when the field is absent; `''` would render "Continue with ".
      expect(register()).toEqual({ name: 'feishu', displayName: undefined })
    })
  })

  it('does not register without a server secret to sign state', () => {
    const value = registerFeishu(
      makeMeasureCtx(logs),
      {} as any,
      makeRouter(routes),
      'https://accounts.example.com',
      Promise.resolve({} as any),
      'https://front.example.com',
      {},
      false,
      undefined
    )
    expect(value).toBeUndefined()
  })

  it('parses the allowed tenant list', () => {
    expect(parseAllowedTenantKeys('a, b ,,c')).toEqual(['a', 'b', 'c'])
    expect(parseAllowedTenantKeys(undefined)).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Authorization URL
  // -------------------------------------------------------------------------

  it('builds an authorization url with a signed state and minimal scope', async () => {
    register()
    const jar = makeCookieJar()
    const ctx = makeCtx({}, jar.cookies)
    await routes['/auth/feishu'](ctx, async () => {})

    // The flow is bound to this browser via an httpOnly cookie.
    expect(jar.jar.get('feishu-auth-state')).toBeTruthy()

    const url = new URL(ctx.redirectedTo)
    expect(url.origin).toBe(mock.url)
    expect(url.pathname).toBe('/open-apis/authen/v1/authorize')
    expect(url.searchParams.get('client_id')).toBe('cli_feishu_app')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('https://accounts.example.com/auth/feishu/callback')
    // Minimal scope: nothing requested unless explicitly configured.
    expect(url.searchParams.get('scope')).toBeNull()
    expect(url.searchParams.get('state')).toBeTruthy()
    // The state never leaks the client secret.
    expect(ctx.redirectedTo).not.toContain(CLIENT_SECRET)
  })

  it('includes the scope when configured', () => {
    const config = {
      clientId: 'id',
      clientSecret: 's',
      redirectUrl: 'https://r/cb',
      allowedTenantKeys: ['t'],
      scope: 'contact:user.id:readonly',
      endpoints: { authBaseUrl: 'https://open.feishu.cn', apiBaseUrl: 'https://open.feishu.cn' }
    }
    const url = new URL(buildAuthorizeUrl(config, 'st'))
    expect(url.searchParams.get('scope')).toBe('contact:user.id:readonly')
  })

  // -------------------------------------------------------------------------
  // Signed state
  // -------------------------------------------------------------------------

  describe('signed state', () => {
    it('round-trips the auth state', () => {
      const nonces = new ConsumedNonceStore()
      const { state, nonce } = encodeSignedState(SECRET, { inviteId: 'inv-1', branding: 'b', autoJoin: true })
      expect(verifySignedState(SECRET, state, nonces, nonce)).toEqual({
        inviteId: 'inv-1',
        branding: 'b',
        autoJoin: true
      })
    })

    it('rejects a state that is not bound to this browser', () => {
      const nonces = new ConsumedNonceStore()
      const { state } = encodeSignedState(SECRET, {})
      const other = encodeSignedState(SECRET, {})

      expect(() => verifySignedState(SECRET, state, nonces, undefined)).toThrow(/not bound/)
      expect(() => verifySignedState(SECRET, state, nonces, '')).toThrow(/not bound/)
      expect(() => verifySignedState(SECRET, state, nonces, other.nonce)).toThrow(/not bound/)
      // The rejected attempts must not have burned the nonce.
      expect(
        verifySignedState(
          SECRET,
          state,
          nonces,
          JSON.parse(
            Buffer.from(
              state.slice(0, state.lastIndexOf('.')).replace(/-/g, '+').replace(/_/g, '/'),
              'base64'
            ).toString('utf8')
          ).nonce
        )
      ).toEqual({})
    })

    it('rejects a tampered payload', () => {
      const nonces = new ConsumedNonceStore()
      const { state: raw, nonce } = encodeSignedState(SECRET, { inviteId: 'inv-1' })
      const [body, sig] = [raw.slice(0, raw.lastIndexOf('.')), raw.slice(raw.lastIndexOf('.') + 1)]
      const tamperedPayload = Buffer.from(JSON.stringify({ inviteId: 'evil', nonce: 'n', iat: Date.now() }), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')

      expect(() => verifySignedState(SECRET, `${tamperedPayload}.${sig}`, nonces, 'n')).toThrow(/signature mismatch/)
      expect(() => verifySignedState(SECRET, `${body}.${sig}x`, nonces, nonce)).toThrow(/signature mismatch/)
      expect(() => verifySignedState('other-secret', raw, nonces, nonce)).toThrow(/signature mismatch/)
    })

    it('rejects a missing or malformed state', () => {
      const nonces = new ConsumedNonceStore()
      expect(() => verifySignedState(SECRET, undefined, nonces, 'n')).toThrow(/Missing state/)
      expect(() => verifySignedState(SECRET, '', nonces, 'n')).toThrow(/Missing state/)
      expect(() => verifySignedState(SECRET, 'nodot', nonces, 'n')).toThrow(/Malformed state/)
      expect(() => verifySignedState(SECRET, '.sig', nonces, 'n')).toThrow(/Malformed state/)
    })

    it('rejects an expired state', () => {
      const nonces = new ConsumedNonceStore()
      const now = Date.now()
      const { state, nonce } = encodeSignedState(SECRET, {}, now - STATE_TTL_MS - 1000)
      expect(() => verifySignedState(SECRET, state, nonces, nonce, now)).toThrow(/expired/)
    })

    it('rejects a replayed state', () => {
      const nonces = new ConsumedNonceStore()
      const { state, nonce } = encodeSignedState(SECRET, {})
      expect(verifySignedState(SECRET, state, nonces, nonce)).toEqual({})
      expect(() => verifySignedState(SECRET, state, nonces, nonce)).toThrow(/replayed/)
    })
  })

  // -------------------------------------------------------------------------
  // Social id value
  // -------------------------------------------------------------------------

  it('encodes the social id value without a colon', () => {
    const value = buildFeishuSocialValue('tenantalpha', 'ou_123')
    expect(value).toBe('tenantalpha.ou_123')
    expect(value).not.toContain(':')
    expect(`feishu:${value}`.split(':')).toHaveLength(2)
    expect(() => buildFeishuSocialValue('a:b', 'ou_1')).toThrow()
  })

  // -------------------------------------------------------------------------
  // Token exchange / user info against the mock server
  // -------------------------------------------------------------------------

  it('exchanges the code for a token and reads the profile', async () => {
    const config = {
      clientId: 'cli_feishu_app',
      clientSecret: CLIENT_SECRET,
      redirectUrl: 'https://accounts.example.com/auth/feishu/callback',
      allowedTenantKeys: ['tenantalpha'],
      scope: '',
      endpoints: { authBaseUrl: mock.url, apiBaseUrl: mock.url }
    }
    const token = await exchangeCodeForToken(config, CODE, (globalThis as any).fetch)
    expect(token).toBe(ACCESS_TOKEN)

    const profile = await fetchUserProfile(config, token, (globalThis as any).fetch)
    expect(profile).toEqual({
      openId: 'ou_abcdef0123456789',
      unionId: 'on_abcdef0123456789',
      tenantKey: 'tenantalpha',
      name: 'Mei Ling',
      firstName: 'Mei',
      lastName: 'Ling'
    })
  })

  it('rejects a reused (one-time) code', async () => {
    const config = {
      clientId: 'cli_feishu_app',
      clientSecret: CLIENT_SECRET,
      redirectUrl: 'https://accounts.example.com/auth/feishu/callback',
      allowedTenantKeys: ['tenantalpha'],
      scope: '',
      endpoints: { authBaseUrl: mock.url, apiBaseUrl: mock.url }
    }
    await exchangeCodeForToken(config, CODE, (globalThis as any).fetch)
    await expect(exchangeCodeForToken(config, CODE, (globalThis as any).fetch)).rejects.toThrow(/HTTP 400/)
  })

  // -------------------------------------------------------------------------
  // Callback flow
  // -------------------------------------------------------------------------

  let browser = makeCookieJar()

  async function runCallback (query: any): Promise<any> {
    const ctx = makeCtx(query, browser.cookies)
    await routes['/auth/feishu/callback'](ctx, async () => {})
    return ctx
  }

  /** Starts a flow in a fresh browser and returns the state handed to the redirect. */
  async function issuedState (): Promise<string> {
    browser = makeCookieJar()
    const ctx = makeCtx({}, browser.cookies)
    await routes['/auth/feishu'](ctx, async () => {})
    return new URL(ctx.redirectedTo).searchParams.get('state') as string
  }

  it('completes the login and passes an empty email', async () => {
    register()
    const ctx = await runCallback({ code: CODE, state: await issuedState() })

    expect(loginOrSignUpWithProvider).toHaveBeenCalledTimes(1)
    const args = loginOrSignUpWithProvider.mock.calls[0]
    // (ctx, db, null, email, first, last, socialKey, ...)
    expect(args[3]).toBe('')
    expect(args[4]).toBe('Mei')
    expect(args[5]).toBe('Ling')
    expect(args[6]).toEqual({ type: 'feishu', value: 'tenantalpha.ou_abcdef0123456789' })
    expect(ctx.redirectedTo).toContain('https://front.example.com/login/auth')
  })

  it('rejects a tampered state at the callback without touching the account db', async () => {
    register()
    const state = await issuedState()
    const ctx = await runCallback({ code: CODE, state: `${state}tamper` })

    expect(loginOrSignUpWithProvider).not.toHaveBeenCalled()
    expect(joinWithProvider).not.toHaveBeenCalled()
    expect(mock.requests).toHaveLength(0)
    expect(ctx.redirectedTo).toBe('https://front.example.com/login')
  })

  it('rejects a missing state at the callback', async () => {
    register()
    const ctx = await runCallback({ code: CODE })
    expect(loginOrSignUpWithProvider).not.toHaveBeenCalled()
    expect(ctx.redirectedTo).toBe('https://front.example.com/login')
  })

  it('rejects a replayed callback', async () => {
    register()
    const state = await issuedState()
    const nonce = browser.jar.get('feishu-auth-state')
    await runCallback({ code: CODE, state })
    expect(loginOrSignUpWithProvider).toHaveBeenCalledTimes(1)

    // Even if the browser still presented the binding cookie, the nonce is spent.
    browser.cookies.set('feishu-auth-state', nonce)
    const ctx = await runCallback({ code: CODE, state })
    expect(loginOrSignUpWithProvider).toHaveBeenCalledTimes(1)
    expect(ctx.redirectedTo).toBe('https://front.example.com/login')
  })

  it('rejects a callback replayed into a different browser (login CSRF)', async () => {
    register()
    // The attacker completes their own authorization and captures the callback URL.
    const state = await issuedState()
    // The victim's browser has no binding cookie for that flow.
    browser = makeCookieJar()
    const ctx = await runCallback({ code: CODE, state })

    expect(loginOrSignUpWithProvider).not.toHaveBeenCalled()
    expect(mock.requests).toHaveLength(0)
    expect(ctx.redirectedTo).toBe('https://front.example.com/login')
  })

  it('rejects a disallowed tenant before any account db call', async () => {
    register()
    mock.userInfoBody = {
      code: 0,
      data: { name: 'Outsider', open_id: 'ou_outsider', tenant_key: 'tenantevil' }
    }
    const ctx = await runCallback({ code: CODE, state: await issuedState() })

    expect(loginOrSignUpWithProvider).not.toHaveBeenCalled()
    expect(joinWithProvider).not.toHaveBeenCalled()
    expect(ctx.redirectedTo).toBe('https://front.example.com/login')
    expect(logs.some((l) => l.params?.reason === 'tenant not allowed')).toBe(true)
  })

  it('rejects an upstream 5xx from the token endpoint', async () => {
    register()
    mock.tokenStatus = 503
    mock.tokenBody = { msg: 'service unavailable' }
    const ctx = await runCallback({ code: CODE, state: await issuedState() })

    expect(loginOrSignUpWithProvider).not.toHaveBeenCalled()
    expect(ctx.redirectedTo).toBe('https://front.example.com/login')
  })

  it('rejects an upstream 5xx from the user info endpoint', async () => {
    register()
    mock.userInfoStatus = 502
    mock.userInfoBody = { msg: 'bad gateway' }
    const ctx = await runCallback({ code: CODE, state: await issuedState() })

    expect(loginOrSignUpWithProvider).not.toHaveBeenCalled()
    expect(ctx.redirectedTo).toBe('https://front.example.com/login')
  })

  it('rejects a missing code', async () => {
    register()
    const ctx = await runCallback({ state: await issuedState() })
    expect(loginOrSignUpWithProvider).not.toHaveBeenCalled()
    expect(ctx.redirectedTo).toBe('https://front.example.com/login')
  })

  // -------------------------------------------------------------------------
  // Secret hygiene
  // -------------------------------------------------------------------------

  it('never logs the code, the access token or the client secret', async () => {
    register()

    await runCallback({ code: CODE, state: await issuedState() })
    mock.tokenStatus = 500
    mock.tokenBody = { msg: 'boom' }
    await runCallback({ code: CODE, state: await issuedState() })
    mock.tokenStatus = 200
    mock.tokenBody = { code: 0, access_token: ACCESS_TOKEN }
    mock.userInfoBody = { code: 0, data: { name: 'X', open_id: 'ou_x', tenant_key: 'tenantevil' } }
    await runCallback({ code: CODE, state: await issuedState() })
    await runCallback({ code: CODE, state: 'garbage.state' })

    const dump = JSON.stringify(logs)
    expect(dump.length).toBeGreaterThan(0)
    expect(dump).not.toContain(CODE)
    expect(dump).not.toContain(ACCESS_TOKEN)
    expect(dump).not.toContain(CLIENT_SECRET)
    expect(dump).not.toContain('cli_feishu_app')
  })

  // -------------------------------------------------------------------------
  // AUTH-004 — configuration parsing
  // -------------------------------------------------------------------------

  describe('tenant -> workspace map parsing', () => {
    it('returns undefined when unset (feature off, behaviour unchanged)', () => {
      expect(parseTenantWorkspaceMap(undefined)).toBeUndefined()
      expect(parseTenantWorkspaceMap('   ')).toBeUndefined()
    })

    it('parses entries with and without an explicit role', () => {
      const map = parseTenantWorkspaceMap(
        'tenantalpha:agentra-main:USER, tenantbeta:agentra-partner ,tenantgamma:ws3:maintainer'
      )
      expect(map.size).toBe(3)
      expect(map.get('tenantalpha')).toEqual({ workspaceUrl: 'agentra-main', role: 'USER' })
      expect(map.get('tenantbeta')).toEqual({ workspaceUrl: 'agentra-partner', role: DEFAULT_MAPPED_ROLE })
      expect(map.get('tenantgamma')).toEqual({ workspaceUrl: 'ws3', role: 'MAINTAINER' })
    })

    it('throws — never degrades to a partial map — on malformed input', () => {
      expect(() => parseTenantWorkspaceMap('tenantalpha')).toThrow(/malformed entry/)
      expect(() => parseTenantWorkspaceMap('tenantalpha:ws:USER:extra')).toThrow(/malformed entry/)
      expect(() => parseTenantWorkspaceMap(':ws:USER')).toThrow(/empty tenant key/)
      expect(() => parseTenantWorkspaceMap('tenantalpha::USER')).toThrow(/empty tenant key or workspace url/)
      expect(() => parseTenantWorkspaceMap('tenantalpha:ws:WIZARD')).toThrow(/unknown role/)
      expect(() => parseTenantWorkspaceMap('t:ws1,t:ws2')).toThrow(/duplicate tenant key/)
      expect(() => parseTenantWorkspaceMap(',,')).toThrow(/no usable entries/)
    })

    it('refuses to grant ADMIN from deployment configuration', () => {
      expect(() => parseAssignableRole('ADMIN')).toThrow(/ADMIN cannot be granted/)
      expect(() => parseTenantWorkspaceMap('t:ws:admin')).toThrow(/ADMIN cannot be granted/)
      expect(parseAssignableRole('owner')).toBe('OWNER')
      expect(parseAssignableRole('docguest')).toBe('DocGuest')
    })

    it('parses booleans strictly', () => {
      expect(parseStrictBoolean(undefined, false)).toBe(false)
      expect(parseStrictBoolean(undefined, true)).toBe(true)
      expect(parseStrictBoolean(' TRUE ', false)).toBe(true)
      expect(parseStrictBoolean('false', true)).toBe(false)
      expect(() => parseStrictBoolean('yes', false)).toThrow(/expected 'true' or 'false'/)
      expect(() => parseStrictBoolean('1', false)).toThrow(/expected 'true' or 'false'/)
    })

    it('does not register the provider when the map is malformed', () => {
      process.env.FEISHU_TENANT_WORKSPACE_MAP = 'tenantalpha'
      expect(register()).toBeUndefined()
      expect(logs.some((l) => l.message.includes('invalid configuration'))).toBe(true)

      process.env.FEISHU_TENANT_WORKSPACE_MAP = 'tenantalpha:agentra-main'
      process.env.FEISHU_AUTO_PROVISION = 'ture'
      expect(register()).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // AUTH-004 — the state secret
  // -------------------------------------------------------------------------

  describe('state hmac secret', () => {
    it('uses the dedicated secret when present and still verifies state', async () => {
      process.env.FEISHU_STATE_HMAC_SECRET = 'feishu-only-secret'
      register()
      const ctx = await runCallback({ code: CODE, state: await issuedState() })
      expect(ctx.redirectedTo).toContain('/login/auth')
      expect(loginOrSignUpWithProvider).toHaveBeenCalledTimes(1)
    })

    it('rejects a state signed with the shared secret once a dedicated one is set', async () => {
      process.env.FEISHU_STATE_HMAC_SECRET = 'feishu-only-secret'
      register()
      // A state minted with the old (shared) secret must no longer verify.
      const stale = encodeSignedState(SECRET, {})
      browser = makeCookieJar()
      browser.cookies.set('feishu-auth-state', stale.nonce)
      const ctx = await runCallback({ code: CODE, state: stale.state })
      expect(loginOrSignUpWithProvider).not.toHaveBeenCalled()
      expect(ctx.redirectedTo).toBe('https://front.example.com/login')
    })

    it('falls back to the shared server secret when no dedicated one is configured', async () => {
      delete process.env.FEISHU_STATE_HMAC_SECRET
      register()
      const ctx = await runCallback({ code: CODE, state: await issuedState() })
      expect(ctx.redirectedTo).toContain('/login/auth')
    })

    it('blank dedicated secret falls back rather than disabling the provider', () => {
      process.env.FEISHU_STATE_HMAC_SECRET = '   '
      expect(register()).toEqual({ name: 'feishu', displayName: 'Feishu' })
    })
  })

  // -------------------------------------------------------------------------
  // AUTH-004 — workspace assignment through the callback
  // -------------------------------------------------------------------------

  describe('workspace assignment', () => {
    beforeEach(() => {
      process.env.FEISHU_TENANT_WORKSPACE_MAP = 'tenantalpha:agentra-main:MAINTAINER'
    })

    it('assigns the mapped workspace on first login and audits it', async () => {
      const fake = makeFakeDb()
      process.env.FEISHU_AUTO_PROVISION = 'true'
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })

      expect(fake.assignCalls).toEqual([['person-1', 'ws-uuid-alpha', 'MAINTAINER']])
      expect(ctx.redirectedTo).toContain('https://front.example.com/login/auth')
      expect(fake.events.map((e: any) => e.eventType)).toEqual([FeishuAccountEventType.WorkspaceAssigned])
    })

    it('never overwrites the role of an existing member', async () => {
      const fake = makeFakeDb()
      fake.roles.set('person-1/ws-uuid-alpha', 'GUEST')
      process.env.FEISHU_AUTO_PROVISION = 'true'
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })

      expect(fake.assignCalls).toEqual([])
      expect(fake.roles.get('person-1/ws-uuid-alpha')).toBe('GUEST')
      expect(ctx.redirectedTo).toContain('/login/auth')
    })

    it('rejects a tenant that is allow-listed but absent from the map, before any db write', async () => {
      const fake = makeFakeDb()
      process.env.FEISHU_ALLOWED_TENANT_KEYS = 'tenantalpha, tenantbeta'
      process.env.FEISHU_TENANT_WORKSPACE_MAP = 'tenantbeta:agentra-partner'
      process.env.FEISHU_AUTO_PROVISION = 'true'
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })

      expect(loginOrSignUpWithProvider).not.toHaveBeenCalled()
      expect(fake.assignCalls).toEqual([])
      expect(ctx.redirectedTo).toBe('https://front.example.com/login?authError=feishu-no-workspace-mapping')
      expect(logs.some((l) => l.params?.reason === 'tenant has no workspace mapping')).toBe(true)
    })

    it('rejects when the mapped workspace does not exist, before any db write', async () => {
      const fake = makeFakeDb({ workspaces: [] })
      process.env.FEISHU_AUTO_PROVISION = 'true'
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })

      expect(loginOrSignUpWithProvider).not.toHaveBeenCalled()
      expect(ctx.redirectedTo).toBe('https://front.example.com/login?authError=feishu-workspace-missing')
      expect(logs.some((l) => l.params?.workspaceUrl === 'agentra-main')).toBe(true)
    })

    it('with auto provisioning off, a new user gets no token and is queued for approval', async () => {
      const fake = makeFakeDb()
      process.env.FEISHU_AUTO_PROVISION = 'false'
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })

      expect(fake.assignCalls).toEqual([])
      expect(ctx.redirectedTo).toBe('https://front.example.com/login?authError=feishu-approval-required')
      expect(ctx.redirectedTo).not.toContain('huly-token')
      const event = fake.events[0]
      expect(event.eventType).toBe(FeishuAccountEventType.WorkspaceApprovalRequired)
      expect(event.data).toEqual({
        tenantKey: 'tenantalpha',
        workspaceUuid: 'ws-uuid-alpha',
        workspaceUrl: 'agentra-main',
        requestedRole: 'MAINTAINER'
      })
    })

    it('with auto provisioning off, an already approved member still logs in', async () => {
      const fake = makeFakeDb()
      fake.roles.set('person-1/ws-uuid-alpha', 'USER')
      process.env.FEISHU_AUTO_PROVISION = 'false'
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })

      expect(ctx.redirectedTo).toContain('https://front.example.com/login/auth')
      expect(fake.events).toEqual([])
    })

    it('auto provisioning defaults to off', async () => {
      const fake = makeFakeDb()
      delete process.env.FEISHU_AUTO_PROVISION
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })
      expect(fake.assignCalls).toEqual([])
      expect(ctx.redirectedTo).toContain('authError=feishu-approval-required')
    })

    it('does not swallow an assignWorkspace failure', async () => {
      const fake = makeFakeDb()
      fake.assignError = new Error('db unavailable')
      process.env.FEISHU_AUTO_PROVISION = 'true'
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })

      expect(ctx.redirectedTo).toBe('https://front.example.com/login?authError=feishu-assign-failed')
      expect(ctx.redirectedTo).not.toContain('huly-token')
      expect(logs.some((l) => l.level === 'error' && l.params?.reason === 'db unavailable')).toBe(true)
    })

    it('does not swallow a membership lookup failure', async () => {
      const fake = makeFakeDb()
      fake.roleLookupError = new Error('role lookup down')
      process.env.FEISHU_AUTO_PROVISION = 'true'
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })
      expect(ctx.redirectedTo).toContain('authError=feishu-assign-failed')
    })

    it('rejects when the social id cannot be found after a reported success', async () => {
      const fake = makeFakeDb({ socialIds: [] })
      process.env.FEISHU_AUTO_PROVISION = 'true'
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })
      expect(ctx.redirectedTo).toBe('https://front.example.com/login?authError=feishu-account-unavailable')
    })

    it('does not assign anything when the login itself failed', async () => {
      const fake = makeFakeDb()
      process.env.FEISHU_AUTO_PROVISION = 'true'
      loginOrSignUpWithProvider.mockResolvedValue(null)
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })

      expect(fake.assignCalls).toEqual([])
      expect(ctx.redirectedTo).toBe('https://front.example.com/login')
    })

    it('turns a failing workspace lookup into a diagnosable rejection, not a 500', async () => {
      const fake = makeFakeDb()
      fake.workspaceLookupError = new Error('workspace table down')
      process.env.FEISHU_AUTO_PROVISION = 'true'
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })

      expect(loginOrSignUpWithProvider).not.toHaveBeenCalled()
      expect(ctx.redirectedTo).toBe('https://front.example.com/login?authError=feishu-workspace-lookup-failed')
      expect(logs.some((l) => l.params?.cause === 'workspace table down')).toBe(true)
    })

    it('lets an invite through even when the tenant has no mapping', async () => {
      const fake = makeFakeDb()
      process.env.FEISHU_TENANT_WORKSPACE_MAP = 'tenantbeta:agentra-partner'
      process.env.FEISHU_AUTO_PROVISION = 'false'
      joinWithProvider.mockResolvedValue({ token: 'huly-token' })
      register(fake.db)

      browser = makeCookieJar()
      const authCtx = makeCtx({ inviteId: 'inv-42' }, browser.cookies)
      await routes['/auth/feishu'](authCtx, async () => {})
      const state = new URL(authCtx.redirectedTo).searchParams.get('state')
      const ctx = await runCallback({ code: CODE, state })

      expect(joinWithProvider).toHaveBeenCalledTimes(1)
      expect(loginOrSignUpWithProvider).not.toHaveBeenCalled()
      expect(fake.assignCalls).toEqual([])
      expect(ctx.redirectedTo).toContain('https://front.example.com/login/auth')
    })

    it('rejects a success-shaped redirect that carries no token', async () => {
      const fake = makeFakeDb()
      process.env.FEISHU_AUTO_PROVISION = 'true'
      loginOrSignUpWithProvider.mockResolvedValue({})
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })

      expect(fake.assignCalls).toEqual([])
      expect(ctx.redirectedTo).toContain('https://front.example.com/login/auth')
      expect(ctx.redirectedTo).not.toContain('token=')
    })

    it('touches no workspace api at all when the map is not configured', async () => {
      delete process.env.FEISHU_TENANT_WORKSPACE_MAP
      const fake = makeFakeDb()
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })
      expect(fake.assignCalls).toEqual([])
      expect(ctx.redirectedTo).toContain('/login/auth')
    })
  })

  // -------------------------------------------------------------------------
  // AUTH-006 — profile sync
  // -------------------------------------------------------------------------

  describe('profile sync', () => {
    it('reads the avatar url out of the user info response', async () => {
      register()
      mock.userInfoBody = {
        code: 0,
        data: {
          name: 'Mei Ling',
          en_name: 'Mei L',
          avatar_url: 'https://example.com/a.png',
          open_id: 'ou_abcdef0123456789',
          tenant_key: 'tenantalpha'
        }
      }
      const config = {
        clientId: 'cli_feishu_app',
        clientSecret: CLIENT_SECRET,
        redirectUrl: 'https://accounts.example.com/auth/feishu/callback',
        allowedTenantKeys: ['tenantalpha'],
        scope: '',
        endpoints: { authBaseUrl: mock.url, apiBaseUrl: mock.url }
      }
      const token = await exchangeCodeForToken(config, CODE, (globalThis as any).fetch)
      const profile = await fetchUserProfile(config, token, (globalThis as any).fetch)
      expect(profile.avatarUrl).toBe('https://example.com/a.png')
      expect(profile.enName).toBe('Mei L')
    })

    it('updates the name and writes an audit event when enabled', async () => {
      const fake = makeFakeDb()
      process.env.FEISHU_SYNC_PROFILE = 'true'
      register(fake.db)
      await runCallback({ code: CODE, state: await issuedState() })

      expect(fake.persons[0]).toEqual({ uuid: 'person-1', firstName: 'Mei', lastName: 'Ling' })
      const event = fake.events.find((e: any) => e.eventType === FeishuAccountEventType.ProfileSynced)
      expect(event.data.nameChanged).toBe(true)
      expect(event.data.tenantKey).toBe('tenantalpha')
    })

    it('does nothing when disabled', async () => {
      const fake = makeFakeDb()
      delete process.env.FEISHU_SYNC_PROFILE
      register(fake.db)
      await runCallback({ code: CODE, state: await issuedState() })
      expect(fake.persons[0]).toEqual({ uuid: 'person-1', firstName: 'Old', lastName: 'Name' })
      expect(fake.events).toEqual([])
    })

    it('never blocks the login when the sync fails', async () => {
      const fake = makeFakeDb()
      fake.personUpdateError = new Error('person table locked')
      process.env.FEISHU_SYNC_PROFILE = 'true'
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })

      expect(ctx.redirectedTo).toContain('https://front.example.com/login/auth')
      expect(ctx.redirectedTo).toContain('huly-token')
      expect(logs.some((l) => l.level === 'error' && l.params?.reason === 'person table locked')).toBe(true)
    })

    it('never blocks the login when the audit write fails', async () => {
      const fake = makeFakeDb()
      fake.eventInsertError = new Error('audit table down')
      process.env.FEISHU_SYNC_PROFILE = 'true'
      process.env.FEISHU_TENANT_WORKSPACE_MAP = 'tenantalpha:agentra-main'
      process.env.FEISHU_AUTO_PROVISION = 'true'
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })

      expect(fake.assignCalls).toHaveLength(1)
      expect(ctx.redirectedTo).toContain('https://front.example.com/login/auth')
    })

    it('does not blank an existing name when feishu returns none', async () => {
      const fake = makeFakeDb()
      process.env.FEISHU_SYNC_PROFILE = 'true'
      mock.userInfoBody = { code: 0, data: { open_id: 'ou_abcdef0123456789', tenant_key: 'tenantalpha' } }
      register(fake.db)
      const ctx = await runCallback({ code: CODE, state: await issuedState() })

      expect(fake.persons[0]).toEqual({ uuid: 'person-1', firstName: 'Old', lastName: 'Name' })
      const event = fake.events.find((e: any) => e.eventType === FeishuAccountEventType.ProfileSynced)
      expect(event.data.nameChanged).toBe(false)
      expect(event.data.nameSkipped).toBe(true)
      expect(ctx.redirectedTo).toContain('/login/auth')
    })

    it('never throws out of syncFeishuProfile, whatever the db does', async () => {
      const ctxLogs: LogEntry[] = []
      const broken = {
        person: {
          findOne: async () => {
            throw new Error('boom')
          }
        }
      } as any
      await expect(
        syncFeishuProfile(makeMeasureCtx(ctxLogs), broken, 'acc-1', {
          firstName: 'A',
          lastName: 'B',
          tenantKey: 't'
        })
      ).resolves.toEqual({ updated: false, reason: 'boom' })
    })
  })

  // -------------------------------------------------------------------------
  // Diagnosability
  // -------------------------------------------------------------------------

  it('adds a machine readable reason to a rejection redirect', () => {
    expect(withAuthError('https://front.example.com/login', 'feishu-approval-required')).toBe(
      'https://front.example.com/login?authError=feishu-approval-required'
    )
    expect(withAuthError('not a url', 'x')).toBe('not a url')
  })

  it('never logs the code, the token or the secret on the new rejection paths', async () => {
    process.env.FEISHU_TENANT_WORKSPACE_MAP = 'tenantalpha:agentra-main'
    process.env.FEISHU_STATE_HMAC_SECRET = 'feishu-only-secret'

    const pending = makeFakeDb()
    register(pending.db)
    await runCallback({ code: CODE, state: await issuedState() })

    const missing = makeFakeDb({ workspaces: [] })
    register(missing.db)
    await runCallback({ code: CODE, state: await issuedState() })

    const failing = makeFakeDb()
    failing.assignError = new Error('nope')
    process.env.FEISHU_AUTO_PROVISION = 'true'
    register(failing.db)
    await runCallback({ code: CODE, state: await issuedState() })

    const dump = JSON.stringify(logs)
    expect(dump.length).toBeGreaterThan(0)
    expect(dump).not.toContain(CODE)
    expect(dump).not.toContain(ACCESS_TOKEN)
    expect(dump).not.toContain(CLIENT_SECRET)
    expect(dump).not.toContain('feishu-only-secret')
    expect(dump).not.toContain('huly-token')
  })
})
