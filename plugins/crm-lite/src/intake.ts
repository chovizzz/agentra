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

import type { LeadPriority, LeadStatus } from './types'

/**
 * The lead intake contract (PRD CRM-008).
 *
 * 🔴 WHY THIS LIVES IN THE CONTRACT PACKAGE AND NOT NEXT TO THE MIDDLEWARE.
 * Two callers have to agree on it byte for byte: `LeadIntakeForm.svelte`, which
 * builds the payload, and `LeadGuardMiddleware`, which is the thing that
 * actually decides. If they were separate implementations the form would
 * eventually offer a field the server drops (a dead control) or omit one the
 * server would have kept. `@hcengineering/crm-lite` is already a dependency of
 * both `crm-lite-resources` and `server-crm-lite`, so sharing costs no new
 * edge in the dependency graph.
 *
 * ⚠️ THE CLIENT HALF IS NOT A CONTROL. Everything here runs again inside the
 * middleware on the raw transaction. The form calling these functions is a UX
 * courtesy — it means a legitimate user sees a trimmed title rather than a
 * refusal — and nothing more. An attacker does not run this file at all.
 */

/**
 * The ONLY attributes an anonymous submission may contribute.
 *
 * 🔴 WHITELIST, NOT BLACKLIST, and specifically not a blacklist of the
 * dangerous names. `Lead` gains attributes over time (`models/crm-lite`
 * declares them as free-standing `core.class.Attribute` documents, so a new one
 * is a one-line change nobody thinks of as security-relevant) and a blacklist
 * silently admits every one of them.
 *
 * 🔴 EVERY ENTRY IS A SEPARATE CHANNEL FROM A STRANGER INTO A STAFF SCREEN, so
 * the list is short and each member had to earn its place. What is NOT here,
 * and why: a triage signal the business owns (`status`, `priority`, `owner`,
 * `pipeline`), an audit fact the server must state rather than accept
 * (`source`), a reference into another document's identity space (`account`,
 * `contact` — accepting those lets a stranger staple their submission onto an
 * arbitrary `Organization` / `Person` by guessing a `Ref`), or a field with a
 * state machine behind it (`disqualifyReason`).
 *
 * 🔴 THE THREE `intake*` FIELDS ARE PLAIN STRINGS AND NOTHING ELSE. They exist
 * because a lead with no way to reach the submitter is not a lead (PRD CRM-008
 * follow-up). Each is prefixed `intake` on purpose: the prefix is the standing
 * reminder, at every read site, that the value is SELF-DECLARED BY AN
 * UNAUTHENTICATED STRANGER and has been verified by nobody.
 *
 *   - `intakeName`    — who they say they are. Not a `Ref<Person>`, not linked
 *                       to one, never resolved into one.
 *   - `intakeEmail`   — 🔴 see {@link INTAKE_EMAIL_IS_UNVERIFIED}. A string. Not
 *                       a `contact.class.Channel`, not a social id, not an
 *                       account identifier, and nothing sends mail to it.
 *   - `intakeMessage` — the free-text body, single line, hard capped. NOT
 *                       `content`; see {@link INTAKE_REJECTS_RICH_TEXT}.
 *
 * ⚠️ `content` IS DELIBERATELY ABSENT — see {@link INTAKE_REJECTS_RICH_TEXT}.
 *
 * @public
 */
export const INTAKE_ALLOWED_FIELDS: readonly string[] = ['title', 'intakeName', 'intakeEmail', 'intakeMessage']

/**
 * Why an intake submission carries no rich text at all.
 *
 * `Card.content` is a `MarkupBlobRef`, i.e. a POINTER to a blob in datalake,
 * not inline markup. Two consequences, and both of them say "no":
 *
 *  1. An anonymous submitter has no datalake credential, so they cannot
 *     produce a blob to point at. A `content` they were allowed to set could
 *     therefore only ever be a reference to a blob SOMEBODY ELSE uploaded —
 *     a confused-deputy read primitive, where the attacker names a blob id and
 *     the CRM operator's browser renders whatever is behind it for them.
 *  2. Markup is a tree the collaborator service and the editor both interpret.
 *     Handing an unauthenticated stranger the ability to author one is the
 *     largest injection surface in the product, and V1 has no reason to pay for
 *     it: an intake submission is a lead to triage, not a document to
 *     collaborate on.
 *
 * So intake accepts PLAIN TEXT ONLY, and even that is normalized by
 * {@link sanitizeIntakeText}. `intakeMessage` IS the "message body" this
 * paragraph used to say a later version would need: a dedicated plain-string
 * attribute running through the same sanitizer, with its own hard length cap.
 * `content` stayed shut, which is the whole point — the body arrived without
 * opening the blob pointer.
 *
 * @public
 */
export const INTAKE_REJECTS_RICH_TEXT = true

/**
 * 🔴 WHAT `intakeEmail` IS NOT. The dangerous reading of "we now collect an
 * email address" is that the system henceforth KNOWS HOW TO REACH THIS PERSON,
 * and that reading is wrong on purpose in three separate ways:
 *
 *  1. NOT AN IDENTITY. Huly resolves people through social ids and
 *     `contact.class.Channel` documents (`provider = contact.channelProvider.Email`).
 *     `intakeEmail` is a plain `TypeString()` attribute on the Lead MasterTag;
 *     it is not a Channel, it creates no Channel, and no code path turns one
 *     into the other. Nothing looks a person up by it. If it were a `Ref` or a
 *     Channel, a stranger could type an employee's address and have their
 *     submission bound to that employee's identity — which is exactly the
 *     `account` / `contact` attack the whitelist already refuses.
 *  2. NOT AN OUTBOUND ADDRESS. The two senders in the platform,
 *     `server-plugins/gmail-resources` and `server-plugins/hr-resources`, both
 *     select recipients by querying `contact.class.Channel` — see
 *     `gmail-resources/src/index.ts` (`channel.provider !== contact.channelProvider.Email`
 *     returns early) and `hr-resources/src/index.ts`. A string attribute on a
 *     Card is invisible to both. So filing a lead cannot make the deployment
 *     send mail anywhere, which matters because "unauthenticated stranger picks
 *     the recipient" is an open relay.
 *  3. NOT VALIDATED, AND THAT IS THE SAFER CHOICE. Intake does no format check
 *     and refuses nothing on the basis of one. A strict check would reject
 *     legitimate addresses (unicode local parts, long TLDs, plus-addressing,
 *     quoted forms) AND would answer differently per input — the field-probe
 *     oracle the silent-drop rule exists to deny. The value is sanitized like
 *     any other free text and stored verbatim, labelled unverified in the UI so
 *     the human reading it applies the scepticism the machine cannot.
 *
 * @public
 */
export const INTAKE_EMAIL_IS_UNVERIFIED = true

/**
 * @public
 */
export const INTAKE_TITLE_MAX_LENGTH = 200

/**
 * @public
 */
export const INTAKE_NAME_MAX_LENGTH = 120

/**
 * The RFC 5321 §4.5.3.1.3 maximum for a forward path, which is the largest
 * address any mail system is obliged to accept. Chosen so the cap never
 * truncates a real address — truncation is silent data corruption, and a
 * half-address looks exactly like a whole one to the salesperson reading it.
 *
 * @public
 */
export const INTAKE_EMAIL_MAX_LENGTH = 254

/**
 * 🔴 THE CAP IS THE CONTROL, and it is deliberately not generous. `title` is a
 * one-liner; a message box is where a stranger puts volume. Everything
 * downstream of it is sized for human text — the lead panel, the CSV export a
 * salesperson opens, the log line an operator reads — and none of it fails
 * safely on a megabyte. 2000 characters is a long paragraph and a bad payload.
 *
 * ⚠️ OVER-LENGTH IS TRUNCATED, NOT REFUSED, exactly as for `title`. Refusing
 * would tell the submitter where the boundary is (probe at 1999 and 2001, read
 * two different answers) and would throw away a legitimate over-talker's whole
 * message; the client counter is what stops an honest visitor being surprised.
 *
 * @public
 */
export const INTAKE_MESSAGE_MAX_LENGTH = 2000

/**
 * The per-field length cap, as a map rather than as one shared constant.
 *
 * 🔴 A SINGLE `maxLength` FOR EVERY FIELD IS A BUG WAITING TO HAPPEN IN EITHER
 * DIRECTION: sized for `title` it would silently chop every message at 200
 * characters, and sized for `intakeMessage` it would let a 2000-character
 * "name" into a column rendered as one line. `sanitizeIntakeText` still
 * defaults to {@link INTAKE_TITLE_MAX_LENGTH}, so a caller that forgets to pass
 * a cap gets the SHORTEST one — fail closed, not open.
 *
 * @public
 */
export const INTAKE_FIELD_MAX_LENGTH: Readonly<Record<string, number>> = {
  title: INTAKE_TITLE_MAX_LENGTH,
  intakeName: INTAKE_NAME_MAX_LENGTH,
  intakeEmail: INTAKE_EMAIL_MAX_LENGTH,
  intakeMessage: INTAKE_MESSAGE_MAX_LENGTH
}

/**
 * The cap for one whitelisted field.
 *
 * ⚠️ Unknown names fall back to the SHORTEST cap rather than to "no cap". They
 * cannot occur through {@link INTAKE_ALLOWED_FIELDS}, but a future field added
 * to the whitelist and forgotten here must degrade into "too strict", never
 * into "unbounded".
 *
 * 🔴 `hasOwnProperty`, NOT `map[field] ?? default`. Plain-object indexing walks
 * the prototype chain, so `INTAKE_FIELD_MAX_LENGTH['__proto__']` is
 * `Object.prototype` — a truthy value, which `??` happily returns, and which
 * then arrives at `String.prototype.slice` as a garbage length. Every lookup
 * here is keyed by a name that ultimately came off an attacker's JSON object.
 *
 * @public
 */
export function intakeFieldMaxLength (field: string): number {
  if (!Object.prototype.hasOwnProperty.call(INTAKE_FIELD_MAX_LENGTH, field)) return INTAKE_TITLE_MAX_LENGTH
  return INTAKE_FIELD_MAX_LENGTH[field]
}

/**
 * A submission always lands at the head of the funnel. `New` is the only status
 * whose invariants an anonymous writer can satisfy, and "untriaged" is the whole
 * point of the queue.
 *
 * @public
 */
export const INTAKE_FORCED_STATUS: LeadStatus = 'New'

/**
 * 🔴 NOT `Urgent`, and not submitter-supplied. Priority is how the sales team
 * orders its own day; a stranger who can set it can jump the queue on every
 * lead the team actually cares about, forever, for free.
 *
 * @public
 */
export const INTAKE_FORCED_PRIORITY: LeadPriority = 'NoPriority'

/**
 * WHERE THE INTAKE FORM LIVES, as the two path segments that address it:
 * `[workbench, <workspace>, LEAD_INTAKE_ALIAS, LEAD_INTAKE_SPECIAL]`.
 *
 * 🔴 THEY LIVE IN THE CONTRACT PACKAGE BECAUSE TWO UNRELATED PLACES HAVE TO
 * AGREE ON THEM AND NEITHER CAN SEE THE OTHER. `models/crm-lite` writes them
 * into the hidden workbench application it registers (`defineIntakeApp`);
 * whatever eventually mints the guest link has to reproduce the same location
 * inside `createAccessLink`'s `navigateUrl`, and a link whose `navigateUrl`
 * points at an alias no application answers to does not fail — it silently
 * falls back to the workbench root (`login-resources/src/utils.ts:544`). A
 * typo would therefore ship as "the form just never appears", which is the
 * worst possible failure shape. One definition, imported by both, removes the
 * chance.
 *
 * ⚠️ `alias` is matched verbatim by `Workbench.svelte`'s
 * `findOne(Application, { alias })`, so changing this string orphans every link
 * already handed out.
 *
 * @public
 */
export const LEAD_INTAKE_ALIAS = 'lead-intake'

/**
 * @public
 */
export const LEAD_INTAKE_SPECIAL = 'form'

/**
 * What a form hands to {@link buildIntakeLeadAttributes}.
 *
 * @public
 */
export interface IntakeSubmissionInput {
  title?: unknown
  intakeName?: unknown
  intakeEmail?: unknown
  intakeMessage?: unknown
}

/**
 * The `Card` scaffolding every lead needs in order to be a well formed document
 * at all. `createCard` (`plugins/card-resources/src/utils.ts`) writes the same
 * five keys; a lead missing them renders as a broken card.
 *
 * 🔴 `content: ''` IS THE RICH-TEXT DECISION EXPRESSED AS CODE. It is not "we
 * forgot to offer a message body": it is a fixed EMPTY `MarkupBlobRef`, written
 * unconditionally, so a submitted `content` is not merely absent from the
 * whitelist but actively overwritten on its way through. See
 * {@link INTAKE_REJECTS_RICH_TEXT} for why letting a stranger name the blob a
 * lead points at is a read primitive rather than a feature.
 *
 * ⚠️ A FUNCTION, not a shared constant. A module-level literal would be aliased
 * into every transaction that spread it, and `parentInfo` / `blobs` are
 * mutable — one downstream `push` would reach every lead ever created.
 *
 * @public
 */
export function intakeStructuralDefaults (): Record<string, unknown> {
  return {
    rank: '',
    content: '',
    parentInfo: [],
    blobs: {}
  }
}

/**
 * Characters removed outright before anything else looks at the string.
 *
 * C0/C1 controls and DEL because they are not text; zero-width and bidi
 * override/isolate characters because their entire purpose is to make the
 * rendered string differ from the stored one — the classic trick being a
 * right-to-left override that displays a title as something other than what a
 * later export, log line or approval screen contains.
 */
// Stripping C0/C1 controls is the entire point of this expression; the rule
// exists to catch ACCIDENTAL ones.
// eslint-disable-next-line no-control-regex
const STRIPPED = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/**
 * Leading characters that make a spreadsheet treat a cell as a FORMULA rather
 * than as text: `=` and `@` start one outright, `+`/`-` start one in Excel.
 *
 * 🔴 This is not paranoia about the database, it is about the next hop. The
 * leads list has a CSV export and the operator opening it is exactly the
 * privileged human the attacker wants; `=HYPERLINK(...)` and `=cmd|...` in a
 * lead title are a remote-content fetch and a command execution on that
 * operator's machine, and NOTHING between here and their spreadsheet knows the
 * string came from a stranger.
 *
 * ⚠️ Tab and CR are the other two triggers in the usual list; they are already
 * gone by the time this runs, removed by {@link STRIPPED}.
 */
const FORMULA_LEAD = /^[=+\-@]/

/**
 * Normalize one free-text field from an unauthenticated submitter.
 *
 * Returns `undefined` for anything that is not usable text, so the caller has a
 * single "there is nothing here" case rather than a family of empty strings.
 *
 * ⚠️ THE FORMULA GUARD PREFIXES, IT DOES NOT REJECT. A refusal would tell the
 * submitter which characters the system is afraid of — and would also refuse
 * `-Acme`, a perfectly ordinary company name. Prefixing with an apostrophe is
 * the spreadsheet-native "this is literal text" marker: it costs one visible
 * character and it defuses the cell.
 *
 * 🔴 EVERY WHITELISTED FIELD GOES THROUGH THIS SAME FUNCTION, INCLUDING THE
 * LONG ONE. The formula guard matters MORE for `intakeMessage` than for
 * `title`, not less: it is the field a stranger is invited to fill, it is the
 * one most likely to be pasted straight into a spreadsheet cell, and a
 * `=HYPERLINK(...)` at the head of it is a fetch on the salesperson's machine
 * whether the string is 12 characters or 2000. The cap is the ONLY thing that
 * varies per field, and it is passed in.
 *
 * ⚠️ THE RESULT IS ALWAYS ONE LINE. `\s+ -> ' '` (and the control strip before
 * it, which eats `\n` and `\r` outright) means a multi-paragraph message comes
 * back as a single paragraph. That is a real cost to a long message and it is
 * accepted rather than worked around: keeping line breaks would mean admitting
 * two of the control characters the strip exists to remove, and a bare newline
 * inside a CSV cell is a row boundary to every parser that is not perfectly
 * strict about quoting. Formatting is not worth a second injection surface.
 *
 * @public
 */
export function sanitizeIntakeText (value: unknown, maxLength: number = INTAKE_TITLE_MAX_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined
  // NFC first: a decomposed sequence can otherwise smuggle a combining mark
  // past a length cap and past any later comparison.
  let text = value.normalize('NFC').replace(STRIPPED, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length === 0) return undefined
  if (FORMULA_LEAD.test(text)) {
    text = `'${text}`
  }
  if (text.length > maxLength) {
    text = text.slice(0, maxLength).trimEnd()
  }
  return text.length === 0 ? undefined : text
}

/**
 * Keep the whitelisted keys, DROP everything else.
 *
 * 🔴 DROP, NOT REFUSE. A refusal is an oracle: submit `{ title, owner }`, read
 * the error, learn that `owner` exists and is guarded; submit `{ title, xyzzy }`,
 * read the acceptance, learn that it does not. Repeat and the whole schema —
 * including every mixin a deployment has hung on Lead — falls out of a public
 * form. Dropping answers every probe identically.
 *
 * ⚠️ `Object.entries` is what makes this safe against the shapes that are not
 * plain keys: a dotted path (`title.$where`), a mixin id used as a key
 * (`crm-lite:mixin:X`), a prototype-polluting `__proto__` — none of them are in
 * the whitelist, so all of them are dropped by the same line.
 *
 * @public
 */
export function pickIntakeFields (attributes: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (attributes == null || typeof attributes !== 'object') return result
  for (const field of INTAKE_ALLOWED_FIELDS) {
    // `Object.prototype.hasOwnProperty.call` rather than `field in attributes`:
    // an inherited or prototype-planted `title` is not a submitted one.
    if (Object.prototype.hasOwnProperty.call(attributes, field)) {
      result[field] = (attributes as Record<string, unknown>)[field]
    }
  }
  return result
}

/**
 * The attributes an intake submission is ALLOWED to produce, fully normalized.
 *
 * Returns `undefined` when the submission has no usable title — a lead with no
 * title is a row nobody can triage, and accepting it would turn the intake form
 * into a free row generator.
 *
 * ⚠️ `title` IS THE ONLY MANDATORY FIELD. Name, email and message are each
 * omitted from the result when they sanitize to nothing, rather than written as
 * an empty string: an absent attribute renders as an empty row in the lead
 * panel, whereas `''` is a value a later "did they leave contact details?"
 * query would count as present.
 *
 * @public
 */
export function buildIntakeLeadAttributes (input: IntakeSubmissionInput): Record<string, unknown> | undefined {
  const picked = pickIntakeFields(input)
  const title = sanitizeIntakeText(picked.title, intakeFieldMaxLength('title'))
  if (title === undefined) return undefined
  const optional: Record<string, unknown> = {}
  for (const field of ['intakeName', 'intakeEmail', 'intakeMessage']) {
    const text = sanitizeIntakeText(picked[field], intakeFieldMaxLength(field))
    if (text !== undefined) {
      optional[field] = text
    }
  }
  return {
    ...intakeStructuralDefaults(),
    title,
    ...optional,
    status: INTAKE_FORCED_STATUS,
    priority: INTAKE_FORCED_PRIORITY
  }
}
