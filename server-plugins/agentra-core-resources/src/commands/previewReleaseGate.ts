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

import type { Doc, MeasureContext, Ref, SessionData, TxOperations } from '@hcengineering/core'
import products, { ProductVersionState, type ProductVersion } from '@hcengineering/products'

import { evaluateReleaseGate, type ReleaseGateReader, type ReleaseGateReport } from './releaseGate'
import { RELEASABLE_FROM } from './releaseProductVersion'

/**
 * The READ-ONLY twin of `releaseProductVersion` (PRD §7.5).
 *
 * 🔴 IT DOES NOT WRITE, AND IT DOES NOT GO THROUGH THE COMMAND LEDGER. Two
 * separate reasons, both load bearing:
 *
 * 1. `CommandRunner` exists to make a WRITE happen exactly once. Wrapping a
 *    pure query in it would insert a `CommandExecution` row per preview — the
 *    ledger would fill with rows for something that changed nothing, and those
 *    rows are the audit trail for what a release did.
 * 2. Worse, it would be WRONG. A `succeeded` row REPLAYS its stored result
 *    without re-entering the body, so the second preview of a version would
 *    hand back the gate as it stood the first time. Gate state moves constantly
 *    — a defect is closed, a run turns green, an approval arrives — and the
 *    whole point of a preview is to answer "what does the gate say RIGHT NOW".
 *    A cached answer is the one answer this function must never give.
 *
 * 🔴 THE JUDGEMENT IS {@link evaluateReleaseGate}'s, NEVER A SECOND
 * IMPLEMENTATION. The preview and the release call the SAME function with the
 * same two readers, so the two verdicts cannot drift: a preview that said
 * "ready" over a gate the release then refuses would be worse than no preview
 * at all. Anything that looks like it wants a local `if` over blockers here
 * belongs in `releaseGate.ts` instead, where both callers get it.
 *
 * @public
 */
export const PREVIEW_RELEASE_GATE = 'PreviewReleaseGate'

/**
 * @public
 */
export interface PreviewReleaseGateInput {
  version: Ref<ProductVersion>
  /**
   * The hypothetical approval. Forwarded verbatim, so a preview run WITHOUT one
   * reports the same `approval-missing` blocker the release would.
   */
  approval?: Ref<Doc>
  /** REL-006. Previewing a waiver writes nothing — the audit record is the release's job. */
  waiverReason?: string
  passRateThreshold?: number
  excludeSkipped?: boolean
}

/**
 * @public
 */
export interface PreviewReleaseGateResult extends Record<string, any> {
  version: Ref<ProductVersion>
  /**
   * The gate, redacted for THIS caller by {@link evaluateReleaseGate}'s
   * `viewer` argument — byte for byte what the release path would report.
   */
  gate: ReleaseGateReport
  /** Whether the version's CURRENT state is one a release may start from. */
  releasable: boolean
  /** The version is already `Released`; a release would be a no-op replay. */
  alreadyReleased: boolean
}

/**
 * @public
 */
export class PreviewReleaseGateError extends Error {
  readonly code = 400

  constructor (
    readonly reason: 'version-not-found' | 'waiver-without-reason',
    message: string
  ) {
    super(message)
    this.name = 'PreviewReleaseGateError'
  }
}

/**
 * @public
 */
export interface PreviewReleaseGateContext {
  ctx: MeasureContext<SessionData>
  /**
   * The CALLER's reader. Two roles at once: the read-permission guard below,
   * and `evaluateReleaseGate`'s `viewer` — so nothing the auditor found reaches
   * this caller unless they can read it themselves.
   *
   * Typed `TxOperations` to match the release path exactly; nothing here calls
   * a write method on it.
   */
  client: TxOperations
  /**
   * The UNFILTERED reader that DECIDES. Same argument, same meaning and same
   * risk as on the release path: it is read-only by type, and every blocker it
   * produces is re-read through `client` before it is reported.
   *
   * Defaults to `client`, in which case the verdict is only as complete as this
   * caller's access — narrower than intended, never wider.
   */
  auditor?: ReleaseGateReader
}

/**
 * Evaluate the release gate for one version WITHOUT releasing it.
 *
 * 🔴 THE READ-PERMISSION GUARD IS NOT OPTIONAL, AND IT IS NOT INHERITED FROM
 * THE LEDGER. `releaseProductVersion` asserts the version is readable before it
 * touches the runner, because the ledger would otherwise replay a stored result
 * to anyone who names the version. This function has no ledger — so THAT
 * failure mode does not apply — but the underlying leak does, and more
 * directly: without the guard, naming any version id would answer whether it
 * exists and what is blocking it. `findOne` through the caller's own filtered
 * client is what makes "not readable" and "does not exist" the same answer.
 *
 * @public
 */
export async function previewReleaseGate (
  context: PreviewReleaseGateContext,
  input: PreviewReleaseGateInput
): Promise<PreviewReleaseGateResult> {
  const { client } = context
  const auditor = context.auditor ?? client

  if (input.waiverReason !== undefined && input.waiverReason.trim() === '') {
    // Refused exactly as the release path refuses it, so a preview cannot show
    // a green gate for a request the release would reject outright.
    throw new PreviewReleaseGateError('waiver-without-reason', 'A gate waiver must carry a non-empty reason')
  }

  // 🔴 THE GUARD. Through the CALLER's client, so the space security middleware
  // filters it; an unreadable version is reported as absent.
  const version = await client.findOne<ProductVersion>(products.class.ProductVersion, { _id: input.version })
  if (version === undefined) {
    throw new PreviewReleaseGateError('version-not-found', `Product version '${input.version}' does not exist`)
  }

  // 🔴 THE SAME FUNCTION THE RELEASE CALLS, with the same reader pair and the
  // same options. Recomputed on EVERY call — no memo, no cache, no ledger.
  const gate = await evaluateReleaseGate(auditor, client, version, {
    passRateThreshold: input.passRateThreshold,
    excludeSkipped: input.excludeSkipped,
    approval: input.approval,
    waiverReason: input.waiverReason
  })

  return {
    version: version._id,
    gate,
    releasable: RELEASABLE_FROM.includes(version.state),
    alreadyReleased: version.state === ProductVersionState.Released
  }
}
