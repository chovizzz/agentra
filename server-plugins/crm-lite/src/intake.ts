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

import { AccountRole, hasAccountRole, type Account, type Ref, type Space } from '@hcengineering/core'
import crmLite, {
  INTAKE_ALLOWED_FIELDS,
  INTAKE_FORCED_PRIORITY,
  INTAKE_FORCED_STATUS,
  intakeFieldMaxLength,
  intakeStructuralDefaults,
  sanitizeIntakeText,
  type LeadSource
} from '@hcengineering/crm-lite'

/**
 * ANONYMOUS LEAD INTAKE — the server half (PRD CRM-008, implementation plan
 * Task 20 Step 1 / Step 3).
 *
 * 🔴 READ THIS BEFORE CHANGING ANYTHING IN THIS FILE. This is the only write
 * path in Agentra whose input comes from someone who has not been vouched for
 * by anybody. Everything else in the product is written by an account a human
 * admin invited. The design rule that follows from that is: intake is
 * SUBTRACTIVE. It never grants a capability, it only removes them from a
 * session that already had less than a user.
 *
 * ─── WHO IS WRITING? ──────────────────────────────────────────────────────
 *
 * There is no such thing as a transaction with no account. Every `tx` reaching
 * the pipeline carries `ctx.contextData.account`, filled in from a validated
 * token. "Anonymous" here therefore means precisely one thing: the submission
 * arrives on a session whose account is BELOW `AccountRole.User` — the
 * guest-grade access link an admin publishes for the intake form (the same
 * `createAccessLink(AccountRole.Guest, …)` mechanism `plugins/love-resources`
 * uses for meeting guests), not a user, not a service, and above all NOT a
 * system token.
 *
 * 🔴 WHY THAT CANNOT BE ABUSED, stated as the three checks that already exist
 * above this middleware and that intake deliberately does not opt out of:
 *
 *   - `IdentityMiddleware` (`foundations/server/packages/middleware/src/identity.ts`)
 *     exempts EXACTLY two identities from the `modifiedBy`-must-match-the-account
 *     rule: `systemAccountUuid` and the AI bot. A guest-grade account is neither,
 *     so an intake submission cannot forge `modifiedBy` and cannot impersonate a
 *     real employee. ⚠️ This is the concrete reason intake must never be given a
 *     system token: `server/collaborator` holds one, and a holder of one may
 *     write any `modifiedBy` it likes. Intake asks for no such thing.
 *   - `SpacePermissionsMiddleware` (the one that actually resolves permissions
 *     from `cud.objectSpace`), `SpaceSecurityMiddleware` and
 *     `GuestPermissionsMiddleware` all run ABOVE `LeadGuardMiddleware` in
 *     `createServerPipeline`'s middleware array, so by the time a submission is
 *     seen here it has already had to satisfy the space ACL and the guest
 *     `ClassPermission` allow-list. Intake adds restrictions on top of those; it
 *     removes none.
 *   - Nothing in this file writes with elevated rights. The one read it performs
 *     (the duplicate check) goes through `provideFindAll`, whose result is never
 *     echoed to the submitter — only its existence changes the verdict.
 *
 * 🔴 THE COROLLARY, which is the load-bearing half: the classification
 * "this is an intake submission" is derived from the SESSION, never from the
 * payload. If a `{ intake: true }` flag in the transaction switched the rules
 * on, an attacker would simply pick whichever ruleset is laxer for what they
 * want to do. A flag can be set; a role cannot.
 *
 * ─── WHAT IS ENFORCED, AND WHERE ──────────────────────────────────────────
 *
 * | control          | mechanism                          | scope             |
 * |------------------|------------------------------------|-------------------|
 * | field whitelist  | {@link normalizeIntakeAttributes}  | per transaction   |
 * | forced status    | {@link normalizeIntakeAttributes}  | per transaction   |
 * | forced source    | {@link normalizeIntakeAttributes}  | per transaction   |
 * | envelope fields  | {@link pinIntakeEnvelope}          | per transaction   |
 * | version chain    | {@link pinIntakeVersionChain}      | per transaction   |
 * | create-only      | LeadGuardMiddleware                | per transaction   |
 * | space pinning    | {@link checkIntakeSpace}           | per transaction   |
 * | uniform refusals | {@link INTAKE_REFUSAL_MESSAGE}     | per transaction   |
 * | duplicate submit | document `_id` (the DATABASE)      | SHARED / durable  |
 * | rate limit       | {@link IntakeRateLimiter}          | 🔴 PER PROCESS    |
 *
 * The last two rows are the ones to read carefully; see each of them below.
 *
 * ⚠️ TWO ROWS ARE ABOUT FIELDS THAT NEVER PASS THROUGH `attributes` AT ALL
 * ({@link pinIntakeEnvelope}, {@link pinIntakeVersionChain}). A whitelist over
 * `attributes` is necessary and NOT sufficient: `createDoc2Doc` also copies
 * `createdBy` / `attachedTo` / `attachedToClass` / `collection` from the
 * transaction envelope, and `VersioningMiddleware` — which runs above this
 * guard — writes `baseId` / `version` / `isLatest` from a submitter-supplied
 * `baseId`. Both were live holes in the first version of this file.
 *
 * ─── KNOWN LIMITS, STATED RATHER THAN IMPLIED ─────────────────────────────
 *
 *  - The rate limit is process-local. See {@link IntakeRateLimiter}.
 *  - Duplicate detection has a TOCTOU window: two concurrent submissions with
 *    the same `_id` can both pass the `provideFindAll` check. The DATABASE is
 *    what actually settles it — the Postgres object table's primary key is
 *    `(workspaceId, _id)` and the object insert path does not use
 *    `ON CONFLICT` — so the loser gets a raw duplicate-key error rather than a
 *    clean `intake-duplicate`. The invariant that matters (one document per
 *    submission id) holds either way; only the error text degrades.
 *  - THIS GUARD ONLY SEES LEADS. A `Guest`-role session may still create other
 *    `card.class.Card` descendants wherever the deployment's guest
 *    `ClassPermission` configuration allows it. That is
 *    `GuestPermissionsMiddleware`'s remit, not this file's — but it means
 *    "anonymous sessions can only file leads" is a statement about the guest
 *    permission model, NOT something this middleware establishes on its own.
 */

/**
 * @public
 */
export type IntakeGuardReason =
  // The session is not a user, and the transaction is something other than
  // "create one lead".
  | 'intake-create-only'
  // The submission names a space other than the CRM space.
  | 'intake-wrong-space'
  // Nothing usable survived {@link sanitizeIntakeText}.
  | 'intake-empty-submission'
  // A lead already exists at this `_id`: the same submission, submitted twice.
  | 'intake-duplicate'
  // Too many submissions from this session, too fast.
  | 'intake-rate-limited'

/**
 * @public
 */
export interface IntakeRefusal {
  ok: false
  reason: IntakeGuardReason
  message: string
}

/**
 * @public
 */
export type IntakeVerdict = { ok: true } | IntakeRefusal

const INTAKE_ACCEPTED: IntakeVerdict = { ok: true }

/**
 * The ONE sentence every intake refusal carries.
 *
 * 🔴 IDENTICAL ON PURPOSE, AND THE UI IS NOT WHERE THIS IS DECIDED. A refusal
 * leaves the pipeline as a thrown `LeadGuardError`; `ClientSession` turns it
 * into `unknownError(err)`, which for a plain `Error` is
 * `unknownStatus(err.message)` — so the MESSAGE STRING IS SERIALIZED TO THE
 * CALLER. Distinct wording per reason would therefore hand a direct API caller
 * (and the browser console, and the network tab) a readout distinguishing
 * "wrong space" from "already received" from "slow down", which is exactly the
 * probe the whitelist's silent-drop rule exists to deny. `LeadIntakeForm`
 * rendering one string is a courtesy on top; this constant is the control.
 *
 * ⚠️ The operator does NOT lose the detail: {@link IntakeRefusal.reason} is a
 * property of the thrown error and never crosses the wire, so it is available
 * to server-side logging and to tests.
 *
 * @public
 */
export const INTAKE_REFUSAL_MESSAGE = 'This submission could not be accepted'

/**
 * @public
 */
export function refuseIntake (reason: IntakeGuardReason): IntakeRefusal {
  return { ok: false, reason, message: INTAKE_REFUSAL_MESSAGE }
}

/**
 * Is this session an anonymous submitter rather than a member of staff?
 *
 * 🔴 The predicate is `role < User`, not `role === Guest`. `AccountRole` grows
 * (`DocGuest` and `ReadOnlyGuest` were both added after `Guest`) and a check
 * written as an equality silently stops covering every role added below it.
 * `hasAccountRole` does the ordered comparison for us and is the same call
 * `GuestPermissionsMiddleware` uses to draw the same line.
 *
 * ⚠️ A system account is NOT an intake account, and that is correct rather than
 * a hole: migrations, triggers and the conversion command all run as system and
 * must be able to write leads freely. What makes that safe is that no intake
 * request can obtain a system token — see the file header.
 *
 * @public
 */
export function isIntakeAccount (account: Account | undefined): boolean {
  if (account === undefined) return false
  return !hasAccountRole(account, AccountRole.User)
}

/**
 * The single space an anonymous submission may land in.
 *
 * 🔴 CHECKED, NOT REWRITTEN. Rewriting `objectSpace` here would be a genuine
 * privilege escalation rather than a tightening: `SpaceSecurityMiddleware` runs
 * ABOVE this middleware in the pipeline array — and, more to the point, so does
 * `SpacePermissionsMiddleware`, which is the one that actually resolves
 * permissions FROM `cud.objectSpace` (`spacePermissions.ts` `checkPermissions`;
 * `SpaceSecurityMiddleware.tx` mostly maintains caches and broadcast targets).
 * Both have therefore already judged the space the client named. Substituting a
 * different one afterwards would move the write into a space nobody checked the
 * caller against, and `createDoc2Doc` copies `tx.objectSpace` straight onto the
 * document. Refusing keeps the decision where the ACL is.
 *
 * @public
 */
export function checkIntakeSpace (space: Ref<Space> | undefined): IntakeVerdict {
  if (space === (crmLite.space.Crm as unknown as Ref<Space>)) return INTAKE_ACCEPTED
  return refuseIntake('intake-wrong-space')
}

/**
 * The source recorded on every anonymous submission.
 *
 * 🔴 SERVER-STATED, NEVER SUBMITTER-STATED. `source` is the audit answer to
 * "where did this lead come from", and a field the subject of the audit fills
 * in is not an audit. Accepting a client `source` would let a stranger label
 * their submission as a `Referral` from a trusted partner — which is exactly
 * the label that makes a salesperson skip the scrutiny.
 *
 * @public
 */
export const INTAKE_SOURCE: Ref<LeadSource> = crmLite.ids.SourceInbound

/**
 * ─── SOURCE AUDIT: what is recorded, where, and who can read it ────────────
 *
 * RECORDED:
 *   - `source = INTAKE_SOURCE` on the Lead — the durable, queryable "this came
 *     in through the public form" fact;
 *   - `status = New` — it is in the untriaged queue and has never been touched
 *     by staff;
 *   - the transaction itself, which the transaction domain keeps forever, and
 *     which carries `modifiedBy` / `createdBy` (the intake social id) and the
 *     server-stamped `modifiedOn` (`ModifiedMiddleware` overwrites the client's
 *     value for every non-system account, so the timestamp is not submitter
 *     controlled).
 *
 * 🔴 NOT RECORDED, deliberately: IP, User-Agent, Referer, or any other request
 * header. Two reasons, and the second is the one that matters.
 *   1. This layer genuinely does not have them. A pipeline middleware sees a
 *      transaction, not an HTTP request; per-IP anything belongs at the front /
 *      ingress tier (see {@link IntakeRateLimiter}).
 *   2. Every one of them is an attacker-controlled string. Writing them onto a
 *      document that staff render, export to CSV and paste into tickets would
 *      re-open, through the audit trail, precisely the injection surface
 *      `sanitizeIntakeText` exists to close. An audit record that carries the
 *      attacker's payload into the reviewer's screen is a delivery mechanism.
 *
 * WHO CAN READ IT: the Lead lands in `crmLite.space.Crm`, which
 * `plugins/crm-lite/src/index.ts` documents as deliberately private rather than
 * `card.space.Default`. So the audit is visible to CRM members and to nobody
 * else — and, critically, never to the submitter: the form is write-only and
 * gets back one fixed acknowledgement no matter what happened, so the audit
 * trail cannot be read back out through the channel that wrote it.
 *
 * @public
 */
export const INTAKE_AUDIT_NOTE = 'source+status on the Lead, plus the transaction; no request headers'

/**
 * Normalize the attributes of an anonymous `TxCreateDoc<Lead>` into the only
 * shape intake is allowed to produce.
 *
 * 🔴 THE RETURN IS A REPLACEMENT, NOT AN OPINION. The caller overwrites
 * `tx.attributes` with it. That is what makes "unlisted fields are dropped"
 * true of the RAW TRANSACTION rather than merely of the form: a hand-crafted tx
 * carrying `owner`, a mixin id, `__proto__` or a dotted path loses them here,
 * silently, with no error to read.
 *
 * ⚠️ WHY SILENT DROP IS THE SECURITY-CORRECT ANSWER AND AN ERROR IS NOT.
 * Refusing on an unexpected field turns the public form into a schema oracle:
 * every probe returns a different answer depending on whether the guessed field
 * exists and is guarded, and a few hundred requests enumerate the model —
 * including whatever mixins a particular deployment has hung on Lead. Dropping
 * returns the same thing for every probe.
 *
 * ⚠️ EVERY WHITELISTED FIELD IS SANITIZED, NOT MERELY COPIED, and each one gets
 * ITS OWN LENGTH CAP (`intakeFieldMaxLength`). The whitelist decides WHICH
 * strings survive; `sanitizeIntakeText` decides WHAT SHAPE they survive in —
 * control characters, zero-width and bidi-override characters removed, leading
 * spreadsheet-formula triggers defused with an apostrophe, whitespace
 * collapsed, length capped. A field added to the whitelist without a cap in
 * `INTAKE_FIELD_MAX_LENGTH` degrades to the shortest cap, never to unbounded.
 *
 * ⚠️ `intakeEmail` IS A STRING AND ONLY A STRING — see
 * `INTAKE_EMAIL_IS_UNVERIFIED` in the contract package. It is never turned into
 * a `contact.class.Channel`, never resolved to a person, never used as a
 * recipient. Making it any of those would let an unauthenticated stranger
 * choose who the deployment mails, or whose identity their submission binds to.
 *
 * ⚠️ `TxProcessor.createDoc2Doc` SPREADS `attributes` VERBATIM into the new
 * document. That is why the whitelist has to be applied to the attribute object
 * itself and not to a list of "known Lead fields": a key like
 * `crm-lite:mixin:Whatever` is not a Lead field at all, it is a whole mixin
 * arriving pre-attached, and only a whitelist sees it for what it is.
 *
 * @public
 */
export function normalizeIntakeAttributes (
  attributes: unknown
): { ok: true, attributes: Record<string, unknown> } | IntakeRefusal {
  const source = attributes == null || typeof attributes !== 'object' ? {} : (attributes as Record<string, unknown>)
  const kept: Record<string, unknown> = {}
  for (const field of INTAKE_ALLOWED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue
    // 🔴 THE CAP IS PER FIELD, resolved from the contract package rather than
    // left to `sanitizeIntakeText`'s default. Taking the default here would
    // truncate `intakeMessage` at the TITLE length — a silent, server-side
    // amputation of the one field the submitter was invited to write in, with
    // no error anywhere and no way for them to tell.
    const text = sanitizeIntakeText(source[field], intakeFieldMaxLength(field))
    if (text === undefined) continue
    kept[field] = text
  }
  if (kept.title === undefined) {
    // The one refusal in the whitelist path, and it leaks nothing: "you sent me
    // no title" is a statement about the submitter's own request.
    return refuseIntake('intake-empty-submission')
  }
  return {
    ok: true,
    attributes: {
      // Structural `Card` scaffolding, server-stated. `content` in particular is
      // forced to the empty markup ref, which is what makes "intake carries no
      // rich text" an enforced fact rather than an omission.
      ...intakeStructuralDefaults(),
      ...kept,
      // 🔴 Written AFTER the spread so a submitted `status` / `priority` /
      // `source` can never win, even if a future edit adds one of them to the
      // whitelist by mistake.
      status: INTAKE_FORCED_STATUS,
      priority: INTAKE_FORCED_PRIORITY,
      source: INTAKE_SOURCE
    }
  }
}

/**
 * Strip the parts of a `TxCreateDoc` that reach the new document WITHOUT going
 * through `attributes` — i.e. the ones the field whitelist structurally cannot
 * see.
 *
 * 🔴 THE WHITELIST IS NOT ENOUGH ON ITS OWN, and this is the reason.
 * `TxProcessor.createDoc2Doc` builds the document as
 * `{ ...attributes, ...attached, _id, _class, space, modifiedBy, modifiedOn,
 * createdBy: tx.createdBy ?? tx.modifiedBy, createdOn }` — so three transaction
 * ENVELOPE fields land on the document over the top of anything `attributes`
 * said:
 *
 *   - `createdBy` 🔴 THE IMPORTANT ONE. `NormalizeTxMiddleware` accepts a
 *     client-supplied `createdBy` (it is parsed and carried through
 *     `parseBaseTx`), and `IdentityMiddleware` validates ONLY `modifiedBy`.
 *     An anonymous submitter can therefore hand the lead any `createdBy` they
 *     like — an employee's social id, for instance — poisoning the ownership
 *     signal that `GuestPermissionsMiddleware.isCreatedByAccount` and every
 *     "who filed this" report read. Forcing it to `modifiedBy` is safe because
 *     `modifiedBy` is the one field `IdentityMiddleware` proves.
 *   - `attachedTo` / `attachedToClass` / `collection`: copied verbatim when
 *     `attachedTo` is set, which would let a submission graft itself into an
 *     arbitrary document's collection without any of it appearing in
 *     `attributes`. An intake lead is a top-level card and attaches to nothing.
 *   - `meta`: also client-supplied and also whitelist-invisible. Nothing in the
 *     intake path needs it.
 *
 * ⚠️ Subtractive only, so it stays correct regardless of where this middleware
 * sits: it removes fields and pins one to a value the pipeline already
 * verified. It never introduces a value nobody checked.
 *
 * @public
 */
export function pinIntakeEnvelope (tx: Record<string, unknown>): void {
  tx.createdBy = tx.modifiedBy
  delete tx.attachedTo
  delete tx.attachedToClass
  delete tx.collection
  delete tx.meta
}

/**
 * Pin an intake submission to a version chain of its own.
 *
 * 🔴 WHY THIS EXISTS AT ALL, AND IT IS NOT A TIDY-UP. A Lead comes from
 * `createSystemType`, so it carries `core.mixin.VersionableClass`, and
 * `VersioningMiddleware` — which sits ABOVE `LeadGuardMiddleware` in
 * `createServerPipeline`'s middleware array — writes `isLatest`, `version`,
 * `baseId` and `docCreatedBy` into `tx.attributes` BEFORE the guard ever sees
 * the transaction. Two consequences, in opposite directions:
 *
 *   1. Replacing `attributes` wholesale would DELETE that stamping, and every
 *      intake lead would arrive with no `isLatest` — invisible to the
 *      `isLatest === true` queries the rest of the card model runs on.
 *   2. Keeping the stamping verbatim would be worse. `setVersionData` reads
 *      `baseId` OUT OF THE SUBMITTED ATTRIBUTES: a submitter who names an
 *      existing lead's chain gets `version = latest.version + 1` and
 *      `isLatest: true` computed for them, and their submission becomes the
 *      current revision of somebody else's lead.
 *
 * So the values are restated rather than kept or dropped: `version: 1`,
 * `baseId` = this document's own id. That is exactly what `setVersionData`
 * itself writes for a first revision, so a genuine submission is unchanged,
 * and a chain-hijack attempt collapses into an ordinary new lead.
 *
 * ⚠️ NOT CLOSED HERE, and it cannot be from this middleware: the nested
 * `{ isLatest: false, readonly: true }` update `setVersionData` emits against
 * the victim's current revision is built ABOVE this guard. It is refused —
 * it reaches the guard as a `TxUpdateDoc` on a Lead from a non-user session,
 * which is `intake-create-only` — but the refusal arrives on a separate
 * `provideTx`. Fully closing it means ordering `LeadGuardMiddleware` above
 * `VersioningMiddleware`, which is a `pipeline.ts` decision.
 *
 * @public
 */
export function pinIntakeVersionChain (
  attributes: Record<string, unknown>,
  objectId: string,
  createdBy: unknown
): Record<string, unknown> {
  return {
    ...attributes,
    isLatest: true,
    version: 1,
    baseId: objectId,
    docCreatedBy: createdBy
  }
}

/**
 * @public
 */
export interface IntakeRateLimit {
  max: number
  windowMs: number
}

/**
 * @public
 */
export const INTAKE_RATE_LIMIT: IntakeRateLimit = { max: 20, windowMs: 60_000 }

/**
 * A sliding-window counter for intake submissions.
 *
 * 🔴🔴 SCOPE: PER PROCESS. THIS IS NOT A RATE LIMIT ON THE DEPLOYMENT.
 *
 * The counters live in this object's `Map`. They are not shared between
 * transactor replicas and they are gone on restart. With N transactors behind a
 * load balancer the effective ceiling is N × `max`, and an attacker who can
 * cause reconnects can reset the window at will. Anything that describes this
 * as "intake is rate limited" is overstating it — the honest sentence is
 * "each transactor process independently sheds obvious floods".
 *
 * ⚠️ IT ALSO CANNOT SEE AN IP. A pipeline middleware is handed a transaction,
 * not a socket; the key available here is the ACCOUNT, and every visitor to a
 * public intake link shares one guest account. So this limiter is really a cap
 * on the intake link as a whole, which protects the workspace from a flood but
 * lets one abuser consume the budget other submitters needed. Per-IP and
 * per-deployment limiting has to happen where the request still exists — the
 * front tier or the ingress — and is left to the operator; this is the floor,
 * not the ceiling.
 *
 * The same caveat the session already recorded for `ConsumedNonceStore`
 * (`pods/authProviders/src/feishu.ts`) applies verbatim: process-local state is
 * a single-replica control. Unlike that store, however, intake's DUPLICATE
 * detection is NOT process-local — it is the document `_id`, i.e. the database.
 *
 * @public
 */
export class IntakeRateLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor (
    readonly limit: IntakeRateLimit = INTAKE_RATE_LIMIT,
    /** Bound on distinct keys, so a key-churning attacker cannot grow this map without end. */
    readonly maxKeys: number = 4096
  ) {}

  /**
   * Record one submission and say whether it is within budget.
   *
   * ⚠️ The hit is recorded ONLY when it is allowed. Counting refused attempts
   * too would let an attacker keep a legitimate submitter locked out
   * indefinitely by continuing to hammer a key that is already over budget.
   */
  take (key: string, now: number): boolean {
    const window = now - this.limit.windowMs
    const recent = (this.hits.get(key) ?? []).filter((at) => at > window)
    if (recent.length >= this.limit.max) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    // Re-insert so the Map's insertion order tracks recency, which is what the
    // eviction below relies on.
    this.hits.delete(key)
    this.hits.set(key, recent)
    this.evict()
    return true
  }

  private evict (): void {
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next()
      if (oldest.done === true) return
      this.hits.delete(oldest.value)
    }
  }

  get size (): number {
    return this.hits.size
  }

  reset (): void {
    this.hits.clear()
  }
}

/**
 * The rate-limit key for a session.
 *
 * Account plus space, so a workspace with two intake links does not have them
 * share one budget. `sessionId` is deliberately NOT part of it: a client picks
 * its own, so keying on it would let a flooder reset the counter by
 * reconnecting.
 *
 * @public
 */
export function intakeRateKey (account: Account, space: Ref<Space> | undefined): string {
  return `${account.uuid}|${String(space)}`
}
