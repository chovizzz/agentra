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

import type { Class, Doc, Markup, Ref } from '@hcengineering/core'

// ───────────────────────────────────────────────────────────────────────────
// REL-005: generate editable release notes, classified into requirements,
// improvements and bug fixes.
//
// 🔴 EVERYTHING HERE IS PURE. The classification, the ordering and the rendering
// take values and return values, so the acceptance points (idempotence, "no
// entry is ever dropped", "restricted collapses to one line without a count")
// are unit assertions rather than screenshots. Fetching the scope is the
// caller's job; see {@link ReleaseNotesInput}.
// ───────────────────────────────────────────────────────────────────────────

/**
 * How one delivered object reached this version.
 *
 * 🔴 THE SCOPE ARRIVES THROUGH TWO CHANNELS AND THIS FIELD RECORDS WHICH, so
 * that classification never has to guess from a class ref:
 *
 * - `requirement` — the requirement's `targetVersion` ATTRIBUTE. Technical note
 *   in `requirements/src/types.ts`: the `delivered-in` EDGE was dropped for
 *   requirements in favour of the attribute, so that `ViewOptionsModel.groupBy`
 *   can group by it. `evaluateReleaseGate` reads the same attribute.
 * - `work-item` — a `delivered-in` trace edge pointing at the version, which is
 *   how issues (work items AND bugs, one class, two task types) are attached.
 *
 * ⚠️ `unknown` is kept as a member on purpose. Task 18b requires that an entry
 * that cannot be classified is LISTED under "other" and never silently dropped;
 * without a member for it the only way to represent one would be to leave it
 * out.
 *
 * @public
 */
export type ReleaseNotesOrigin = 'requirement' | 'work-item' | 'unknown'

/**
 * One candidate line, as the caller resolved it.
 *
 * 🔴 A WIRE TYPE DECLARED LOCALLY. It deliberately names no class from
 * `@hcengineering/requirements`, `@hcengineering/tracker` or
 * `@hcengineering/traceability`: this browser package must not grow a
 * dependency on them (`crm-lite-resources` and `traceability-resources` copy
 * their wire types for the same reason). The consequence is that this module
 * cannot be fooled by a class hierarchy change either — it classifies on
 * signals the caller states outright.
 *
 * @public
 */
export interface ReleaseNotesCandidate {
  id: Ref<Doc>
  objectClass?: Ref<Class<Doc>>
  /** Human identifier, e.g. `REQ-14` / `PRJ-102`. */
  identifier?: string
  title: string
  origin: ReleaseNotesOrigin
  /**
   * The issue is a DEFECT.
   *
   * Task 18b's classification rule verbatim: "Bug（有 `defect-of` 或类型为
   * Bug）". Both signals collapse into this one boolean, resolved by the caller,
   * because the underlying facts live in two different places — a `defect-of`
   * trace edge, and the issue's TaskType — and Technical Spec §3.4 forbids a
   * parallel Bug class that would make the distinction a `_class` check.
   */
  isDefect?: boolean
}

/**
 * The four sections, in the order they are rendered.
 *
 * 🔴 THE ORDER IS PART OF THE CONTRACT, because regenerating must produce a
 * byte-identical body (Task 18b: "同一版本重复生成产生相同内容"). Any ordering
 * that depends on query return order, on a `Set`'s iteration or on the clock
 * breaks that.
 *
 * @public
 */
export const releaseNotesSections = ['requirements', 'improvements', 'bug-fixes', 'other'] as const

/**
 * @public
 */
export type ReleaseNotesSection = (typeof releaseNotesSections)[number]

/**
 * Classify one candidate.
 *
 * The rule is Task 18b Step 1's, unchanged:
 * Requirement → 需求, non-Bug work item → 改进, Bug → 缺陷修复, and anything
 * that fits none of them → 其他, **explicitly listed rather than dropped**.
 *
 * ⚠️ `isDefect` is only consulted for `work-item`. A requirement is a
 * requirement even if somebody hangs a `defect-of` edge off it; letting the flag
 * win there would move requirements into the bug list depending on unrelated
 * trace data.
 *
 * @public
 */
export function classifyReleaseNotesCandidate (candidate: ReleaseNotesCandidate): ReleaseNotesSection {
  switch (candidate.origin) {
    case 'requirement':
      return 'requirements'
    case 'work-item':
      return candidate.isDefect === true ? 'bug-fixes' : 'improvements'
    default:
      return 'other'
  }
}

/**
 * @public
 */
export interface ReleaseNotesEntry {
  id: Ref<Doc>
  identifier?: string
  title: string
}

/**
 * @public
 */
export interface ReleaseNotesDocument {
  sections: Array<{ section: ReleaseNotesSection, entries: ReleaseNotesEntry[] }>
  /**
   * At least one entry was withheld from the caller.
   *
   * 🔴 A BOOLEAN, AND THERE IS NO COUNT ANYWHERE IN THIS TYPE. Task 18b: the
   * withheld entries collapse into one line, "不含数量、标题、严重度、负责人",
   * because the NUMBER of items in a space the caller cannot read is itself the
   * cross-space side channel. Same rule as `ReleaseGateReport.restricted`.
   */
  restricted: boolean
  /** `true` when nothing at all is in scope — distinct from "all restricted". */
  empty: boolean
}

/**
 * @public
 */
export interface ReleaseNotesInput {
  candidates: readonly ReleaseNotesCandidate[]
  /**
   * Set by the CALLER when it knows the scope query returned less than the
   * whole scope. It is never derived from `candidates` here — an empty list is
   * indistinguishable from a fully withheld one, and guessing would either
   * invent a restriction or hide a real one.
   */
  restricted?: boolean
}

/**
 * Aggregate and classify the scope.
 *
 * 🔴 IDEMPOTENT BY CONSTRUCTION. Two properties do it:
 *
 * - duplicates collapse on `id`, so a requirement reachable twice (two edges,
 *   or the attribute plus an edge somebody added by hand) produces ONE line;
 * - entries are sorted by `identifier` then `id`, both stable strings, so the
 *   output does not depend on the order the queries happened to return.
 *
 * Without both, "regenerate" would produce a different body every time and the
 * overwrite confirmation would fire on notes nobody had edited.
 *
 * ⚠️ EMPTY SECTIONS ARE OMITTED, but a section with entries is never omitted —
 * including `other`. Dropping `other` for tidiness is exactly the silent loss
 * Task 18b forbids.
 *
 * @public
 */
export function buildReleaseNotes (input: ReleaseNotesInput): ReleaseNotesDocument {
  const buckets = new Map<ReleaseNotesSection, Map<Ref<Doc>, ReleaseNotesEntry>>()
  for (const section of releaseNotesSections) {
    buckets.set(section, new Map())
  }
  for (const candidate of input.candidates) {
    const bucket = buckets.get(classifyReleaseNotesCandidate(candidate))
    if (bucket === undefined || bucket.has(candidate.id)) {
      continue
    }
    bucket.set(candidate.id, {
      id: candidate.id,
      ...(candidate.identifier !== undefined && candidate.identifier !== ''
        ? { identifier: candidate.identifier }
        : {}),
      title: candidate.title
    })
  }
  const sections: ReleaseNotesDocument['sections'] = []
  let total = 0
  for (const section of releaseNotesSections) {
    const entries = [...(buckets.get(section) as Map<Ref<Doc>, ReleaseNotesEntry>).values()].sort(compareEntries)
    total += entries.length
    if (entries.length > 0) {
      sections.push({ section, entries })
    }
  }
  return { sections, restricted: input.restricted === true, empty: total === 0 }
}

function compareEntries (a: ReleaseNotesEntry, b: ReleaseNotesEntry): number {
  const left = a.identifier ?? ''
  const right = b.identifier ?? ''
  if (left !== right) {
    // ⚠️ Plain `<` rather than `localeCompare`: the sort must not depend on the
    // browser's locale, or the same scope would render in different orders on
    // two machines and every regeneration would look like an edit.
    return left < right ? -1 : 1
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering to `Markup`.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The subset of the editor's document model this renderer emits.
 *
 * 🔴 DECLARED LOCALLY, MIRRORING `@hcengineering/text-core`'s `MarkupNode`.
 * `Markup` is `JSON.stringify` of a ProseMirror document, and `text-core` is not
 * a dependency of this package. The node type STRINGS below are the wire
 * contract (`doc`, `heading`, `paragraph`, `bulletList`, `listItem`, `text`) and
 * a test pins them, because a typo produces a syntactically valid document that
 * the viewer renders as nothing.
 */
interface RenderedNode {
  type: string
  content?: RenderedNode[]
  attrs?: Record<string, string | number>
  text?: string
}

/**
 * Section headings, resolved by the CALLER.
 *
 * 🔴 TRANSLATED AT GENERATION TIME AND FROZEN INTO THE BODY, and that is a
 * decision rather than an oversight. The notes are a persisted, hand editable
 * artefact — once a human has corrected a line, re-translating the headings
 * around it would mean rewriting a document somebody owns. So the body carries
 * the language it was generated in; switching UI language does not rewrite
 * published notes.
 *
 * ⚠️ Which is also why this is an argument rather than an `IntlString` lookup
 * inside the renderer: keeping the translation outside keeps the renderer pure
 * and its output assertable.
 *
 * @public
 */
export interface ReleaseNotesLabels {
  requirements: string
  improvements: string
  'bug-fixes': string
  other: string
  /** One line, no count. See {@link ReleaseNotesDocument.restricted}. */
  restricted: string
  empty: string
}

/**
 * Render the classified scope into `Markup`.
 *
 * ⚠️ PLAIN TEXT LINES, NOT `reference` NODES. A reference node needs a valid
 * `{ id, label, objectclass }` triple and is resolved by the viewer at render
 * time; a stale or unreadable one degrades inside the editor rather than here.
 * Release notes are a RECORD of what shipped, so the text has to keep reading
 * correctly after the objects it names have moved on.
 *
 * @public
 */
export function renderReleaseNotes (doc: ReleaseNotesDocument, labels: ReleaseNotesLabels): Markup {
  const content: RenderedNode[] = []
  for (const { section, entries } of doc.sections) {
    content.push(heading(labels[section]))
    content.push({
      type: 'bulletList',
      content: entries.map((entry) => ({
        type: 'listItem',
        content: [paragraph(entryLine(entry))]
      }))
    })
  }
  if (doc.restricted) {
    content.push(paragraph(labels.restricted))
  }
  if (content.length === 0) {
    content.push(paragraph(labels.empty))
  }
  return JSON.stringify({ type: 'doc', content })
}

/**
 * `IDENTIFIER — title`, or just the title when there is no identifier.
 *
 * ⚠️ An entry with an empty title still produces a line: the identifier, or the
 * id when even that is missing. A blank bullet is confusing; a vanished entry
 * is a lie about what shipped.
 *
 * @public
 */
export function entryLine (entry: ReleaseNotesEntry): string {
  const title = entry.title.trim()
  if (entry.identifier !== undefined && entry.identifier !== '') {
    return title === '' ? entry.identifier : `${entry.identifier} — ${title}`
  }
  return title === '' ? entry.id : title
}

function heading (text: string): RenderedNode {
  return { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] }
}

function paragraph (text: string): RenderedNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] }
}

// ───────────────────────────────────────────────────────────────────────────
// Overwrite and read-only policy.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Whether regenerating would overwrite something and must therefore ask first.
 *
 * 🔴 THE QUESTION IS ABOUT THE BODY, NOT ABOUT THE TIMESTAMP. Task 18b requires
 * a confirmation when notes have been hand edited, and there is no field that
 * records "a human touched this": `modifiedOn` moves on every unrelated edit to
 * the version, and `releaseNotesGeneratedOn` only says when the generator last
 * ran. So the guard is the conservative one — ANY non-empty body is confirmed
 * before it is replaced.
 *
 * ⚠️ THE CONSERVATIVE DIRECTION IS THE SAFE ONE. It over-asks (a confirmation
 * on untouched machine output, where the regenerated body is usually identical
 * anyway) and never under-asks. The alternative — comparing the stored body to a
 * fresh render and skipping the prompt when they match — silently loses an edit
 * made against a scope that has since changed back.
 *
 * @public
 */
export function releaseNotesNeedConfirmation (existing: Markup | undefined): boolean {
  if (existing === undefined || existing.trim() === '') {
    return false
  }
  // An "empty" ProseMirror document is a doc with one empty paragraph, which is
  // a non-empty STRING. Treating it as content would put a confirmation in front
  // of every first generation.
  return !isBlankMarkup(existing)
}

/**
 * `true` for `undefined`, `''`, and a document whose nodes carry no text.
 *
 * ⚠️ Parses rather than string-matches: `EmptyMarkup` is one exact spelling of
 * an empty document, but the editor also produces `{"type":"doc","content":[]}`
 * and a paragraph holding an empty text node, and a string comparison would
 * classify those as content.
 *
 * @public
 */
export function isBlankMarkup (markup: Markup | undefined): boolean {
  if (markup === undefined || markup.trim() === '') {
    return true
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(markup)
  } catch {
    // Not JSON at all: it is *something*, and something must not be silently
    // overwritten. Fails closed.
    return false
  }
  return !hasText(parsed)
}

function hasText (node: unknown): boolean {
  if (node == null || typeof node !== 'object') {
    return false
  }
  const it = node as { text?: unknown, content?: unknown }
  if (typeof it.text === 'string' && it.text.trim() !== '') {
    return true
  }
  return Array.isArray(it.content) && it.content.some(hasText)
}
