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
  type Doc,
  type DocumentQuery,
  type Ref,
  type Space,
  type Tx,
  type TxCUD,
  type TxUpdateDoc,
  TxProcessor
} from '@hcengineering/core'
import crmLite from '@hcengineering/crm-lite'

/**
 * GUEST SCOPE IN THE CRM SPACE — the read half of anonymous intake.
 *
 * `./intake.ts` answers "what may a stranger WRITE". This file answers the
 * other half, which was left open when intake landed: "what may that same
 * stranger READ, and how do they stop being able to read it".
 *
 * ─── THE LEAK THIS EXISTS TO CLOSE, LINK BY LINK ──────────────────────────
 *
 * Every link below is upstream code this fork does not own, and every one of
 * them is correct on its own. The hole is the composition.
 *
 *  1. `models/card/src/actions.ts:36-51` registers a "get public link" action
 *     with `target: card.class.CardSpace` — i.e. on the SPACE, not on a card.
 *  2. Its text provider `getSpaceAccessPublicLink`
 *     (`plugins/card-resources/src/utils.ts:813-828`) calls
 *     `createAccessLink(AccountRole.Guest, { spaces: [doc._id] })`, so the
 *     minted token carries a grant naming the whole space.
 *  3. `crmLite.space.Crm` IS a `card.class.CardSpace`
 *     (`models/crm-lite/src/migration.ts` `ensureCrmSpace`), so that action
 *     appears on it today, in the ordinary context menu, for any Maintainer.
 *  4. On the link holder's FIRST connection, `OnEmployeeCreate`
 *     (`server-plugins/contact-resources/src/index.ts:161-176`) resolves the
 *     grant through `getGrantSpaces` — which accepts a non-private space with
 *     no further check (`index.ts:97-110`) — and pushes the guest account into
 *     `space.members`.
 *  5. Membership is exactly what gates lead reads.
 *     `SpaceSecurityMiddleware.getAllAllowedSpaces` (`spaceSecurity.ts:527-543`)
 *     sets `ignorePublicSpaces` for every DATA domain, so `private: false`
 *     grants nothing; `this.allowedSpaces[account.uuid]`, built only from
 *     `space.members` (`spaceSecurity.ts:107-122`), grants everything.
 *
 * Net effect before this file existed: an admin who published the intake form
 * with the button already on screen handed every link holder read access to
 * every lead in the pipeline.
 *
 * ⚠️ LINK 4 IS NOT A NO-OP, THOUGH IT READS LIKE ONE. `OnEmployeeCreate` emits
 * those pushes through `control.apply(control.ctx, systemTxes)`, and
 * `TriggersMiddleware`'s own `apply` closure (`triggers.ts:148-153`) returns
 * `{}` without applying anything when `needResult` is falsy. The txes are not
 * dropped: `Triggers.applyTrigger` (`foundations/server/packages/core/src/triggers.ts:99-104`)
 * wraps that closure, collects the batch into a local `apply[]`, and appends it
 * to the trigger's return value (`return result.concat(apply)`). They come back
 * as ordinary derived txes and are applied by `processDerivedTxes` →
 * `this.context.derived.tx`. Stopping at the closure and concluding "the grant
 * is dead code" is a mistake that is very easy to make and was made once while
 * writing this file.
 *
 * ─── WHY THE FIX LIVES HERE AND NOT WHERE THE BUG IS ──────────────────────
 *
 * The clean fix is upstream: do not put a whole-space guest-link action on a
 * space class, or make `getGrantSpaces` refuse spaces whose contents the
 * grantee has no business reading. Neither is ours to change. What IS ours is
 * `LeadGuardMiddleware`, which sits in the pipeline below everything that
 * matters here, and which sees both halves of the leak: the membership write
 * (link 4) and every read that membership would authorise (link 5).
 *
 * 🔴 THAT PLACEMENT IS LOAD BEARING FOR LINK 4. `processDerivedTxes` re-enters
 * the chain at `this.context.derived`, which is `MarkDerivedEntryMiddleware` —
 * position 13 of `createServerPipeline`'s array, ABOVE `LeadGuardMiddleware` at
 * position 22. Derived txes therefore still pass through this guard, even
 * though they have already bypassed `SpaceSecurityMiddleware`,
 * `SpacePermissionsMiddleware` and `GuestPermissionsMiddleware`, which all sit
 * above the re-entry point. A trigger could not have done this job for a second
 * reason as well: triggers run after `provideTx` and are wrapped in a
 * log-only `try/catch`, so they cannot refuse anything (see the class comment
 * on `LeadGuardMiddleware`).
 *
 * ─── THE TWO LAYERS, AND WHY BOTH ─────────────────────────────────────────
 *
 *  - {@link isCrmMembershipGrantTx} (write side) keeps the guest from ever
 *    BECOMING a member. This is the layer that also closes the live broadcast
 *    channel, which no read-side check can reach: `SpaceSecurityMiddleware`
 *    computes broadcast targets from `space.members`
 *    (`spaceSecurity.ts:519`), and the first middleware to register a target
 *    function wins (`broadcast.ts:94-99` breaks on the first defined result),
 *    so a lower middleware cannot override it. Not a member, not a target.
 *  - {@link scopeGuestQuery} (read side) makes the CRM space unreadable to a
 *    below-`User` session whether or not it is a member. It is the layer that
 *    survives being wrong about the write side — an admin adding a guest by
 *    hand, a future upstream path that grants membership some other way, a
 *    workspace that already has such a member from before this code shipped.
 *
 * Neither layer classifies from the payload. Both use {@link isIntakeAccount},
 * the same session-derived predicate intake writes are classified by; see the
 * header of `./intake.ts` for why a flag would be worthless.
 *
 * ─── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────
 *
 *  - It does not touch the `space` domain, so `crmLite.space.Crm`'s own Space
 *    DOCUMENT stays readable to a guest. That is upstream behaviour for any
 *    non-private space and is independent of the grant
 *    (`getAllAllowedSpaces` only sets `ignorePublicSpaces` for DATA domains, so
 *    public spaces ARE returned for the space domain itself). Hiding it would
 *    also risk breaking a guest's connect path for the sake of concealing a
 *    name, a description and a list of opaque account uuids. Stated, not fixed.
 *  - It does not restrict what classes a guest may create. That is
 *    `GuestPermissionsMiddleware`'s remit, and the relevant configuration is
 *    upstream's: `models/card/src/index.ts:1028-1039` seeds a
 *    `ModulePermissionGroup` for `AccountRole.Guest` whose single permission
 *    has `targetClass: card.class.Card`, which every master tag — Lead
 *    included — derives from. ⚠️ `GuestPermissionsMiddleware.loadPermissionsCache`
 *    reads only `role` / `permissions` / `disabledPermissions` / `enabled` from
 *    that document and IGNORES its `spaceClass`, so the allowance is
 *    workspace-wide rather than scoped to `CardSpace`. Narrowing it means
 *    editing `models/card`.
 */

/**
 * The one space anonymous intake is about, as a plain `Ref<Space>`.
 *
 * Declared here as well as in `./intake.ts` rather than imported from it so the
 * read half does not depend on the write half; they are two independent
 * controls that happen to name the same space.
 *
 * @public
 */
export const CRM_SPACE: Ref<Space> = crmLite.space.Crm as unknown as Ref<Space>

/**
 * The query key that carries a document's space, per DOMAIN.
 *
 * 🔴 COPIED FROM `SpaceSecurityMiddleware.getKey` (`spaceSecurity.ts:612-614`)
 * ON PURPOSE, and it must stay in step with it. Filtering on `space` alone
 * would leave the `tx` domain wide open: a `TxCreateDoc` for a lead lives in
 * the transaction domain with `space: core.space.DerivedTx` and the real space
 * on `objectSpace`, so a guest reading raw transactions would get every lead's
 * attributes back through a key this file never looked at.
 *
 * Returns `undefined` for the `space` domain, which this file leaves alone —
 * see the class header.
 *
 * @public
 */
export function guestScopeKey (domain: string): string | undefined {
  if (domain === 'space') return undefined
  return domain === 'tx' ? 'objectSpace' : 'space'
}

/**
 * The outcome of scoping one query.
 *
 * `'deny'` means the query can only ever have matched documents inside the CRM
 * space, so the caller must return an empty result WITHOUT going to the
 * database. `'pass'` means the rewritten query is safe to forward.
 *
 * @public
 */
export type GuestScopeResult<T extends Doc> = { verdict: 'deny' } | { verdict: 'pass', query: DocumentQuery<T> }

const DENY = { verdict: 'deny' } as const

/**
 * Rewrite a query so it can never return a document from the CRM space.
 *
 * 🔴 A QUERY REWRITE, NOT A RESULT FILTER, and the difference is not stylistic.
 * A result filter reads `doc.space` — which is absent whenever the caller
 * passed a `projection` that does not include it, and a filter that silently
 * matches nothing is a filter that silently passes everything. Pushing the
 * constraint into the query makes the database enforce it regardless of
 * projection, limit, sort or lookup.
 *
 * ⚠️ AND IT MUST COMPOSE WITH WHAT THE CALLER ALREADY ASKED FOR, in all four
 * shapes the key can arrive in:
 *
 *  - absent            → add `$nin: [CRM]`
 *  - a bare `Ref`      → deny if it IS the CRM space, otherwise leave alone
 *  - `{ $in: [...] }`  → subtract the CRM space; deny if nothing survives
 *  - any other operator → merge into its `$nin`, preserving what was there
 *
 * The `$in` case must subtract rather than add `$nin` next to it: the adapter
 * emits both predicates (`storage.ts:1356-1361`), so they would be ANDed and
 * the result would be right — but `{ $in: [crm] }` would then become a query
 * that is unsatisfiable rather than one that is recognisably empty, and the
 * database would be asked anyway.
 *
 * @public
 */
export function scopeGuestQuery<T extends Doc> (key: string, query: DocumentQuery<T>): GuestScopeResult<T> {
  const existing = (query as Record<string, any>)[key]

  if (existing === undefined || existing === null) {
    return { verdict: 'pass', query: { ...query, [key]: { $nin: [CRM_SPACE] } } }
  }

  if (typeof existing === 'string') {
    return existing === CRM_SPACE ? DENY : { verdict: 'pass', query }
  }

  // A bare array is not a shape the query language defines for this key (set
  // membership is spelled `$in`), so it is not a shape whose match set this
  // function can reason about. It has to be tested BEFORE the operator branches
  // below: `typeof [] === 'object'`, so the `$nin` merge would otherwise
  // cheerfully hang a key off the array and forward a query that matches
  // everything.
  if (Array.isArray(existing)) return DENY

  if (typeof existing === 'object' && Array.isArray(existing.$in)) {
    const survivors = existing.$in.filter((it: unknown) => it !== CRM_SPACE)
    if (survivors.length === 0) return DENY
    return { verdict: 'pass', query: { ...query, [key]: { ...existing, $in: survivors } } }
  }

  if (typeof existing === 'object') {
    const previous: unknown[] = Array.isArray(existing.$nin) ? existing.$nin : []
    if (previous.includes(CRM_SPACE)) return { verdict: 'pass', query }
    return { verdict: 'pass', query: { ...query, [key]: { ...existing, $nin: [...previous, CRM_SPACE] } } }
  }

  // Some shape neither this function nor the adapter understands. Refusing is
  // the only safe reading of "I do not know what this matches".
  return DENY
}

/**
 * True when `tx` would add somebody to `crmLite.space.Crm`'s member list.
 *
 * ⚠️ IT MATCHES THE SPACE BY `objectId`, NOT BY CLASS. The class of the tx is
 * `card.class.CardSpace`, which `server-plugins/crm-lite` cannot name — it does
 * not depend on `@hcengineering/card`, and adding that dependency to close a
 * membership hole would be a strange trade. Matching the one space id this
 * package already owns is both narrower and sufficient: no other space is this
 * function's business.
 *
 * ⚠️ ALL THREE WRITE SHAPES COUNT. `OnEmployeeCreate` uses `$push`, the space
 * editor UI writes a whole `members` array, and `$pull` is listed only so that
 * the reader can see it was considered — a removal is never refused, because
 * removing a guest from the space is the very thing this file wants.
 *
 * @public
 */
export function isCrmMembershipGrantTx (tx: Tx): boolean {
  if (!TxProcessor.isExtendsCUD(tx._class)) return false
  const cud = tx as TxCUD<Doc>
  if (cud.objectId !== (CRM_SPACE as unknown as Ref<Doc>)) return false
  if (cud._class !== core.class.TxUpdateDoc) return false

  const operations = (cud as TxUpdateDoc<Space>).operations as Record<string, any> | undefined
  if (operations === undefined) return false

  if (operations.members !== undefined) return true
  return operations.$push?.members !== undefined
}
