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

import type { Doc, Markup, Ref, Timestamp } from '@hcengineering/core'
import {
  MarkupNodeType,
  jsonToMarkup,
  markBold,
  nodeParagraph,
  nodeReference,
  nodeText,
  type MarkupNode
} from '@hcengineering/text-core'

/**
 * The three objects a defect may be raised against, per the V1 matrix
 * (`Bug --defect-of--> TestResult | TestCase | Requirement`).
 *
 * @public
 */
export type DefectTargetKind = 'TestResult' | 'TestCase' | 'Requirement'

/**
 * One reproduction step as it is rendered into the defect body.
 *
 * @public
 */
export interface DefectStep {
  index: number
  action: Markup
  testData?: Markup
  expectedResult: Markup
}

/**
 * Everything the defect body states, gathered by the command and passed here as
 * PLAIN DATA.
 *
 * 🔴 A data struct rather than "the command formats as it reads". The evidence
 * this body carries (which case revision, which build, which environment, who
 * ran it) is the entire point of raising the defect from a failure instead of by
 * hand, and a formatting function tangled up with four `findOne` calls cannot be
 * asserted against without a database. Keeping it pure is what lets the tests
 * pin the CONTENT rather than merely the fact that something was written.
 *
 * @public
 */
export interface DefectFacts {
  targetKind: DefectTargetKind
  target: Ref<Doc>
  targetClass: Ref<any>
  /** Human name of the thing that failed — result name, case name, requirement title. */
  targetTitle: string

  /** The test case behind the failure, when there is one. */
  caseName?: string
  /**
   * The frozen revision the verdict was reached against.
   *
   * 🔴 When a snapshot exists it is ALWAYS preferred over the live case, and
   * `snapshotUsed` records which one was read. A defect quoting today's case
   * text for yesterday's run is not evidence, it is a guess — the snapshot is
   * the only record of "this is the version the run was judged against".
   */
  caseVersion?: number
  snapshotUsed?: boolean
  steps?: DefectStep[]

  /** Free text from the person raising the defect. */
  actual?: string

  runName?: string
  build?: string
  environment?: string
  productVersion?: string
  executedBy?: string
  startedOn?: Timestamp
  finishedOn?: Timestamp

  /** Backlinks rendered as reference nodes, so the defect navigates back. */
  links?: Array<{ label: string, id: Ref<Doc>, objectClass: Ref<any> }>
}

/**
 * @public
 */
export interface DefectContent {
  title: string
  markup: Markup
}

function heading (text: string): MarkupNode {
  return { type: MarkupNodeType.heading, attrs: { level: 3 }, content: [nodeText(text)] }
}

function field (label: string, value: string): MarkupNode {
  return nodeParagraph(markBold(nodeText(`${label}: `)), nodeText(value))
}

/**
 * ISO-8601 in UTC, deliberately not a locale format.
 *
 * A defect body is read by whoever picks the bug up, which is routinely not the
 * person (or timezone) that filed it; a locale-formatted timestamp frozen into
 * the text would be ambiguous forever.
 */
function stamp (value: Timestamp): string {
  return new Date(value).toISOString()
}

/**
 * Markup carries a ProseMirror document, so a step body that is already markup
 * cannot simply be spliced in as text. V1 renders it as-is when it is plain and
 * falls back to the raw string otherwise: the alternative — parsing and merging
 * two ProseMirror trees — is a text-editor concern that does not belong in a
 * command, and the raw JSON is at worst ugly, never wrong.
 */
function plain (markup: Markup | undefined): string {
  if (markup === undefined || markup === '') return ''
  const trimmed = markup.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return markup
  try {
    return collectText(JSON.parse(trimmed))
  } catch {
    return markup
  }
}

function collectText (node: any): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(collectText).join(' ')
  if (typeof node.text === 'string') return node.text
  if (Array.isArray(node.content)) {
    return node.content
      .map(collectText)
      .filter((it: string) => it !== '')
      .join(' ')
  }
  return ''
}

/**
 * Compose the defect title and body from the gathered facts.
 *
 * The body always states, in this order: what failed, the reproduction steps
 * with their expected results, the observed result, and the execution context
 * (build / environment / product version / executor / timing). Sections with no
 * data are OMITTED rather than emitted empty — an empty "Build:" line reads as
 * "ran against no build", which is a claim the command cannot make.
 *
 * @public
 */
export function buildDefectContent (facts: DefectFacts): DefectContent {
  const title = `[${facts.targetKind}] ${facts.targetTitle}`

  const content: MarkupNode[] = []

  content.push(heading('Failure'))
  content.push(field('Source', `${facts.targetKind} ${facts.targetTitle}`))
  if (facts.caseName !== undefined) {
    content.push(field('Test case', facts.caseName))
  }
  if (facts.caseVersion !== undefined) {
    // The `(snapshot)` / `(live case)` marker is load bearing: it tells the
    // reader whether the steps below are the frozen revision the run was judged
    // against or today's text.
    content.push(
      field('Case revision', `v${facts.caseVersion} ${facts.snapshotUsed === true ? '(snapshot)' : '(live case)'}`)
    )
  }
  if (facts.runName !== undefined) {
    content.push(field('Test run', facts.runName))
  }

  if (facts.steps !== undefined && facts.steps.length > 0) {
    content.push(heading('Steps and expected result'))
    for (const step of facts.steps) {
      const parts: MarkupNode[] = [markBold(nodeText(`${step.index}. `)), nodeText(plain(step.action))]
      content.push(nodeParagraph(...parts))
      const data = plain(step.testData)
      if (data !== '') {
        content.push(field('   Test data', data))
      }
      content.push(field('   Expected', plain(step.expectedResult)))
    }
  }

  content.push(heading('Actual result'))
  content.push(nodeParagraph(nodeText(facts.actual !== undefined && facts.actual !== '' ? facts.actual : '—')))

  const context: MarkupNode[] = []
  if (facts.build !== undefined) context.push(field('Build', facts.build))
  if (facts.environment !== undefined) context.push(field('Environment', facts.environment))
  if (facts.productVersion !== undefined) context.push(field('Product version', facts.productVersion))
  if (facts.executedBy !== undefined) context.push(field('Executed by', facts.executedBy))
  if (facts.startedOn !== undefined) context.push(field('Started', stamp(facts.startedOn)))
  if (facts.finishedOn !== undefined) context.push(field('Finished', stamp(facts.finishedOn)))
  if (context.length > 0) {
    content.push(heading('Execution context'))
    content.push(...context)
  }

  if (facts.links !== undefined && facts.links.length > 0) {
    content.push(heading('Links'))
    for (const link of facts.links) {
      content.push(nodeParagraph(nodeReference({ id: link.id, label: link.label, objectclass: link.objectClass })))
    }
  }

  return { title, markup: jsonToMarkup({ type: MarkupNodeType.doc, content }) }
}
