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

/**
 * Where one `TraceLink.metadata` key gets its value FROM.
 *
 * 🔴 THE POINT IS THE READER, NOT THE WRITER. `TraceLink` rows live in
 * `core.space.Workspace`, which `spaceSecurity` hands to every account
 * unconditionally, and no `findAll` middleware filters them by whether the
 * caller may see the two endpoints. So everything in the `data` JSONB blob is
 * readable workspace-wide — including by an account with no access to the
 * project either endpoint sits in. `docA` / `docB` / `kind` / the two base ids
 * are structurally unavoidable there; ANYTHING ELSE we copy in is a leak we
 * chose.
 *
 * - `command-identity` — describes the COMMAND that made the edge, not the
 *   objects it joins: the command name, the caller's idempotency key. Drawn
 *   from the request, so it discloses nothing the request did not already
 *   contain.
 * - `edge-identity` — the identity of a `TraceLink`, ours or another one.
 *   Discloses nothing past the columns of the row it is written on: a trace
 *   link id is `sha256(kind, docA, docB)` truncated, so it is a one-way digest
 *   over values that are already plaintext columns on that same row.
 * - `endpoint-derived` — read off one of the endpoint DOCUMENTS: its status,
 *   title, name, assignee, owning space or project. **This is the banned one.**
 *   Classifying a key this way is not a warning, it is a compile error at every
 *   call site — see {@link PersistableTraceLinkMetadataKey}.
 *
 * @public
 */
export type TraceLinkMetadataProvenance = 'command-identity' | 'edge-identity' | 'endpoint-derived'

/**
 * Every key any command in this package may name when building metadata.
 *
 * A key that is not in this union cannot be passed to {@link traceLinkMetadata}
 * at all (`TS2353`), which is the first half of the mechanism; the second half
 * is that adding it here does not compile either until it is classified below.
 *
 * @public
 */
export type TraceLinkMetadataKey = 'command' | 'idempotencyKey' | 'inheritedFrom'

/**
 * The classification table.
 *
 * 🔴 THE EXHAUSTIVENESS MECHANISM, deliberately shaped like
 * `PartialWriteTable` in `partialWrite.ts`. `satisfies Record<Key, Prov>` is
 * checked in both directions: a key added to {@link TraceLinkMetadataKey} with
 * no entry here is `TS2741 (property missing)`, and an entry for a key not in
 * the union is `TS2353 (unknown property)`. `as const` is what keeps the
 * literal value types, which is what lets the ban below be a TYPE and not a
 * comment.
 *
 * So the next person who wants to record something on an edge cannot get there
 * without writing down, here, where the value came from — which is the step
 * that was skipped when `leadStatus`, `project` and `requirementStatus` went in.
 *
 * @public
 */
export const TRACE_LINK_METADATA_PROVENANCE = {
  // The command constant, e.g. `ConvertLeadToRequirement`. A closed vocabulary
  // fixed at compile time; it names our own code, never a document.
  command: 'command-identity',
  // The caller's own key, echoed back. ⚠️ Free-form and CLIENT-SUPPLIED — see
  // the note on `traceLinkMetadata` about what this does and does not promise.
  idempotencyKey: 'command-identity',
  // The `TraceLink` this edge was carried forward from. An edge id, not an
  // endpoint id, and a digest at that.
  inheritedFrom: 'edge-identity'
} as const satisfies Record<TraceLinkMetadataKey, TraceLinkMetadataProvenance>

/**
 * The keys that survive the ban: {@link TraceLinkMetadataKey} minus everything
 * classified `endpoint-derived`.
 *
 * 🔴 THIS IS THE ENFORCEMENT. Reclassify a key as `endpoint-derived` above and
 * it drops out of this union, so every call site that names it stops compiling.
 * The honest classification and the ban are therefore the same edit — there is
 * no way to admit "yes, this comes off the endpoint document" and still ship it.
 *
 * @public
 */
export type PersistableTraceLinkMetadataKey = {
  [K in TraceLinkMetadataKey]: (typeof TRACE_LINK_METADATA_PROVENANCE)[K] extends 'endpoint-derived' ? never : K
}[TraceLinkMetadataKey]

/**
 * What a command may hand to {@link traceLinkMetadata}.
 *
 * @public
 */
export type TraceLinkMetadataInput = { readonly [K in PersistableTraceLinkMetadataKey]?: string | undefined }

/**
 * Build the `metadata` blob for a `TraceLink`.
 *
 * 🔴 EVERY `metadata:` ON A `TraceLink` `createDoc` IN THIS PACKAGE GOES
 * THROUGH HERE, and `traceLinkMetadata.test.ts` scans the sources to keep that
 * true — the type check above only binds the call sites that opt into it, so a
 * bare object literal handed straight to `createDoc` would slip past it. The
 * scan is what closes that hole; between them, adding a leaking key fails
 * either `tsc` or `jest`.
 *
 * ⚠️ WHAT THIS DOES NOT CATCH, stated plainly:
 *
 * 1. **A wrong classification.** Marking a genuinely endpoint-derived key
 *    `command-identity` compiles fine. The table makes the claim explicit and
 *    reviewable; it cannot verify it.
 * 2. **The VALUE of an admitted key.** `idempotencyKey` is a client string this
 *    package never generates (`fixedByIdempotencyKey` shows the house shape:
 *    `…:${defect}:${pullRequest}:${revision}` — endpoint REFS, which are
 *    already plaintext `docA` / `docB` columns on the same row, so it adds no
 *    disclosure). Nothing stops a caller putting a title in it. That is a
 *    property of the request, not of this module.
 * 3. **Other packages.** `server-traceability-resources` writes `metadata` on
 *    its inheritance path; this module is not in its dependency graph.
 * 4. **The actual hole.** None of this narrows who can READ the row. The fix
 *    for that is the space/`findAll` filter, and it is a separate decision.
 *
 * Keys whose value is `undefined` are dropped rather than persisted as the
 * string `"undefined"`.
 *
 * @public
 */
export function traceLinkMetadata (input: TraceLinkMetadataInput): Record<string, string> {
  const metadata: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) {
      continue
    }
    // The runtime companion. The type check is defeated by any `as any`, by a
    // spread of a widened `Record<string, string>`, and says nothing at all to
    // a JavaScript caller; this turns those into a throw at the point of use
    // rather than a row that quietly carries a status into every account's
    // reach.
    const provenance = (TRACE_LINK_METADATA_PROVENANCE as Record<string, TraceLinkMetadataProvenance>)[key]
    if (provenance === undefined) {
      throw new Error(`Trace link metadata key '${key}' has no provenance classification`)
    }
    if (provenance === 'endpoint-derived') {
      throw new Error(`Trace link metadata key '${key}' is endpoint-derived and must not be persisted on an edge`)
    }
    metadata[key] = value
  }
  return metadata
}
