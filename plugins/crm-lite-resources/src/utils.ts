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

import {
  canTransitionLead,
  leadPriorityOrder,
  leadStatusOrder,
  type Lead,
  type LeadPriority,
  type LeadStatus
} from '@hcengineering/crm-lite'
import type {
  Class,
  Client,
  Doc,
  DomainParams,
  DomainResult,
  OperationDomain,
  Ref,
  Space,
  TxOperations
} from '@hcengineering/core'
import type { IntlString } from '@hcengineering/platform'

import crmLite from './plugin'

/**
 * `SortFunc` implementation for `crmLite.class.TypeLeadStatus`.
 *
 * Grouping resolves the attribute's `attrClass` and then calls the `SortFuncs`
 * mixin registered on that class, so this is what orders the kanban columns.
 * Values not in the canonical order (data written by an older/newer build) are
 * kept and pushed to the end rather than dropped.
 *
 * @public
 */
export async function sortLeadStatuses (_: TxOperations, values: LeadStatus[]): Promise<LeadStatus[]> {
  return [...values].sort((a, b) => rank(leadStatusOrder, a) - rank(leadStatusOrder, b))
}

/**
 * `AllValuesFunc` implementation: what makes an empty status still render as a
 * kanban column when "show empty groups" is on.
 *
 * @public
 */
export async function getAllLeadStatuses (): Promise<LeadStatus[]> {
  return leadStatusOrder
}

/**
 * @public
 */
export async function sortLeadPriorities (_: TxOperations, values: LeadPriority[]): Promise<LeadPriority[]> {
  return [...values].sort((a, b) => rank(leadPriorityOrder, a) - rank(leadPriorityOrder, b))
}

/**
 * @public
 */
export async function getAllLeadPriorities (): Promise<LeadPriority[]> {
  return leadPriorityOrder
}

function rank<T> (order: T[], value: T): number {
  const idx = order.indexOf(value)
  return idx === -1 ? order.length : idx
}

// ───────────────────────────────────────────────────────────────────────────
// Lead → Requirement conversion (the client half of `agentra-command`).
// ───────────────────────────────────────────────────────────────────────────

/**
 * The operation domain the Agentra command middleware answers on.
 *
 * 🔴 Must stay identical to `AGENTRA_COMMAND_DOMAIN` in
 * `server-plugins/agentra-core-resources/src/commandRequest.ts`. It is a plain
 * string on the wire; a typo here does not fail to compile, it falls through
 * `BaseMiddleware.provideDomainRequest` to `{ domain, value: null }`, which
 * {@link parseConvertLeadResult} reports as `unavailable` rather than as a
 * silent success.
 *
 * @public
 */
export const AGENTRA_COMMAND_DOMAIN = 'agentra-command' as OperationDomain

/**
 * @public
 */
export const AGENTRA_OP_CONVERT_LEAD = 'convertLeadToRequirement'

/**
 * Prefix of the derived idempotency key. Part of the persisted contract: the
 * ledger row id is `commandExecutionId(command, idempotencyKey)`, so changing
 * this string re-points every future request away from the executions already
 * recorded and a converted lead would look unconverted to the ledger.
 *
 * @public
 */
export const CONVERT_LEAD_KEY_PREFIX = 'crm-lite:convert-lead:v1'

/**
 * The idempotency key for converting one lead.
 *
 * 🔴 DERIVED FROM THE LEAD, NOT FROM THE CLICK. The obvious implementation —
 * `generateId()` per click, or per opened dialog — makes every repetition a
 * NEW ledger entry, and the outer claim in `CommandRunner` then has nothing to
 * deduplicate: a double click, a re-opened dialog, a page reload mid-flight, a
 * second browser tab and a second user all produce different keys and all run
 * the command body. The ledger would still be correct, it would simply never be
 * consulted.
 *
 * Deriving the key from `lead._id` makes "convert THIS lead" the unit of
 * intent, which is exactly the unit the server enforces anyway: the inner claim
 * is `(CONVERT_LEAD_LOCK, leadId)` and every object the command produces has an
 * `_id` derived from the lead. Two callers therefore converge on one ledger row
 * as well as on one Requirement, so the second caller REPLAYS the first
 * caller's stored result instead of racing it — which is what CRM-T005 ("opens
 * the original requirement rather than creating a second one") asks for.
 *
 * ⚠️ TRADE-OFF, stated explicitly. A per-dialog key would let the same user
 * convert the same lead twice with different `product` / `project` / `owner`
 * and get two ledger rows. That is not a capability worth having: the second
 * run cannot produce a second Requirement anyway (the inner claim forbids it),
 * so the only thing the extra key buys is a second, misleading audit record of
 * an intent that was never carried out. Losing it is the point.
 *
 * ⚠️ The other direction is safe: a key is not a lock. `CommandRunner` treats
 * `failed` as always retryable and `running` as retryable once stale, so a
 * refused or crashed attempt does NOT wedge the lead forever — only a
 * `succeeded` row is replayed, and replaying a success is the desired outcome.
 *
 * @public
 */
export function convertLeadIdempotencyKey (lead: Ref<Doc>): string {
  return `${CONVERT_LEAD_KEY_PREFIX}:${lead}`
}

/**
 * Wire shape of `ConvertLeadToRequirementInput`.
 *
 * 🔴 Structurally copied rather than imported. The real declaration lives in
 * `@hcengineering/server-agentra-core-resources`, a `server-*` bundle that this
 * browser package must not depend on (and adding the dependency would rewrite
 * `pnpm-lock.yaml`). `traceability-resources` copies its four wire types for the
 * same reason. `product` / `project` are `Ref<Doc>` here because the client only
 * ever forwards them.
 *
 * @public
 */
export interface ConvertLeadRequest {
  lead: Ref<Doc>
  idempotencyKey: string
  product?: Ref<Doc>
  project?: Ref<Doc>
  owner?: Ref<Doc>
}

/**
 * The refusal reasons `ConvertLeadError` can carry, plus the middleware's own
 * `malformed-input`. Listed explicitly so that a reason the server adds later
 * lands on the generic label instead of on a wrong specific one.
 *
 * @public
 */
export type ConvertLeadReason =
  | 'lead-not-found'
  | 'illegal-transition'
  | 'invalid-trace-link'
  | 'converted-without-link'
  | 'requirement-id-taken'
  | 'malformed-input'

/**
 * What the UI is allowed to say after one call.
 *
 * The three server reply families map onto four outcomes, and the distinction
 * between them is the CRM-T006 acceptance point — "operation failed" is not an
 * acceptable rendering of any of them:
 *
 * - `converted` / `replayed` — `ok: true`. `replayed` means the result came out
 *   of the ledger (or the lead already carried a `converted-to` edge), so the
 *   only honest offer is "open the requirement that exists", never "converted".
 * - `in-progress` — HTTP 409. A claim is held or was preempted. RETRYABLE: the
 *   result does not exist yet, and will.
 * - `refused` — HTTP 400. NOT retryable by repetition; the user has to change
 *   something first (typically the lead's status).
 * - `unavailable` — no handler, or a reply this build cannot read. Fails closed,
 *   and it is the ONE case where "nothing happened" may be stated: an unrouted
 *   domain request never reached the command at all.
 * - `errored` — the call THREW. `toCommandResult` deliberately rethrows anything
 *   that is not one of the two expected failure families, so a server bug
 *   arrives as an exception rather than as an envelope. It is a distinct
 *   outcome because, unlike `unavailable`, the command body may have run and
 *   partially completed, and the UI must not claim otherwise.
 *
 * @public
 */
export type ConvertLeadOutcome =
  | { kind: 'converted' | 'replayed', executionId: string, requirement: Ref<Doc>, retryable: false }
  | { kind: 'in-progress', code: number, reason: string, message: string, retryable: true }
  | { kind: 'refused', code: number, reason: string, message: string, retryable: false }
  | { kind: 'unavailable', retryable: false }
  | { kind: 'errored', message: string, retryable: false }

const UNAVAILABLE: ConvertLeadOutcome = { kind: 'unavailable', retryable: false }

function isRecord (value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object'
}

/**
 * Narrows an untrusted `DomainResult.value` into a {@link ConvertLeadOutcome}.
 *
 * 🔴 FAIL CLOSED. Every branch demands the fields it is about to render, and
 * anything else becomes `unavailable`. In particular `ok: true` without a
 * `result.requirement` is NOT reported as a success: it would put a
 * "converted, open the requirement" message on screen with nothing to open,
 * i.e. this client claiming an outcome the server never stated. `value: null`
 * — what an unrouted domain request returns when the middleware is not
 * registered — lands here too.
 *
 * @public
 */
export function parseConvertLeadResult (value: unknown): ConvertLeadOutcome {
  if (!isRecord(value)) {
    return UNAVAILABLE
  }
  if (value.ok === true) {
    const result = value.result
    if (typeof value.executionId !== 'string' || !isRecord(result) || typeof result.requirement !== 'string') {
      return UNAVAILABLE
    }
    // Two independent ways for the server to say "this already existed": the
    // ledger replayed a stored result, or the body found a `converted-to` edge
    // already on the lead. Either one means "open it", so both collapse here.
    const replayed = value.replayed === true || result.alreadyConverted === true
    return {
      kind: replayed ? 'replayed' : 'converted',
      executionId: value.executionId,
      requirement: result.requirement as Ref<Doc>,
      retryable: false
    }
  }
  if (value.ok === false) {
    if (typeof value.code !== 'number' || typeof value.reason !== 'string') {
      return UNAVAILABLE
    }
    const message = typeof value.message === 'string' ? value.message : ''
    if (value.code === 409) {
      return { kind: 'in-progress', code: 409, reason: value.reason, message, retryable: true }
    }
    // 400 and anything else well formed. An unrecognised code is deliberately
    // treated as NOT retryable: inviting the user to hammer a status this build
    // does not understand is the worse of the two mistakes.
    return { kind: 'refused', code: value.code, reason: value.reason, message, retryable: false }
  }
  return UNAVAILABLE
}

/**
 * The user facing explanation of a 400.
 *
 * Every known reason is mapped explicitly, so a reason added on the server
 * shows the generic sentence rather than an unrelated specific one.
 *
 * @public
 */
export function convertLeadReasonLabel (reason: string): IntlString {
  const labels: Record<ConvertLeadReason, IntlString> = {
    'lead-not-found': crmLite.string.ReasonLeadNotFound,
    'illegal-transition': crmLite.string.ReasonIllegalTransition,
    'invalid-trace-link': crmLite.string.ReasonInvalidTraceLink,
    'converted-without-link': crmLite.string.ReasonConvertedWithoutLink,
    'requirement-id-taken': crmLite.string.ReasonRequirementIdTaken,
    'malformed-input': crmLite.string.ReasonMalformedInput
  }
  return labels[reason as ConvertLeadReason] ?? crmLite.string.ReasonUnknown
}

/**
 * Invoke the conversion command.
 *
 * 🔴 The inner key is `params`. `AgentraCommandRequestMiddleware.handleCommand`
 * destructures `args.convertLeadToRequirement.params`; naming it `query` — the
 * other plausible spelling — makes the server read `undefined` and there is a
 * server-side test asserting exactly that. It is not a type error on either
 * side, because `DomainParams` is `Record<string, any>`.
 *
 * @public
 */
export async function convertLeadToRequirement (
  client: Client,
  request: ConvertLeadRequest
): Promise<ConvertLeadOutcome> {
  const params: DomainParams = { [AGENTRA_OP_CONVERT_LEAD]: { params: request } }
  try {
    const result: DomainResult<unknown> = await client.domainRequest(AGENTRA_COMMAND_DOMAIN, params)
    return parseConvertLeadResult(result?.value)
  } catch (err: unknown) {
    // 🔴 Not swallowed — turned into a state the popup RENDERS. Only
    // `CommandInProgressError`, `CommandPreemptedError` and `ConvertLeadError`
    // come back as envelopes; `toCommandResult` rethrows everything else on
    // purpose, so without this the exception would escape the click handler and
    // leave the dialog sitting on its opening hint as if nothing had been
    // clicked. The message is kept for the console, not shown as an
    // explanation, because a platform error string is not a user instruction.
    console.error('crm-lite: convertLeadToRequirement threw', err)
    return { kind: 'errored', message: err instanceof Error ? err.message : String(err), retryable: false }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Inline status / priority editing (`view.mixin.AttributeEditor`).
// ───────────────────────────────────────────────────────────────────────────

/**
 * The outcome of one inline status pick, as a value rather than as a side
 * effect, so the state machine is unit testable without a Svelte runtime.
 *
 * `unchanged` is kept apart from `accepted` on purpose: `canTransitionLead`
 * answers `true` for `from === to` (a self transition is trivially legal), but
 * writing the value back would still produce a pointless Tx and an Activity
 * entry claiming the status "changed" to what it already was.
 *
 * @public
 */
export type LeadStatusChange =
  | { kind: 'accepted', status: LeadStatus }
  | { kind: 'unchanged' }
  | { kind: 'rejected', from: LeadStatus, to: LeadStatus }

/**
 * The statuses the inline editor may OFFER for a lead currently in `from`.
 *
 * Returned in `leadStatusOrder`, not in `leadTransitions` order, so the
 * dropdown reads in the same sequence as the kanban columns.
 *
 * ⚠️ This is the first of two gates and it is the cosmetic one. Filtering the
 * list is not enforcement: `DropdownLabelsIntl` can dispatch `selected` for an
 * id that is no longer in `items` (the lead's status can change underneath an
 * open popup), so {@link resolveLeadStatusChange} re-checks on the way in and
 * is the gate that actually refuses.
 *
 * @public
 */
export function leadStatusChoices (from: LeadStatus | undefined): LeadStatus[] {
  // No current status at all — nothing has been asserted yet, so nothing can be
  // violated. Offer the whole vocabulary rather than silently offering nothing.
  if (from === undefined) {
    return [...leadStatusOrder]
  }
  return leadStatusOrder.filter((to) => canTransitionLead(from, to))
}

/**
 * The gate. Given the value on screen and the value picked, say what — if
 * anything — may be written.
 *
 * 🔴 `canTransitionLead` is the single source of truth for legality; this
 * function adds only the `from === to` short circuit. Do not reimplement the
 * transition table here: `plugins/crm-lite/src/types.ts` owns it and the server
 * command checks the same function, so a second copy would drift.
 *
 * @public
 */
export function resolveLeadStatusChange (from: LeadStatus | undefined, to: LeadStatus): LeadStatusChange {
  if (from === to) {
    return { kind: 'unchanged' }
  }
  if (from === undefined) {
    return { kind: 'accepted', status: to }
  }
  return canTransitionLead(from, to) ? { kind: 'accepted', status: to } : { kind: 'rejected', from, to }
}

// ───────────────────────────────────────────────────────────────────────────
// Disqualification (PRD §5.1: any non-Converted status may go to
// `Disqualified`, and it MUST carry a reason).
// ───────────────────────────────────────────────────────────────────────────

/**
 * What one disqualification attempt may do, as a value.
 *
 * ⚠️ THIS IS NOT THE ENFORCEMENT. `LeadGuardMiddleware` in
 * `@hcengineering/server-crm-lite` refuses a reasonless or illegal
 * `Disqualified` write on every path — drag and drop, API, a future view. This
 * function exists so the user is ASKED for the reason before that refusal
 * rather than shown an error afterwards; deleting it would make the product
 * worse, not less safe.
 *
 * @public
 */
export type DisqualifyIntent =
  | { kind: 'ready', reason: string }
  | { kind: 'empty-reason' }
  | { kind: 'illegal', from: LeadStatus }

/**
 * Can a lead in `from` be disqualified at all?
 *
 * Reads the transition table rather than restating it: `Converted` and
 * `Disqualified` are terminal, everything else may leave.
 *
 * @public
 */
export function canDisqualifyLead (from: LeadStatus | undefined): boolean {
  return from === undefined || canTransitionLead(from, 'Disqualified')
}

/**
 * 🔴 The reason is TRIMMED and the trimmed value is what gets written. A
 * required field that accepts `'   '` is not a required field, and the server
 * applies exactly the same rule (`hasDisqualifyReason`), so accepting
 * whitespace here would only buy the user a refusal one round trip later.
 *
 * @public
 */
export function resolveDisqualifyIntent (from: LeadStatus | undefined, reason: string): DisqualifyIntent {
  if (from !== undefined && !canTransitionLead(from, 'Disqualified')) {
    return { kind: 'illegal', from }
  }
  const trimmed = reason.trim()
  if (trimmed.length === 0) {
    return { kind: 'empty-reason' }
  }
  return { kind: 'ready', reason: trimmed }
}

/**
 * The write itself: status and reason in ONE `TxUpdateDoc`.
 *
 * 🔴 One transaction, not two. Writing `status` first and `disqualifyReason`
 * second would be refused by the server guard (the first write has no reason
 * yet), and writing the reason first would leave a lead carrying a rejection
 * note it was never actually rejected with if the second write failed.
 *
 * @public
 */
export async function disqualifyLead (
  client: TxOperations,
  lead: { _id: Ref<Doc>, _class: Ref<Class<Doc>>, space: Ref<Space> },
  reason: string
): Promise<void> {
  await client.updateDoc(lead._class, lead.space, lead._id, {
    status: 'Disqualified',
    disqualifyReason: reason
  } as any)
}

// ───────────────────────────────────────────────────────────────────────────
// Required-field completeness and the `Converted` read-only rule (Task 7).
// ───────────────────────────────────────────────────────────────────────────

/**
 * The one status an ordinary write may never produce.
 *
 * 🔴 MUST STAY IN SYNC WITH `COMMAND_ONLY_STATUS` in
 * `server-plugins/crm-lite/src/leadGuard.ts`. It is restated rather than
 * imported for the same reason `ConvertLeadRequest` above is restated: this is
 * a browser bundle and `@hcengineering/server-crm-lite` is a server package, so
 * importing it would both drag the server runtime into the client and rewrite
 * `pnpm-lock.yaml`.
 *
 * @public
 */
export const COMMAND_ONLY_LEAD_STATUS: LeadStatus = 'Converted'

/**
 * `Converted` is legal in the transition table (`Qualifying -> Converted`) but
 * is NOT writable by hand: `LeadGuardMiddleware.enforceConversionEvidence`
 * demands an idempotency-ledger row that no transaction entering the pipeline
 * can create, so a plain `{ status: 'Converted' }` write is refused with
 * `converted-requires-command`.
 *
 * 🔴 This is why the inline dropdown HANDS OFF instead of writing, exactly as
 * it already does for `Disqualified`. Offering the pick and then writing it
 * would produce the one failure mode this layer exists to prevent — the client
 * letting a gesture through that the server then rejects.
 *
 * ⚠️ The pick is deliberately still OFFERED. `leadStatusChoices` mirrors the
 * state machine and nothing else; removing `Converted` from it would make the
 * only route to conversion the context-menu action, i.e. would hide a legal
 * status rather than route it.
 *
 * @public
 */
export function requiresConversionCommand (to: LeadStatus): boolean {
  return to === COMMAND_ONLY_LEAD_STATUS
}

/**
 * Is a lead in `status` closed to further editing?
 *
 * `Converted` only. `Disqualified` is terminal in the transition table too, but
 * it is NOT read only: the server explicitly permits amending
 * `disqualifyReason` on an already-disqualified lead (`validateUpdate`'s
 * reason-only branch), and `resolveDisqualifyIntent` lets the popup do it.
 * Treating the two terminal statuses alike would take away an edit the server
 * allows.
 *
 * ⚠️ Client side only, and only ever STRICTER than the server: the guard has no
 * opinion about editing a converted lead's priority. That direction is the safe
 * one — a rule the client applies but the server does not merely withholds a
 * gesture, whereas the reverse (client permits, server refuses) is what shows
 * the user an unexplained platform error.
 *
 * @public
 */
export function isLeadReadonly (status: LeadStatus | undefined): boolean {
  return status === COMMAND_ONLY_LEAD_STATUS
}

/**
 * The fields PRD §5.1 / Task 7 call mandatory on a lead.
 *
 * 🔴 NOT MODELLED AS REQUIRED, ON PURPOSE. Every one of them is an OPTIONAL
 * attribute in `models/crm-lite` and `LeadGuardMiddleware` never looks at them,
 * so a lead created by the import tool, by a migration or by any API caller can
 * legitimately be missing all four. Making them a write-time client gate would
 * therefore not "enforce" anything — it would only stop the one caller that
 * happens to go through this UI, while the incomplete leads kept arriving by
 * every other route.
 *
 * What this list drives instead is a CHECKLIST: `LeadFieldsSection` names what
 * is still missing on the detail page. That is the part the server genuinely
 * cannot do, and it is the same division of labour as the status dropdown —
 * ask here, enforce there.
 *
 * @public
 */
export type LeadRequiredField = 'account' | 'contact' | 'owner' | 'nextActionAt'

/**
 * @public
 */
export const leadRequiredFields: LeadRequiredField[] = ['account', 'contact', 'owner', 'nextActionAt']

/**
 * @public
 */
export interface LeadFieldsVerdict {
  complete: boolean
  missing: LeadRequiredField[]
}

/**
 * A field counts as present when it holds a usable value.
 *
 * 🔴 `null` is a value this model really produces: `Lead.nextActionAt` is typed
 * `Timestamp | null`, because clearing a timestamp through the attribute editor
 * writes `null` rather than deleting the key. Checking `=== undefined` alone
 * would report a deliberately cleared date as present.
 *
 * 🔴 Refs are strings, and an empty string is what a dropdown that was opened
 * and dismissed can leave behind. It is not a reference, so it does not count —
 * the same reasoning the server applies to a whitespace-only disqualification
 * reason.
 *
 * `0` is NOT special-cased away: it is a legal `Timestamp` (the epoch), absurd
 * as a next action but not this function's business to reject.
 */
function isFieldPresent (value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

/**
 * Which mandatory fields is this lead still missing?
 *
 * Returns them in {@link leadRequiredFields} order so the checklist reads the
 * same way every time rather than in whatever order the object's keys happen to
 * enumerate.
 *
 * ⚠️ NOT A GATE. See {@link leadRequiredFields} for why refusing writes here
 * would be enforcement theatre. Callers render this; nothing branches a write
 * on it.
 *
 * @public
 */
export function validateLeadFields (lead: Partial<Lead> | undefined): LeadFieldsVerdict {
  if (lead === undefined) {
    return { complete: false, missing: [...leadRequiredFields] }
  }
  const missing = leadRequiredFields.filter((field) => !isFieldPresent((lead as Record<string, unknown>)[field]))
  return { complete: missing.length === 0, missing }
}

/**
 * The label of one required field, so the checklist names fields the same way
 * the properties panel above it does.
 *
 * @public
 */
export function leadRequiredFieldLabel (field: LeadRequiredField): IntlString {
  const labels: Record<LeadRequiredField, IntlString> = {
    account: crmLite.string.Account,
    contact: crmLite.string.Contact,
    owner: crmLite.string.Owner,
    nextActionAt: crmLite.string.NextActionAt
  }
  return labels[field]
}
