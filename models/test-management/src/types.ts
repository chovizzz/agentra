//
// Copyright © 2024 Hardcore Engineering Inc.
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

import type { Employee } from '@hcengineering/contact'
import type {
  Build,
  TestCase,
  TestCaseSnapshot,
  TestEnvironment,
  TestEnvironmentVariable,
  TestSuite,
  TestCaseType,
  TestCasePriority,
  TestCaseStatus,
  TestProject,
  TestRun,
  TestRunStatus,
  TestResult,
  TestPlan,
  TestPlanItem,
  TestStep,
  TestStepData,
  TestSnapshotAttachment
} from '@hcengineering/test-management'
import { type Attachment } from '@hcengineering/attachment'
import contact from '@hcengineering/contact'
import chunter from '@hcengineering/chunter'
import { getEmbeddedLabel } from '@hcengineering/platform'
import {
  DateRangeMode,
  IndexKind,
  type Doc,
  type Markup,
  type Rank,
  type RolesAssignment,
  type Role,
  type Ref,
  type Domain,
  type Timestamp,
  type Type,
  type CollectionSize,
  type MarkupBlobRef,
  type Class,
  type AccountUuid
} from '@hcengineering/core'
import {
  ArrOf,
  Mixin,
  Model,
  Prop,
  TypeRank,
  TypeRecord,
  TypeRef,
  UX,
  TypeBoolean,
  TypeMarkup,
  TypeNumber,
  Index,
  TypeCollaborativeDoc,
  TypeString,
  Collection,
  ReadOnly,
  TypeDate,
  Hidden
} from '@hcengineering/model'
import attachment from '@hcengineering/model-attachment'
import products, { type ProductVersion } from '@hcengineering/products'
import core, { TAttachedDoc, TDoc, TType, TTypedSpace } from '@hcengineering/model-core'

import testManagement from './plugin'

export { testManagementId } from '@hcengineering/test-management/src/index'

export const DOMAIN_TEST_MANAGEMENT = 'test-management' as Domain

/** @public */
export function TypeTestCaseType (): Type<TestCaseType> {
  return { _class: testManagement.class.TypeTestCaseType, label: testManagement.string.TestCaseType }
}

@Model(testManagement.class.TypeTestCaseType, core.class.Type, DOMAIN_TEST_MANAGEMENT)
@UX(testManagement.string.TestCaseType)
export class TTypeTestCaseType extends TType {}

/** @public */
export function TypeTestCasePriority (): Type<TestCasePriority> {
  return { _class: testManagement.class.TypeTestCasePriority, label: testManagement.string.TestCasePriority }
}

@Model(testManagement.class.TypeTestCasePriority, core.class.Type, DOMAIN_TEST_MANAGEMENT)
@UX(testManagement.string.TestCasePriority)
export class TTypeTestCasePriority extends TType {}

/** @public */
export function TypeTestCaseStatus (): Type<TestCaseStatus> {
  return { _class: testManagement.class.TypeTestCaseStatus, label: testManagement.string.TestCaseStatus }
}

@Model(testManagement.class.TypeTestCaseStatus, core.class.Type, DOMAIN_TEST_MANAGEMENT)
@UX(testManagement.string.TestCaseStatus)
export class TTypeTestCaseStatus extends TType {}

@Model(testManagement.class.TestProject, core.class.TypedSpace)
@UX(testManagement.string.TestProject)
export class TTestProject extends TTypedSpace implements TestProject {
  @Prop(TypeMarkup(), testManagement.string.FullDescription)
  @Index(IndexKind.FullText)
    fullDescription?: string
}

@Mixin(testManagement.mixin.DefaultProjectTypeData, testManagement.class.TestProject)
@UX(getEmbeddedLabel('Default project'), testManagement.icon.TestProject)
export class TDefaultProjectTypeData extends TTestProject implements RolesAssignment {
  [key: Ref<Role>]: AccountUuid[]
}

/**
 * @public
 */
@Model(testManagement.class.TestSuite, core.class.Doc, DOMAIN_TEST_MANAGEMENT)
@UX(testManagement.string.TestSuite, testManagement.icon.TestSuite, testManagement.string.TestSuite)
export class TTestSuite extends TDoc implements TestSuite {
  @Prop(TypeString(), testManagement.string.SuiteName)
  @Index(IndexKind.FullText)
    name!: string

  @Prop(TypeMarkup(), testManagement.string.SuiteDescription)
  @Index(IndexKind.FullText)
    description?: string

  @Prop(TypeRef(testManagement.class.TestSuite), testManagement.string.TestSuite)
    parent!: Ref<TestSuite>

  @Prop(Collection(testManagement.class.TestCase), testManagement.string.TestCases, {
    shortLabel: testManagement.string.TestCase
  })
    testCases?: CollectionSize<TestCase>

  declare space: Ref<TestProject>
}

/**
 * @public
 */
@Model(testManagement.class.TestCase, core.class.AttachedDoc, DOMAIN_TEST_MANAGEMENT)
@UX(testManagement.string.TestCase, testManagement.icon.TestCase, testManagement.string.TestCase)
export class TTestCase extends TAttachedDoc implements TestCase {
  @Prop(TypeRef(testManagement.class.TestProject), core.string.Space)
  @Index(IndexKind.Indexed)
  @Hidden()
  declare space: Ref<TestProject>

  @Prop(TypeRef(testManagement.class.TestSuite), core.string.AttachedTo)
  @Index(IndexKind.Indexed)
  declare attachedTo: Ref<TestSuite>

  @Prop(TypeRef(testManagement.class.TestSuite), core.string.AttachedToClass)
  @Index(IndexKind.Indexed)
  @Hidden()
  declare attachedToClass: Ref<Class<TestSuite>>

  @Prop(TypeString(), core.string.Collection)
  @Hidden()
  override collection: 'testCases' = 'testCases'

  @Prop(TypeString(), testManagement.string.TestName)
  @Index(IndexKind.FullText)
    name!: string

  @Prop(TypeCollaborativeDoc(), testManagement.string.FullDescription)
  @Index(IndexKind.FullText)
    description!: MarkupBlobRef | null

  @Prop(TypeTestCaseType(), testManagement.string.TestType)
  @ReadOnly()
    type!: TestCaseType

  @Prop(TypeTestCasePriority(), testManagement.string.TestPriority)
  @ReadOnly()
    priority!: TestCasePriority

  @Prop(TypeTestCaseStatus(), testManagement.string.TestStatus)
  @ReadOnly()
    status!: TestCaseStatus

  @Prop(TypeRef(contact.mixin.Employee), testManagement.string.TestAssignee)
    assignee!: Ref<Employee>

  @Prop(Collection(attachment.class.Attachment), attachment.string.Attachments, { shortLabel: attachment.string.Files })
    attachments?: CollectionSize<Attachment>

  @Prop(Collection(chunter.class.ChatMessage), chunter.string.Comments)
    comments?: number

  @Prop(TypeMarkup(), testManagement.string.Preconditions)
  @Index(IndexKind.FullText)
    preconditions?: Markup

  @Prop(TypeString(), testManagement.string.AutomationKey)
  @Index(IndexKind.Indexed)
    automationKey?: string

  @Prop(TypeNumber(), testManagement.string.Version)
  @ReadOnly()
    version?: number

  @Prop(Collection(testManagement.class.TestStep), testManagement.string.Steps, {
    shortLabel: testManagement.string.TestStep
  })
    steps?: CollectionSize<TestStep>

  @Prop(Collection(testManagement.class.TestCaseSnapshot), testManagement.string.Snapshots)
  @Hidden()
    snapshots?: CollectionSize<TestCaseSnapshot>
}

/**
 * ⚠️ `action` / `testData` / `expectedResult` are `TypeMarkup`, NOT
 * `TypeCollaborativeDoc`. See the note on the `TestStep` interface: a
 * collaborative field is one object-storage blob per field per save, with no
 * reclamation, and the step grid would mint hundreds of thousands of them.
 */
@Model(testManagement.class.TestStep, core.class.AttachedDoc, DOMAIN_TEST_MANAGEMENT)
@UX(testManagement.string.TestStep, testManagement.icon.TestStep)
export class TTestStep extends TAttachedDoc implements TestStep {
  @Prop(TypeRef(testManagement.class.TestCase), core.string.AttachedTo)
  @Index(IndexKind.Indexed)
  declare attachedTo: Ref<TestCase>

  @Prop(TypeRef(testManagement.class.TestCase), core.string.AttachedToClass)
  @Index(IndexKind.Indexed)
  @Hidden()
  declare attachedToClass: Ref<Class<TestCase>>

  @Prop(TypeRef(testManagement.class.TestProject), core.string.Space)
  @Index(IndexKind.Indexed)
  @Hidden()
  declare space: Ref<TestProject>

  @Prop(TypeString(), core.string.Collection)
  @Hidden()
  override collection: 'steps' = 'steps'

  @Prop(TypeRank(), core.string.Rank)
  @Index(IndexKind.Indexed)
  @Hidden()
    rank!: Rank

  @Prop(TypeMarkup(), testManagement.string.StepAction)
  @Index(IndexKind.FullText)
    action!: Markup

  @Prop(TypeMarkup(), testManagement.string.StepTestData)
    testData?: Markup

  @Prop(TypeMarkup(), testManagement.string.StepExpectedResult)
  @Index(IndexKind.FullText)
    expectedResult!: Markup
}

/**
 * An immutable frozen revision of a test case.
 *
 * There is deliberately NO editor and NO `ObjectEditor` mixin for this class:
 * the UI offers no way in, and `SnapshotGuardMiddleware`
 * (`server-plugins/test-management`) refuses every update / remove / mixin tx
 * that targets one, so the absence of an editor is a convenience rather than
 * the enforcement.
 */
@Model(testManagement.class.TestCaseSnapshot, core.class.AttachedDoc, DOMAIN_TEST_MANAGEMENT)
@UX(testManagement.string.TestCaseSnapshot)
export class TTestCaseSnapshot extends TAttachedDoc implements TestCaseSnapshot {
  @Prop(TypeRef(testManagement.class.TestCase), core.string.AttachedTo)
  @Index(IndexKind.Indexed)
  declare attachedTo: Ref<TestCase>

  @Prop(TypeRef(testManagement.class.TestCase), core.string.AttachedToClass)
  @Index(IndexKind.Indexed)
  @Hidden()
  declare attachedToClass: Ref<Class<TestCase>>

  @Prop(TypeRef(testManagement.class.TestProject), core.string.Space)
  @Index(IndexKind.Indexed)
  @Hidden()
  declare space: Ref<TestProject>

  @Prop(TypeString(), core.string.Collection)
  @Hidden()
  override collection: 'snapshots' = 'snapshots'

  /**
   * Indexed because `(attachedTo, version)` is the deduplication key every
   * `ensureTestCaseSnapshot` call probes before creating anything.
   */
  @Prop(TypeNumber(), testManagement.string.Version)
  @Index(IndexKind.Indexed)
  @ReadOnly()
    version!: number

  @Prop(TypeString(), testManagement.string.TestName)
  @ReadOnly()
    name!: string

  @Prop(TypeCollaborativeDoc(), testManagement.string.FullDescription)
  @ReadOnly()
    description!: MarkupBlobRef | null

  @Prop(TypeMarkup(), testManagement.string.Preconditions)
  @ReadOnly()
    preconditions?: Markup

  @Prop(TypeTestCaseType(), testManagement.string.TestType)
  @ReadOnly()
    type!: TestCaseType

  @Prop(TypeTestCasePriority(), testManagement.string.TestPriority)
  @ReadOnly()
    priority!: TestCasePriority

  // ⚠️ `@Hidden()` on both: there is no `AttributePresenter` registered for
  // `core.class.ArrOf` / `core.class.TypeRecord`, and `getAttributePresenter`
  // THROWS rather than degrading when it cannot find one. A snapshot has no
  // attribute bar today, but hiding them means adding one later cannot crash.
  @Prop(ArrOf(TypeRecord()), testManagement.string.Steps)
  @ReadOnly()
  @Hidden()
    steps!: TestStepData[]

  @Prop(ArrOf(TypeRecord()), attachment.string.Attachments)
  @ReadOnly()
  @Hidden()
    attachmentsMeta?: TestSnapshotAttachment[]
}

/** @public */
export function TypeTestEnvironmentVariables (): Type<TestEnvironmentVariable[]> {
  return {
    _class: testManagement.class.TypeTestEnvironmentVariables,
    label: testManagement.string.EnvironmentVariables
  }
}

@Model(testManagement.class.TypeTestEnvironmentVariables, core.class.Type, DOMAIN_TEST_MANAGEMENT)
@UX(testManagement.string.EnvironmentVariables)
export class TTypeTestEnvironmentVariables extends TType {}

/**
 * Archived, never deleted — a historical `TestRun.environment` ref must not
 * dangle.
 */
@Model(testManagement.class.TestEnvironment, core.class.Doc, DOMAIN_TEST_MANAGEMENT)
@UX(testManagement.string.TestEnvironment, testManagement.icon.TestEnvironment)
export class TTestEnvironment extends TDoc implements TestEnvironment {
  @Prop(TypeRef(testManagement.class.TestProject), core.string.Space)
  @Index(IndexKind.Indexed)
  @Hidden()
  declare space: Ref<TestProject>

  @Prop(TypeString(), testManagement.string.EnvironmentName)
  @Index(IndexKind.FullText)
    name!: string

  @Prop(TypeString(), testManagement.string.DescriptionPlaceholder)
    description?: string

  /**
   * ⚠️ NON-SENSITIVE display values only — no CI tokens, no credentials.
   *
   * Declared through {@link TypeTestEnvironmentVariables} rather than raw
   * `ArrOf(TypeRecord())` because a custom `Type` subclass is the only way to
   * hang an `AttributePresenter` on it, and `getAttributePresenter` THROWS when
   * a visible attribute has none. The underlying storage is still an array of
   * `{ key, value }` records — the platform's own `TypeRecord` shape, not an
   * untyped JSON blob.
   */
  @Prop(TypeTestEnvironmentVariables(), testManagement.string.EnvironmentVariables)
    variables?: TestEnvironmentVariable[]

  @Prop(TypeBoolean(), testManagement.string.Archived)
  @Index(IndexKind.Indexed)
    archived!: boolean
}

@Model(testManagement.class.Build, core.class.Doc, DOMAIN_TEST_MANAGEMENT)
@UX(testManagement.string.Build, testManagement.icon.Build)
export class TBuild extends TDoc implements Build {
  @Prop(TypeRef(testManagement.class.TestProject), core.string.Space)
  @Index(IndexKind.Indexed)
  @Hidden()
  declare space: Ref<TestProject>

  @Prop(TypeString(), testManagement.string.BuildName)
  @Index(IndexKind.FullText)
    name!: string

  /**
   * 🔴 The idempotent match key, `${provider}:${pipelineId}`. Indexed because
   * `ensureBuild` probes `(space, externalKey)` on every CI ingest.
   * NOT `commitSha`: one commit yields many CI runs.
   */
  @Prop(TypeString(), testManagement.string.ExternalKey)
  @Index(IndexKind.Indexed)
    externalKey!: string

  @Prop(TypeRef(products.class.ProductVersion), testManagement.string.ProductVersion)
  @Index(IndexKind.Indexed)
    productVersion?: Ref<ProductVersion>

  @Prop(TypeString(), testManagement.string.CommitSha)
  @Index(IndexKind.Indexed)
    commitSha?: string

  /** ⚠️ A URL only. CI tokens are never persisted here. */
  @Prop(TypeString(), testManagement.string.CiUrl)
    ciUrl?: string

  @Prop(TypeDate(DateRangeMode.DATETIME), testManagement.string.StartedOn)
    createdOnCi?: Timestamp
}

@Model(testManagement.class.TestRun, core.class.Doc, DOMAIN_TEST_MANAGEMENT)
@UX(testManagement.string.TestRun)
export class TTestRun extends TDoc implements TestRun {
  @Prop(TypeString(), testManagement.string.TestRunName)
  @Index(IndexKind.FullText)
    name!: string

  @Prop(TypeCollaborativeDoc(), testManagement.string.FullDescription)
  @Index(IndexKind.FullText)
    description!: MarkupBlobRef | null

  @Prop(TypeDate(DateRangeMode.DATETIME), testManagement.string.DueDate)
    dueDate?: Timestamp

  @Prop(Collection(testManagement.class.TestResult), testManagement.string.TestResult, {
    shortLabel: testManagement.string.TestResult
  })
    results?: CollectionSize<TestResult>

  //
  // Execution context. FLAT, and every ref is `@Index(Indexed)` so it can carry
  // a `ClassFilters` entry and an `orderBy` term — both of which address
  // top-level attribute names only. A nested `TestRunContext` object would be
  // invisible to all three mechanisms.
  //
  @Prop(TypeRef(testManagement.class.TestPlan), testManagement.string.TestPlan)
  @Index(IndexKind.Indexed)
    testPlan?: Ref<TestPlan>

  @Prop(TypeRef(products.class.ProductVersion), testManagement.string.ProductVersion)
  @Index(IndexKind.Indexed)
    productVersion?: Ref<ProductVersion>

  @Prop(TypeRef(testManagement.class.Build), testManagement.string.Build)
  @Index(IndexKind.Indexed)
    build?: Ref<Build>

  @Prop(TypeRef(testManagement.class.TestEnvironment), testManagement.string.TestEnvironment)
  @Index(IndexKind.Indexed)
    environment?: Ref<TestEnvironment>

  /**
   * ⚠️ `TypeRef(core.class.Doc)` rather than the cycle class: the cycle module
   * is owned by another workstream and a hard dependency would couple the two
   * packages' build graphs. Narrow this once they are wired together.
   */
  @Prop(TypeRef(core.class.Doc), testManagement.string.Cycle)
  @Index(IndexKind.Indexed)
    cycle?: Ref<Doc>

  @Prop(TypeRef(contact.mixin.Employee), testManagement.string.ExecutedBy)
  @Index(IndexKind.Indexed)
    executedBy?: Ref<Employee>

  @Prop(TypeDate(DateRangeMode.DATETIME), testManagement.string.StartedOn)
    startedOn?: Timestamp

  @Prop(TypeDate(DateRangeMode.DATETIME), testManagement.string.FinishedOn)
    finishedOn?: Timestamp

  @Prop(TypeString(), testManagement.string.ExternalRunId)
  @Index(IndexKind.Indexed)
    externalRunId?: string
}

/** @public */
export function TypeTestRunStatus (): Type<TestRunStatus> {
  return { _class: testManagement.class.TypeTestRunStatus, label: testManagement.string.TestRunStatus }
}

@Model(testManagement.class.TypeTestRunStatus, core.class.Type, DOMAIN_TEST_MANAGEMENT)
@UX(testManagement.string.TestRunStatus)
export class TTypeTestRunStatus extends TType {}

// TODO: Refactor to associations
@Model(testManagement.class.TestResult, core.class.AttachedDoc, DOMAIN_TEST_MANAGEMENT)
@UX(testManagement.string.TestResult)
export class TTestResult extends TAttachedDoc implements TestResult {
  @Prop(TypeRef(testManagement.class.TestRun), core.string.AttachedTo)
  @Index(IndexKind.Indexed)
  declare attachedTo: Ref<TestRun>

  @Prop(TypeRef(testManagement.class.TestRun), core.string.AttachedToClass)
  @Index(IndexKind.Indexed)
  @Hidden()
  declare attachedToClass: Ref<Class<TestRun>>

  @Prop(TypeRef(testManagement.class.TestProject), core.string.Space)
  @Index(IndexKind.Indexed)
  @Hidden()
  declare space: Ref<TestProject>

  @Prop(TypeString(), core.string.Collection)
  @Hidden()
  override collection: 'results' = 'results'

  @Prop(TypeString(), testManagement.string.TestRunName)
  @Index(IndexKind.FullText)
    name!: string

  @Prop(TypeCollaborativeDoc(), testManagement.string.FullDescription)
  @Index(IndexKind.FullText)
    description!: MarkupBlobRef | null

  @Prop(TypeRef(testManagement.class.TestCase), testManagement.string.TestCase)
    testCase!: Ref<TestCase>

  @Prop(TypeRef(testManagement.class.TestCaseSnapshot), testManagement.string.TestCaseSnapshot)
  @Index(IndexKind.Indexed)
  @ReadOnly()
    snapshot?: Ref<TestCaseSnapshot>

  @Prop(TypeRef(testManagement.class.TestSuite), testManagement.string.TestSuite)
  @Index(IndexKind.Indexed)
    testSuite?: Ref<TestSuite>

  @Prop(TypeTestRunStatus(), testManagement.string.TestRunStatus)
  @Index(IndexKind.Indexed)
    status?: TestRunStatus

  // A plain string rather than a custom `Type` subclass on purpose: a custom
  // Type would need its own `AttributePresenter` registration or
  // `getAttributePresenter` THROWS (it does not degrade), and there is nothing
  // to present here beyond the text.
  @Prop(TypeString(), testManagement.string.BlockedReason)
  @Index(IndexKind.FullText)
    blockedReason?: string

  @Prop(TypeRef(contact.mixin.Employee), testManagement.string.TestAssignee)
  @Index(IndexKind.Indexed)
    assignee?: Ref<Employee>

  @Prop(Collection(attachment.class.Attachment), attachment.string.Attachments, { shortLabel: attachment.string.Files })
    attachments?: CollectionSize<Attachment>

  @Prop(Collection(chunter.class.ChatMessage), chunter.string.Comments)
    comments?: number
}

@Model(testManagement.class.TestPlan, core.class.Doc, DOMAIN_TEST_MANAGEMENT)
@UX(testManagement.string.TestPlan)
export class TTestPlan extends TDoc implements TestPlan {
  @Prop(TypeString(), testManagement.string.Name)
  @Index(IndexKind.FullText)
    name!: string

  @Prop(TypeCollaborativeDoc(), testManagement.string.FullDescription)
  @Index(IndexKind.FullText)
    description!: MarkupBlobRef | null

  @Prop(Collection(testManagement.class.TestPlanItem), testManagement.string.TestCase, {
    shortLabel: testManagement.string.TestCase
  })
    results?: CollectionSize<TestPlanItem>
}

@Model(testManagement.class.TestPlanItem, core.class.AttachedDoc, DOMAIN_TEST_MANAGEMENT)
@UX(testManagement.string.TestCase)
export class TTestPlanItem extends TAttachedDoc implements TestPlanItem {
  @Prop(TypeRef(testManagement.class.TestPlan), core.string.AttachedTo)
  @Index(IndexKind.Indexed)
  declare attachedTo: Ref<TestPlan>

  @Prop(TypeRef(testManagement.class.TestPlan), core.string.AttachedToClass)
  @Index(IndexKind.Indexed)
  @Hidden()
  declare attachedToClass: Ref<Class<TestPlan>>

  @Prop(TypeRef(testManagement.class.TestProject), core.string.Space)
  @Index(IndexKind.Indexed)
  @Hidden()
  declare space: Ref<TestProject>

  @Prop(TypeString(), core.string.Collection)
  @Hidden()
  override collection: 'items' = 'items'

  @Prop(TypeRef(testManagement.class.TestCase), testManagement.string.TestCase)
    testCase!: Ref<TestCase>

  @Prop(TypeRef(testManagement.class.TestCaseSnapshot), testManagement.string.TestCaseSnapshot)
  @Index(IndexKind.Indexed)
  @ReadOnly()
    snapshot?: Ref<TestCaseSnapshot>

  @Prop(TypeRef(testManagement.class.TestSuite), testManagement.string.TestSuite)
  @Index(IndexKind.Indexed)
    testSuite?: Ref<TestSuite>

  @Prop(TypeRef(contact.mixin.Employee), testManagement.string.TestAssignee)
  @Index(IndexKind.Indexed)
    assignee?: Ref<Employee>
}
