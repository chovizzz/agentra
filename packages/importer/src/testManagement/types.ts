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
 * The JSON contract of the test-management import channel.
 *
 * The file is EITHER an object shaped like {@link TestManagementImportFile}, OR
 * a bare array of {@link TestCaseRecord} — the array form is exactly
 * `{ testCases: [...] }` with every option left at its default, which is what a
 * one-off export from a spreadsheet or a tracker usually looks like.
 *
 * The schema is deliberately source-agnostic: no field is named after any
 * particular tool. A record's STRUCTURAL fields are the fixed, documented set
 * listed on {@link TestCaseRecord}; **every other key is carried through
 * verbatim** into the case description as a metadata row, in file order. That
 * is what lets an exporter keep its own columns (reviewer, execution result,
 * source id, ...) without this package growing a branch per source.
 *
 * @public
 */
export interface TestManagementImportFile {
  /** The `TestProject` to import into. Found by name, created when absent. */
  project?: TestProjectSpec
  /**
   * A single suite every imported suite hangs under, so one import is one
   * visible subtree. Omit (or set `name` to `''`) to attach the per-record
   * suites directly to the project root.
   */
  rootSuite?: TestSuiteSpec
  testCases: TestCaseRecord[]
}

/**
 * @public
 */
export interface TestProjectSpec {
  name: string
  description?: string
  private?: boolean
}

/**
 * @public
 */
export interface TestSuiteSpec {
  name: string
  description?: string
}

/**
 * One test case.
 *
 * Every property below is STRUCTURAL — it is consumed into a typed attribute of
 * `TestCase` / `TestStep` and does NOT appear in the metadata table. Anything
 * else found on the record does appear there. Only {@link name} is required.
 *
 * @public
 */
export interface TestCaseRecord {
  /** `TestCase.name`. The only required field. */
  name: string
  /**
   * Name of the `TestSuite` this case belongs to, created on demand under the
   * root suite. Blank or absent puts the case straight in the root suite.
   */
  suite?: string
  /** Optional description for the suite named by {@link suite}. */
  suiteDescription?: string
  /**
   * A stable external identifier, stored as `TestCase.automationKey`.
   *
   * 🔴 ALSO THE RESUME KEY — SCOPED TO THE SUITE, AND NOT ASSUMED UNIQUE. The
   * n-th record carrying a given `code` inside a given suite is matched against
   * the n-th case the project already holds there, so a re-run skips what
   * landed and creates what did not — including the repeats that real exports
   * do contain (the 2953-record file this channel was built for had 134).
   *
   * ⚠️ It follows that the resume is only exact for a file whose ORDER is
   * stable; reordering a file that repeats a code inside one suite can pair a
   * record with a different existing case. Records without a `code` have no key
   * at all and are imported again on every run — the importer logs how many
   * such records it sees before it writes anything.
   */
  code?: string
  /** `Low` | `Medium` | `High` | `Urgent`, case-insensitive. Default `Medium`. */
  priority?: string
  /**
   * `Functional` | `Performance` | `Regression` | `Security` | `Smoke` |
   * `Usability`, case-insensitive. Default `Functional`.
   */
  type?: string
  /**
   * `Draft` | `ReadyForReview` | `FixReviewComments` | `Approved` | `Rejected`,
   * case-insensitive. Default `Draft`.
   *
   * ⚠️ This is the REVIEW lifecycle of the case, not the outcome of running it.
   * An execution outcome belongs to `TestResult.status` (`TestRunStatus`), on a
   * `TestRun` — it is not expressible here, and a source column holding one
   * should be left to fall through into the metadata table.
   */
  status?: string
  /** Markdown. `TestCase.preconditions`. `precondition` is accepted too. */
  preconditions?: string
  precondition?: string
  /** Explicit steps. Takes precedence over the flat {@link step} shorthand. */
  steps?: TestStepRecord[]
  /** Shorthand for a single step: its action. Markdown. */
  step?: string
  /** Shorthand for a single step: its test data. Markdown. */
  input?: string
  /** Shorthand for a single step: its expected result. Markdown. */
  expected?: string
  /**
   * Identifier of a tracker issue this case belongs to, e.g. `PLAUD-39`.
   *
   * Resolved against `Issue.identifier` in the workspace and rendered as a
   * clickable reference chip at the top of the case description, which the
   * platform's reference indexer turns into an `ActivityReference` on the issue
   * — so the link is navigable from both ends. An identifier that resolves to
   * nothing degrades to plain text; it is never dropped.
   *
   * 🔴 NOT A `TraceLink`, and that is not an omission. `traceLinkMatrix`
   * (`plugins/traceability/src/links.ts`) has no `TestCase -> Issue` edge in any
   * of its six kinds — `verifies` targets a `Requirement`, `defect-of` runs the
   * other way from a `Bug` — and `TestCase` carries no issue ref of its own.
   * Asserting one would mean widening the matrix, which belongs to the
   * traceability module, not to an importer.
   */
  linkedIssue?: string
  /** Markdown prepended to the generated metadata table, if any. */
  description?: string
  /** Extra columns. Rendered into the description metadata table, in order. */
  [key: string]: unknown
}

/**
 * @public
 */
export interface TestStepRecord {
  /** Markdown. */
  action?: string
  /** Markdown. */
  testData?: string
  /** Markdown. */
  expectedResult?: string
}

/**
 * @public
 */
export interface TestManagementImportOptions {
  /** Project name, overriding the file's own `project.name`. */
  projectName?: string
  /** Root suite name, overriding the file's own `rootSuite.name`. */
  rootSuiteName?: string
  /** Fallback `TestCase.status` for records that do not carry one. */
  defaultStatus?: string
  /** Fallback `TestCase.type` for records that do not carry one. */
  defaultType?: string
  /** Fallback `TestCase.priority` for records that do not carry one. */
  defaultPriority?: string
  /** Accounts to put on a newly created project. */
  accounts?: string[]
  /** Parse and report, write nothing. */
  dryRun?: boolean
  /** Stop after this many records. Useful for a smoke run. */
  limit?: number
  /** Log a progress line every N cases. Default 100. */
  progressEvery?: number
}

/**
 * @public
 */
export interface TestManagementImportResult {
  project: string
  suitesCreated: number
  suitesReused: number
  casesCreated: number
  casesSkipped: number
  /** Skipped cases whose missing steps this run filled in. */
  casesRepaired: number
  stepsCreated: number
  issuesLinked: number
  issuesUnresolved: string[]
}
