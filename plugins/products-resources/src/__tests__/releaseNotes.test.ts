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
import type { ProductVersion } from '@hcengineering/products'

import {
  buildReleaseNotes,
  classifyReleaseNotesCandidate,
  entryLine,
  isBlankMarkup,
  releaseNotesNeedConfirmation,
  releaseNotesSections,
  renderReleaseNotes,
  type ReleaseNotesCandidate,
  type ReleaseNotesLabels
} from '../releaseNotes'
import {
  ISSUE_CLASS,
  REQUIREMENT_CLASS,
  TRACE_LINK_CLASS,
  collectReleaseNotesScope,
  type ReleaseNotesReader
} from '../releaseNotesScope'

const LABELS: ReleaseNotesLabels = {
  requirements: 'Requirements',
  improvements: 'Improvements',
  'bug-fixes': 'Bug fixes',
  other: 'Other',
  restricted: 'There are further items in a restricted scope',
  empty: 'Nothing is in scope for this version yet'
}

/** Cast helper: `Ref` is a branded string, so a bare literal is a type error. */
function ref (id: string): Ref<Doc> {
  return id as Ref<Doc>
}

function candidate (over: Omit<Partial<ReleaseNotesCandidate>, 'id'> & { id: string }): ReleaseNotesCandidate {
  return { title: 't', origin: 'work-item', ...over, id: ref(over.id) }
}

describe('classification (Task 18b Step 1)', () => {
  it('maps requirement / non-bug work item / bug onto the three named sections', () => {
    // The rule verbatim: Requirement → 需求, 非 Bug 的 Work Item → 改进,
    // Bug（有 `defect-of` 或类型为 Bug）→ 缺陷修复.
    expect(classifyReleaseNotesCandidate(candidate({ id: 'a', origin: 'requirement' }))).toBe('requirements')
    expect(classifyReleaseNotesCandidate(candidate({ id: 'b', origin: 'work-item' }))).toBe('improvements')
    expect(classifyReleaseNotesCandidate(candidate({ id: 'c', origin: 'work-item', isDefect: true }))).toBe('bug-fixes')
  })

  it('sends an unclassifiable entry to `other` instead of dropping it', () => {
    // 🔴 "无法归类的条目进「其他」并显式列出，不得静默丢弃".
    expect(classifyReleaseNotesCandidate(candidate({ id: 'd', origin: 'unknown' }))).toBe('other')
    const doc = buildReleaseNotes({ candidates: [candidate({ id: 'd', origin: 'unknown', title: 'mystery' })] })
    expect(doc.sections).toEqual([{ section: 'other', entries: [{ id: ref('d'), title: 'mystery' }] }])
  })

  it('does not let a `defect-of` edge move a REQUIREMENT into the bug list', () => {
    // ⚠️ `isDefect` is only consulted for work items; letting it win for a
    // requirement would reclassify requirements on unrelated trace data.
    expect(classifyReleaseNotesCandidate(candidate({ id: 'e', origin: 'requirement', isDefect: true }))).toBe(
      'requirements'
    )
  })

  it('renders the sections in a fixed order', () => {
    expect([...releaseNotesSections]).toEqual(['requirements', 'improvements', 'bug-fixes', 'other'])
  })
})

describe('aggregation', () => {
  const scope: ReleaseNotesCandidate[] = [
    candidate({ id: 'i-2', origin: 'work-item', identifier: 'PRJ-2', title: 'Faster export' }),
    candidate({ id: 'r-1', origin: 'requirement', identifier: 'REQ-1', title: 'Export CSV' }),
    candidate({ id: 'i-1', origin: 'work-item', identifier: 'PRJ-1', title: 'Fix crash', isDefect: true })
  ]

  it('is IDEMPOTENT: the same scope in any order produces the same document', () => {
    // 🔴 "同一版本重复生成产生相同内容，不产生重复条目". Without a stable sort
    // the body would change on every regeneration and the overwrite prompt would
    // fire on notes nobody had edited.
    const a = buildReleaseNotes({ candidates: scope })
    const b = buildReleaseNotes({ candidates: [...scope].reverse() })
    expect(b).toEqual(a)
    expect(renderReleaseNotes(b, LABELS)).toBe(renderReleaseNotes(a, LABELS))
  })

  it('collapses a duplicate id into one entry', () => {
    const doc = buildReleaseNotes({
      candidates: [
        candidate({ id: 'r-1', origin: 'requirement', identifier: 'REQ-1', title: 'Export CSV' }),
        candidate({ id: 'r-1', origin: 'requirement', identifier: 'REQ-1', title: 'Export CSV' })
      ]
    })
    expect(doc.sections[0].entries).toHaveLength(1)
  })

  it('omits empty sections but never a populated one', () => {
    const doc = buildReleaseNotes({ candidates: scope })
    expect(doc.sections.map((it) => it.section)).toEqual(['requirements', 'improvements', 'bug-fixes'])
    expect(doc.empty).toBe(false)
  })

  it('reports `restricted` as a BOOLEAN with no count anywhere in the document', () => {
    // 🔴 Same side channel as `ReleaseGateReport.restricted`: the number of
    // items in a space the caller cannot read must not be derivable.
    const doc = buildReleaseNotes({ candidates: scope, restricted: true })
    expect(doc.restricted).toBe(true)
    expect(JSON.stringify(doc)).not.toMatch(/restrictedCount|hidden|withheld/)
    const markup = renderReleaseNotes(doc, LABELS)
    expect(markup).toContain(LABELS.restricted)
    // One line, and it states existence only.
    expect(markup.split(LABELS.restricted)).toHaveLength(2)
  })

  it('distinguishes "nothing in scope" from "everything restricted"', () => {
    expect(buildReleaseNotes({ candidates: [] }).empty).toBe(true)
    const allHidden = buildReleaseNotes({ candidates: [], restricted: true })
    expect(allHidden.empty).toBe(true)
    expect(allHidden.restricted).toBe(true)
    // The restricted notice is rendered instead of the "nothing in scope" one:
    // claiming an empty scope when items were withheld would be a lie.
    const markup = renderReleaseNotes(allHidden, LABELS)
    expect(markup).toContain(LABELS.restricted)
    expect(markup).not.toContain(LABELS.empty)
  })
})

describe('rendering to Markup', () => {
  it('emits the ProseMirror node type spellings the editor expects', () => {
    // 🔴 A typo here produces a syntactically valid document that renders as
    // nothing at all.
    const doc = buildReleaseNotes({
      candidates: [candidate({ id: 'r-1', origin: 'requirement', identifier: 'REQ-1', title: 'Export CSV' })]
    })
    const parsed = JSON.parse(renderReleaseNotes(doc, LABELS))
    expect(parsed.type).toBe('doc')
    expect(parsed.content[0]).toEqual({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Requirements' }]
    })
    expect(parsed.content[1].type).toBe('bulletList')
    expect(parsed.content[1].content[0].type).toBe('listItem')
    expect(parsed.content[1].content[0].content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'REQ-1 — Export CSV' }]
    })
  })

  it('never renders a blank bullet', () => {
    // ⚠️ A blank line is confusing; a vanished entry is a lie about what
    // shipped. So the fallback chain is identifier, then id.
    expect(entryLine({ id: ref('x'), title: '   ' })).toBe('x')
    expect(entryLine({ id: ref('x'), identifier: 'REQ-9', title: '' })).toBe('REQ-9')
    expect(entryLine({ id: ref('x'), title: 'Plain' })).toBe('Plain')
  })

  it('says so when nothing is in scope', () => {
    expect(renderReleaseNotes(buildReleaseNotes({ candidates: [] }), LABELS)).toContain(LABELS.empty)
  })
})

describe('the overwrite guard', () => {
  it('does not ask before the first generation', () => {
    expect(releaseNotesNeedConfirmation(undefined)).toBe(false)
    expect(releaseNotesNeedConfirmation('')).toBe(false)
    // An "empty" ProseMirror document is a non-empty STRING; treating it as
    // content would put a confirmation in front of every first generation.
    expect(releaseNotesNeedConfirmation('{"type":"doc","content":[{"type":"paragraph","content":[]}]}')).toBe(false)
  })

  it('asks before replacing anything that carries text', () => {
    const body = renderReleaseNotes(
      buildReleaseNotes({ candidates: [candidate({ id: 'r', origin: 'requirement', title: 'X' })] }),
      LABELS
    )
    expect(releaseNotesNeedConfirmation(body)).toBe(true)
  })

  it('fails CLOSED on a body it cannot parse', () => {
    // Not JSON is still *something*, and something must not be silently
    // overwritten.
    expect(isBlankMarkup('<p>hand written</p>')).toBe(false)
    expect(releaseNotesNeedConfirmation('<p>hand written</p>')).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────

const VERSION = 'v-1' as Ref<ProductVersion>

function reader (rows: Record<string, Doc[]>): ReleaseNotesReader {
  return {
    findAll: (async (_class: Ref<Class<Doc>>, query: any) => {
      const all = rows[_class as string] ?? []
      const filtered = all.filter((row: any) => {
        for (const [key, want] of Object.entries(query)) {
          const have = row[key]
          if (want != null && typeof want === 'object' && '$in' in (want as any)) {
            if (!((want as any).$in as unknown[]).includes(have)) return false
          } else if (have !== want) {
            return false
          }
        }
        return true
      })
      return Object.assign([...filtered], { total: filtered.length })
    }) as ReleaseNotesReader['findAll']
  }
}

describe('collecting the scope', () => {
  it('pins the three class references it queries by literal', () => {
    // ⚠️ Renaming a descriptor key on the other side would not fail to compile
    // here — the query would simply match nothing and the notes would come out
    // empty.
    expect(REQUIREMENT_CLASS).toBe('requirements:masterTag:Requirement')
    expect(TRACE_LINK_CLASS).toBe('traceability:class:TraceLink')
    expect(ISSUE_CLASS).toBe('tracker:class:Issue')
  })

  it('reads requirements by `targetVersion` and issues by `delivered-in`', async () => {
    // 🔴 TWO CHANNELS BECAUSE THE SCHEMA HAS TWO. The `delivered-in` edge was
    // dropped for requirements in favour of the attribute, and the gate reads
    // the attribute too — reading only edges would leave 需求 permanently empty
    // while the gate blocked on those very requirements.
    const scope = await collectReleaseNotesScope(
      reader({
        [REQUIREMENT_CLASS as string]: [
          { _id: 'r-1', _class: REQUIREMENT_CLASS, targetVersion: VERSION, title: 'Export CSV', identifier: 'REQ-1' }
        ] as any,
        [TRACE_LINK_CLASS as string]: [
          { _id: 'e-1', _class: TRACE_LINK_CLASS, docA: 'i-1', docB: VERSION, kind: 'delivered-in', state: 'active' },
          { _id: 'e-2', _class: TRACE_LINK_CLASS, docA: 'i-1', docB: 'bug-9', kind: 'defect-of', state: 'active' }
        ] as any,
        [ISSUE_CLASS as string]: [{ _id: 'i-1', _class: ISSUE_CLASS, title: 'Fix crash', identifier: 'PRJ-1' }] as any
      }),
      VERSION
    )

    const doc = buildReleaseNotes(scope)
    expect(doc.sections).toEqual([
      { section: 'requirements', entries: [{ id: ref('r-1'), identifier: 'REQ-1', title: 'Export CSV' }] },
      { section: 'bug-fixes', entries: [{ id: ref('i-1'), identifier: 'PRJ-1', title: 'Fix crash' }] }
    ])
    expect(doc.restricted).toBe(false)
  })

  it('MEASURES restriction from the edges whose issue did not come back', async () => {
    // 🔴 The count of missing issues is computed and then discarded; only the
    // boolean survives.
    const scope = await collectReleaseNotesScope(
      reader({
        [TRACE_LINK_CLASS as string]: [
          { _id: 'e-1', _class: TRACE_LINK_CLASS, docA: 'i-1', docB: VERSION, kind: 'delivered-in', state: 'active' },
          { _id: 'e-2', _class: TRACE_LINK_CLASS, docA: 'i-2', docB: VERSION, kind: 'delivered-in', state: 'active' },
          { _id: 'e-3', _class: TRACE_LINK_CLASS, docA: 'i-3', docB: VERSION, kind: 'delivered-in', state: 'active' }
        ] as any,
        // Only one of the three is readable by this caller.
        [ISSUE_CLASS as string]: [{ _id: 'i-1', _class: ISSUE_CLASS, title: 'Visible' }] as any
      }),
      VERSION
    )
    expect(scope.restricted).toBe(true)
    expect(scope.candidates).toHaveLength(1)
    // Two were withheld — and nothing anywhere says "two".
    expect(JSON.stringify(buildReleaseNotes(scope))).not.toContain('2')
  })

  it('lets a caller OR in a restriction the browser cannot observe', async () => {
    // 🔴 CLIENT-SIDE DETECTION IS A LOWER BOUND. An unreadable requirement, or
    // an unreadable `delivered-in` edge, leaves no trace to compare against —
    // only the server has both views. `restrictedHint` carries its answer in.
    const rows = {
      [REQUIREMENT_CLASS as string]: [
        { _id: 'r-1', _class: REQUIREMENT_CLASS, targetVersion: VERSION, title: 'Visible' }
      ] as any
    }
    expect((await collectReleaseNotesScope(reader(rows), VERSION)).restricted).toBe(false)
    expect((await collectReleaseNotesScope(reader(rows), VERSION, { restrictedHint: true })).restricted).toBe(true)
  })

  it('never lets a `false` hint clear a restriction it actually observed', async () => {
    const scope = await collectReleaseNotesScope(
      reader({
        [TRACE_LINK_CLASS as string]: [
          { _id: 'e-1', _class: TRACE_LINK_CLASS, docA: 'i-1', docB: VERSION, kind: 'delivered-in', state: 'active' }
        ] as any,
        [ISSUE_CLASS as string]: [] as any
      }),
      VERSION,
      { restrictedHint: false }
    )
    expect(scope.restricted).toBe(true)
  })

  it('ignores edges of another kind, another version, or a retired state', async () => {
    const scope = await collectReleaseNotesScope(
      reader({
        [TRACE_LINK_CLASS as string]: [
          { _id: 'e-1', _class: TRACE_LINK_CLASS, docA: 'i-1', docB: 'other', kind: 'delivered-in', state: 'active' },
          { _id: 'e-2', _class: TRACE_LINK_CLASS, docA: 'i-2', docB: VERSION, kind: 'implements', state: 'active' },
          { _id: 'e-3', _class: TRACE_LINK_CLASS, docA: 'i-3', docB: VERSION, kind: 'delivered-in', state: 'retired' }
        ] as any,
        [ISSUE_CLASS as string]: [{ _id: 'i-1', _class: ISSUE_CLASS, title: 'Nope' }] as any
      }),
      VERSION
    )
    expect(scope.candidates).toEqual([])
    expect(scope.restricted).toBe(false)
  })

  it('accepts the second defect signal from the caller when it can resolve it', async () => {
    // ⚠️ Absent means "edge only", not "not a defect" — a misfiled line in an
    // EDITABLE document, which is recoverable.
    const rows = {
      [TRACE_LINK_CLASS as string]: [
        { _id: 'e-1', _class: TRACE_LINK_CLASS, docA: 'i-1', docB: VERSION, kind: 'delivered-in', state: 'active' }
      ] as any,
      [ISSUE_CLASS as string]: [{ _id: 'i-1', _class: ISSUE_CLASS, title: 'Crash', kind: 'task-type-bug' }] as any
    }
    const without = await collectReleaseNotesScope(reader(rows), VERSION)
    expect(buildReleaseNotes(without).sections[0].section).toBe('improvements')

    const withPredicate = await collectReleaseNotesScope(reader(rows), VERSION, {
      isDefect: (issue) => (issue as any).kind === 'task-type-bug'
    })
    expect(buildReleaseNotes(withPredicate).sections[0].section).toBe('bug-fixes')
  })

  it('never guesses the task-type signal on its own', async () => {
    // 🔴 PINS A DELIBERATE NON-IMPLEMENTATION, documented on
    // `ReleaseNotesScopeOptions.isDefect`. `models/tracker` seeds exactly one
    // `task.class.TaskType` (`tracker.taskTypes.Issue`, name 'Issue') under one
    // descriptor, so a workspace's "Bug" task type is a runtime document with a
    // `generateId()` ref and a free-form, user-editable `name` — there is no
    // stable literal to pin the way `ISSUE_CLASS` is pinned, and importing
    // `@hcengineering/tracker` would not supply one either.
    //
    // If this test ever starts failing, somebody added a heuristic (a name
    // match, a title match, a hard-coded TaskType id). It must not be here: an
    // issue whose task type is Bug but which carries no `defect-of` edge is
    // classified as an improvement, on purpose, and the caller's predicate is
    // the only way to change that.
    const scope = await collectReleaseNotesScope(
      reader({
        [TRACE_LINK_CLASS as string]: [
          { _id: 'e-1', _class: TRACE_LINK_CLASS, docA: 'i-1', docB: VERSION, kind: 'delivered-in', state: 'active' }
        ] as any,
        [ISSUE_CLASS as string]: [
          { _id: 'i-1', _class: ISSUE_CLASS, title: 'Bug: crash on save', kind: 'bug-task-type-id' }
        ] as any
      }),
      VERSION
    )
    expect(scope.candidates).toEqual([
      { id: 'i-1', objectClass: ISSUE_CLASS, title: 'Bug: crash on save', origin: 'work-item' }
    ])
    expect(buildReleaseNotes(scope).sections[0].section).toBe('improvements')
  })
})
