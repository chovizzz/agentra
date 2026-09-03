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
  type AccountUuid,
  type Class,
  type Doc,
  type Markup,
  type Mixin,
  type Blob as PlatformBlob,
  type Rank,
  type Ref,
  SortingOrder,
  type Space,
  type SpaceType,
  type TxOperations,
  generateId,
  makeCollabId
} from '@hcengineering/core'
import { makeRank } from '@hcengineering/rank'
import { type MarkupNode, MarkupNodeType, jsonToMarkup } from '@hcengineering/text'
import { markdownToMarkup } from '@hcengineering/text-markdown'
import tracker, { type Issue } from '@hcengineering/tracker'

import { type Logger } from '../importer/logger'
import { type FileUploader } from '../importer/uploader'
import {
  type TestCaseRecord,
  type TestManagementImportFile,
  type TestManagementImportOptions,
  type TestManagementImportResult,
  type TestStepRecord
} from './types'

/**
 * Ids of `@hcengineering/test-management`, spelled out rather than imported.
 *
 * 🔴 NOT AN OVERSIGHT. `@hcengineering/importer` deliberately does not depend on
 * the test-management descriptor package: this package is linked into the
 * import tool bundle, and every plugin it pulls in is bundled with it. The ids
 * below are what `plugin('testManagement', ...)` produces — `identify()` joins
 * the plugin id, the category and the key with `:` — so they are exactly the
 * strings the descriptor would hand back, and they are part of the persisted
 * model contract already (they appear verbatim in the `_class` column).
 *
 * ⚠️ If any of these ever fails to resolve, the create throws server side with
 * "class not found" rather than writing something wrong.
 */
const testManagement = {
  class: {
    TestProject: 'testManagement:class:TestProject' as Ref<Class<Doc>>,
    TestSuite: 'testManagement:class:TestSuite' as Ref<Class<Doc>>,
    TestCase: 'testManagement:class:TestCase' as Ref<Class<Doc>>,
    TestStep: 'testManagement:class:TestStep' as Ref<Class<Doc>>
  },
  ids: {
    NoParent: 'testManagement:ids:NoParent' as Ref<Doc>
  },
  spaceType: {
    DefaultProject: 'testManagement:spaceType:DefaultProject' as Ref<SpaceType>
  }
}

/**
 * `TestCasePriority`, `TestCaseType` and `TestCaseStatus` are NUMERIC enums
 * whose values are persisted verbatim, so the numbers — not the names — are the
 * contract. They are repeated here for the same reason as the ids above.
 */
const priorities: Record<string, number> = { low: 0, medium: 1, high: 2, urgent: 3 }
const types: Record<string, number> = {
  functional: 0,
  performance: 1,
  regression: 2,
  security: 3,
  smoke: 4,
  usability: 5
}
const statuses: Record<string, number> = {
  draft: 0,
  readyforreview: 1,
  fixreviewcomments: 2,
  approved: 3,
  rejected: 4
}

/**
 * Keys a {@link TestCaseRecord} consumes structurally. Everything else on a
 * record becomes a metadata row in the description — see the schema docs.
 */
const structuralKeys = new Set([
  'name',
  'suite',
  'suiteDescription',
  'code',
  'priority',
  'type',
  'status',
  'preconditions',
  'precondition',
  'steps',
  'step',
  'input',
  'expected',
  'linkedIssue',
  'description'
])

interface ExistingCase {
  id: Ref<Doc>
  steps: number
}

/**
 * The resume key of one case: its suite AND its `automationKey`.
 *
 * 🔴 THE SUITE IS PART OF THE KEY. Codes repeat across suites in real exports,
 * and a key that ignored the suite would match a record against a same-code
 * case in a DIFFERENT suite — skipping work that was never done and, if the
 * file is ever reordered, matching records to the wrong existing documents.
 */
function resumeKey (suite: Ref<Doc>, code: string): string {
  return `${suite}\u0000${code}`
}

function countSteps (record: TestCaseRecord): number {
  if (Array.isArray(record.steps)) return record.steps.length
  return record.step !== undefined || record.input !== undefined || record.expected !== undefined ? 1 : 0
}

/**
 * Cases already in the project, grouped by `automationKey`.
 *
 * 🔴 A LIST PER KEY, NOT ONE CASE PER KEY. `automationKey` is NOT unique in
 * practice: real exports repeat a code across suites, and sometimes inside one
 * suite (a 2953-record file used here carried 134 such rows). Keying the resume
 * on the bare code silently dropped every repeat — the import reported success
 * and 134 cases were simply missing. Counting instead answers the only question
 * a resume actually has: "the file wants N cases with this code and the project
 * has M — create the remaining N - M."
 */
type ExistingCases = Map<string, ExistingCase[]>

const EMPTY_MARKUP: Markup = jsonToMarkup({ type: MarkupNodeType.doc, content: [] })

/**
 * Enum name -> persisted number.
 *
 * 🔴 AN UNKNOWN NAME IS REPORTED, NOT SILENTLY DEFAULTED. These enums are
 * NUMERIC and their values are persisted verbatim, so a typo in a source column
 * ("Critical", "P1") would otherwise land every record on the fallback with
 * nothing in the log to say it happened.
 */
function lookup (
  table: Record<string, number>,
  value: string | undefined,
  fallback: number,
  onUnknown?: (value: string) => void
): number {
  if (value === undefined) return fallback
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '')
  if (key === '') return fallback
  const found = table[key]
  if (found === undefined) {
    onUnknown?.(value)
    return fallback
  }
  return found
}

function markdownToInlineMarkup (text: string | undefined): Markup | undefined {
  const trimmed = text?.trim()
  if (trimmed === undefined || trimmed === '') return undefined
  return jsonToMarkup(markdownToMarkup(trimmed))
}

function escapeCell (value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

function stringify (value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * Import test cases into `test-management` from a documented JSON file.
 *
 * See `./types.ts` for the file contract.
 *
 * @public
 */
export class TestManagementImporter {
  private readonly suites = new Map<string, Ref<Doc>>()
  private readonly issueByIdentifier = new Map<string, Ref<Issue> | null>()
  private readonly unknownValues = new Set<string>()
  private readonly seenCodes = new Map<string, number>()

  private readonly result: TestManagementImportResult = {
    project: '',
    suitesCreated: 0,
    suitesReused: 0,
    casesCreated: 0,
    casesSkipped: 0,
    casesRepaired: 0,
    stepsCreated: 0,
    issuesLinked: 0,
    issuesUnresolved: []
  }

  constructor (
    private readonly client: TxOperations,
    private readonly fileUploader: FileUploader,
    private readonly logger: Logger,
    private readonly options: TestManagementImportOptions = {}
  ) {}

  async importFile (path: string): Promise<TestManagementImportResult> {
    const { readFile } = await import('fs/promises')
    const raw = JSON.parse(await readFile(path, 'utf-8'))
    return await this.import(normalize(raw))
  }

  async import (file: TestManagementImportFile): Promise<TestManagementImportResult> {
    const projectName = this.options.projectName ?? file.project?.name
    if (projectName === undefined || projectName.trim() === '') {
      throw new Error('test-management import: a project name is required (--project or file.project.name)')
    }
    this.result.project = projectName

    const records = this.options.limit !== undefined ? file.testCases.slice(0, this.options.limit) : file.testCases
    this.logger.log(`test-management import: ${records.length} record(s) into project '${projectName}'`)

    if (this.options.dryRun === true) {
      const suiteNames = new Set(records.map((r) => (r.suite ?? '').trim()).filter((s) => s !== ''))
      this.logger.log(`dry run: ${suiteNames.size} suite(s), ${records.length} case(s); nothing written`)
      return this.result
    }

    const spaceId = await this.ensureProject(projectName, file.project?.description, file.project?.private === true)

    const rootSuiteName = this.options.rootSuiteName ?? file.rootSuite?.name ?? projectName
    const rootSuite =
      rootSuiteName.trim() === ''
        ? testManagement.ids.NoParent
        : await this.ensureSuite(spaceId, testManagement.ids.NoParent, rootSuiteName, file.rootSuite?.description)

    const existing = await this.loadExistingCases(spaceId)
    this.logger.log(`found ${existing.size} case(s) already in the project`)

    // 🔴 SAID OUT LOUD BEFORE THE FIRST WRITE. A record with no `code` has no
    // resume key, so re-running the import creates it a second time. That is the
    // documented contract, but "safe to re-run" is how a CLI reads, and a silent
    // extra copy in a QA library looks like a data bug rather than a choice.
    const codeless = records.filter((r) => typeof r.code !== 'string' || r.code.trim() === '').length
    if (codeless > 0) {
      this.logger.error(
        `test-management import: ${codeless} record(s) carry no 'code'; they cannot be deduplicated and WILL be duplicated if this import is run again`
      )
    }

    const progressEvery = this.options.progressEvery ?? 100
    let index = 0
    for (const record of records) {
      index++
      await this.importCase(record, spaceId, rootSuite, existing)
      if (index % progressEvery === 0) {
        this.logger.log(`... ${index}/${records.length} (created ${this.result.casesCreated})`)
      }
    }

    this.logger.log('test-management import finished', this.result)
    return this.result
  }

  private async importCase (
    record: TestCaseRecord,
    spaceId: Ref<Space>,
    rootSuite: Ref<Doc>,
    existing: ExistingCases
  ): Promise<void> {
    const name = (record.name ?? '').trim()
    if (name === '') {
      this.logger.error('test-management import: record without a name, skipped', record)
      this.result.casesSkipped++
      return
    }

    // The suite is resolved BEFORE the resume check, because the resume key
    // includes it — see {@link resumeKey}.
    const suiteName = (record.suite ?? '').trim()
    const suiteId =
      suiteName === '' ? rootSuite : await this.ensureSuite(spaceId, rootSuite, suiteName, record.suiteDescription)

    const code = typeof record.code === 'string' ? record.code.trim() : ''
    const key = code !== '' ? resumeKey(suiteId, code) : ''
    const seen = key !== '' ? (this.seenCodes.get(key) ?? 0) : 0
    if (key !== '') this.seenCodes.set(key, seen + 1)
    const already = key !== '' ? existing.get(key)?.[seen] : undefined
    if (already !== undefined) {
      this.result.casesSkipped++
      const expected = countSteps(record)
      if (already.steps === 0) {
        // Finish a case a previous run left half written rather than calling it done.
        const repaired = await this.createSteps(record, already.id, spaceId)
        if (repaired > 0) {
          this.result.casesRepaired++
          await this.client.updateDoc(testManagement.class.TestCase, spaceId, already.id, { steps: repaired } as any)
        }
      } else if (already.steps < expected) {
        // 🔴 REPORTED, NOT "REPAIRED". Steps carry no stable id, so appending
        // the difference cannot tell a missing step from one that is already
        // there — it would duplicate whatever DID land. Partial step writes are
        // rare enough (the case and its steps are written back to back) that
        // naming the case and letting a human decide beats a silent guess.
        this.logger.error(
          `test-management import: case '${already.id}' has ${already.steps} step(s), the file describes ${expected}; left untouched`
        )
      }
      return
    }

    const caseId = generateId<Doc>()
    const description = await this.buildDescription(record, caseId, spaceId)

    await this.client.addCollection(
      testManagement.class.TestCase,
      spaceId,
      suiteId,
      testManagement.class.TestSuite,
      'testCases',
      {
        name,
        description,
        // 🔴 `TestCase.assignee` is typed non-optional but the UI creates cases
        // with `null`; an import that invented an assignee would be lying about
        // who owns the case.
        assignee: null,
        type: lookup(types, record.type ?? this.options.defaultType, types.functional, (v) => {
          this.reportUnknown('type', v)
        }),
        priority: lookup(priorities, record.priority ?? this.options.defaultPriority, priorities.medium, (v) => {
          this.reportUnknown('priority', v)
        }),
        status: lookup(statuses, record.status ?? this.options.defaultStatus, statuses.draft, (v) => {
          this.reportUnknown('status', v)
        }),
        preconditions: markdownToInlineMarkup(record.preconditions ?? record.precondition),
        automationKey: code !== '' ? code : undefined,
        attachments: 0,
        comments: 0,
        steps: 0,
        snapshots: 0
      } as any,
      caseId as Ref<any>
    )

    await this.createSteps(record, caseId, spaceId)

    this.result.casesCreated++
  }

  private async createSteps (record: TestCaseRecord, caseId: Ref<Doc>, spaceId: Ref<Space>): Promise<number> {
    const steps: TestStepRecord[] =
      Array.isArray(record.steps) && record.steps.length > 0
        ? record.steps
        : [{ action: record.step, testData: record.input, expectedResult: record.expected }]

    // 🔴 Ranks are computed here, client side, chained off the previous one, and
    // the chain starts at `undefined` because a case created moments ago has no
    // steps yet. `RANK_AUTO` is NOT usable: `RankMiddleware.setRank` resolves it
    // from the last document of the class IN THE SPACE with no `attachedTo`
    // term, so every `TestStep` in the project would be ranked against some
    // other case's last step.
    let previous: Rank | undefined
    let created = 0
    for (const step of steps) {
      const action = markdownToInlineMarkup(step.action)
      const expectedResult = markdownToInlineMarkup(step.expectedResult)
      const testData = markdownToInlineMarkup(step.testData)
      if (action === undefined && expectedResult === undefined && testData === undefined) {
        continue
      }
      const rank = makeRank(previous, undefined)
      previous = rank
      await this.client.addCollection(
        testManagement.class.TestStep,
        spaceId,
        caseId,
        testManagement.class.TestCase,
        'steps',
        {
          rank,
          action: action ?? EMPTY_MARKUP,
          testData,
          expectedResult: expectedResult ?? EMPTY_MARKUP
        } as any
      )
      this.result.stepsCreated++
      created++
    }
    return created
  }

  /**
   * The case description: an optional prose block, an optional clickable
   * reference to the tracker issue the case belongs to, and a table of every
   * NON-structural key on the record.
   *
   * 🔴 THE TABLE IS WHERE UNMAPPED SOURCE COLUMNS SURVIVE. An execution outcome,
   * a reviewer, a source-system id — none of them has a typed home on
   * `TestCase`, and silently dropping them would make the import lossy in a way
   * nobody could detect afterwards.
   */
  private async buildDescription (
    record: TestCaseRecord,
    caseId: Ref<Doc>,
    spaceId: Ref<Space>
  ): Promise<Ref<PlatformBlob> | null> {
    const content: MarkupNode[] = []

    const prose = typeof record.description === 'string' ? record.description.trim() : ''
    if (prose !== '') {
      content.push(...(markdownToMarkup(prose).content ?? []))
    }

    const issueNode = await this.buildIssueReference(record)
    if (issueNode !== undefined) {
      content.push(issueNode)
    }

    const rows: Array<[string, string]> = []
    for (const [key, value] of Object.entries(record)) {
      if (structuralKeys.has(key)) continue
      const text = stringify(value).trim()
      if (text === '') continue
      rows.push([key, text])
    }
    if (rows.length > 0) {
      const md = ['| Field | Value |', '| --- | --- |']
      for (const [key, value] of rows) {
        md.push(`| ${escapeCell(key)} | ${escapeCell(value)} |`)
      }
      content.push(...(markdownToMarkup(md.join('\n')).content ?? []))
    }

    if (content.length === 0) {
      return null
    }

    const markup = jsonToMarkup({ type: MarkupNodeType.doc, content })
    const collabId = makeCollabId(testManagement.class.TestCase as Ref<Class<any>>, caseId, 'description')

    // 🔴 RETRIED HERE, not inside the uploader. `FrontFileUploader` is a bare
    // `fetch` with no retry, and this is the one HTTP call on a path that makes
    // thousands of them — a single transient 502 from the front would otherwise
    // abort an import that is 90% done.
    // One initial attempt plus two retries. A THROW counts as a failed attempt
    // too: `fetch` rejects on a dropped connection, and only the HTTP-level
    // failure comes back as `{ success: false }`.
    const attempts = 3
    let lastError = ''
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const uploaded = await this.fileUploader.uploadCollaborativeDoc(collabId, markup)
        if (uploaded.success) {
          void spaceId
          return uploaded.id
        }
        lastError = uploaded.error
      } catch (err: any) {
        lastError = err?.message ?? String(err)
      }
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
    throw new Error(`test-management import: failed to upload description of '${caseId}': ${lastError}`)
  }

  /** Reported once per distinct bad value; thousands of identical lines help nobody. */
  private reportUnknown (field: string, value: string): void {
    const key = `${field}=${value}`
    if (this.unknownValues.has(key)) return
    this.unknownValues.add(key)
    this.logger.error(`test-management import: unknown ${field} '${value}', using the default`)
  }

  /**
   * `linkedIssue` as a clickable chip.
   *
   * ⚠️ A REFERENCE NODE, NOT A `TraceLink`. The trace matrix
   * (`plugins/traceability/src/links.ts`) has no `TestCase -> Issue` edge in any
   * of its six kinds — `verifies` targets a `Requirement`, `defect-of` points
   * the other way from a `Bug` — and `TestCase` itself carries no issue ref. A
   * reference node is what the platform already renders as a live link and what
   * the reference indexer picks up, and it costs one cached lookup per
   * identifier instead of one server command per pair.
   */
  private async buildIssueReference (record: TestCaseRecord): Promise<MarkupNode | undefined> {
    const identifier = typeof record.linkedIssue === 'string' ? record.linkedIssue.trim() : ''
    if (identifier === '') return undefined

    const issue = await this.resolveIssue(identifier)
    // The chip is labelled with the IDENTIFIER, never with the issue title: the
    // title is a live field of another document and a copy of it here would rot
    // the moment somebody renames the issue. A record that carries the title as
    // an extra column keeps it — in the metadata table, where it reads as the
    // snapshot it is.
    const label = identifier

    if (issue === null) {
      if (!this.result.issuesUnresolved.includes(identifier)) {
        this.result.issuesUnresolved.push(identifier)
      }
      return {
        type: MarkupNodeType.paragraph,
        content: [{ type: MarkupNodeType.text, text: `Issue: ${identifier}` }]
      }
    }

    this.result.issuesLinked++
    return {
      type: MarkupNodeType.paragraph,
      content: [
        { type: MarkupNodeType.text, text: 'Issue: ' },
        {
          type: MarkupNodeType.reference,
          attrs: { id: issue, label, objectclass: tracker.class.Issue }
        }
      ]
    }
  }

  private async resolveIssue (identifier: string): Promise<Ref<Issue> | null> {
    const cached = this.issueByIdentifier.get(identifier)
    if (cached !== undefined) return cached
    const issue = await this.client.findOne(tracker.class.Issue, { identifier })
    const resolved = issue?._id ?? null
    this.issueByIdentifier.set(identifier, resolved)
    if (resolved === null) {
      this.logger.error(`test-management import: issue '${identifier}' not found, kept as plain text`)
    }
    return resolved
  }

  private async ensureProject (name: string, description: string | undefined, isPrivate: boolean): Promise<Ref<Space>> {
    const found = await this.client.findOne<Space>(testManagement.class.TestProject as Ref<Class<Space>>, { name })
    if (found !== undefined) {
      this.logger.log(`reusing existing test project '${name}'`)
      return found._id
    }

    const spaceType = await this.client.findOne(core.class.SpaceType, { _id: testManagement.spaceType.DefaultProject })
    if (spaceType?.targetClass === undefined) {
      throw new Error(
        `test-management import: space type '${testManagement.spaceType.DefaultProject}' is missing from the model`
      )
    }

    const accounts = (this.options.accounts ?? []) as AccountUuid[]
    const projectId = generateId<Space>()
    await this.client.createDoc(
      testManagement.class.TestProject as Ref<Class<Space>>,
      core.space.Space,
      {
        name,
        description: description ?? '',
        private: isPrivate,
        members: accounts,
        owners: accounts,
        archived: false,
        type: testManagement.spaceType.DefaultProject
      } as any,
      projectId
    )
    // The space type's mixin carries the role assignments. It is empty here —
    // but the mixin has to EXIST, or the project is not a valid typed space.
    await this.client.createMixin(
      projectId,
      testManagement.class.TestProject,
      core.space.Space,
      spaceType.targetClass as Ref<Mixin<Doc>>,
      {}
    )
    this.logger.log(`created test project '${name}' (${projectId})`)
    return projectId
  }

  private async ensureSuite (
    spaceId: Ref<Space>,
    parent: Ref<Doc>,
    name: string,
    description: string | undefined
  ): Promise<Ref<Doc>> {
    const cacheKey = `${parent}/${name}`
    const cached = this.suites.get(cacheKey)
    if (cached !== undefined) return cached

    const found = await this.client.findOne<Doc>(testManagement.class.TestSuite, {
      space: spaceId,
      parent,
      name
    } as any)
    if (found !== undefined) {
      this.suites.set(cacheKey, found._id)
      this.result.suitesReused++
      return found._id
    }

    const suiteId = generateId<Doc>()
    await this.client.createDoc(
      testManagement.class.TestSuite,
      spaceId,
      { name, description, parent, testCases: 0 } as any,
      suiteId
    )
    this.suites.set(cacheKey, suiteId)
    this.result.suitesCreated++
    return suiteId
  }

  /**
   * The cases already in the project, by `automationKey`.
   *
   * 🔴 THE STEP COUNT IS CARRIED ALONG ON PURPOSE. A case is created before its
   * steps, so an import killed between the two writes leaves a case with no
   * steps — and a resume keyed on "does the key exist" would skip it forever
   * and report the import complete. Knowing the count lets the resume finish
   * the job instead of hiding it. Read ONCE: thousands of individual existence
   * queries would cost more than the import itself.
   */
  private async loadExistingCases (spaceId: Ref<Space>): Promise<ExistingCases> {
    const cases: ExistingCases = new Map()
    const found = await this.client.findAll<Doc>(testManagement.class.TestCase, { space: spaceId } as any, {
      // The order is pinned so that the n-th record of a repeated code always
      // meets the same n-th document; an unordered `findAll` would let two runs
      // pair them up differently.
      projection: { automationKey: 1, steps: 1, attachedTo: 1 } as any,
      sort: { createdOn: SortingOrder.Ascending, _id: SortingOrder.Ascending } as any
    })
    for (const doc of found) {
      const code = (doc as any).automationKey
      const suite = (doc as any).attachedTo
      if (typeof code === 'string' && code !== '' && typeof suite === 'string') {
        const key = resumeKey(suite as Ref<Doc>, code)
        const bucket = cases.get(key)
        const entry: ExistingCase = { id: doc._id, steps: (doc as any).steps ?? 0 }
        if (bucket === undefined) cases.set(key, [entry])
        else bucket.push(entry)
      }
    }
    return cases
  }
}

/**
 * Accept both the object form and the bare-array shorthand.
 *
 * @public
 */
export function normalize (raw: unknown): TestManagementImportFile {
  if (Array.isArray(raw)) {
    return { testCases: raw as TestCaseRecord[] }
  }
  const file = raw as TestManagementImportFile
  if (file === null || typeof file !== 'object' || !Array.isArray(file.testCases)) {
    throw new Error('test-management import: expected an array of records or an object with a `testCases` array')
  }
  return file
}
