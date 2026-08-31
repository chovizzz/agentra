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

import type { Class, Doc, Ref } from '@hcengineering/core'

/**
 * The six cross-module trace kinds.
 *
 * `blocks` is deliberately absent: Issue <-> Issue dependencies stay native to
 * Tracker (`Issue.blockedBy` / `Issue.relations`) and never become a TraceLink.
 *
 * @public
 */
export type TraceLinkKind = 'converted-to' | 'implements' | 'verifies' | 'defect-of' | 'fixed-by' | 'delivered-in'

/**
 * @public
 */
export const traceLinkKinds: readonly TraceLinkKind[] = [
  'converted-to',
  'implements',
  'verifies',
  'defect-of',
  'fixed-by',
  'delivered-in'
] as const

/**
 * Lifecycle of a trace edge.
 *
 * `Doc` has no `archived` field, so "keep an archived relation when one end is
 * deleted" is not an existing platform semantic — this field carries it.
 *
 * - `active`   — both ends resolvable, the edge counts towards coverage
 * - `orphaned` — one end was deleted; the edge is retained as an audit fact
 * - `revoked`  — a human explicitly withdrew the assertion
 *
 * @public
 */
export type TraceLinkState = 'active' | 'orphaned' | 'revoked'

/**
 * @public
 */
export const traceLinkStates: readonly TraceLinkState[] = ['active', 'orphaned', 'revoked'] as const

/**
 * A cross-module traceability edge: `source --kind--> target`.
 *
 * ## Storage
 *
 * TraceLink lives in the upstream `DOMAIN_RELATION` domain but extends
 * `core.class.Doc` directly — it is NOT a `core.class.Relation` descendant.
 * That is what keeps the two co-tenants apart: every upstream read of relations
 * goes through `findAll(core.class.Relation, ...)`, and the query layer rewrites
 * that into `_class IN (descendants of core.class.Relation)`, which never
 * includes TraceLink.
 *
 * The source/target refs are persisted under the field names `docA` / `docB`
 * ON PURPOSE. Those two names are the only ones the Postgres `relationSchema`
 * promotes to real indexed columns; anything else lands in the `data` JSONB blob
 * and gets no index. Naming them `source` / `target` would silently throw away
 * the two free btree indexes that are the entire reason for reusing this domain.
 * Read `docA` as "source" and `docB` as "target" everywhere, or use the
 * {@link traceSource} / {@link traceTarget} accessors.
 *
 * ## Semantics
 *
 * An edge records an AUDIT FACT about two CONCRETE VERSIONS, not a "current
 * logical relationship". It always points at the `_id` the endpoints had when it
 * was created; a requirement revision never rewrites existing edges. The
 * redundant `sourceBaseId` / `targetBaseId` exist so queries can normalise back
 * to the logical object at read time. They are NOT part of the unique key.
 *
 * ## 🔴 Auditing
 *
 * `DOMAIN_RELATION` is excluded from both the fulltext index and Activity.
 * Writing a TraceLink therefore produces NO activity record on its own.
 * Any command that creates an edge MUST explicitly write Activity to BOTH
 * endpoints, or the edge will be invisible in the object's history.
 *
 * 🔴 ONE EXCEPTION, decided 2026-08-27: edges INHERITED onto a new revision do
 * NOT write Activity. A single revision inherits many edges at once, and one
 * activity entry per edge would bury the feed under entries no human produced.
 * Inheritance is a mechanical consequence of the revision, and the revision is
 * already recorded; an edge's own `createdOn` plus the version it belongs to is
 * what answers "when did this edge appear". Do not "fix" this by making the
 * inheritance path write Activity — that is the behaviour that was rejected.
 * See the technical spec, §3.2.1.
 *
 * @public
 */
export interface TraceLink extends Doc {
  /** The source endpoint, at the concrete version it had when the edge was made. */
  docA: Ref<Doc>
  sourceClass: Ref<Class<Doc>>

  /** The target endpoint, at the concrete version it had when the edge was made. */
  docB: Ref<Doc>
  targetClass: Ref<Class<Doc>>

  kind: TraceLinkKind

  /** `normId(doc) = doc.baseId ?? doc._id` — also well defined for unversioned objects. */
  sourceBaseId: Ref<Doc>
  targetBaseId: Ref<Doc>

  state: TraceLinkState

  /**
   * Free-form provenance; lands in the `data` JSONB blob.
   *
   * 🔴 NEVER COPY ENDPOINT TITLES, IDENTIFIERS, PEOPLE OR STATUSES IN HERE.
   * `TraceLink` rows sit in `core.space.Workspace`, which every account can
   * read, and no `findAll` middleware filters them by endpoint permission — so
   * this blob is workspace-visible regardless of who may see `docA` / `docB`.
   * Three commands violated this before it was enforced (`leadStatus`,
   * `project`, `requirementStatus`).
   *
   * Enforcement lives in
   * `server-plugins/agentra-core-resources/src/traceLinkMetadata.ts`: a closed
   * key set, a provenance table, and a source scan that makes its builder
   * mandatory. The type stays `Record<string, string>` here so the narrowing
   * does not reach into packages that one does not own.
   */
  metadata?: Record<string, string>

  /**
   * How many times this edge has been WITHDRAWN.
   *
   * Absent means `0` — always read it through {@link traceLinkRevocations},
   * never as a bare property.
   *
   * 🔴 AN IDEMPOTENCY DISCRIMINATOR, NOT A STATISTIC. A trace edge has exactly
   * ONE row per (kind, source, target) forever, so "withdraw it and assert it
   * again" is a state change on a row that already exists. Every command that
   * performs such a change claims an idempotency-ledger row first, and while
   * those rows were keyed on the pair ALONE they were PERMANENT: the second
   * assertion after a withdrawal replayed the first one's stored success
   * without ever entering the body, so the user was told "linked" and the edge
   * stayed `revoked`. This counter is what the ASSERTING commands fold into
   * their keys, so each round of the lifecycle gets a row of its own.
   *
   * ⚠️ IT IS ADVANCED BY THE WITHDRAWING COMMAND, AND READ BY THE ASSERTING
   * ONE — never both by the same command, which is the whole trick. See
   * {@link TraceLink.assertionGeneration}.
   *
   * ⚠️ MONOTONIC, AND ENFORCED AS SUCH. It is absent from
   * `TRACE_LINK_MUTABLE_FIELDS` in `server-plugins/agentra-core-resources`, so
   * no transaction may ASSIGN it a value; the only write the guard admits is
   * `$inc` by exactly `1`. It therefore cannot be rolled back to replay an
   * older round, which is the one attack a plain settable counter would open.
   *
   * ⚠️ NOT A VERSION OF THE ENDPOINTS. Requirement revisions are modelled by
   * new documents and new edges; this counter never crosses from one edge to
   * another.
   */
  revocationGeneration?: number

  /**
   * How many times this edge has been RE-ASSERTED after a withdrawal.
   *
   * Absent means `0` — always read it through {@link traceLinkReassertions}.
   *
   * 🔴 THE SECOND COUNTER EXISTS BECAUSE ONE COUNTER CANNOT WORK, and the
   * reason is worth the ten lines. Suppose a single counter advanced on every
   * transition and both commands keyed on it. The FIRST withdrawal advances it,
   * so a REPEATED "unlink" click — the same intent, the same caller key, one
   * second later — observes a different value, lands on a fresh ledger row and
   * re-enters the body instead of replaying. That is not merely wasteful: it
   * spends the row the NEXT genuine withdrawal would have used, storing
   * "already revoked" in it, and after a re-link that next withdrawal replays
   * the no-op and answers "already revoked" about an edge that is `active`.
   * The bug simply moves one cycle further along.
   *
   * Splitting it fixes both ends at once. Each command keys on the counter the
   * OTHER command advances, so within one round the value a command reads is
   * FROZEN — a repeat click replays exactly as before — while the opposite
   * command's transition is guaranteed to move it before the next round starts.
   *
   * ⚠️ Advanced by the ASSERTING command, read by the WITHDRAWING one. Same
   * monotonicity guarantee as {@link TraceLink.revocationGeneration}.
   */
  assertionGeneration?: number
}

/**
 * How many times an edge has been withdrawn; `0` for a pair that has none.
 *
 * 🔴 `undefined` IS `0`, ON BOTH ARMS, and that is what makes these fields safe
 * to add without a backfill migration. An edge written before they existed — or
 * by a path that does not set them, such as revision inheritance — has been
 * withdrawn zero times by definition. A pair with NO edge at all is also at
 * `0`: the first assertion creates the row, and creation is not a transition.
 *
 * @public
 */
export function traceLinkRevocations (link: Pick<TraceLink, 'revocationGeneration'> | undefined): number {
  return link?.revocationGeneration ?? 0
}

/**
 * How many times an edge has been re-asserted; `0` for a pair that has none.
 *
 * @public
 */
export function traceLinkReassertions (link: Pick<TraceLink, 'assertionGeneration'> | undefined): number {
  return link?.assertionGeneration ?? 0
}

/**
 * The two counter field names, in the order the guard reports them.
 *
 * Exported so the server-side write guard and the ledger keys name the same
 * strings rather than spellings that compile independently of each other.
 *
 * @public
 */
export const TRACE_GENERATION_FIELDS: readonly string[] = ['revocationGeneration', 'assertionGeneration']

/**
 * The persisted field name carrying the source endpoint.
 *
 * @public
 */
export const TRACE_SOURCE_FIELD = 'docA'

/**
 * The persisted field name carrying the target endpoint.
 *
 * @public
 */
export const TRACE_TARGET_FIELD = 'docB'

/**
 * @public
 */
export function traceSource (link: TraceLink): Ref<Doc> {
  return link.docA
}

/**
 * @public
 */
export function traceTarget (link: TraceLink): Ref<Doc> {
  return link.docB
}

/**
 * A document that may carry a version chain. `baseId` is the stable logical
 * identity shared by every version; unversioned documents simply lack it.
 *
 * @public
 */
export interface MaybeVersioned extends Doc {
  baseId?: Ref<Doc>
}

/**
 * Query-time normalisation rule: `normId(doc) = doc.baseId ?? doc._id`.
 * Holds for unversioned objects too, which is why the trace edge can store it
 * unconditionally.
 *
 * @public
 */
export function normId (doc: MaybeVersioned): Ref<Doc> {
  return doc.baseId ?? doc._id
}
