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

import core, {
  AccountRole,
  toFindResult,
  TxFactory,
  type Account,
  type Class,
  type Doc,
  type MeasureContext,
  type Ref,
  type Space,
  type Tx,
  type TxCreateDoc
} from '@hcengineering/core'
import crmLite, {
  buildIntakeLeadAttributes,
  INTAKE_ALLOWED_FIELDS,
  INTAKE_EMAIL_MAX_LENGTH,
  INTAKE_MESSAGE_MAX_LENGTH,
  INTAKE_NAME_MAX_LENGTH,
  INTAKE_TITLE_MAX_LENGTH,
  intakeFieldMaxLength,
  pickIntakeFields,
  sanitizeIntakeText,
  type Lead
} from '@hcengineering/crm-lite'
import { ApplyTxMiddleware } from '@hcengineering/middleware'
import type { Middleware, PipelineContext } from '@hcengineering/server-core'

import {
  checkIntakeSpace,
  INTAKE_SOURCE,
  intakeRateKey,
  IntakeRateLimiter,
  isIntakeAccount,
  INTAKE_REFUSAL_MESSAGE,
  normalizeIntakeAttributes,
  pinIntakeEnvelope,
  pinIntakeVersionChain
} from '../intake'
import { LeadGuardError, LeadGuardMiddleware } from '../leadGuard'

const LEAD_CLASS = crmLite.masterTag.Lead as Ref<Class<Doc>>
const SPACE = crmLite.space.Crm as unknown as Ref<Space>
const OTHER_SPACE = 'card:space:Default' as Ref<Space>
const LEAD_ID = '000000000000000000000042' as Ref<Lead>

/**
 * 🔴 Pinned literals, not `expect(x).toBe(crmLite.x)`. Comparing a constant to
 * itself passes whatever it is; these ids are written into documents and into
 * the intake form's URL, so a rename has to be a deliberate, visible edit.
 */
describe('intake identifiers', () => {
  it('pins the space and source the guard forces', () => {
    expect(SPACE).toBe('crm-lite:space:Crm')
    expect(INTAKE_SOURCE).toBe('crm-lite:ids:SourceInbound')
  })

  it('pins the whitelist itself', () => {
    // If this list ever grows, the new field needs its own reasoning about what
    // an unauthenticated stranger can do with it — hence a failing test.
    expect([...INTAKE_ALLOWED_FIELDS]).toEqual(['title', 'intakeName', 'intakeEmail', 'intakeMessage'])
  })

  it('gives every whitelisted field a cap, and falls back to the SHORTEST one', () => {
    // 🔴 A whitelisted field with no cap would be unbounded free text from a
    // stranger. The fallback must therefore be the strictest value, not "no
    // limit" — asserted directly so a future addition fails closed.
    for (const field of INTAKE_ALLOWED_FIELDS) {
      expect(intakeFieldMaxLength(field)).toBeGreaterThan(0)
    }
    expect(intakeFieldMaxLength('title')).toBe(INTAKE_TITLE_MAX_LENGTH)
    expect(intakeFieldMaxLength('intakeName')).toBe(INTAKE_NAME_MAX_LENGTH)
    expect(intakeFieldMaxLength('intakeEmail')).toBe(INTAKE_EMAIL_MAX_LENGTH)
    expect(intakeFieldMaxLength('intakeMessage')).toBe(INTAKE_MESSAGE_MAX_LENGTH)
    expect(intakeFieldMaxLength('somethingAddedLater')).toBe(INTAKE_TITLE_MAX_LENGTH)
    expect(intakeFieldMaxLength('__proto__')).toBe(INTAKE_TITLE_MAX_LENGTH)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Malicious text: formulas, control characters, bidi, length
// ─────────────────────────────────────────────────────────────────────────────

const ZWSP = String.fromCharCode(0x200b)
const RLO = String.fromCharCode(0x202e)
const PDF = String.fromCharCode(0x202c)
const LRI = String.fromCharCode(0x2066)
const PDI = String.fromCharCode(0x2069)
const BOM = String.fromCharCode(0xfeff)

describe('sanitizeIntakeText', () => {
  it('neutralizes every spreadsheet formula trigger', () => {
    // The next hop is a CRM operator's spreadsheet, not the database.
    expect(sanitizeIntakeText('=1+1')).toBe("'=1+1")
    expect(sanitizeIntakeText('=HYPERLINK("http://evil","click")')).toBe('\'=HYPERLINK("http://evil","click")')
    expect(sanitizeIntakeText('+1-800-EVIL')).toBe("'+1-800-EVIL")
    expect(sanitizeIntakeText('-2+3')).toBe("'-2+3")
    expect(sanitizeIntakeText('@SUM(A1)')).toBe("'@SUM(A1)")
  })

  it('does not double-prefix and leaves ordinary text alone', () => {
    expect(sanitizeIntakeText("'=already")).toBe("'=already")
    expect(sanitizeIntakeText('Acme Corp')).toBe('Acme Corp')
  })

  it('strips the control characters that would otherwise start a formula', () => {
    // Tab and CR are formula triggers in the classic list; they never reach the
    // formula check because they are removed first.
    expect(sanitizeIntakeText('\t=1+1')).toBe("'=1+1")
    expect(sanitizeIntakeText('\r\n=1+1')).toBe("'=1+1")
    expect(sanitizeIntakeText('a\tb')).toBe('a b')
    expect(sanitizeIntakeText('a b')).toBe('a b')
  })

  it('strips zero-width and bidi characters', () => {
    // A right-to-left override makes the stored string and the rendered string
    // disagree, which is the whole trick.
    expect(sanitizeIntakeText(`Ac${ZWSP}me`)).toBe('Ac me')
    expect(sanitizeIntakeText(`${RLO}evil${PDF}`)).toBe('evil')
    expect(sanitizeIntakeText(`${BOM}Acme`)).toBe('Acme')
    expect(sanitizeIntakeText(`${LRI}=1+1${PDI}`)).toBe("'=1+1")
  })

  it('collapses whitespace, trims and caps the length', () => {
    expect(sanitizeIntakeText('  Acme   Corp  ')).toBe('Acme Corp')
    const long = 'x'.repeat(INTAKE_TITLE_MAX_LENGTH + 50)
    expect(sanitizeIntakeText(long)).toHaveLength(INTAKE_TITLE_MAX_LENGTH)
  })

  it('returns undefined for everything that is not usable text', () => {
    expect(sanitizeIntakeText(undefined)).toBeUndefined()
    expect(sanitizeIntakeText(null)).toBeUndefined()
    expect(sanitizeIntakeText(42)).toBeUndefined()
    expect(sanitizeIntakeText({ toString: () => 'Acme' })).toBeUndefined()
    expect(sanitizeIntakeText(['Acme'])).toBeUndefined()
    expect(sanitizeIntakeText('')).toBeUndefined()
    expect(sanitizeIntakeText(`   ${ZWSP}  `)).toBeUndefined()
  })

  it('does not evaluate markup - it is stored as the literal text it is', () => {
    // The rich-text answer for V1: there is no markup path at all, so a markup
    // payload is just a long string.
    expect(sanitizeIntakeText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>')
    expect(sanitizeIntakeText('{"type":"doc","content":[]}')).toBe('{"type":"doc","content":[]}')
  })

  it('applies the SAME defences to a long message, not a relaxed set', () => {
    // 🔴 The message box is the field a stranger is INVITED to fill, so the
    // formula guard and the bidi/control strip matter more there than in the
    // title — the cap is the only thing that differs.
    const max = INTAKE_MESSAGE_MAX_LENGTH
    expect(sanitizeIntakeText("=cmd|'/c calc'!A1", max)).toBe("'=cmd|'/c calc'!A1")
    expect(sanitizeIntakeText(`${RLO}moc.live${PDF} please visit`, max)).toBe('moc.live please visit')
    expect(sanitizeIntakeText(`hello${ZWSP}there`, max)).toBe('hello there')
  })

  it('collapses a multi-line message into one line', () => {
    // ⚠️ A deliberate, documented loss: a bare newline inside a CSV cell is a
    // row boundary, and admitting `\n` would mean punching a hole in the same
    // control-character strip that removes the bidi overrides.
    expect(sanitizeIntakeText('line one\nline two\r\nline three', INTAKE_MESSAGE_MAX_LENGTH)).toBe(
      'line one line two line three'
    )
  })

  it('truncates each field at ITS OWN cap rather than at a shared one', () => {
    // 🔴 The bug this pins: taking `sanitizeIntakeText`'s default cap for every
    // field would amputate a message at the TITLE length, silently.
    const long = 'x'.repeat(INTAKE_MESSAGE_MAX_LENGTH + 500)
    expect(sanitizeIntakeText(long, INTAKE_MESSAGE_MAX_LENGTH)).toHaveLength(INTAKE_MESSAGE_MAX_LENGTH)
    expect(sanitizeIntakeText(long, INTAKE_NAME_MAX_LENGTH)).toHaveLength(INTAKE_NAME_MAX_LENGTH)
    expect(sanitizeIntakeText(long, INTAKE_EMAIL_MAX_LENGTH)).toHaveLength(INTAKE_EMAIL_MAX_LENGTH)
    // The default is the SHORTEST cap, so a forgetful caller fails closed.
    expect(sanitizeIntakeText(long)).toHaveLength(INTAKE_TITLE_MAX_LENGTH)
  })

  it('stores an email verbatim instead of validating it', () => {
    // 🔴 No format check anywhere: a validator refuses legitimate addresses and
    // answers differently per probe, and it could not make the value trusted in
    // any case — nobody confirmed the visitor owns it.
    const max = INTAKE_EMAIL_MAX_LENGTH
    expect(sanitizeIntakeText('jane@acme.com', max)).toBe('jane@acme.com')
    expect(sanitizeIntakeText('jane+crm@sub.acme.co.uk', max)).toBe('jane+crm@sub.acme.co.uk')
    expect(sanitizeIntakeText('BÜRO@münchen.de', max)).toBe('BÜRO@münchen.de')
    // Nonsense is accepted too — it is a claim, not a credential.
    expect(sanitizeIntakeText('not an address at all', max)).toBe('not an address at all')
    // ⚠️ …but a leading formula trigger is still defused, at the cost of one
    // visible apostrophe on an address that could not have been valid anyway.
    expect(sanitizeIntakeText('@SUM(A1)@acme.com', max)).toBe("'@SUM(A1)@acme.com")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Field whitelist: unlisted fields are DROPPED, never refused
// ─────────────────────────────────────────────────────────────────────────────

describe('pickIntakeFields', () => {
  it('drops unlisted fields silently rather than reporting them', () => {
    const picked = pickIntakeFields({
      title: 'Acme',
      owner: 'contact:person:Boss',
      status: 'Converted',
      whateverFieldNameIGuessed: 1
    })
    expect(picked).toEqual({ title: 'Acme' })
  })

  it('answers a probe for an existing guarded field and a nonexistent one identically', () => {
    // 🔴 The anti-oracle property, asserted directly: the response must not
    // distinguish "that field exists and is protected" from "no such field".
    const guarded = pickIntakeFields({ title: 'Acme', owner: 'x' })
    const nonsense = pickIntakeFields({ title: 'Acme', zzzznotafield: 'x' })
    expect(guarded).toEqual(nonsense)
  })

  it('ignores inherited and prototype-planted keys', () => {
    const parent = { title: 'Inherited' }
    const child = Object.create(parent)
    expect(pickIntakeFields(child)).toEqual({})
    expect(pickIntakeFields(JSON.parse('{"__proto__":{"title":"polluted"}}'))).toEqual({})
    const untouched: Record<string, unknown> = {}
    expect(untouched.title).toBeUndefined()
  })

  it('survives non-objects', () => {
    expect(pickIntakeFields(null)).toEqual({})
    expect(pickIntakeFields('title')).toEqual({})
    expect(pickIntakeFields(7)).toEqual({})
  })
})

describe('buildIntakeLeadAttributes', () => {
  it('produces exactly the attributes the client is allowed to send', () => {
    expect(buildIntakeLeadAttributes({ title: '  Acme  ' })).toEqual({
      title: 'Acme',
      status: 'New',
      priority: 'NoPriority',
      rank: '',
      content: '',
      parentInfo: [],
      blobs: {}
    })
  })

  it('has nothing to build without a usable title', () => {
    expect(buildIntakeLeadAttributes({ title: '   ' })).toBeUndefined()
    expect(buildIntakeLeadAttributes({})).toBeUndefined()
  })

  it('carries name, email and message when they are given', () => {
    expect(
      buildIntakeLeadAttributes({
        title: 'Acme',
        intakeName: '  Jane Doe ',
        intakeEmail: 'jane@acme.com',
        intakeMessage: 'We need  20 seats\nby March'
      })
    ).toEqual({
      title: 'Acme',
      intakeName: 'Jane Doe',
      intakeEmail: 'jane@acme.com',
      intakeMessage: 'We need 20 seats by March',
      status: 'New',
      priority: 'NoPriority',
      rank: '',
      content: '',
      parentInfo: [],
      blobs: {}
    })
  })

  it('omits the optional fields rather than writing empty strings', () => {
    // ⚠️ Absent, not `''`: an empty string is a value that a later "did they
    // leave contact details?" query would count as present.
    const built = buildIntakeLeadAttributes({ title: 'Acme', intakeName: '   ', intakeEmail: 42 })
    expect(built).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(built ?? {}, 'intakeName')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(built ?? {}, 'intakeEmail')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(built ?? {}, 'intakeMessage')).toBe(false)
  })

  it('gives the three optional fields no way to overwrite the forced triage values', () => {
    // 🔴 `status` / `priority` are written AFTER the optional spread, so no
    // ordering accident inside the new fields can dislodge them.
    const built = buildIntakeLeadAttributes({
      title: 'Acme',
      intakeMessage: 'x'
    })
    expect(built?.status).toBe('New')
    expect(built?.priority).toBe('NoPriority')
  })
})

describe('normalizeIntakeAttributes', () => {
  it('drops every privileged field and states the rest itself', () => {
    const result = normalizeIntakeAttributes({
      title: 'Acme',
      owner: 'contact:person:Boss',
      status: 'Converted',
      priority: 'Urgent',
      source: 'crm-lite:ids:SourceReferral',
      pipeline: 'crm-lite:ids:DefaultPipeline',
      account: 'contact:class:Organization#1',
      contact: 'contact:class:Person#1',
      disqualifyReason: 'nope',
      nextActionAt: 1,
      intakeName: '  Jane Doe  ',
      intakeEmail: 'jane@acme.com',
      intakeMessage: '=HYPERLINK("http://evil")',
      content: 'blob-id-somebody-else-uploaded',
      readonlyFields: [],
      baseId: LEAD_ID,
      'crm-lite:mixin:Escalation': { level: 9 },
      'title.$where': 'x',
      __proto__: { title: 'polluted' }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attributes).toEqual({
      title: 'Acme',
      // The three fields a stranger IS allowed to contribute — sanitized, and
      // the message's formula trigger defused rather than rejected.
      intakeName: 'Jane Doe',
      intakeEmail: 'jane@acme.com',
      intakeMessage: '\'=HYPERLINK("http://evil")',
      status: 'New',
      priority: 'NoPriority',
      source: INTAKE_SOURCE,
      rank: '',
      // 🔴 The submitted blob ref is not merely dropped, it is OVERWRITTEN with
      // the empty markup ref.
      content: '',
      parentInfo: [],
      blobs: {}
    })
  })

  it('refuses only the one thing that is about the submitter own request', () => {
    expect(normalizeIntakeAttributes({ title: '  ' })).toMatchObject({ reason: 'intake-empty-submission' })
    expect(normalizeIntakeAttributes({})).toMatchObject({ reason: 'intake-empty-submission' })
    expect(normalizeIntakeAttributes(undefined)).toMatchObject({ reason: 'intake-empty-submission' })
    // A message without a title is still not a triageable row, and the extra
    // fields do not change that.
    expect(normalizeIntakeAttributes({ intakeMessage: 'please call me' })).toMatchObject({
      reason: 'intake-empty-submission'
    })
  })

  it('caps the message on the SERVER, at the message length, whatever the form allowed', () => {
    // 🔴 The client counter is a courtesy; this is the control. The bug it
    // pins is the server using the title cap for every field.
    const result = normalizeIntakeAttributes({
      title: 'Acme',
      intakeMessage: 'm'.repeat(INTAKE_MESSAGE_MAX_LENGTH + 5000),
      intakeName: 'n'.repeat(INTAKE_NAME_MAX_LENGTH + 100),
      intakeEmail: 'e'.repeat(INTAKE_EMAIL_MAX_LENGTH + 100)
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(String(result.attributes.intakeMessage)).toHaveLength(INTAKE_MESSAGE_MAX_LENGTH)
    expect(String(result.attributes.intakeName)).toHaveLength(INTAKE_NAME_MAX_LENGTH)
    expect(String(result.attributes.intakeEmail)).toHaveLength(INTAKE_EMAIL_MAX_LENGTH)
  })

  it('keeps the email a string and nothing more', () => {
    // 🔴 `intakeEmail` must never become a Ref, a Channel or an identity. The
    // only thing that reaches the document is the text the stranger typed.
    const result = normalizeIntakeAttributes({
      title: 'Acme',
      intakeEmail: { address: 'ceo@ourcompany.com' }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A non-string is dropped, not coerced: `String({})` would have written
    // "[object Object]" onto a lead as if it were a contact address.
    expect(result.attributes.intakeEmail).toBeUndefined()

    const plain = normalizeIntakeAttributes({ title: 'Acme', intakeEmail: 'ceo@ourcompany.com' })
    expect(plain.ok).toBe(true)
    if (!plain.ok) return
    expect(typeof plain.attributes.intakeEmail).toBe('string')
    // Nothing else on the document changed because of it — no channel, no
    // person reference, no owner.
    expect(plain.attributes.contact).toBeUndefined()
    expect(plain.attributes.account).toBeUndefined()
    expect(plain.attributes.owner).toBeUndefined()
  })
})

describe('pinIntakeEnvelope', () => {
  it('forces createdBy to the one identity IdentityMiddleware proves', () => {
    // 🔴 `NormalizeTxMiddleware` accepts a client `createdBy` and
    // `IdentityMiddleware` checks only `modifiedBy`, so without this an
    // anonymous submitter picks who the lead was "created by".
    const tx: Record<string, unknown> = { modifiedBy: 'social-anon', createdBy: 'social-ceo' }
    pinIntakeEnvelope(tx)
    expect(tx.createdBy).toBe('social-anon')
  })

  it('removes the envelope fields createDoc2Doc copies past the whitelist', () => {
    const tx: Record<string, unknown> = {
      modifiedBy: 'social-anon',
      attachedTo: 'some:doc',
      attachedToClass: 'some:class',
      collection: 'messages',
      meta: { anything: true }
    }
    pinIntakeEnvelope(tx)
    expect(tx.attachedTo).toBeUndefined()
    expect(tx.attachedToClass).toBeUndefined()
    expect(tx.collection).toBeUndefined()
    expect(tx.meta).toBeUndefined()
  })
})

describe('pinIntakeVersionChain', () => {
  it('restates the stamp VersioningMiddleware wrote above this guard', () => {
    // 🔴 The submitted `baseId` names somebody else's version chain, and
    // `setVersionData` has already computed `version: 8` from it. Keeping
    // either would make the submission the current revision of that lead.
    const pinned = pinIntakeVersionChain(
      { title: 'Acme', baseId: 'victim-chain', version: 8, isLatest: true },
      'own-id',
      'social-1'
    )
    expect(pinned.baseId).toBe('own-id')
    expect(pinned.version).toBe(1)
    expect(pinned.isLatest).toBe(true)
    expect(pinned.docCreatedBy).toBe('social-1')
  })

  it('leaves a fresh submission unchanged in substance', () => {
    const pinned = pinIntakeVersionChain({ title: 'Acme' }, 'own-id', 'social-1')
    expect(pinned.title).toBe('Acme')
  })
})

describe('checkIntakeSpace', () => {
  it('pins submissions to the CRM space', () => {
    expect(checkIntakeSpace(SPACE).ok).toBe(true)
    expect(checkIntakeSpace(OTHER_SPACE)).toMatchObject({ reason: 'intake-wrong-space' })
    expect(checkIntakeSpace(undefined)).toMatchObject({ reason: 'intake-wrong-space' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Who is writing
// ─────────────────────────────────────────────────────────────────────────────

function account (role: AccountRole, uuid: string = 'anon-uuid'): Account {
  return { uuid, role, primarySocialId: 'social-1', socialIds: ['social-1'], fullSocialIds: [] } as any
}

describe('isIntakeAccount', () => {
  it('treats every role below User as an anonymous submitter', () => {
    expect(isIntakeAccount(account(AccountRole.ReadOnlyGuest))).toBe(true)
    expect(isIntakeAccount(account(AccountRole.DocGuest))).toBe(true)
    expect(isIntakeAccount(account(AccountRole.Guest))).toBe(true)
  })

  it('treats staff as staff', () => {
    expect(isIntakeAccount(account(AccountRole.User))).toBe(false)
    expect(isIntakeAccount(account(AccountRole.Maintainer))).toBe(false)
    expect(isIntakeAccount(account(AccountRole.Owner))).toBe(false)
    expect(isIntakeAccount(account(AccountRole.Admin))).toBe(false)
    expect(isIntakeAccount(undefined)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting — PROCESS LOCAL, and the tests say so
// ─────────────────────────────────────────────────────────────────────────────

describe('IntakeRateLimiter', () => {
  it('allows the budget and then sheds', () => {
    const limiter = new IntakeRateLimiter({ max: 3, windowMs: 1000 })
    expect(limiter.take('k', 0)).toBe(true)
    expect(limiter.take('k', 1)).toBe(true)
    expect(limiter.take('k', 2)).toBe(true)
    expect(limiter.take('k', 3)).toBe(false)
  })

  it('slides the window', () => {
    const limiter = new IntakeRateLimiter({ max: 2, windowMs: 1000 })
    expect(limiter.take('k', 0)).toBe(true)
    expect(limiter.take('k', 100)).toBe(true)
    expect(limiter.take('k', 200)).toBe(false)
    expect(limiter.take('k', 1101)).toBe(true)
  })

  it('does not let refused attempts extend the lockout', () => {
    // Counting rejections would hand an attacker a way to keep a legitimate
    // submitter out forever by continuing to hammer the key.
    const limiter = new IntakeRateLimiter({ max: 1, windowMs: 1000 })
    expect(limiter.take('k', 0)).toBe(true)
    for (let at = 1; at < 900; at++) limiter.take('k', at)
    expect(limiter.take('k', 1001)).toBe(true)
  })

  it('keys budgets separately', () => {
    const limiter = new IntakeRateLimiter({ max: 1, windowMs: 1000 })
    expect(limiter.take('a', 0)).toBe(true)
    expect(limiter.take('a', 1)).toBe(false)
    expect(limiter.take('b', 1)).toBe(true)
  })

  it('bounds its own memory against a key-churning attacker', () => {
    const limiter = new IntakeRateLimiter({ max: 5, windowMs: 1000 }, 10)
    for (let i = 0; i < 500; i++) limiter.take(`k${i}`, i)
    expect(limiter.size).toBeLessThanOrEqual(10)
  })

  it('keys on the account and space, never on the client-chosen session id', () => {
    const key = intakeRateKey(account(AccountRole.Guest, 'u1'), SPACE)
    expect(key).toBe(`u1|${SPACE}`)
    expect(intakeRateKey(account(AccountRole.Guest, 'u1'), OTHER_SPACE)).not.toBe(key)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The middleware, i.e. the raw-transaction surface
// ─────────────────────────────────────────────────────────────────────────────

const derivedFrom: Record<string, string[]> = {
  [core.class.TxApplyIf]: [core.class.Tx]
}
const known = new Set<string>([LEAD_CLASS])

const hierarchy = {
  hasClass: (_class: string) => known.has(_class),
  isDerived: (a: string, b: string) => a === b || (derivedFrom[a] ?? []).includes(b)
} as any

class Recorder implements Partial<Middleware> {
  readonly written: Tx[] = []
  constructor (readonly docs: Doc[]) {}

  async tx (_ctx: MeasureContext, txes: Tx[]): Promise<any> {
    this.written.push(...txes)
    return {}
  }

  async findAll (_ctx: MeasureContext, _class: Ref<Class<Doc>>, query: Record<string, any>): Promise<any> {
    const matches = this.docs.filter(
      (doc) =>
        (doc._class === _class || (derivedFrom[doc._class] ?? []).includes(_class)) &&
        Object.entries(query).every(([key, value]) => (doc as any)[key] === value)
    )
    return toFindResult(matches as any)
  }
}

async function guard (docs: Doc[] = []): Promise<{ mw: Middleware, sink: Recorder }> {
  const sink = new Recorder(docs)
  const mw = (await LeadGuardMiddleware.create(
    {} as any,
    { hierarchy, contextVars: {} } as any as PipelineContext,
    sink as any
  )) as Middleware
  return { mw, sink }
}

async function applyStack (docs: Doc[] = []): Promise<{ head: Middleware, sink: Recorder }> {
  const sink = new Recorder(docs)
  const ctx = { hierarchy, contextVars: {} } as any as PipelineContext
  const inner = (await LeadGuardMiddleware.create({} as any, ctx, sink as any)) as Middleware
  const head = await ApplyTxMiddleware.create({} as any, ctx, inner)
  return { head, sink }
}

/** A session context carrying an account, which is the ONLY intake signal. */
function session (role: AccountRole, uuid: string = 'anon-uuid'): MeasureContext {
  return { contextData: { account: account(role, uuid) } } as any
}

const factory = new TxFactory(core.account.System, true)

function submit (attributes: Record<string, unknown>, space: Ref<Space> = SPACE, id: Ref<Lead> = LEAD_ID): Tx {
  return factory.createTxCreateDoc(LEAD_CLASS as Ref<Class<Lead>>, space, attributes as any, id)
}

async function refusalOf (fn: () => Promise<unknown>): Promise<LeadGuardError> {
  try {
    await fn()
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(LeadGuardError)
    return err as LeadGuardError
  }
  throw new Error('expected the guard to refuse, but the write was accepted')
}

function existingLead (id: Ref<Lead> = LEAD_ID): Doc {
  return {
    _id: id,
    _class: LEAD_CLASS,
    space: SPACE,
    modifiedBy: core.account.System,
    modifiedOn: 0,
    title: 'Already here',
    status: 'New',
    priority: 'NoPriority'
  } as any
}

describe('LeadGuardMiddleware: anonymous intake', () => {
  it('accepts a submission and rewrites it to exactly the allowed shape', async () => {
    const { mw, sink } = await guard()
    const tx = submit({ title: '  Acme   Corp  ' })
    await mw.tx(session(AccountRole.Guest), [tx])
    expect(sink.written).toHaveLength(1)
    expect((sink.written[0] as TxCreateDoc<Lead>).attributes).toEqual({
      title: 'Acme Corp',
      status: 'New',
      priority: 'NoPriority',
      source: INTAKE_SOURCE,
      rank: '',
      content: '',
      parentInfo: [],
      blobs: {},
      isLatest: true,
      version: 1,
      baseId: (sink.written[0] as TxCreateDoc<Lead>).objectId,
      docCreatedBy: core.account.System
    })
  })

  it('DROPS hidden privileged fields instead of refusing them', async () => {
    // 🔴 The write must SUCCEED — a refusal here would be a field-probing
    // oracle. What must not survive is the payload.
    const { mw, sink } = await guard()
    const tx = submit({
      title: 'Acme',
      owner: 'contact:person:Boss',
      status: 'Converted',
      priority: 'Urgent',
      source: 'crm-lite:ids:SourceReferral',
      account: 'contact:class:Organization#1',
      readonlyFields: ['title']
    })
    await mw.tx(session(AccountRole.Guest), [tx])
    const written = (sink.written[0] as TxCreateDoc<Lead>).attributes as Record<string, unknown>
    expect(written.owner).toBeUndefined()
    expect(written.account).toBeUndefined()
    expect(written.readonlyFields).toBeUndefined()
    expect(written.status).toBe('New')
    expect(written.priority).toBe('NoPriority')
    expect(written.source).toBe(INTAKE_SOURCE)
  })

  it('cannot create a lead that is born Converted', async () => {
    const { mw, sink } = await guard()
    await mw.tx(session(AccountRole.Guest), [submit({ title: 'Acme', status: 'Converted' })])
    expect((sink.written[0] as TxCreateDoc<Lead>).attributes.status).toBe('New')
  })

  it('cannot smuggle a mixin in through TxCreateDoc.attributes', async () => {
    // `TxProcessor.createDoc2Doc` spreads `attributes` verbatim, so a mixin id
    // used as an attribute key would arrive pre-attached to the new document.
    const { mw, sink } = await guard()
    await mw.tx(session(AccountRole.Guest), [
      submit({
        title: 'Acme',
        'crm-lite:mixin:Escalation': { level: 9 },
        'contact:mixin:Employee': { active: true }
      })
    ])
    const written = (sink.written[0] as TxCreateDoc<Lead>).attributes as Record<string, unknown>
    expect(Object.keys(written).sort()).toEqual([
      'baseId',
      'blobs',
      'content',
      'docCreatedBy',
      'isLatest',
      'parentInfo',
      'priority',
      'rank',
      'source',
      'status',
      'title',
      'version'
    ])
  })

  it('neutralizes a formula in the submitted title', async () => {
    const { mw, sink } = await guard()
    await mw.tx(session(AccountRole.Guest), [submit({ title: '=HYPERLINK("http://evil")' })])
    expect((sink.written[0] as TxCreateDoc<Lead>).attributes.title).toBe('\'=HYPERLINK("http://evil")')
  })

  it('cannot graft a submission onto another lead version chain', async () => {
    // `VersioningMiddleware` runs ABOVE this guard and reads `baseId` out of the
    // submitted attributes. The guard restates the stamp so the result is a new
    // chain rather than a new revision of somebody else's lead.
    const { mw, sink } = await guard()
    await mw.tx(session(AccountRole.Guest), [
      submit({ title: 'Acme', baseId: 'victim-chain', version: 8, isLatest: true })
    ])
    const written = (sink.written[0] as TxCreateDoc<Lead>).attributes as Record<string, unknown>
    expect(written.baseId).toBe(LEAD_ID)
    expect(written.version).toBe(1)
    expect(written.isLatest).toBe(true)
  })

  it('cannot forge createdBy or attach itself to another document', async () => {
    const { mw, sink } = await guard()
    const tx = submit({ title: 'Acme' }) as any
    tx.createdBy = 'social:ceo'
    tx.attachedTo = 'card:doc:Victim'
    tx.attachedToClass = 'card:class:Card'
    tx.collection = 'children'
    await mw.tx(session(AccountRole.Guest), [tx])
    const written = sink.written[0] as any
    expect(written.createdBy).toBe(written.modifiedBy)
    expect(written.attachedTo).toBeUndefined()
    expect(written.attachedToClass).toBeUndefined()
    expect(written.collection).toBeUndefined()
  })

  it('says the same sentence for every refusal', async () => {
    // 🔴 `ClientSession` serializes `err.message` to the caller via
    // `unknownError`, so differing wording would be a readable oracle even
    // though the UI renders one string. Only `reason` may differ.
    const messages = new Set<string>()
    const reasons = new Set<string>()
    const cases: Array<() => Promise<{ mw: Middleware, tx: Tx }>> = [
      async () => ({ mw: (await guard()).mw, tx: submit({ title: 'Acme' }, OTHER_SPACE) }),
      async () => ({ mw: (await guard()).mw, tx: submit({ title: '  ' }) }),
      async () => ({ mw: (await guard([existingLead()])).mw, tx: submit({ title: 'Acme' }) }),
      async () => ({
        mw: (await guard([existingLead()])).mw,
        tx: factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, { title: 'x' } as any)
      })
    ]
    for (const build of cases) {
      const { mw, tx } = await build()
      const err = await refusalOf(async () => await mw.tx(session(AccountRole.Guest), [tx]))
      messages.add(err.message)
      reasons.add(err.reason)
    }
    expect(messages).toEqual(new Set([INTAKE_REFUSAL_MESSAGE]))
    expect(reasons.size).toBe(4)
  })

  it('refuses a submission with no usable title', async () => {
    const { mw, sink } = await guard()
    const err = await refusalOf(async () => await mw.tx(session(AccountRole.Guest), [submit({ title: '   ' })]))
    expect(err.reason).toBe('intake-empty-submission')
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a submission aimed at another space', async () => {
    const { mw } = await guard()
    const err = await refusalOf(
      async () => await mw.tx(session(AccountRole.Guest), [submit({ title: 'Acme' }, OTHER_SPACE)])
    )
    expect(err.reason).toBe('intake-wrong-space')
  })

  it('refuses every non-create shape, including the operator payloads', async () => {
    for (const tx of [
      factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, { title: 'x' } as any),
      factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, {
        $set: { status: 'Converted' }
      } as any),
      factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, {
        title: 'x',
        $set: { owner: 'contact:person:Boss' }
      } as any),
      factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, { $unset: { status: '' } } as any),
      factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, {
        $rename: { title: 'status' }
      } as any),
      factory.createTxRemoveDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID),
      factory.createTxMixin(
        LEAD_ID,
        LEAD_CLASS as Ref<Class<Lead>>,
        SPACE,
        LEAD_CLASS as any,
        {
          status: 'Converted'
        } as any
      )
    ]) {
      const { mw, sink } = await guard([existingLead()])
      const err = await refusalOf(async () => await mw.tx(session(AccountRole.Guest), [tx]))
      expect(err.reason).toBe('intake-create-only')
      expect(sink.written).toHaveLength(0)
    }
  })

  it('refuses the same shapes when they are smuggled inside a TxApplyIf', async () => {
    const { head, sink } = await applyStack([existingLead()])
    const inner = factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, {
      status: 'Converted'
    } as any)
    const apply = factory.createTxApplyIf(SPACE, undefined, [], [], [inner as any], undefined)
    const err = await refusalOf(async () => await head.tx(session(AccountRole.Guest), [apply]))
    expect(err.reason).toBe('intake-create-only')
    expect(sink.written).toHaveLength(0)
  })

  it('refuses a create smuggled into a TxApplyIf that targets another space', async () => {
    const { head } = await applyStack()
    const inner = submit({ title: 'Acme' }, OTHER_SPACE)
    const apply = factory.createTxApplyIf(SPACE, undefined, [], [], [inner as any], undefined)
    const err = await refusalOf(async () => await head.tx(session(AccountRole.Guest), [apply]))
    expect(err.reason).toBe('intake-wrong-space')
  })

  it('still normalizes a create that arrives inside a TxApplyIf', async () => {
    const { head, sink } = await applyStack()
    const inner = submit({ title: 'Acme', owner: 'contact:person:Boss' })
    const apply = factory.createTxApplyIf(SPACE, undefined, [], [], [inner as any], undefined)
    await head.tx(session(AccountRole.Guest), [apply])
    const created = sink.written.find((tx) => tx._class === core.class.TxCreateDoc) as TxCreateDoc<Lead> | undefined
    expect(created?.attributes).toEqual({
      title: 'Acme',
      status: 'New',
      priority: 'NoPriority',
      source: INTAKE_SOURCE,
      rank: '',
      content: '',
      parentInfo: [],
      blobs: {},
      isLatest: true,
      version: 1,
      baseId: (sink.written[0] as TxCreateDoc<Lead>).objectId,
      docCreatedBy: core.account.System
    })
  })

  it('refuses a repeat of the same submission, using the database as the ledger', async () => {
    // 🔴 Dedup is the document `_id`, i.e. SHARED durable state — not a
    // process-local nonce table. The form reuses one id for every retry of one
    // submission, so this is exactly the double-click case.
    const { mw, sink } = await guard([existingLead()])
    const err = await refusalOf(async () => await mw.tx(session(AccountRole.Guest), [submit({ title: 'Acme' })]))
    expect(err.reason).toBe('intake-duplicate')
    expect(sink.written).toHaveLength(0)
  })

  it('lets a different submission through while refusing the repeat', async () => {
    const { mw, sink } = await guard([existingLead()])
    await mw.tx(session(AccountRole.Guest), [submit({ title: 'Acme' }, SPACE, '000000000000000000000099' as Ref<Lead>)])
    expect(sink.written).toHaveLength(1)
  })

  it('sheds a flood, per process', async () => {
    const { mw } = await guard()
    let refused: LeadGuardError | undefined
    for (let i = 0; i < 200; i++) {
      const tx = submit({ title: `Acme ${i}` }, SPACE, `0000000000000000000001${String(i).padStart(2, '0')}` as any)
      try {
        await mw.tx(session(AccountRole.Guest), [tx])
      } catch (err: unknown) {
        refused = err as LeadGuardError
        break
      }
    }
    expect(refused?.reason).toBe('intake-rate-limited')
  })

  it('gives each pipeline instance its own budget', async () => {
    // One limiter per middleware instance = one per workspace pipeline, so a
    // flood against one workspace cannot lock another one out. It is also the
    // exact reason this control does NOT span transactor replicas.
    const a = await guard()
    const b = await guard()
    for (let i = 0; i < 200; i++) {
      try {
        await a.mw.tx(session(AccountRole.Guest), [
          submit({ title: `x${i}` }, SPACE, `0000000000000000000002${String(i).padStart(2, '0')}` as any)
        ])
      } catch {
        break
      }
    }
    await expect(b.mw.tx(session(AccountRole.Guest), [submit({ title: 'fresh' })])).resolves.toBeDefined()
  })
})

describe('LeadGuardMiddleware: intake rules apply to nobody else', () => {
  it('leaves a staff create untouched', async () => {
    const { mw, sink } = await guard()
    const tx = submit({ title: '  Acme  ', owner: 'contact:person:Boss', priority: 'Urgent' })
    await mw.tx(session(AccountRole.User), [tx])
    const written = (sink.written[0] as TxCreateDoc<Lead>).attributes as Record<string, unknown>
    expect(written.owner).toBe('contact:person:Boss')
    expect(written.priority).toBe('Urgent')
    expect(written.title).toBe('  Acme  ')
    expect(written.source).toBeUndefined()
  })

  it('lets staff update a lead, which intake may never do', async () => {
    const { mw, sink } = await guard([existingLead()])
    const tx = factory.createTxUpdateDoc(LEAD_CLASS as Ref<Class<Lead>>, SPACE, LEAD_ID, { title: 'Renamed' } as any)
    await mw.tx(session(AccountRole.User), [tx])
    expect(sink.written).toHaveLength(1)
  })

  it('does not classify a write as intake when there is no session at all', async () => {
    // 🔴 The classification input is the SESSION. A context with no account is
    // an internal call (migration, trigger), not an anonymous stranger.
    const { mw, sink } = await guard()
    await mw.tx({} as any, [submit({ title: 'Acme', owner: 'contact:person:Boss' })])
    expect((sink.written[0] as TxCreateDoc<Lead>).attributes.owner).toBe('contact:person:Boss')
  })

  it('ignores a payload that claims to be an intake submission', async () => {
    // A flag in the transaction must not be able to select a ruleset — in
    // either direction. Here a staff write carrying intake-looking keys is
    // still judged as staff.
    const { mw, sink } = await guard()
    await mw.tx(session(AccountRole.User), [submit({ title: 'Acme', intake: true, source: 'anything' } as any)])
    expect((sink.written[0] as TxCreateDoc<Lead>).attributes.source).toBe('anything')
  })

  it('ignores an intake claim from an anonymous session too', async () => {
    const { mw, sink } = await guard()
    await mw.tx(session(AccountRole.Guest), [submit({ title: 'Acme', intake: false } as any)])
    expect(Object.keys((sink.written[0] as TxCreateDoc<Lead>).attributes).sort()).toEqual([
      'baseId',
      'blobs',
      'content',
      'docCreatedBy',
      'isLatest',
      'parentInfo',
      'priority',
      'rank',
      'source',
      'status',
      'title',
      'version'
    ])
  })

  it('leaves transactions on other classes to the middlewares that own them', async () => {
    const { mw, sink } = await guard()
    const tx = factory.createTxCreateDoc('contact:class:Person' as Ref<Class<Doc>>, SPACE, { name: 'X' } as any)
    await mw.tx(session(AccountRole.Guest), [tx])
    expect(sink.written).toHaveLength(1)
  })
})
