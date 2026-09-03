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

import core, { systemAccountUuid, toFindResult, TxFactory } from '@hcengineering/core'
import type {
  Class,
  Doc,
  DocumentQuery,
  DomainParams,
  DomainResult,
  FindOptions,
  FindResult,
  MeasureContext,
  OperationDomain,
  Ref,
  SessionData,
  Tx,
  TxCreateDoc,
  TxCUD
} from '@hcengineering/core'
import {
  BaseMiddleware,
  type Middleware,
  type MiddlewareCreator,
  type PipelineContext,
  type TxMiddlewareResult
} from '@hcengineering/server-core'
import {
  TRACEABILITY_DOMAIN,
  TRACE_OP_FIND_INCOMING,
  TRACE_OP_FIND_OUTGOING,
  type TraceEndpointResolver,
  type TraceLinkQuery,
  type TraceLinkView,
  type TraceLinksResult
} from '@hcengineering/server-traceability'
import traceability, { type TraceLink } from '@hcengineering/traceability'

import { inheritedEdgeIds, planInheritedEdges, readRevisionCreate, type RevisionCreate } from './inheritance'
import { findIncomingLinks, findOutgoingLinks, summarize, type TraceLinkFinder } from './query'
import {
  adjustTotal,
  edgeEndpoints,
  endpointKey,
  filterLookup,
  lookupClasses,
  stripAddedFields,
  TRACE_ENDPOINT_FIELDS,
  TRACE_TX_FIELDS,
  widenProjection
} from './readFilter'

/**
 * Marks a read this middleware issued itself.
 *
 * A module-private `Symbol` on `SessionData`, so it cannot be named — let alone
 * set — by anything outside this file, and in particular not by a client: the
 * wire carries a `DocumentQuery` and a `FindOptions`, never a `SessionData`.
 */
const TRACE_INTERNAL_READ = Symbol('traceability.internalRead')

/**
 * Server half of the traceability read contract.
 *
 * Shape copied from `CommunicationMiddleware` in `server/server-pipeline`: an
 * overridden `domainRequest` that claims one `OperationDomain` and dispatches on
 * a `{ <op>: { params } }` argument object, forwarding every other domain down
 * the chain untouched.
 *
 * @public
 */
export class TraceabilityMiddleware extends BaseMiddleware implements Middleware {
  private constructor (context: PipelineContext, next?: Middleware) {
    super(context, next)
  }

  static create: MiddlewareCreator = async (_ctx, context, next): Promise<Middleware> => {
    return new TraceabilityMiddleware(context, next)
  }

  /**
   * Carry the inheritable trace edges of a document's PREVIOUS revision onto the
   * revision this batch creates (Technical Spec §3.2.1).
   *
   * ## 🔴 Why a middleware and not a trigger, given this is a DERIVED write
   *
   * A derived write is exactly the shape a trigger is for, and if the only
   * question were "veto or not" a trigger would win. Three concrete facts on
   * this particular write decide the other way:
   *
   * 1. **A trigger runs as the system account with `isTriggerCtx = true`, one
   *    round trip later.** Between the revision landing and the trigger firing,
   *    every reader sees a revision with ZERO inherited edges — which is
   *    indistinguishable from the state §3.2.1 deliberately produces for
   *    `verifies` (coverage zero). A reader cannot tell "inheritance has not run
   *    yet" from "this kind does not inherit", and the second is a designed
   *    signal that drives QA behaviour. Collapsing the two is the whole hazard.
   * 2. **`TriggersMiddleware.processDerived` wraps every trigger in a try/catch
   *    that only logs.** A failed inheritance would leave a permanently
   *    under-linked revision and say so nowhere the caller can see. Here the
   *    throw reaches the client, which is the only thing that makes the pass
   *    retryable at all.
   * 3. This middleware is ALREADY in the pipeline, sitting between
   *    `VersioningMiddleware` (so `baseId` / `version` are stamped by the time a
   *    tx arrives) and `TxMiddleware`. A trigger would need a new broad
   *    `TxCreateDoc` txMatch registration on top.
   *
   * ⚠️ IT IS NOT ATOMIC WITH THE REVISION, and re-sending the revision does not
   * repair it. Huly has no multi-object atomicity, and the edge lives in
   * `DOMAIN_RELATION` while the document does not — no placement in this list
   * buys that. Nor can the caller simply retry: the document insert has no
   * `ON CONFLICT` clause, so a replayed `TxCreateDoc` dies on the primary key
   * before ever reaching this code. Throwing is therefore how the caller LEARNS
   * that the revision landed under-linked; repairing it needs a pass driven from
   * the exported planner (see {@link planInheritedEdges}), not another create.
   *
   * ## Ordering
   *
   * The READ happens before `provideTx` so the predecessor lookup is
   * unambiguous: the successor does not exist yet, and `VersioningMiddleware`
   * has not yet issued its `isLatest: false` demotion (it does that in a second
   * `provideTx` AFTER this one returns), so the predecessor still carries the
   * flag. The WRITE happens after, so a rejected revision never leaves edges
   * pointing at a document that was never created.
   *
   * ⚠️ `TxApplyIf` is deliberately NOT descended into. `ApplyTxMiddleware` sits
   * above this one and has already flattened every apply block, so there is
   * nothing to gain — and descending would mean emitting edges for a create that
   * the apply's `match` may still reject. The `LeadGuardMiddleware` recursion is
   * safe because refusing a tx that never happens costs nothing; writing edges
   * for one does not have that property.
   */
  async tx (ctx: MeasureContext<SessionData>, txes: Tx[]): Promise<TxMiddlewareResult> {
    const inherited = await this.planInheritance(ctx, txes)
    const result = await this.provideTx(ctx, txes)
    if (inherited.length > 0) {
      await this.provideTx(ctx, inherited)
    }
    return result
  }

  private async planInheritance (ctx: MeasureContext<SessionData>, txes: Tx[]): Promise<Tx[]> {
    const out: Tx[] = []
    for (const tx of txes) {
      const revision = readRevisionCreate(tx)
      // 🔴 The versionable check is not redundant with `readRevisionCreate`.
      // `VersioningMiddleware.setVersionData` returns early for an unversioned
      // class and stamps NOTHING, so on such a class `baseId` is whatever the
      // caller put in the attributes — a forgeable field. Only a class carrying
      // `core.mixin.VersionableClass` can have had its `baseId` written by the
      // platform.
      if (revision === undefined || !this.isVersionableClass(revision.objectClass)) continue
      out.push(...(await this.inheritOne(ctx, revision)))
    }
    return out
  }

  private async inheritOne (ctx: MeasureContext<SessionData>, revision: RevisionCreate): Promise<Tx[]> {
    const previous = await this.findPredecessor(ctx, revision)
    if (previous === undefined) return []

    const edges = await this.edgesTouching(ctx, previous)
    if (edges.length === 0) return []

    const ids = inheritedEdgeIds(edges, previous, revision)
    const existing = new Set<Ref<TraceLink>>(
      ids.length === 0
        ? []
        : (await this.provideFindAll<TraceLink>(ctx, traceability.class.TraceLink, { _id: { $in: ids } } as any)).map(
            (link) => link._id
          )
    )

    // A derived tx: authored by the system and flagged so the platform does not
    // mistake it for a user edit of the edge domain.
    const factory = new TxFactory(core.account.System, true)
    return planInheritedEdges(edges, previous, revision, existing).map((edge) =>
      factory.createTxCreateDoc<TraceLink>(traceability.class.TraceLink, edge.space, edge.attributes, edge._id)
    )
  }

  /**
   * The revision this create supersedes.
   *
   * 🔴 THE ORDER OF THE THREE RULES IS THE WHOLE FUNCTION.
   *
   * 1. **Drop the successor itself.** If this pass ever runs against a chain that
   *    already contains the new revision, that revision still carries
   *    `isLatest: true` (promoting the new one and demoting the old one is the
   *    same moment), so without this filter the pass would pick the successor as
   *    its own predecessor and inherit from itself.
   * 2. **Keep only versions BELOW this one.** `VersioningMiddleware` has already
   *    stamped `version` by the time a tx reaches here, so "which revision did
   *    this one branch from" is answerable arithmetically. Without it, a pass
   *    over a chain that has since grown to V3 would pick V3 — a LATER revision
   *    — as the predecessor of V2 and copy the wrong generation's edges forward.
   *    `isLatest` alone cannot express this: it names the head of the chain, not
   *    the parent of a given member.
   * 3. **Highest version wins, `isLatest` breaks a tie, `_id` breaks that.** A
   *    chain caught mid-write can carry `isLatest` on two members or on none;
   *    picking `chain.find(isLatest)` would then depend on the row order the
   *    adapter happened to return.
   *
   * The version filter is skipped when `version` is absent, which is what a
   * fixture or an older migration leaves behind; the remaining two rules still
   * give a deterministic answer.
   */
  private async findPredecessor (
    ctx: MeasureContext<SessionData>,
    revision: RevisionCreate
  ): Promise<Ref<Doc> | undefined> {
    const chain = (
      await this.provideFindAll<Doc>(ctx, revision.objectClass, { baseId: revision.baseId } as any)
    ).filter((doc) => doc._id !== revision.objectId)
    if (chain.length === 0) return undefined

    const version = (doc: Doc): number => (doc as { version?: number }).version ?? 0
    const isLatest = (doc: Doc): boolean => (doc as { isLatest?: boolean }).isLatest === true

    const below =
      revision.version !== undefined ? chain.filter((doc) => version(doc) < (revision.version as number)) : []
    const pool = below.length > 0 ? below : chain

    const best = pool.reduce((a, b) => {
      if (version(b) !== version(a)) return version(b) > version(a) ? b : a
      if (isLatest(b) !== isLatest(a)) return isLatest(b) ? b : a
      return b._id < a._id ? b : a
    })
    return best._id
  }

  /**
   * Every edge with the predecessor at either end.
   *
   * 🔴 `provideFindAll`, NOT `context.head`. This is the exact inverse of the
   * rule the read handler below follows, and both are deliberate. A READ must
   * run as the caller so it cannot leak endpoints. This is not a read the caller
   * ever sees: it is the input to a system-derived write, and running it as the
   * caller would make inheritance DEPEND ON PERMISSIONS — a revision published
   * by someone who cannot see a linked test case would silently drop that edge
   * and quietly falsify the audit trail. Nothing gathered here is returned to
   * anyone; only ids are re-pointed.
   *
   * Two queries rather than an `$or`: `docA` and `docB` are the only two fields
   * the Postgres relation schema promotes to indexed columns, and an `$or`
   * across them does not use either index.
   */
  private async edgesTouching (ctx: MeasureContext<SessionData>, previous: Ref<Doc>): Promise<TraceLink[]> {
    const [incoming, outgoing] = await Promise.all([
      this.provideFindAll<TraceLink>(ctx, traceability.class.TraceLink, { docB: previous } as any),
      this.provideFindAll<TraceLink>(ctx, traceability.class.TraceLink, { docA: previous } as any)
    ])
    const byId = new Map<Ref<TraceLink>, TraceLink>()
    for (const link of [...incoming, ...outgoing]) {
      byId.set(link._id, link)
    }
    return [...byId.values()]
  }

  /**
   * ⚠️ `hasClass` FIRST. `classHierarchyMixin` on a classifier the hierarchy
   * does not know throws or walks an empty chain depending on the build; asking
   * first makes a stale or forged `objectClass` a clean `false`.
   */
  private isVersionableClass (_class: Ref<Class<Doc>>): boolean {
    const hierarchy = this.context.hierarchy
    if (_class === undefined || !hierarchy?.hasClass?.(_class)) return false
    try {
      return hierarchy.classHierarchyMixin(_class, core.mixin.VersionableClass) !== undefined
    } catch {
      return false
    }
  }

  /**
   * Per-endpoint filtering for the ORDINARY query path.
   *
   * ## 🔴 Why this exists at all
   *
   * `TraceLink` lives in `core.space.Workspace`, and `SpaceSecurityMiddleware`
   * puts that space in `mainSpaces`, which is added to EVERY account's readable
   * set unconditionally — no membership check, no role check. Space security is
   * therefore a no-op on the edge itself, and the per-endpoint filter in
   * `query.ts` only runs on the `domainRequest` path. Nothing obliges a client to
   * use that path: a plain
   * `client.findAll(traceability.class.TraceLink, {})` walked straight past it
   * and returned every trace edge in the workspace, including edges between
   * objects in projects the caller cannot open. This override closes that door,
   * and `findOne` with it — `Middleware` has no `findOne`, and `Client.findOne`
   * is `findAll(..., { limit: 1 })`, so there is exactly one door to close.
   *
   * ## 🔴 Filtering is not enough on its own: this is a query REWRITE
   *
   * The decision needs `docA` / `docB` / `sourceClass` / `targetClass`, all four
   * of which are ordinary attributes a caller can delete from the response with
   * `projection`. A filter that only inspects the rows it is handed would then
   * find nothing to match and — written the natural way — let everything
   * through, making `projection: { _id: 1 }` a one-line bypass. So the
   * projection is WIDENED on the way down ({@link widenProjection}) and the
   * added fields are removed again on the way out ({@link stripAddedFields}), and
   * a row that still cannot be judged is dropped rather than passed.
   *
   * ## Cost
   *
   * `findAll` is the hottest method in the pipeline, so the class test comes
   * first and nothing else runs for a query that cannot produce an edge — the
   * shape `CommandMiddleware`'s audit-record filter uses. Endpoint visibility is
   * then resolved in ONE read per endpoint class over the whole page, never per
   * edge.
   */
  override async findAll<T extends Doc>(
    ctx: MeasureContext<SessionData>,
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Promise<FindResult<T>> {
    // 🔴 CHEAP GATE FIRST. Three hierarchy lookups decide the overwhelming
    // majority of calls, and nothing that cannot possibly carry an edge pays for
    // a projection copy or a property read.
    const viaClass = this.mayReturnTraceLink(_class)
    const viaTx = this.mayReturnTx(_class)
    const viaLookup = lookupClasses(options?.lookup).some((cls) => this.mayReturnTraceLink(cls))
    if ((!viaClass && !viaTx && !viaLookup) || this.isPrivilegedRead(ctx)) {
      return await this.provideFindAll(ctx, _class, query, options)
    }

    // A `$lookup` payload is not projected, so only the two paths that put rows
    // at the top level need the projection widened.
    const widened = widenProjection(options, [
      ...(viaClass ? TRACE_ENDPOINT_FIELDS : []),
      ...(viaTx ? TRACE_TX_FIELDS : [])
    ])
    const result = await this.provideFindAll(ctx, _class, query, widened.options)

    const isEdge = (doc: Doc): boolean => doc?._class !== undefined && this.isTraceLink(doc._class)
    const isEdgeTx = (doc: Doc): boolean =>
      this.isDerivedSafe(doc?._class, core.class.TxCUD) && this.isTraceLink((doc as unknown as TxCUD<Doc>).objectClass)

    // One pass over the page; `edges` collects whatever has to be judged and
    // `endpointsOf` remembers where each row's endpoints came from.
    const judged = new Map<Doc, Array<{ _class: Ref<Class<Doc>>, _id: Ref<Doc> }> | undefined>()
    const note = (doc: Doc, ends: Array<{ _class: Ref<Class<Doc>>, _id: Ref<Doc> }> | undefined): void => {
      judged.set(doc, ends)
    }
    for (const doc of result) {
      if (viaClass && isEdge(doc)) note(doc, edgeEndpoints(doc as unknown as TraceLink))
      else if (viaTx && isEdgeTx(doc)) note(doc, this.txEdgeEndpoints(doc))
      if (viaLookup) {
        for (const nested of lookupEdges(doc, isEdge)) {
          note(nested, edgeEndpoints(nested as unknown as TraceLink))
        }
      }
    }
    if (judged.size === 0) {
      // Nothing to judge and nothing was added to the projection: hand back the
      // adapter's own result object rather than rebuilding one.
      if (widened.added.length === 0) return result
      return finish(result, stripAddedFields([...result], widened.added))
    }

    const visible = await this.resolveVisible(ctx, [...judged.values()])
    const keep = (doc: Doc): boolean => {
      const ends = judged.get(doc)
      // Not a row this pass judged (an ordinary document in a `core.class.Doc`
      // query) — untouched. A judged row with no endpoints fails closed.
      if (!judged.has(doc)) return true
      if (ends === undefined) return false
      return ends.every((end) => visible.has(endpointKey(end._class, end._id)))
    }

    // 🔴 DROP FIRST, REWRITE SECOND. `judged` is keyed by document IDENTITY, and
    // `filterLookup` returns a COPY whenever it changes anything — so a row that
    // went through it first would no longer be found in `judged` and would be
    // waved through. That is not hypothetical: a `TraceLink` row can itself carry
    // a `$lookup` payload. Filtering while every key is still the object the
    // decision was recorded against removes the trap entirely.
    let docs: T[] = [...result].filter((doc) => keep(doc))
    if (viaLookup) {
      // The nested edges are passed to `keep` unchanged, so their identity — and
      // therefore their verdict — survives this pass.
      docs = docs.map((doc) => filterLookup(doc, isEdge, keep))
    }
    return finish(result, stripAddedFields(docs, widened.added))
  }

  /**
   * The endpoints a transaction reveals, or `undefined` for one that must be
   * dropped without further thought.
   *
   * A `TxCreateDoc` carries the whole edge in `attributes`, so it is judged
   * exactly like the edge itself. Anything else — an update, a remove, a mixin —
   * carries no endpoint at all, and there is nothing to judge it against: its
   * `objectId` is `sha256(kind ‖ source ‖ target)` truncated, which reveals no
   * endpoint by itself but DOES answer "does this exact triple have an edge?"
   * for anyone willing to compute the hash. That oracle is precisely what the
   * row filter above closes, so the transaction that would reopen it is dropped
   * rather than passed.
   */
  private txEdgeEndpoints (doc: Doc): Array<{ _class: Ref<Class<Doc>>, _id: Ref<Doc> }> | undefined {
    if (!this.isDerivedSafe(doc._class, core.class.TxCreateDoc)) return undefined
    return edgeEndpoints((doc as unknown as TxCreateDoc<TraceLink>).attributes)
  }

  /**
   * Could a query for `_class` return a `TraceLink`?
   *
   * ⚠️ `isDerived(TraceLink, _class)` and NOT the other way round, the same way
   * `CommandMiddleware.mayCarryAuditRecord` does it. A caller reading edges by
   * their own class is the easy case; the ones that matter are the queries on
   * `core.class.Doc` and on `core.class.Relation` — `TraceLink` shares
   * `DOMAIN_RELATION` with upstream relations — and asking whether the QUERY
   * class derives from `TraceLink` would answer "no" for both, so the filter
   * would never fire on exactly the paths that need it.
   */
  private mayReturnTraceLink (_class: Ref<Class<Doc>>): boolean {
    return this.mayIntersect(traceability.class.TraceLink, _class)
  }

  /** Could a query for `_class` return a document-changing transaction? */
  private mayReturnTx (_class: Ref<Class<Doc>>): boolean {
    return this.mayIntersect(core.class.TxCUD, _class)
  }

  /**
   * Can a query for `_class` and the class `target` name the same document?
   *
   * 🔴 BOTH DIRECTIONS, and neither is optional. `isDerived(target, _class)`
   * catches the queries from ABOVE — `core.class.Doc`, `core.class.Relation`,
   * `core.class.Tx` — which is the direction `CommandMiddleware`'s audit filter
   * needs and the one it is easy to stop at. It answers "no" for a query from
   * BELOW: `isDerived(core.class.TxCUD, core.class.TxCreateDoc)` is false,
   * because `TxCUD` is the parent, so a gate built on that half alone would let
   * `findAll(core.class.TxCreateDoc, {})` walk straight past — and that query
   * returns exactly the transactions that carry a whole trace edge in their
   * `attributes`. Asking both ways costs one extra hierarchy lookup on a path
   * that has already decided it is worth looking.
   */
  private mayIntersect (target: Ref<Class<Doc>>, _class: Ref<Class<Doc>>): boolean {
    return this.isDerivedSafe(target, _class) || this.isDerivedSafe(_class, target)
  }

  /** Is this returned document an edge? The concrete-class direction. */
  private isTraceLink (_class: Ref<Class<Doc>>): boolean {
    return this.isDerivedSafe(_class, traceability.class.TraceLink)
  }

  private isDerivedSafe (a: Ref<Class<Doc>>, b: Ref<Class<Doc>>): boolean {
    const hierarchy = this.context.hierarchy
    if (hierarchy === undefined || a === undefined || b === undefined) return false
    try {
      return hierarchy.isDerived(a, b)
    } catch {
      // A class this hierarchy does not know is not a trace link.
      return false
    }
  }

  /**
   * Reads that must NOT be filtered.
   *
   * 🔴 THIS IS WHERE "SESSION READ" AND "SYSTEM READ" ARE TOLD APART, and
   * getting it wrong breaks the server rather than the security boundary:
   * `handleCommand`, the inheritance pass in {@link tx} and every trigger have
   * to see ALL edges, or inheritance starts depending on the publisher's
   * permissions and quietly falsifies the audit trail (see `edgesTouching`).
   *
   * Four cases, none of which a client can manufacture:
   *
   * 1. **No `contextData`.** Not a session at all — migration, tooling, tests.
   * 2. **Our own marker.** {@link asCaller} stamps a module-private `Symbol` on a
   *    context that shadows the caller's, so the reads this middleware issues
   *    through `context.head` re-enter the chain WITHOUT being filtered a second
   *    time. That is not a loophole: those reads are already the filter, and
   *    without the marker the `domainRequest` path would be pre-filtered and
   *    `summarize`'s `restricted` count — a deliberate signal — would be
   *    permanently zero. It doubles as the recursion stop.
   * 3. **`isTriggerCtx`.** `TriggersMiddleware.processDerived` sets it; the
   *    Postgres adapter already skips the space ACL for such a context, so
   *    filtering here would be inconsistent, not stricter.
   * 4. **The system account.** The same test `isSystem` in
   *    `foundations/server/packages/middleware/src/utils.ts` performs, inlined
   *    rather than imported so this package does not grow a dependency on
   *    `server-middleware`.
   *
   * ⚠️ `admin` is deliberately NOT on that list. An admin's endpoint reads go
   * through the head like everyone else's, so whatever `SpaceSecurityMiddleware`
   * grants an admin is what the filter grants them — adding a bypass here could
   * only make the two disagree.
   */
  private isPrivilegedRead (ctx: MeasureContext<SessionData>): boolean {
    const data = ctx?.contextData
    if (data === undefined || data === null) return true
    if ((data as any)[TRACE_INTERNAL_READ] === true) return true
    if (data.isTriggerCtx === true) return true
    return data.account?.uuid === systemAccountUuid
  }

  /**
   * Resolve every endpoint of a page of edges in one batch and return the
   * per-edge verdict.
   *
   * 🔴 The reads go through `context.head`, for the reason spelled out on
   * {@link head}: it re-enters the chain from the top, so `FindSecurityMiddleware`,
   * `PrivateMiddleware`, `SpaceSecurityMiddleware`, `SpacePermissionsMiddleware`
   * and `GuestPermissionsMiddleware` all run against `ctx.contextData.account` —
   * the CALLING session. `provideFindAll` would go the other way, descending
   * below this middleware and therefore below space security, which would make
   * the filter grade its own homework: a privileged read used to decide what an
   * unprivileged caller may see would find everything visible.
   *
   * ⚠️ `TriggerControl.findAll` is not an option either, for the same reason it
   * is banned on the `domainRequest` path: it stamps `isTriggerCtx = true` and
   * runs as the system account.
   *
   * No projection is passed. `SpaceSecurityMiddleware` mostly REWRITES the query
   * rather than filtering rows, so a projection would usually be harmless — but
   * its >85%-of-spaces branch post-filters on `(doc as any).space`, and a
   * projection that dropped `space` would make it discard everything. Whole
   * documents are what the `domainRequest` resolver already fetches; matching it
   * keeps one behaviour to reason about.
   */
  private async resolveVisible (
    ctx: MeasureContext<SessionData>,
    batches: Array<Array<{ _class: Ref<Class<Doc>>, _id: Ref<Doc> }> | undefined>
  ): Promise<Set<string>> {
    const wanted = new Map<Ref<Class<Doc>>, Set<Ref<Doc>>>()
    for (const ends of batches) {
      if (ends === undefined) continue
      for (const end of ends) {
        const set = wanted.get(end._class) ?? new Set<Ref<Doc>>()
        set.add(end._id)
        wanted.set(end._class, set)
      }
    }

    const internal = this.asCaller(ctx)
    const visible = new Set<string>()
    for (const [_class, ids] of wanted) {
      // ⚠️ Belt on top of the internal-read marker: an endpoint class that could
      // itself yield trace links (`core.class.Doc`, `core.class.Relation`) is not
      // resolved at all, so no arrangement of edges can drive this into itself
      // even if the marker were ever lost. Such an endpoint is reported NOT
      // visible, which is the fail-closed direction; a real endpoint class
      // (Requirement, TestCase, Issue) is never one of them.
      if (this.mayReturnTraceLink(_class)) continue
      // ⚠️ And a classifier the hierarchy does not know is not asked for either:
      // `head.findAll` would throw on it, turning a row that should have been
      // dropped into a failed request for everything else on the page.
      const hierarchy = this.context.hierarchy
      if (hierarchy?.hasClass !== undefined && !hierarchy.hasClass(_class)) continue
      const docs = await this.head().findAll<Doc>(internal, _class, { _id: { $in: [...ids] } })
      for (const doc of docs) {
        // Same two assertions the `domainRequest` resolver makes: the document
        // was actually asked for, and it really is of the class the edge claims.
        if (ids.has(doc._id) && this.isDerivedSafe(doc._class, _class)) {
          visible.add(endpointKey(_class, doc._id))
        }
      }
    }
    return visible
  }

  override async domainRequest (
    ctx: MeasureContext,
    domain: OperationDomain,
    params: DomainParams
  ): Promise<DomainResult> {
    if (domain !== TRACEABILITY_DOMAIN) {
      return await this.provideDomainRequest(ctx, domain, params)
    }
    return {
      domain,
      value: await this.handleCommand(ctx as MeasureContext<SessionData>, params)
    }
  }

  /**
   * Returns `null` — not `{ links: [], coverage }` — for an operation this
   * handler does not know. `parseTraceLinksResult` on the client reads that as
   * "no handler", which is the truth; an empty result set would be a confident
   * claim that the object has no trace links.
   */
  async handleCommand (ctx: MeasureContext<SessionData>, args: DomainParams): Promise<TraceLinksResult | null> {
    if (args[TRACE_OP_FIND_OUTGOING] !== undefined) {
      const { params } = args[TRACE_OP_FIND_OUTGOING]
      return await this.answer(ctx, params as TraceLinkQuery, findOutgoingLinks)
    }
    if (args[TRACE_OP_FIND_INCOMING] !== undefined) {
      const { params } = args[TRACE_OP_FIND_INCOMING]
      return await this.answer(ctx, params as TraceLinkQuery, findIncomingLinks)
    }
    return null
  }

  private async answer (
    ctx: MeasureContext<SessionData>,
    query: TraceLinkQuery,
    find: (f: TraceLinkFinder, r: TraceEndpointResolver, q: TraceLinkQuery) => Promise<TraceLinkView[]>
  ): Promise<TraceLinksResult> {
    if (query == null || typeof query !== 'object' || query.doc === undefined) {
      throw new Error('traceability: malformed query, `doc` is required')
    }
    const links = await find(this.finder(ctx), this.resolver(ctx), query)
    // 🔴 Coverage is computed here, on the ALREADY FILTERED view. Computing it
    // before the filter would publish the count of edges whose endpoints the
    // caller may not read.
    return { links, coverage: summarize(links) }
  }

  /**
   * The pipeline HEAD, i.e. the same entry point a client request enters
   * through.
   *
   * 🔴 THIS IS THE SECURITY GROUND. `BaseMiddleware.provideFindAll` delegates to
   * `this.next`, so it descends BELOW this middleware and therefore below
   * `SpaceSecurityMiddleware` — a global, unfiltered read (see the comment on
   * `CommandMiddleware.findExecution`, which relies on exactly that property).
   * `context.head` goes the other way: `PipelineImpl.create` assigns
   * `context.head = pipeline.head`, so calling it re-enters the FULL chain,
   * including `FindSecurityMiddleware`, `PrivateMiddleware`,
   * `SpaceSecurityMiddleware`, `SpacePermissionsMiddleware` and
   * `GuestPermissionsMiddleware`. `TriggersMiddleware` uses the same
   * `this.context.head?.domainRequest(...)` handle, so this is an established
   * pattern rather than a new one.
   *
   * The IDENTITY every one of those middlewares filters on is
   * `ctx.contextData.account` (`isSystem(account, ctx)` is
   * `account.uuid === systemAccountUuid`), and the `ctx` handed to
   * `domainRequest` is the CALLING session's, put there by
   * `ClientSession.includeSessionContext`. So the read runs as the caller.
   *
   * ⚠️ NEVER substitute `TriggerControl.findAll` here. It stamps
   * `_ctx.contextData.isTriggerCtx = true` (`triggers.ts#processDerived`) and
   * runs as the system account, which turns the entire per-endpoint filter into
   * a no-op — every caller would receive the title and status of every endpoint
   * in the workspace.
   *
   * Fails LOUD rather than falling back: a missing head is a pipeline
   * construction bug, and the only available fallback is the unsafe one.
   */
  private head (): Middleware {
    const head = this.context.head
    if (head === undefined) {
      throw new Error('traceability: pipeline head is not available, refusing to read without the caller session')
    }
    return head
  }

  /**
   * Read as the caller, and say so explicitly.
   *
   * 🔴 `PostgresAdapter.addSecurity` skips the SQL space ACL entirely when
   * `sessionContext.isTriggerCtx === true`, and `TriggersMiddleware.processDerived`
   * SETS that flag on the shared `contextData` and never clears it. This handler
   * runs on a fresh per-request context and writes nothing, so no trigger can
   * have set it — but "no trigger ran yet" is a property of today's call graph,
   * not an invariant, and the failure mode is total: every endpoint in the
   * workspace becomes readable. Stating it costs one assignment.
   */
  private asCaller (ctx: MeasureContext<SessionData>): MeasureContext<SessionData> {
    if (ctx.contextData === undefined || ctx.contextData === null) return ctx
    if ((ctx.contextData as any)[TRACE_INTERNAL_READ] === true) return ctx

    // A context that IS the caller's for every purpose the chain cares about,
    // plus one private marker so `findAll` above recognises the read as its own
    // and does not filter it a second time (see `isPrivilegedRead`, case 2).
    //
    // 🔴 Built with `Object.create`, deliberately, and not by spreading:
    //
    // - `Object.create(ctx.contextData)` puts the SessionData on the prototype
    //   chain, so `account`, `contextCache`, `broadcast`, `removedMap` and the
    //   rest resolve to the very same objects the session uses — the identity
    //   that matters is the identity of those members, and mutations INTO them
    //   (the normal pattern) still land on the shared ones. Only a write of a
    //   NEW top-level key would land on the shadow, and this is a read path.
    // - `Object.create(ctx)` keeps the context's prototype methods working,
    //   which a spread of a class instance would silently drop.
    // - `MeasureMetricsContext.newChild` copies `contextData` BY REFERENCE
    //   (`c.contextData = this.contextData`), so the marker survives every
    //   `ctx.with(...)` a middleware below wraps the call in. A marker put on
    //   the context object itself would not.
    // - `MeasureMetricsContext` has no `#private` fields, so a derived object
    //   can call its methods. Checked, not assumed.
    const data = Object.create(ctx.contextData)
    data[TRACE_INTERNAL_READ] = true
    // 🔴 On the SHADOW, not on the session. The flag has to be false for the
    // read that is about to happen, and it used to be cleared in place — which
    // reached back into a context other work may still be using. The shadow gets
    // the same protection with none of the shared mutation.
    data.isTriggerCtx = false
    const derived: MeasureContext<SessionData> = Object.create(ctx)
    derived.contextData = data
    return derived
  }

  private finder (_ctx: MeasureContext<SessionData>): TraceLinkFinder {
    const ctx = this.asCaller(_ctx)
    return async (query) => {
      // `_class` is pinned both as the find argument and inside `query` by
      // `edgeQuery`, so upstream `core.class.Relation` rows sharing
      // DOMAIN_RELATION can never come back.
      return [...(await this.head().findAll<TraceLink>(ctx, traceability.class.TraceLink, query as any))]
    }
  }

  /**
   * Resolve one class-worth of endpoint ids as the CALLER.
   *
   * The `hierarchy.isDerived` guard is the class-level assertion
   * `resolveEndpoints` cannot make on its own (it has no hierarchy). A strict
   * `doc._class === _class` would be WRONG: `sourceClass` / `targetClass` are
   * `Ref<Class<Doc>>` and may legitimately name a base class, so equality would
   * make every subclass endpoint unresolvable and silently render the whole
   * graph as restricted.
   */
  private resolver (_ctx: MeasureContext<SessionData>): TraceEndpointResolver {
    const ctx = this.asCaller(_ctx)
    return async (_class: Ref<Class<Doc>>, ids: Array<Ref<Doc>>) => {
      if (ids.length === 0) {
        return []
      }
      const docs = await this.head().findAll<Doc>(ctx, _class, { _id: { $in: ids } })
      return docs.filter((doc) => this.context.hierarchy.isDerived(doc._class, _class))
    }
  }
}

/** The edges hanging off a document's `$lookup` payload. */
function lookupEdges (doc: Doc, isEdge: (doc: Doc) => boolean): Doc[] {
  const lookup = (doc as any).$lookup
  if (lookup === undefined || lookup === null || typeof lookup !== 'object') return []
  const out: Doc[] = []
  for (const value of Object.values(lookup as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === 'object' && isEdge(item as Doc)) out.push(item as Doc)
      }
    } else if (value !== null && typeof value === 'object' && isEdge(value as Doc)) {
      out.push(value as Doc)
    }
  }
  return out
}

/**
 * Rebuild the `FindResult` wrapper.
 *
 * `toFindResult` rather than returning the array: `total` and `lookupMap` are
 * properties OF THE RESULT, not of any document, and `total` in particular has
 * to be re-derived — see {@link adjustTotal} for why the adapter's count must
 * not survive a drop.
 */
function finish<T extends Doc> (original: FindResult<T>, docs: T[]): FindResult<T> {
  return toFindResult(docs, adjustTotal(original.total, original.length, docs.length), original.lookupMap)
}
