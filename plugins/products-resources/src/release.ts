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

import type { Class, Client, Doc, DomainParams, DomainResult, OperationDomain, Ref } from '@hcengineering/core'
import type { IntlString } from '@hcengineering/platform'
import { ProductVersionState, type ProductVersion } from '@hcengineering/products'

import products from './plugin'

// ───────────────────────────────────────────────────────────────────────────
// The client half of `agentra-command`'s `releaseProductVersion` (REL-003/004).
//
// 🔴 THIS FILE IS THE ONLY DOOR. `ProductVersionState.Released` is absent from
// `userSelectableProductVersionStates` and `parentStateOnChildVersion` is
// `Archived`, precisely so that the gate, the approval and the audit record
// cannot be skipped. Nothing in this package may write `Released` directly —
// grep for `ProductVersionState.Released` and the only hits should be the
// READ-side checks below.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The operation domain the Agentra command middleware answers on.
 *
 * 🔴 Must stay identical to `AGENTRA_COMMAND_DOMAIN` in
 * `server-plugins/agentra-core-resources/src/commandRequest.ts`. It is a plain
 * string on the wire; a typo here does not fail to compile, it falls through
 * `BaseMiddleware.provideDomainRequest` to `{ domain, value: null }`, which
 * {@link parseReleaseResult} reports as `unavailable` rather than as a silent
 * success. `crm-lite-resources` mirrors the same constant for the same reason.
 *
 * @public
 */
export const AGENTRA_COMMAND_DOMAIN = 'agentra-command' as OperationDomain

/**
 * 🔴 Mirrors `AGENTRA_OP_RELEASE_PRODUCT_VERSION` on the server. The middleware
 * dispatches on this exact key.
 *
 * @public
 */
export const AGENTRA_OP_RELEASE_PRODUCT_VERSION = 'releaseProductVersion'

/**
 * 🔴 Mirrors `AGENTRA_OP_PREVIEW_RELEASE_GATE` on the server. The READ-ONLY
 * twin: same gate function, same redaction, no ledger row and no writes.
 *
 * ⚠️ A SEPARATE OPERATION rather than a `dryRun` flag on the release request —
 * see the server constant. Nothing here may send this key to the release
 * handler or that key to this one; they are different code paths on purpose.
 *
 * @public
 */
export const AGENTRA_OP_PREVIEW_RELEASE_GATE = 'previewReleaseGate'

/**
 * Prefix of the derived idempotency key.
 *
 * 🔴 A PERSISTED CONTRACT, MIRRORED FROM THE SERVER. The server exports
 * `releaseProductVersionIdempotencyKey` from
 * `server-plugins/agentra-core-resources/src/commands/releaseProductVersion.ts`
 * and this string reproduces it verbatim. It is COPIED rather than imported
 * because this browser package must not depend on a `server-*` bundle —
 * `crm-lite-resources` (`CONVERT_LEAD_KEY_PREFIX`) and `traceability-resources`
 * copy their wire contracts for the same reason.
 *
 * ⚠️ The copy is load bearing, so it is pinned by an assertion on the exact
 * literal in `__tests__/release.test.ts`. A divergence would not fail to
 * compile: the ledger row id is `commandExecutionId(command, idempotencyKey)`,
 * so a different prefix simply points every future request away from the
 * executions already recorded, and a released version would look unreleased to
 * the ledger.
 *
 * The `v1` component is a schema marker, not a version counter.
 *
 * @public
 */
export const RELEASE_KEY_PREFIX = 'products:release-product-version:v1'

/**
 * The idempotency key for releasing one version.
 *
 * 🔴 A PURE FUNCTION OF THE VERSION — never of the click, the dialog, the tab
 * or the clock. The obvious implementation (`generateId()` per click, or per
 * opened popup) makes every repetition a NEW ledger entry, and the outer claim
 * in `CommandRunner` then has nothing to deduplicate: a double click, a
 * reopened popup, an F5 mid-flight, a second browser tab and a second release
 * manager all produce different keys and all enter the command body. The ledger
 * would still be correct — the inner claim is `(RELEASE_PRODUCT_VERSION_LOCK,
 * versionId)` — but it would never be consulted, so the second caller would
 * race the first instead of REPLAYING it.
 *
 * "Release THIS version" is therefore the unit of intent, and it is the same
 * unit the server enforces.
 *
 * ⚠️ A key is not a lock. `CommandRunner` treats `failed` as always retryable
 * and `running` as retryable once stale, so a gate refusal does NOT wedge the
 * version forever: fix the blockers, press the button again, same key, fresh
 * evaluation. Only a `succeeded` row replays, and replaying a success is the
 * desired outcome.
 *
 * @public
 */
export function releaseProductVersionIdempotencyKey (version: Ref<Doc>): string {
  return `${RELEASE_KEY_PREFIX}:${version}`
}

/**
 * Wire shape of `ReleaseProductVersionInput`.
 *
 * Structurally copied from the server declaration; see
 * {@link RELEASE_KEY_PREFIX}. `approval` is `Ref<Doc>` because the client only
 * ever forwards it.
 *
 * @public
 */
export interface ReleaseProductVersionRequest {
  version: Ref<ProductVersion>
  idempotencyKey: string
  /** REL-003: the approval backing this release. Absent is a gate blocker. */
  approval?: Ref<Doc>
  /** REL-006: an administrator waiver. Must carry a reason; it is audited. */
  waiverReason?: string
  passRateThreshold?: number
  excludeSkipped?: boolean
}

/**
 * @public
 */
export type ReleaseBlockerKind =
  | 'requirement-not-ready'
  | 'work-item-open'
  | 'blocking-defect'
  | 'test-run-missing'
  | 'test-run-no-verdicts'
  | 'test-run-below-threshold'
  | 'approval-missing'
  | 'restricted'

/**
 * One reason the version may not ship, as this caller is allowed to see it.
 *
 * ⚠️ A blocker with `kind: 'restricted'` carries NOTHING else — no object, no
 * count, no title, no severity. See {@link ReleaseGateReport.restricted}.
 *
 * @public
 */
export interface ReleaseBlocker {
  kind: ReleaseBlockerKind
  object?: Ref<Doc>
  objectClass?: Ref<Class<Doc>>
  detail?: string
}

/**
 * Wire shape of the server's `ReleaseGateReport`.
 *
 * @public
 */
export interface ReleaseGateReport {
  version: Ref<ProductVersion>
  passed: boolean
  waived: boolean
  blockers: ReleaseBlocker[]
  /**
   * `true` when at least one blocker was WITHHELD.
   *
   * 🔴 THE COUNT IS NOT ON THE WIRE AND MUST NOT BE RECONSTRUCTED. The server
   * collapses every unreadable blocker into ONE contentless entry precisely so
   * that "how many P0 defects are open in a project you cannot read" stays
   * unanswerable. Rendering `blockers.filter(restricted).length` would restore
   * exactly the side channel the server removed — it is always 0 or 1, so it
   * would also be a WRONG number presented confidently. PRD §7.5 allows one
   * line: "未通过：存在受限范围内的阻断项".
   */
  restricted: boolean
  /**
   * Lowest per-run pass rate across the version's runs.
   *
   * 🔴 ABSENT MEANS NO DATA, NOT 0%. The field is omitted entirely — not sent
   * as 0, not sent as 100 — when every result was `Skipped` (which raises its
   * own `test-run-no-verdicts` blocker) and when the report is `restricted`.
   * `report.passRate ?? 0` is the bug this comment exists to prevent: it would
   * put "0%" on the release page for a version nobody has tested yet, and for a
   * version whose runs the caller merely cannot read.
   */
  passRate?: number
  passRateThreshold: number
  notEvaluated: readonly string[]
}

/**
 * The refusal reasons `ReleaseProductVersionError` can carry, plus the
 * middleware's own `malformed-input`.
 *
 * @public
 */
export type ReleaseReason =
  | 'version-not-found'
  | 'illegal-transition'
  | 'gate-failed'
  | 'waiver-without-reason'
  | 'malformed-input'

/**
 * The successful payload, as this caller may see it.
 *
 * @public
 */
export interface ReleaseSuccess {
  version: Ref<ProductVersion>
  gate: ReleaseGateReport
  requirementsReleased: number
  /**
   * `true` when scope remained in `Validating` after the write-back.
   *
   * ⚠️ A ONE-BIT FLAG, DELIBERATELY NOT A COUNT — same reason as
   * {@link ReleaseGateReport.restricted}. Render it as a warning sentence, never
   * as "N requirements were not updated".
   */
  writeBackIncomplete: boolean
  /** The version was ALREADY `Released` when this attempt read it. */
  alreadyReleased: boolean
}

/**
 * What the UI is allowed to say after one call.
 *
 * The distinction between these is the acceptance point; "operation failed" is
 * not an acceptable rendering of any of them:
 *
 * - `released` / `replayed` — `ok: true`. `replayed` means the answer came out
 *   of the ledger, or the version was already `Released`, so the only honest
 *   sentence is "this version is released", never "released just now".
 * - `in-progress` — HTTP 409, a claim is held or was preempted. RETRYABLE.
 * - `refused` — HTTP 400. Not retryable by repetition; something has to change
 *   first (typically a gate blocker).
 * - `unavailable` — no handler, or a reply this build cannot read. Fails
 *   closed, and it is the ONE case where "nothing happened" may be stated.
 * - `errored` — the call THREW. The command body may have run and partly
 *   completed, so the UI must not claim otherwise.
 *
 * @public
 */
export type ReleaseOutcome =
  | { kind: 'released' | 'replayed', executionId: string, result: ReleaseSuccess, retryable: false }
  | { kind: 'in-progress', code: number, reason: string, message: string, retryable: true }
  | { kind: 'refused', code: number, reason: string, message: string, retryable: false }
  | { kind: 'unavailable', retryable: false }
  | { kind: 'errored', message: string, retryable: false }

const UNAVAILABLE: ReleaseOutcome = { kind: 'unavailable', retryable: false }

function isRecord (value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object'
}

/**
 * Narrow an untrusted gate report.
 *
 * 🔴 `passRate` IS ONLY CARRIED WHEN IT IS A REAL NUMBER. The `typeof` test is
 * what keeps "absent" absent: `Number(undefined)` is `NaN` and `value ?? 0` is
 * `0`, and both would be rendered as a pass rate the server never stated.
 *
 * ⚠️ Fails closed to `undefined` rather than to an empty report: a caller that
 * cannot read the gate must show nothing, not a green one.
 *
 * @public
 */
export function parseGateReport (value: unknown): ReleaseGateReport | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  if (typeof value.passed !== 'boolean' || !Array.isArray(value.blockers)) {
    return undefined
  }
  const blockers: ReleaseBlocker[] = []
  for (const raw of value.blockers) {
    if (!isRecord(raw) || typeof raw.kind !== 'string') {
      continue
    }
    blockers.push({
      kind: raw.kind as ReleaseBlockerKind,
      ...(typeof raw.object === 'string' ? { object: raw.object as Ref<Doc> } : {}),
      ...(typeof raw.objectClass === 'string' ? { objectClass: raw.objectClass as Ref<Class<Doc>> } : {}),
      ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {})
    })
  }
  // The flag is authoritative, but a `restricted` ENTRY without the flag is
  // still a restriction — trust either, so a shape change cannot silently drop
  // the notice.
  const restricted = value.restricted === true || blockers.some((it) => it.kind === 'restricted')
  return {
    version: value.version as Ref<ProductVersion>,
    passed: value.passed,
    waived: value.waived === true,
    blockers,
    restricted,
    ...(typeof value.passRate === 'number' && Number.isFinite(value.passRate) ? { passRate: value.passRate } : {}),
    passRateThreshold: typeof value.passRateThreshold === 'number' ? value.passRateThreshold : 100,
    notEvaluated: Array.isArray(value.notEvaluated) ? (value.notEvaluated as string[]) : []
  }
}

/**
 * Narrow an untrusted `DomainResult.value` into a {@link ReleaseOutcome}.
 *
 * 🔴 FAIL CLOSED. Every branch demands the fields it is about to render.
 * `ok: true` without a readable gate report is NOT a success: it would put
 * "released" on screen with no evidence of why that was allowed, which is the
 * one thing REL-003 exists to record.
 *
 * @public
 */
export function parseReleaseResult (value: unknown): ReleaseOutcome {
  if (!isRecord(value)) {
    return UNAVAILABLE
  }
  if (value.ok === true) {
    const result = value.result
    if (typeof value.executionId !== 'string' || !isRecord(result)) {
      return UNAVAILABLE
    }
    const gate = parseGateReport(result.gate)
    if (gate === undefined || typeof result.version !== 'string') {
      return UNAVAILABLE
    }
    // Two independent ways of saying "this already happened": the ledger
    // replayed a stored result, or the body found the version already
    // `Released`. Both mean "do not claim you released it just now".
    const replayed = value.replayed === true || result.alreadyReleased === true
    return {
      kind: replayed ? 'replayed' : 'released',
      executionId: value.executionId,
      result: {
        version: result.version as Ref<ProductVersion>,
        gate,
        requirementsReleased: typeof result.requirementsReleased === 'number' ? result.requirementsReleased : 0,
        writeBackIncomplete: result.writeBackIncomplete === true,
        alreadyReleased: result.alreadyReleased === true
      },
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
    // NOT retryable: inviting the user to hammer a refusal this build does not
    // understand is the worse of the two mistakes.
    return { kind: 'refused', code: value.code, reason: value.reason, message, retryable: false }
  }
  return UNAVAILABLE
}

/**
 * Invoke the release command.
 *
 * 🔴 THE INNER KEY IS `params`. `AgentraCommandRequestMiddleware.handleCommand`
 * destructures `args.releaseProductVersion.params`; spelling it `query` — the
 * other plausible name — makes the server read `undefined`, and it is NOT a
 * type error on either side because `DomainParams` is `Record<string, any>`.
 *
 * @public
 */
export async function releaseProductVersion (
  client: Client,
  request: ReleaseProductVersionRequest
): Promise<ReleaseOutcome> {
  const params: DomainParams = { [AGENTRA_OP_RELEASE_PRODUCT_VERSION]: { params: request } }
  try {
    const result: DomainResult<unknown> = await client.domainRequest(AGENTRA_COMMAND_DOMAIN, params)
    return parseReleaseResult(result?.value)
  } catch (err: unknown) {
    // 🔴 Not swallowed — turned into a state the popup RENDERS. Only the two
    // expected failure families come back as envelopes; `toCommandResult`
    // rethrows everything else on purpose, so without this the exception would
    // escape the click handler and leave the dialog sitting on its opening hint
    // as if the button had not been pressed.
    console.error('products: releaseProductVersion threw', err)
    return { kind: 'errored', message: err instanceof Error ? err.message : String(err), retryable: false }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The read-only gate preview (PRD §7.5).
//
// 🔴 WHY IT EXISTS. Until this call, the gate report was reachable only as a
// side effect of PRESSING RELEASE: a passing gate came back inside the success
// payload, and a failing one came back as a bare error envelope — reason
// `gate-failed`, no report — so the release page could say "the gate did not
// pass" and nothing about WHAT was blocking. §7.5 requires the scope, the
// blocking defects, the approval and the pass rate to be VISIBLE, which means
// visible before the button is pressed and visible when the gate says no.
//
// 🔴 IT IS NOT A SECOND JUDGEMENT. The server answers this from the same
// `evaluateReleaseGate` the release runs, with the same two readers, so a
// preview cannot report a verdict the release then contradicts.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Wire shape of `PreviewReleaseGateInput`.
 *
 * ⚠️ NO `idempotencyKey`, AND THAT IS THE POINT. The key is the ledger's
 * vocabulary and the ledger is what makes a write happen once; a query has
 * neither. Sending one would be harmless on the wire and misleading in the
 * code — it would suggest this call can be replayed, when in fact it must be
 * RE-EVALUATED every single time.
 *
 * @public
 */
export interface PreviewReleaseGateRequest {
  version: Ref<ProductVersion>
  /** The hypothetical approval; absent reports the same `approval-missing` blocker. */
  approval?: Ref<Doc>
  /** REL-006. Previewing a waiver writes no audit record — the release does that. */
  waiverReason?: string
  passRateThreshold?: number
  excludeSkipped?: boolean
}

/**
 * The previewed gate, as this caller may see it.
 *
 * @public
 */
export interface GatePreview {
  version: Ref<ProductVersion>
  gate: ReleaseGateReport
  releasable: boolean
  alreadyReleased: boolean
}

/**
 * What the release page is allowed to say about a preview.
 *
 * ⚠️ NO `in-progress` MEMBER. That state means "a ledger claim is held"; there
 * is no claim here, so a 409 cannot arise and pretending it could would put a
 * retry button in front of a query that never blocks.
 *
 * `refused` is where `version-not-found` lands — which is ALSO the answer for a
 * version this caller may not read. The two are indistinguishable by design.
 *
 * @public
 */
export type GatePreviewOutcome =
  | { kind: 'ready', result: GatePreview }
  | { kind: 'refused', code: number, reason: string, message: string }
  | { kind: 'unavailable' }
  | { kind: 'errored', message: string }

const PREVIEW_UNAVAILABLE: GatePreviewOutcome = { kind: 'unavailable' }

/**
 * Narrow an untrusted preview reply.
 *
 * 🔴 FAILS CLOSED TO `unavailable`, never to an empty green gate. A page that
 * rendered "ready to release" because it could not parse the answer would be
 * making the one claim it has no evidence for.
 *
 * @public
 */
export function parseGatePreviewResult (value: unknown): GatePreviewOutcome {
  if (!isRecord(value)) {
    return PREVIEW_UNAVAILABLE
  }
  if (value.ok === true) {
    const result = value.result
    if (!isRecord(result)) {
      return PREVIEW_UNAVAILABLE
    }
    const gate = parseGateReport(result.gate)
    if (gate === undefined || typeof result.version !== 'string') {
      return PREVIEW_UNAVAILABLE
    }
    return {
      kind: 'ready',
      result: {
        version: result.version as Ref<ProductVersion>,
        gate,
        releasable: result.releasable === true,
        alreadyReleased: result.alreadyReleased === true
      }
    }
  }
  if (value.ok === false) {
    if (typeof value.code !== 'number' || typeof value.reason !== 'string') {
      return PREVIEW_UNAVAILABLE
    }
    return {
      kind: 'refused',
      code: value.code,
      reason: value.reason,
      message: typeof value.message === 'string' ? value.message : ''
    }
  }
  return PREVIEW_UNAVAILABLE
}

/**
 * Ask the server what the gate says, without releasing anything.
 *
 * 🔴 THE INNER KEY IS `params`, same as every other operation —
 * `handleCommand` destructures `args.previewReleaseGate.params`, and spelling
 * it anything else is not a type error on either side because `DomainParams` is
 * `Record<string, any>`; the server simply reads `undefined`.
 *
 * @public
 */
export async function previewReleaseGate (
  client: Client,
  request: PreviewReleaseGateRequest
): Promise<GatePreviewOutcome> {
  const params: DomainParams = { [AGENTRA_OP_PREVIEW_RELEASE_GATE]: { params: request } }
  try {
    const result: DomainResult<unknown> = await client.domainRequest(AGENTRA_COMMAND_DOMAIN, params)
    return parseGatePreviewResult(result?.value)
  } catch (err: unknown) {
    console.error('products: previewReleaseGate threw', err)
    return { kind: 'errored', message: err instanceof Error ? err.message : String(err) }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Presentation of the gate report (PRD §7.5).
// ───────────────────────────────────────────────────────────────────────────

/**
 * How the release page must render the pass rate.
 *
 * 🔴 THREE STATES, NOT A NUMBER WITH A FALLBACK. `passRate` is absent in two
 * genuinely different situations and neither of them is a rate:
 *
 * - `no-verdicts` — nothing produced a pass or fail. Rendering 0% blames the
 *   version for evidence nobody produced; rendering 100% ships a version nobody
 *   tested. The gate raises `test-run-no-verdicts` for exactly this, and the
 *   page must say so in words.
 * - `restricted` — the rate was suppressed because the caller cannot read the
 *   runs it was computed from. A number derived from those runs is the same
 *   cross-space side channel as a blocker count.
 *
 * Returning a discriminated union rather than `number | undefined` is what
 * stops the two collapsing into one "unknown" in the template, and stops
 * `?? 0` being reachable at all.
 *
 * @public
 */
export type PassRateDisplay = { kind: 'known', value: number } | { kind: 'no-verdicts' } | { kind: 'restricted' }

/**
 * @public
 */
export function passRateDisplay (gate: ReleaseGateReport): PassRateDisplay {
  if (gate.passRate !== undefined) {
    return { kind: 'known', value: gate.passRate }
  }
  // Order matters: under restriction the server suppresses the rate even when
  // it computed one, so "restricted" is the accurate explanation and
  // "no verdicts" would be a claim about test data the caller cannot see.
  return gate.restricted ? { kind: 'restricted' } : { kind: 'no-verdicts' }
}

/**
 * The blockers to list, in order, with the contentless marker removed.
 *
 * 🔴 The `restricted` marker is stripped here and re-surfaced as the BOOLEAN
 * {@link ReleaseGateReport.restricted}. Leaving it in the list would make it a
 * countable row — one line today, and a line per withheld blocker the moment
 * anybody "improves" the server to send them individually.
 *
 * @public
 */
export function visibleBlockers (gate: ReleaseGateReport): ReleaseBlocker[] {
  return gate.blockers.filter((it) => it.kind !== 'restricted')
}

/**
 * The label for one blocker kind. Every kind is mapped explicitly, so a kind
 * the server adds later lands on the generic sentence rather than on a wrong
 * specific one.
 *
 * @public
 */
export function blockerLabel (kind: string): IntlString {
  const labels: Record<ReleaseBlockerKind, IntlString> = {
    'requirement-not-ready': products.string.BlockerRequirementNotReady,
    'work-item-open': products.string.BlockerWorkItemOpen,
    'blocking-defect': products.string.BlockerBlockingDefect,
    'test-run-missing': products.string.BlockerTestRunMissing,
    'test-run-no-verdicts': products.string.BlockerTestRunNoVerdicts,
    'test-run-below-threshold': products.string.BlockerTestRunBelowThreshold,
    'approval-missing': products.string.BlockerApprovalMissing,
    restricted: products.string.BlockerRestricted
  }
  return labels[kind as ReleaseBlockerKind] ?? products.string.BlockerUnknown
}

/**
 * The user facing explanation of a refusal.
 *
 * @public
 */
export function releaseReasonLabel (reason: string): IntlString {
  const labels: Record<ReleaseReason, IntlString> = {
    'version-not-found': products.string.ReasonVersionNotFound,
    'illegal-transition': products.string.ReasonIllegalTransition,
    'gate-failed': products.string.ReasonGateFailed,
    'waiver-without-reason': products.string.ReasonWaiverWithoutReason,
    'malformed-input': products.string.ReasonMalformedInput
  }
  return labels[reason as ReleaseReason] ?? products.string.ReasonUnknown
}

/**
 * The states a version may legally be released FROM.
 *
 * 🔴 MIRRORS THE SERVER'S `RELEASABLE_FROM`, and it is a LIST rather than a
 * numeric comparison: the lifecycle order `Planning -> Active ->
 * ReleaseCandidate -> Released -> Archived` has nothing to do with the enum's
 * numbers (`Planning` is 2, `Released` is 1), so `state < Released` would be
 * silently wrong.
 *
 * ⚠️ ADVISORY ONLY. This hides the action; the server re-checks and answers
 * `illegal-transition`. Never treat a client-side pass as authorisation.
 *
 * @public
 */
export const RELEASABLE_FROM: readonly ProductVersionState[] = [
  ProductVersionState.Active,
  ProductVersionState.ReleaseCandidate
]

/**
 * Whether the release action should be offered for this version.
 *
 * @public
 */
export function canReleaseProductVersionState (state: ProductVersionState): boolean {
  return RELEASABLE_FROM.includes(state)
}
