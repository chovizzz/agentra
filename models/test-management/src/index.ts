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

import activity from '@hcengineering/activity'
import chunter from '@hcengineering/chunter'
import core from '@hcengineering/model-core'
import { AccountRole, SortingOrder, type FindOptions } from '@hcengineering/core'

import { type Builder } from '@hcengineering/model'
import view, { createAction } from '@hcengineering/model-view'
import workbench from '@hcengineering/model-workbench'
import print from '@hcengineering/model-print'
import tracker from '@hcengineering/model-tracker'
import { type ViewOptionsModel } from '@hcengineering/view'
import contact from '@hcengineering/contact'
import traceability from '@hcengineering/traceability'

import { testManagementId, type TestPlanItem, type TestResult } from '@hcengineering/test-management'

import {
  DOMAIN_TEST_MANAGEMENT,
  TBuild,
  TTypeTestCaseType,
  TTypeTestCasePriority,
  TTypeTestCaseStatus,
  TTypeTestEnvironmentVariables,
  TTestProject,
  TTestSuite,
  TTestCase,
  TTestCaseSnapshot,
  TTestEnvironment,
  TTestStep,
  TDefaultProjectTypeData,
  TTestRun,
  TTypeTestRunStatus,
  TTestResult,
  TTestPlan,
  TTestPlanItem
} from './types'

import testManagement from './plugin'
import { definePresenters } from './presenters'
import { definePermissions } from './permissions'
import { roles } from './roles'

export { testManagementId } from '@hcengineering/test-management/src/index'

function defineApplication (builder: Builder): void {
  builder.createDoc(
    workbench.class.Application,
    core.space.Model,
    {
      label: testManagement.string.TestManagementApplication,
      icon: testManagement.icon.TestManagementApplication,
      alias: testManagementId,
      hidden: false,
      navigatorModel: {
        spaces: [
          {
            id: 'projects',
            label: testManagement.string.Projects,
            spaceClass: testManagement.class.TestProject,
            addSpaceLabel: testManagement.string.CreateProject,
            createComponent: testManagement.component.CreateProject,
            icon: testManagement.icon.Home,
            specials: [
              {
                id: 'library',
                label: testManagement.string.TestLibrary,
                icon: testManagement.icon.TestLibrary,
                component: workbench.component.SpecialView,
                componentProps: {
                  _class: testManagement.class.TestCase,
                  icon: testManagement.icon.TestLibrary,
                  label: testManagement.string.TestLibrary
                },
                navigationModel: {
                  navigationComponent: view.component.FoldersBrowser,
                  navigationComponentLabel: testManagement.string.TestSuites,
                  navigationComponentIcon: testManagement.icon.TestSuites,
                  mainComponentLabel: testManagement.string.TestCases,
                  mainComponentIcon: testManagement.icon.TestCases,
                  createComponent: testManagement.component.CreateTestSuite,
                  mainHeaderComponent: testManagement.component.RunButton,
                  navigationComponentProps: {
                    _class: testManagement.class.TestSuite,
                    icon: testManagement.icon.TestSuites,
                    title: testManagement.string.TestSuites,
                    createLabel: testManagement.string.CreateTestSuite,
                    createComponent: testManagement.component.CreateTestSuite,
                    titleKey: 'name',
                    parentKey: 'parent',
                    noParentId: testManagement.ids.NoParent,
                    getFolderLink: testManagement.function.GetTestSuiteLink,
                    allObjectsLabel: testManagement.string.AllTestSuites,
                    allObjectsIcon: testManagement.icon.TestSuites
                  },
                  syncWithLocationQuery: true
                }
              },
              {
                id: 'testPlans',
                label: testManagement.string.TestPlans,
                icon: testManagement.icon.TestPlans,
                component: workbench.component.SpecialView,
                componentProps: {
                  _class: testManagement.class.TestPlanItem,
                  icon: testManagement.icon.TestPlans,
                  label: testManagement.string.TestPlans,
                  createButton: testManagement.component.CreateTestPlanButton
                },
                navigationModel: {
                  navigationComponent: view.component.FoldersBrowser,
                  navigationComponentLabel: testManagement.string.TestPlan,
                  navigationComponentIcon: testManagement.icon.TestPlans,
                  mainComponentLabel: testManagement.string.TestCase,
                  mainComponentIcon: testManagement.icon.TestCase,
                  mainHeaderComponent: testManagement.component.RunTestPlanButton,
                  navigationComponentProps: {
                    _class: testManagement.class.TestPlan,
                    icon: testManagement.icon.TestPlans,
                    title: testManagement.string.TestPlans,
                    titleKey: 'name',
                    getFolderLink: testManagement.function.GetTestPlanLink,
                    plainList: true
                  },
                  syncWithLocationQuery: true
                }
              },
              {
                id: 'testRuns',
                label: testManagement.string.TestRuns,
                icon: testManagement.icon.TestRuns,
                component: workbench.component.SpecialView,
                componentProps: {
                  _class: testManagement.class.TestResult,
                  icon: testManagement.icon.TestRuns,
                  label: testManagement.string.TestRuns,
                  createButton: testManagement.component.CreateTestRunButton
                },
                navigationModel: {
                  navigationComponent: view.component.FoldersBrowser,
                  navigationComponentLabel: testManagement.string.TestRun,
                  navigationComponentIcon: testManagement.icon.TestRuns,
                  mainComponentLabel: testManagement.string.TestResults,
                  mainComponentIcon: testManagement.icon.TestResult,
                  mainHeaderComponent: testManagement.component.TestRunHeader,
                  navigationComponentProps: {
                    _class: testManagement.class.TestRun,
                    icon: testManagement.icon.TestRuns,
                    title: testManagement.string.TestSuites,
                    titleKey: 'name',
                    getFolderLink: testManagement.function.GetTestRunLink,
                    plainList: true
                  },
                  syncWithLocationQuery: true
                }
              }
            ]
          }
        ]
      },
      navHeaderComponent: testManagement.component.TestManagementSpaceHeader
    },
    testManagement.app.TestManagement
  )
}

export function createModel (builder: Builder): void {
  builder.createModel(
    TTypeTestCaseType,
    TTypeTestCasePriority,
    TTypeTestCaseStatus,
    TTestProject,
    TTestSuite,
    TTestCase,
    TDefaultProjectTypeData,
    TTestRun,
    TTypeTestRunStatus,
    TTestResult,
    TTestPlan,
    TTestPlanItem,
    TTestStep,
    TTestCaseSnapshot,
    TTypeTestEnvironmentVariables,
    TTestEnvironment,
    TBuild
  )

  builder.mixin(testManagement.class.TestProject, core.class.Class, activity.mixin.ActivityDoc, {})

  builder.createDoc(activity.class.ActivityExtension, core.space.Model, {
    ofClass: testManagement.class.TestProject,
    components: { input: { component: chunter.component.ChatMessageInput } }
  })

  defineTestSuite(builder)
  defineTestCase(builder)
  defineTestStep(builder)
  defineTestCaseSnapshot(builder)
  defineTestEnvironment(builder)
  defineBuild(builder)
  defineTestRun(builder)
  defineTestResult(builder)
  defineTestPlan(builder)

  definePresenters(builder)

  defineApplication(builder)
  builder.createDoc(
    core.class.ModulePermissionGroup,
    core.space.Model,
    {
      application: testManagement.app.TestManagement,
      role: AccountRole.Guest,
      permissions: [],
      spaceClass: testManagement.class.TestProject,
      enabled: false,
      order: 70
    },
    testManagement.ids.ModulePermissionGroup
  )

  builder.createDoc(
    core.class.ModulePermissionGroup,
    core.space.Model,
    {
      application: testManagement.app.TestManagement,
      role: AccountRole.ReadOnlyGuest,
      permissions: [],
      spaceClass: testManagement.class.TestProject,
      enabled: false,
      order: 70
    },
    testManagement.ids.ModulePermissionGroupReadOnlyGuest
  )

  builder.mixin(testManagement.class.TestCase, core.class.Class, view.mixin.ObjectIcon, {
    component: testManagement.component.TestCaseStatusPresenter
  })

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_TEST_MANAGEMENT,
    disabled: [
      { space: 1 },
      { attachedToClass: 1 },
      { status: 1 },
      { project: 1 },
      { priority: 1 },
      { assignee: 1 },
      { sprint: 1 },
      { component: 1 },
      { category: 1 },
      { modifiedOn: 1 },
      { modifiedBy: 1 },
      { createdBy: 1 },
      { relations: 1 },
      { milestone: 1 },
      { createdOn: -1 }
    ]
  })

  definePermissions(builder)
  defineSpaceType(builder)
}

function defineSpaceType (builder: Builder): void {
  builder.createDoc(
    core.class.SpaceTypeDescriptor,
    core.space.Model,
    {
      name: testManagement.string.TestProject,
      description: testManagement.string.FullDescription,
      icon: testManagement.icon.TestProject,
      baseClass: testManagement.class.TestProject,
      availablePermissions: [
        core.permission.UpdateSpace,
        core.permission.ArchiveSpace,
        core.permission.ForbidDeleteObject,
        testManagement.permission.ManageTestAssets
      ]
    },
    testManagement.descriptors.ProjectType
  )

  builder.createDoc(
    core.class.SpaceType,
    core.space.Model,
    {
      name: 'Default Test Management',
      descriptor: testManagement.descriptors.ProjectType,
      roles: roles.length,
      targetClass: testManagement.mixin.DefaultProjectTypeData
    },
    testManagement.spaceType.DefaultProject
  )

  // 🔴 `roles` MUST STAY IN SYNC WITH `SpaceType.roles`. `Role` is an
  // `AttachedDoc` with `collection: 'roles'`, and the space type carries the
  // count denormalised; a mismatch makes the settings UI render the wrong
  // number of member pickers, which is how a role silently becomes
  // unassignable. `models/products` and `models/controlled-documents` write
  // the same `roles.length` for the same reason.
  for (const role of roles) {
    builder.createDoc(
      core.class.Role,
      core.space.Model,
      {
        attachedTo: testManagement.spaceType.DefaultProject,
        attachedToClass: core.class.SpaceType,
        collection: 'roles',
        name: role.name,
        permissions: role.permissions
      },
      role._id
    )
  }
}

function defineTestSuite (builder: Builder): void {
  builder.mixin(testManagement.class.TestSuite, core.class.Class, activity.mixin.ActivityDoc, {})

  builder.createDoc(activity.class.ActivityExtension, core.space.Model, {
    ofClass: testManagement.class.TestSuite,
    components: { input: { component: chunter.component.ChatMessageInput } }
  })

  builder.mixin(testManagement.class.TestSuite, core.class.Class, view.mixin.ObjectEditor, {
    editor: testManagement.component.EditTestSuite
  })

  builder.mixin(testManagement.class.TestSuite, core.class.Class, view.mixin.ObjectPanel, {
    component: testManagement.component.EditTestSuite
  })

  builder.mixin(testManagement.class.TestSuite, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: testManagement.component.TestSuitePresenter
  })

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: testManagement.class.TestSuite,
      descriptor: view.viewlet.Table,
      config: ['', 'description'],
      configOptions: {
        strict: true
      }
    },
    testManagement.viewlet.TableTestSuites
  )

  // Actions

  builder.mixin(testManagement.class.TestSuite, core.class.Class, view.mixin.IgnoreActions, {
    actions: [print.action.Print, tracker.action.EditRelatedTargets, tracker.action.NewRelatedIssue]
  })

  createAction(
    builder,
    {
      action: testManagement.actionImpl.CreateChildTestSuite,
      label: testManagement.string.CreateTestSuite,
      icon: testManagement.icon.TestSuite,
      category: testManagement.category.TestSuite,
      input: 'none',
      target: testManagement.class.TestSuite,
      context: {
        mode: ['context', 'browser'],
        application: testManagement.app.TestManagement,
        group: 'create'
      }
    },
    testManagement.action.CreateChildTestSuite
  )

  createAction(
    builder,
    {
      action: testManagement.actionImpl.RunSelectedTests,
      label: testManagement.string.RunTestCases,
      icon: testManagement.icon.Run,
      category: testManagement.category.TestCase,
      input: 'selection',
      target: testManagement.class.TestCase,
      context: {
        mode: ['context'],
        application: testManagement.app.TestManagement,
        group: 'create'
      }
    },
    testManagement.action.RunSelectedTests
  )

  // `verifies` entry point 3. `input: 'selection'` is what makes it the BULK
  // entry; the two detail-page buttons cover the single-object case.
  createAction(
    builder,
    {
      action: testManagement.actionImpl.LinkVerifies,
      label: traceability.string.LinkVerifies,
      icon: traceability.icon.TraceLink,
      category: testManagement.category.TestCase,
      input: 'selection',
      target: testManagement.class.TestCase,
      context: {
        mode: ['context'],
        application: testManagement.app.TestManagement,
        group: 'associate'
      }
    },
    testManagement.action.LinkVerifies
  )

  createAction(
    builder,
    {
      action: testManagement.actionImpl.EditProject,
      label: testManagement.string.EditProject,
      icon: contact.icon.Edit,
      input: 'focus',
      category: testManagement.category.TestProject,
      target: testManagement.class.TestProject,
      visibilityTester: view.function.CanEditSpace,
      query: {},
      context: {
        mode: ['context', 'browser'],
        group: 'edit'
      }
    },
    testManagement.action.EditProject
  )
}

function defineTestCase (builder: Builder): void {
  builder.mixin(testManagement.class.TestCase, core.class.Class, activity.mixin.ActivityDoc, {})

  builder.createDoc(activity.class.ActivityExtension, core.space.Model, {
    ofClass: testManagement.class.TestCase,
    components: { input: { component: chunter.component.ChatMessageInput } }
  })

  builder.mixin(testManagement.class.TestCase, core.class.Class, view.mixin.ObjectEditor, {
    editor: testManagement.component.EditTestCase
  })

  builder.mixin(testManagement.class.TestCase, core.class.Class, view.mixin.ObjectPanel, {
    component: testManagement.component.EditTestCase
  })

  builder.mixin(testManagement.class.TestCase, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: testManagement.component.TestCasePresenter
  })

  builder.mixin(testManagement.class.TypeTestCaseStatus, core.class.Class, view.mixin.AttributeFilter, {
    component: view.component.ValueFilter
  })

  builder.mixin(testManagement.class.TestSuite, core.class.Class, view.mixin.AttributePresenter, {
    presenter: testManagement.component.TestSuiteRefPresenter
  })

  builder.mixin(testManagement.class.TestCase, core.class.Class, view.mixin.ClassFilters, {
    filters: ['priority', 'status'],
    ignoreKeys: ['createdBy', 'modifiedBy', 'createdOn', 'modifiedOn', 'name']
  })

  const viewOptions: ViewOptionsModel = {
    groupBy: ['attachedTo'],
    orderBy: [
      ['status', SortingOrder.Ascending],
      ['modifiedOn', SortingOrder.Descending],
      ['createdOn', SortingOrder.Descending]
    ],
    other: [
      {
        key: 'shouldShowAll',
        type: 'toggle',
        defaultValue: false,
        actionTarget: 'category',
        action: view.function.ShowEmptyGroups,
        label: view.string.ShowEmptyGroups
      }
    ]
  }

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: testManagement.class.TestCase,
      descriptor: view.viewlet.List,
      configOptions: {
        strict: true,
        hiddenKeys: ['title']
      },
      config: [
        { key: '', displayProps: { fixed: 'left' } },
        {
          key: 'status',
          props: { kind: 'list', size: 'small', shouldShowName: false },
          displayProps: { key: 'status', fixed: 'left' }
        },
        { key: '', displayProps: { grow: true } },
        { key: 'modifiedOn', displayProps: { key: 'modified', fixed: 'right', dividerBefore: true } },
        {
          key: 'assignee',
          props: { kind: 'list', shouldShowName: false, avatarSize: 'x-small' },
          displayProps: { key: 'assignee', fixed: 'right' }
        }
      ],
      viewOptions
    },
    testManagement.viewlet.ListTestCase
  )

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: testManagement.class.TestCase,
      descriptor: view.viewlet.Table,
      config: ['', { key: 'attachedTo', label: testManagement.string.TestSuite }, 'status', 'assignee'],
      configOptions: {
        strict: true
      }
    },
    testManagement.viewlet.TableTestCase
  )
}

/**
 * Steps are edited inside the test case panel (`TestSteps.svelte`), so a step
 * needs a presenter but no panel, no editor and no viewlet of its own.
 */
function defineTestStep (builder: Builder): void {
  builder.mixin(testManagement.class.TestStep, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: testManagement.component.TestStepPresenter
  })

  builder.mixin(testManagement.class.TestStep, core.class.Class, view.mixin.IgnoreActions, {
    actions: [
      view.action.Open,
      view.action.OpenInNewTab,
      print.action.Print,
      tracker.action.EditRelatedTargets,
      tracker.action.NewRelatedIssue
    ]
  })
}

/**
 * 🔴 A snapshot gets NO `ObjectEditor` and NO `ObjectPanel`, and every
 * mutating action is suppressed. That is the CONVENIENCE half of immutability;
 * the ENFORCEMENT half is `SnapshotGuardMiddleware` in
 * `server-plugins/test-management`, which refuses the corresponding
 * transactions no matter which client emits them.
 */
function defineTestCaseSnapshot (builder: Builder): void {
  builder.mixin(testManagement.class.TestCaseSnapshot, core.class.Class, view.mixin.IgnoreActions, {
    actions: [
      view.action.Delete,
      view.action.Archive,
      view.action.Move,
      print.action.Print,
      tracker.action.EditRelatedTargets,
      tracker.action.NewRelatedIssue
    ]
  })
}

function defineTestEnvironment (builder: Builder): void {
  // 🔴 `TestRun.environment` is a `TypeRef`, and both `ObjectFilter` and every
  // table cell resolve it through `getAttributePresenter`, which THROWS rather
  // than degrading when the target class has no presenter. Registering this is
  // what makes "filter runs by environment" work instead of crash.
  builder.mixin(testManagement.class.TestEnvironment, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: testManagement.component.TestEnvironmentPresenter
  })

  // An `AttributePresenter` is handed the REF; an `ObjectPresenter` the DOC.
  builder.mixin(testManagement.class.TestEnvironment, core.class.Class, view.mixin.AttributePresenter, {
    presenter: testManagement.component.TestEnvironmentRefPresenter
  })

  builder.mixin(testManagement.class.TypeTestEnvironmentVariables, core.class.Class, view.mixin.AttributePresenter, {
    presenter: testManagement.component.EnvironmentVariablesPresenter
  })

  builder.mixin(testManagement.class.TestEnvironment, core.class.Class, view.mixin.ClassFilters, {
    filters: ['archived'],
    ignoreKeys: ['createdBy', 'modifiedBy', 'createdOn', 'modifiedOn']
  })

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: testManagement.class.TestEnvironment,
      descriptor: view.viewlet.Table,
      config: ['', 'description', 'archived', 'modifiedOn'],
      configOptions: {
        strict: true
      }
    },
    testManagement.viewlet.TableTestEnvironment
  )
}

function defineBuild (builder: Builder): void {
  // Same reason as `TestEnvironment` above — see the note there.
  builder.mixin(testManagement.class.Build, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: testManagement.component.BuildPresenter
  })

  builder.mixin(testManagement.class.Build, core.class.Class, view.mixin.AttributePresenter, {
    presenter: testManagement.component.BuildRefPresenter
  })

  builder.mixin(testManagement.class.Build, core.class.Class, view.mixin.ClassFilters, {
    filters: ['productVersion', 'commitSha'],
    ignoreKeys: ['createdBy', 'modifiedBy', 'createdOn', 'modifiedOn']
  })

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: testManagement.class.Build,
      descriptor: view.viewlet.Table,
      // ⚠️ `productVersion` is deliberately NOT a column. A table cell resolves
      // through `getAttributePresenter`, which THROWS when the attribute's
      // target class carries no `AttributePresenter` mixin — and
      // `products.class.ProductVersion` ships only an `ObjectPresenter`
      // (`models/products/src/index.ts`). It stays available as a FILTER,
      // because `ObjectFilter` resolves through `getObjectPresenter` instead.
      config: ['', 'externalKey', 'commitSha', 'createdOnCi'],
      configOptions: {
        strict: true
      }
    },
    testManagement.viewlet.TableBuild
  )
}

function defineTestRun (builder: Builder): void {
  builder.mixin(testManagement.class.TestRun, core.class.Class, activity.mixin.ActivityDoc, {})

  builder.createDoc(activity.class.ActivityExtension, core.space.Model, {
    ofClass: testManagement.class.TestRun,
    components: { input: { component: chunter.component.ChatMessageInput } }
  })

  builder.mixin(testManagement.class.TestRun, core.class.Class, view.mixin.ObjectPanel, {
    component: testManagement.component.EditTestRun
  })

  builder.mixin(testManagement.class.TestRun, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: testManagement.component.TestRunPresenter
  })

  builder.mixin(testManagement.class.TestRun, core.class.Class, view.mixin.ObjectIcon, {
    component: testManagement.component.TestResultStatusPresenter
  })

  builder.mixin(testManagement.class.TestRun, core.class.Class, view.mixin.IgnoreActions, {
    actions: [print.action.Print, tracker.action.EditRelatedTargets, tracker.action.NewRelatedIssue]
  })

  //
  // 🔴 THE POINT OF THE FLAT CONTEXT FIELDS. `ClassFilters.filters` and
  // `ViewOptionsModel.orderBy` both take ATTRIBUTE NAMES, resolved against the
  // class's own attribute map — there is no path syntax for reaching into a
  // nested value object. Had the context been modelled as a single
  // `TestRunContext` attribute, none of the entries below would resolve and
  // "filter runs by build" / "sort runs by environment" would be unbuildable.
  //
  // ⚠️ `cycle` is deliberately ABSENT from this list even though it is indexed
  // and queryable. `ObjectFilter` (the component `core.class.RefTo` resolves
  // to) calls `getPresenter` on the attribute's target class, and
  // `getAttributePresenter` THROWS when there is none — `core.class.Doc`, which
  // is what `cycle` points at until the cycle module is wired in, has no
  // presenter. Add it here in the same change that narrows the ref.
  builder.mixin(testManagement.class.TestRun, core.class.Class, view.mixin.ClassFilters, {
    filters: ['build', 'environment', 'productVersion', 'testPlan', 'executedBy'],
    ignoreKeys: ['createdBy', 'modifiedBy', 'createdOn', 'description']
  })

  const runViewOptions: ViewOptionsModel = {
    groupBy: ['build', 'environment'],
    orderBy: [
      ['startedOn', SortingOrder.Descending],
      ['finishedOn', SortingOrder.Descending],
      ['modifiedOn', SortingOrder.Descending],
      ['dueDate', SortingOrder.Ascending]
    ],
    other: []
  }

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: testManagement.class.TestRun,
      descriptor: view.viewlet.Table,
      // `build` and `environment` are columns because this module registers an
      // `AttributePresenter` for each; `productVersion` is not, for the reason
      // spelled out on the Build viewlet above.
      config: ['', 'build', 'environment', 'executedBy', 'startedOn', 'finishedOn'],
      configOptions: {
        strict: true
      },
      viewOptions: runViewOptions
    },
    testManagement.viewlet.TableTestRun
  )
}

function defineTestResult (builder: Builder): void {
  builder.mixin(testManagement.class.TestResult, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: testManagement.component.TestResultPresenter
  })

  builder.mixin(testManagement.class.TestResult, core.class.Class, activity.mixin.ActivityDoc, {})

  builder.createDoc(activity.class.ActivityExtension, core.space.Model, {
    ofClass: testManagement.class.TestResult,
    components: { input: { component: chunter.component.ChatMessageInput } }
  })

  builder.mixin(testManagement.class.TestResult, core.class.Class, view.mixin.ObjectEditor, {
    editor: testManagement.component.EditTestResult
  })

  builder.mixin(testManagement.class.TestResult, core.class.Class, view.mixin.ObjectEditorHeader, {
    editor: testManagement.component.TestResultHeader
  })

  builder.mixin(testManagement.class.TestResult, core.class.Class, view.mixin.ObjectPanel, {
    component: testManagement.component.EditTestResult
  })

  builder.mixin(testManagement.class.TestResult, core.class.Class, view.mixin.ObjectPanelFooter, {
    editor: testManagement.component.TestResultFooter
  })

  builder.mixin(testManagement.class.TestResult, core.class.Class, view.mixin.ClassFilters, {
    filters: ['assignee', 'status', 'testSuite'],
    ignoreKeys: ['createdBy', 'modifiedBy', 'createdOn', 'modifiedOn', 'name', 'attachedTo']
  })

  const viewOptions: ViewOptionsModel = {
    groupBy: ['testSuite'],
    orderBy: [
      ['status', SortingOrder.Ascending],
      ['modifiedOn', SortingOrder.Descending],
      ['createdOn', SortingOrder.Descending]
    ],
    other: [
      {
        key: 'shouldShowAll',
        type: 'toggle',
        defaultValue: false,
        actionTarget: 'category',
        action: view.function.ShowEmptyGroups,
        label: view.string.ShowEmptyGroups
      }
    ]
  }

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: testManagement.class.TestResult,
      descriptor: view.viewlet.List,
      configOptions: {
        strict: true,
        hiddenKeys: ['title', 'status', 'modifiedOn']
      },
      config: [
        { key: '', displayProps: { fixed: 'left' } },
        {
          key: 'status',
          props: { kind: 'list', size: 'small', shouldShowName: false }
        },
        { key: '', displayProps: { grow: true } },
        { key: 'modifiedOn', displayProps: { key: 'modified', fixed: 'right', dividerBefore: true } },
        {
          key: 'assignee',
          props: { kind: 'list', shouldShowName: false, avatarSize: 'x-small' },
          displayProps: { key: 'assignee', fixed: 'right' }
        }
      ],
      viewOptions,
      /* eslint-disable @typescript-eslint/consistent-type-assertions */
      options: {
        lookup: {
          testCase: testManagement.class.TestCase
        }
      } as FindOptions<TestResult>
    },
    testManagement.viewlet.TestResultList
  )

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: testManagement.class.TestResult,
      descriptor: view.viewlet.Table,
      config: ['', 'testSuite', 'status', 'assignee'],
      configOptions: {
        strict: true
      },
      options: {
        lookup: {
          testCase: testManagement.class.TestCase
        }
      } as FindOptions<TestResult>
    },
    testManagement.viewlet.TableTestResult
  )

  const testPlanViewOptions: ViewOptionsModel = {
    groupBy: ['testSuite'],
    orderBy: [['assignee', SortingOrder.Ascending]],
    other: [
      {
        key: 'shouldShowAll',
        type: 'toggle',
        defaultValue: false,
        actionTarget: 'category',
        action: view.function.ShowEmptyGroups,
        label: view.string.ShowEmptyGroups
      }
    ]
  }

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: testManagement.class.TestPlanItem,
      descriptor: view.viewlet.List,
      configOptions: {
        strict: true
      },
      config: [
        {
          key: '$lookup.testCase',
          displayProps: { fixed: 'left' },
          presenter: testManagement.component.TestCasePresenter
        },
        { key: '', displayProps: { grow: true } },
        {
          key: 'assignee',
          props: { kind: 'list', shouldShowName: true, avatarSize: 'x-small', label: testManagement.string.Unassigned },
          displayProps: { key: 'assignee', fixed: 'right' }
        }
      ],
      viewOptions: testPlanViewOptions,
      /* eslint-disable @typescript-eslint/consistent-type-assertions */
      options: {
        lookup: {
          testCase: testManagement.class.TestCase
        }
      } as FindOptions<TestPlanItem>
    },
    testManagement.viewlet.TestPlanItemsList
  )

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: testManagement.class.TestPlanItem,
      descriptor: view.viewlet.Table,
      config: ['$lookup.testCase', 'assignee'],
      configOptions: {
        strict: true
      },
      options: {
        lookup: {
          testCase: testManagement.class.TestCase
        }
      } as FindOptions<TestResult>
    },
    testManagement.viewlet.TableTestPlanItems
  )
}

function defineTestPlan (builder: Builder): void {
  builder.mixin(testManagement.class.TestPlan, core.class.Class, activity.mixin.ActivityDoc, {})

  builder.createDoc(activity.class.ActivityExtension, core.space.Model, {
    ofClass: testManagement.class.TestPlan,
    components: { input: { component: chunter.component.ChatMessageInput } }
  })

  builder.mixin(testManagement.class.TestPlan, core.class.Class, view.mixin.ObjectPanel, {
    component: view.component.EditDoc
  })

  builder.mixin(testManagement.class.TestPlan, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: testManagement.component.TestPlanPresenter
  })

  builder.mixin(testManagement.class.TestPlan, core.class.Class, view.mixin.IgnoreActions, {
    actions: [print.action.Print, tracker.action.EditRelatedTargets, tracker.action.NewRelatedIssue]
  })

  builder.mixin(testManagement.class.TestPlanItem, core.class.Class, view.mixin.IgnoreActions, {
    actions: [
      view.action.Open,
      view.action.OpenInNewTab,
      print.action.Print,
      tracker.action.EditRelatedTargets,
      tracker.action.NewRelatedIssue
    ]
  })

  builder.mixin(testManagement.class.TestPlanItem, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: testManagement.component.TestPlanItemPresenter
  })
}

export { testManagementOperation } from './migration'
export { default } from './plugin'
