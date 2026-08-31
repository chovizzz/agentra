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

import { DOMAIN_RELATION, type Class, type Doc, type Ref } from '@hcengineering/core'
import { Model, Prop, TypeRef, TypeString, UX } from '@hcengineering/model'
import core, { TDoc } from '@hcengineering/model-core'
import type { TraceLink, TraceLinkKind, TraceLinkState } from '@hcengineering/traceability'

import traceability from './plugin'

/**
 * 🔴 TraceLink is stored in the UPSTREAM `DOMAIN_RELATION`, but extends
 * `core.class.Doc` — NOT `core.class.Relation`.
 *
 * Why this is safe (verified against this tree, not assumed):
 *
 *  - Every upstream read of relations goes through `findAll(core.class.Relation, …)`.
 *    The Postgres query builder rewrites the class filter via
 *    `fillClass` -> `getBaseClass` -> `getDescendants`
 *    (foundations/server/packages/postgres/src/storage.ts), producing
 *    `_class IN (descendants of core.class.Relation)`. TraceLink is not a
 *    descendant, so it is invisible to those queries — including the two
 *    association-less reads in `plugins/card-resources/src/utils.ts`.
 *  - `foundations/core/packages/query/src/index.ts` guards its relation handling
 *    with exact `_class === core.class.Relation` comparisons.
 *  - `memdb.ts` reads relations with an explicit `association:` filter.
 *
 * Why the field names are `docA` / `docB` and not `source` / `target`:
 * the Postgres `relationSchema` promotes exactly `docA`, `docB` and
 * `association` to real indexed columns. Every other field falls into the `data`
 * JSONB blob and gets NO index. Renaming these two would throw away the two free
 * btree indexes that are the whole reason for reusing this domain.
 *
 * On the `association` column: `relationSchema` marks it `notNull`, and
 * `createTable` emits `"association" text NOT NULL`. TraceLink does not carry
 * that field, but `convertDoc` (foundations/server/packages/postgres/src/utils.ts)
 * backfills missing not-null text columns with `''`, so inserts succeed and the
 * row can never match the `AND r.association = $assocId` predicate that
 * `fetchAssociations` uses. Do not add an `association` field to work around
 * something — it is handled.
 *
 * 🔴 `DOMAIN_RELATION` is excluded from the fulltext index and from Activity.
 * Creating a TraceLink therefore emits NO activity record. Any command that
 * creates an edge MUST write Activity to both endpoints explicitly.
 */
@Model(traceability.class.TraceLink, core.class.Doc, DOMAIN_RELATION)
@UX(traceability.string.TraceLink, traceability.icon.TraceLink)
export class TTraceLink extends TDoc implements TraceLink {
  // Persisted as the indexed `docA` column. Read as "source".
  // No @Index here on purpose: on Postgres `@Index` does not create an index
  // (the schema does), and `relationSchema` already indexes this column.
  @Prop(TypeRef(core.class.Doc), traceability.string.Source)
    docA!: Ref<Doc>

  @Prop(TypeRef(core.class.Class), traceability.string.Source)
    sourceClass!: Ref<Class<Doc>>

  // Persisted as the indexed `docB` column. Read as "target".
  // Reverse navigation rides this index; never double-write a reverse edge.
  @Prop(TypeRef(core.class.Doc), traceability.string.Target)
    docB!: Ref<Doc>

  @Prop(TypeRef(core.class.Class), traceability.string.Target)
    targetClass!: Ref<Class<Doc>>

  @Prop(TypeString(), traceability.string.Kind)
    kind!: TraceLinkKind

  // Query-time normalisation to the logical object: `doc.baseId ?? doc._id`.
  // Redundant on purpose — the edge itself points at a concrete version.
  // NOT part of the unique key: keying on baseId would collapse a requirement's
  // revisions into a single edge and destroy the audit history.
  @Prop(TypeRef(core.class.Doc), traceability.string.Source)
    sourceBaseId!: Ref<Doc>

  @Prop(TypeRef(core.class.Doc), traceability.string.Target)
    targetBaseId!: Ref<Doc>

  @Prop(TypeString(), traceability.string.State)
    state!: TraceLinkState

  // Free-form; lands in the `data` JSONB blob. Never copy endpoint titles,
  // identifiers, people or statuses in here — that would leak past the
  // per-endpoint permission filter.
  //
  // 🔴 THE INVARIANT ABOVE IS NOW ENFORCED, not merely stated: it was violated
  // by three commands (`leadStatus`, `project`, `requirementStatus`) before
  // anyone noticed. `server-plugins/agentra-core-resources/src/traceLinkMetadata.ts`
  // holds the closed key set plus a provenance table, and every write in that
  // package goes through its builder. The type here stays `Record<string,
  // string>` on purpose — narrowing it would reach into packages this one does
  // not own.
  metadata?: Record<string, string>

  // The two idempotency counters. Read them through `traceLinkRevocations` /
  // `traceLinkReassertions`; absent means 0, so no backfill migration is owed.
  //
  // NO @Prop, deliberately — same as `metadata` above. @Prop registers a UI
  // attribute and demands an IntlString label, and this counter is ledger
  // bookkeeping that no user should be shown or allowed to filter on. It is
  // persisted all the same: persistence follows the document, not the
  // decorators, and it lands in the `data` JSONB blob.
  //
  // NO @Index either. `relationSchema` promotes only `docA` / `docB` /
  // `association` to real columns, and on Postgres @Index creates nothing
  // anyway; nothing queries by this value — it is read alongside the edge that
  // carries it.
  revocationGeneration?: number
  assertionGeneration?: number
}
