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

import type { PlatformClient } from '@hcengineering/api-client'
import core, { generateId, SortingOrder, type Ref } from '@hcengineering/core'
import task, { makeRank, type TaskType } from '@hcengineering/task'
import tracker, { IssuePriority, type Issue, type IssueStatus, type Project } from '@hcengineering/tracker'

import { ISSUE_PRIORITIES, type IssuePriorityName } from './vocabulary'

export interface ProjectSummary {
  identifier: string
  name: string
  description?: string
}

export interface IssueSummary {
  identifier: string
  title: string
  status: string
  priority: IssuePriorityName
  assignee: unknown
  modifiedOn: string
}

export interface IssueDetail extends IssueSummary {
  description: string
}

export interface SearchIssuesParams {
  project?: string
  status?: string
  title?: string
  limit?: number
}

export interface CreateIssueParams {
  project: string
  title: string
  description?: string
  status?: string
  priority?: IssuePriorityName
  taskType?: string
}

export interface UpdateIssueParams {
  identifier: string
  title?: string
  description?: string
  status?: string
  priority?: IssuePriorityName
}

/**
 * Resolve a project by its identifier (the short prefix shown in issue ids,
 * e.g. `PLAUD` in `PLAUD-42`). Identifier rather than name because that is what
 * a person reads off an issue, and it is unique by construction.
 */
async function findProject (client: PlatformClient, identifier: string): Promise<Project> {
  const project = await client.findOne(tracker.class.Project, { identifier })
  if (project === undefined) {
    throw new Error(`Project '${identifier}' not found. Use listProjects to see what exists.`)
  }
  return project
}

async function findIssue (client: PlatformClient, identifier: string): Promise<Issue> {
  const issue = await client.findOne(tracker.class.Issue, { identifier })
  if (issue === undefined) {
    throw new Error(`Issue '${identifier}' not found.`)
  }
  return issue
}

/**
 * Collect the statuses reachable from a project.
 *
 * 🔴 Statuses are NOT stored in a space keyed by the project type — they hang off
 * each TaskType's `statuses` array, and the project type only points at the task
 * types. Querying `IssueStatus` by `space: project.type` silently returns nothing,
 * which reads as "this project has no statuses" rather than as a wrong query.
 *
 * `taskType` narrows the search to one flow. That matters because a project type
 * modelling 任务 and 缺陷 carries two same-named statuses (both end in 已完成), and
 * resolving to the wrong one puts the issue in a flow that does not contain it.
 */
async function collectStatuses (
  client: PlatformClient,
  project: Project,
  taskType?: Ref<TaskType>
): Promise<IssueStatus[]> {
  let statusIds: Array<Ref<IssueStatus>> = []
  if (taskType !== undefined) {
    const tt = await client.findOne(task.class.TaskType, { _id: taskType })
    statusIds = (tt?.statuses ?? []) as Array<Ref<IssueStatus>>
  } else {
    const type = await client.findOne(task.class.ProjectType, { _id: project.type })
    if (type === undefined) return []
    const taskTypes = await client.findAll(task.class.TaskType, { _id: { $in: type.tasks } })
    statusIds = taskTypes.flatMap((tt) => tt.statuses) as Array<Ref<IssueStatus>>
  }
  if (statusIds.length === 0) return []
  return await client.findAll(tracker.class.IssueStatus, { _id: { $in: statusIds } })
}

async function findStatus (
  client: PlatformClient,
  project: Project,
  name: string,
  taskType?: Ref<TaskType>
): Promise<Ref<IssueStatus>> {
  const statuses = await collectStatuses(client, project, taskType)
  const match = statuses.find((s) => s.name.toLowerCase() === name.toLowerCase())
  if (match === undefined) {
    const names = statuses.map((s) => s.name).join(', ')
    const available = names === '' ? '(none)' : names
    throw new Error(`Status '${name}' not found in project ${project.identifier}. Available: ${available}`)
  }
  return match._id
}

/**
 * 🔴 `findOne` on TaskType WITHOUT a name returns an arbitrary type — whichever the
 * adapter yields first. That is only correct for a project type with exactly one task
 * type; for a type modelling several flows (任务 / 缺陷, each with its own statuses) it
 * silently stamps every issue with the same kind, and issues carrying the second flow's
 * statuses end up in a flow that does not contain their status.
 *
 * So an unmatched name is an error rather than a fallback: falling back reproduces that
 * bug invisibly — the issue gets created, it just sits in the wrong flow.
 */
async function findTaskType (client: PlatformClient, project: Project, name?: string): Promise<TaskType> {
  const parentQuery = project.type !== undefined ? { parent: project.type } : {}
  if (name !== undefined) {
    const named = await client.findOne(task.class.TaskType, { ...parentQuery, name })
    if (named === undefined) {
      throw new Error(`Task type '${name}' not found in project ${project.identifier}.`)
    }
    return named
  }
  const all = await client.findAll(task.class.TaskType, parentQuery)
  if (all.length === 0) {
    throw new Error(`Project ${project.identifier} has no task types.`)
  }
  if (all.length > 1) {
    throw new Error(
      `Project ${project.identifier} has several task types (${all.map((t) => t.name).join(', ')}); ` +
        'pass taskType to say which one.'
    )
  }
  return all[0]
}

function describeIssue (issue: Issue, statusName?: string): IssueSummary {
  return {
    identifier: issue.identifier,
    title: issue.title,
    status: statusName ?? issue.status,
    priority: ISSUE_PRIORITIES[issue.priority] ?? 'NoPriority',
    assignee: issue.assignee,
    modifiedOn: new Date(issue.modifiedOn).toISOString()
  }
}

export async function listProjects (client: PlatformClient): Promise<ProjectSummary[]> {
  const projects = await client.findAll(tracker.class.Project, {})
  return projects.map((p) => ({ identifier: p.identifier, name: p.name, description: p.description }))
}

export async function searchIssues (client: PlatformClient, params: SearchIssuesParams): Promise<IssueSummary[]> {
  const query: Record<string, unknown> = {}
  let project: Project | undefined
  if (params.project !== undefined) {
    project = await findProject(client, params.project)
    query.space = project._id
  }
  if (params.status !== undefined) {
    if (project === undefined) {
      throw new Error('Filtering by status needs a project too — status names are scoped to a project type.')
    }
    query.status = await findStatus(client, project, params.status)
  }
  if (params.title !== undefined) {
    query.title = { $like: `%${params.title}%` }
  }
  const issues = await client.findAll(tracker.class.Issue, query, {
    limit: params.limit ?? 50,
    sort: { modifiedOn: SortingOrder.Descending }
  })
  const statuses = await client.findAll(tracker.class.IssueStatus, {})
  const byId = new Map(statuses.map((s) => [s._id, s.name]))
  return issues.map((i) => describeIssue(i, byId.get(i.status)))
}

export async function getIssue (client: PlatformClient, identifier: string): Promise<IssueDetail> {
  const issue = await findIssue(client, identifier)
  const status = await client.findOne(tracker.class.IssueStatus, { _id: issue.status })
  let description = ''
  if (issue.description != null) {
    description = await client.fetchMarkup(tracker.class.Issue, issue._id, 'description', issue.description, 'markdown')
  }
  return { ...describeIssue(issue, status?.name), description }
}

export async function createIssue (client: PlatformClient, params: CreateIssueParams): Promise<string> {
  const project = await findProject(client, params.project)
  const kind = await findTaskType(client, project, params.taskType)

  const issueId = generateId<Issue>()
  const description =
    params.description !== undefined
      ? await client.uploadMarkup(tracker.class.Issue, issueId, 'description', params.description, 'markdown')
      : null

  const status =
    params.status !== undefined
      ? await findStatus(client, project, params.status, kind._id)
      : (kind.statuses[0] as Ref<IssueStatus>)

  // The project's `sequence` is the single source of issue numbers; bumping it
  // atomically is what stops two concurrent creates from claiming one number.
  const incResult = await client.updateDoc(
    tracker.class.Project,
    core.space.Space,
    project._id,
    { $inc: { sequence: 1 } },
    true
  )
  const number = (incResult as any).object.sequence
  const identifier = `${project.identifier}-${number}`

  const last = await client.findOne<Issue>(
    tracker.class.Issue,
    { space: project._id },
    { sort: { rank: SortingOrder.Descending } }
  )

  await client.addCollection(
    tracker.class.Issue,
    project._id,
    tracker.ids.NoParent,
    tracker.class.Issue,
    'subIssues',
    {
      title: params.title,
      description,
      assignee: null,
      component: null,
      number,
      status,
      priority: params.priority !== undefined ? IssuePriority[params.priority] : IssuePriority.NoPriority,
      rank: makeRank(last?.rank, undefined),
      comments: 0,
      subIssues: 0,
      startDate: null,
      dueDate: null,
      parents: [],
      remainingTime: 0,
      estimation: 0,
      reportedTime: 0,
      reports: 0,
      childInfo: [],
      identifier,
      kind: kind._id
    } as any,
    issueId
  )
  return identifier
}

/** Returns the names of the fields that were actually changed. */
export async function updateIssue (client: PlatformClient, params: UpdateIssueParams): Promise<string[]> {
  const issue = await findIssue(client, params.identifier)
  const update: Record<string, unknown> = {}

  if (params.title !== undefined) update.title = params.title
  if (params.priority !== undefined) update.priority = IssuePriority[params.priority]
  if (params.status !== undefined) {
    const project = await client.findOne(tracker.class.Project, { _id: issue.space })
    if (project === undefined) throw new Error(`Project of ${params.identifier} not found.`)
    // Scope to the issue's own task type: the project type may model several
    // flows with same-named statuses, and moving the issue into another flow's
    // status leaves it in a state its own flow does not contain.
    update.status = await findStatus(client, project, params.status, issue.kind)
  }
  if (params.description !== undefined) {
    update.description = await client.uploadMarkup(
      tracker.class.Issue,
      issue._id,
      'description',
      params.description,
      'markdown'
    )
  }
  if (Object.keys(update).length === 0) {
    throw new Error('Nothing to update — pass at least one field.')
  }
  await client.updateDoc(tracker.class.Issue, issue.space, issue._id, update)
  return Object.keys(update)
}
