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
import { z } from 'zod'

import { jsonResult, textResult, type ToolResult } from './result'

const PRIORITIES = ['NoPriority', 'Urgent', 'High', 'Medium', 'Low'] as const

/**
 * Resolve a project by its identifier (the short prefix shown in issue ids,
 * e.g. `PLAUD` in `PLAUD-42`). Identifier rather than name because that is what
 * a person reads off an issue, and it is unique by construction.
 */
async function findProject (client: PlatformClient, identifier: string): Promise<Project> {
  const project = await client.findOne(tracker.class.Project, { identifier })
  if (project === undefined) {
    throw new Error(`Project '${identifier}' not found. Use agentra_list_projects to see what exists.`)
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
    const available = statuses.map((s) => s.name).join(', ')
    throw new Error(
      `Status '${name}' not found in project ${project.identifier}. Available: ${available || '(none)'}`
    )
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

function describeIssue (issue: Issue, statusName?: string): Record<string, unknown> {
  return {
    identifier: issue.identifier,
    title: issue.title,
    status: statusName ?? issue.status,
    priority: PRIORITIES[issue.priority] ?? 'NoPriority',
    assignee: issue.assignee,
    modifiedOn: new Date(issue.modifiedOn).toISOString()
  }
}

export function registerIssueTools (server: any, getClient: () => Promise<PlatformClient>): void {
  server.registerTool(
    'agentra_list_projects',
    {
      title: '列出项目',
      description: 'List all tracker projects with their identifier (the prefix used in issue ids).',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async (): Promise<ToolResult> => {
      const client = await getClient()
      const projects = await client.findAll(tracker.class.Project, {})
      return jsonResult(
        projects.map((p) => ({ identifier: p.identifier, name: p.name, description: p.description }))
      )
    }
  )

  server.registerTool(
    'agentra_search_issues',
    {
      title: '搜索问题',
      description:
        'Search issues. All filters are optional and combine with AND. Returns a compact list; ' +
        'use agentra_get_issue for the full body of one issue.',
      inputSchema: {
        project: z.string().optional().describe('Project identifier, e.g. PLAUD'),
        status: z.string().optional().describe('Status name, e.g. 进行中'),
        title: z.string().optional().describe('Case-insensitive substring match on the title'),
        limit: z.number().int().min(1).max(200).default(50)
      },
      annotations: { readOnlyHint: true }
    },
    async (args: { project?: string, status?: string, title?: string, limit: number }): Promise<ToolResult> => {
      const client = await getClient()
      const query: Record<string, unknown> = {}
      let project: Project | undefined
      if (args.project !== undefined) {
        project = await findProject(client, args.project)
        query.space = project._id
      }
      if (args.status !== undefined) {
        if (project === undefined) {
          throw new Error('Filtering by status needs a project too — status names are scoped to a project type.')
        }
        query.status = await findStatus(client, project, args.status)
      }
      if (args.title !== undefined) {
        query.title = { $like: `%${args.title}%` }
      }
      const issues = await client.findAll(tracker.class.Issue, query, {
        limit: args.limit,
        sort: { modifiedOn: SortingOrder.Descending }
      })
      const statuses = await client.findAll(tracker.class.IssueStatus, {})
      const byId = new Map(statuses.map((s) => [s._id, s.name]))
      return jsonResult(issues.map((i) => describeIssue(i, byId.get(i.status))))
    }
  )

  server.registerTool(
    'agentra_get_issue',
    {
      title: '读取问题',
      description: 'Read one issue in full, including its description rendered as markdown.',
      inputSchema: { identifier: z.string().describe('Issue identifier, e.g. PLAUD-42') },
      annotations: { readOnlyHint: true }
    },
    async (args: { identifier: string }): Promise<ToolResult> => {
      const client = await getClient()
      const issue = await findIssue(client, args.identifier)
      const status = await client.findOne(tracker.class.IssueStatus, { _id: issue.status })
      let description = ''
      if (issue.description != null) {
        description = await client.fetchMarkup(
          tracker.class.Issue,
          issue._id,
          'description',
          issue.description,
          'markdown'
        )
      }
      return jsonResult({ ...describeIssue(issue, status?.name), description })
    }
  )

  server.registerTool(
    'agentra_create_issue',
    {
      title: '创建问题',
      description: 'Create an issue in a project. Returns the new identifier.',
      inputSchema: {
        project: z.string().describe('Project identifier, e.g. PLAUD'),
        title: z.string().min(1),
        description: z.string().optional().describe('Markdown'),
        status: z.string().optional().describe('Status name; defaults to the project type’s first status'),
        priority: z.enum(PRIORITIES).optional(),
        taskType: z.string().optional().describe('Required when the project type has several task types')
      }
    },
    async (args: {
      project: string
      title: string
      description?: string
      status?: string
      priority?: (typeof PRIORITIES)[number]
      taskType?: string
    }): Promise<ToolResult> => {
      const client = await getClient()
      const project = await findProject(client, args.project)
      const kind = await findTaskType(client, project, args.taskType)

      const issueId = generateId<Issue>()
      const description =
        args.description !== undefined
          ? await client.uploadMarkup(tracker.class.Issue, issueId, 'description', args.description, 'markdown')
          : null

      const status =
        args.status !== undefined
          ? await findStatus(client, project, args.status, kind._id)
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
          title: args.title,
          description,
          assignee: null,
          component: null,
          number,
          status,
          priority: args.priority !== undefined ? IssuePriority[args.priority] : IssuePriority.NoPriority,
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
      return textResult(`Created ${identifier}`)
    }
  )

  server.registerTool(
    'agentra_update_issue',
    {
      title: '修改问题',
      description: 'Update fields of an existing issue. Omitted fields are left untouched.',
      inputSchema: {
        identifier: z.string().describe('Issue identifier, e.g. PLAUD-42'),
        title: z.string().min(1).optional(),
        description: z.string().optional().describe('Markdown; replaces the whole description'),
        status: z.string().optional(),
        priority: z.enum(PRIORITIES).optional()
      }
    },
    async (args: {
      identifier: string
      title?: string
      description?: string
      status?: string
      priority?: (typeof PRIORITIES)[number]
    }): Promise<ToolResult> => {
      const client = await getClient()
      const issue = await findIssue(client, args.identifier)
      const update: Record<string, unknown> = {}

      if (args.title !== undefined) update.title = args.title
      if (args.priority !== undefined) update.priority = IssuePriority[args.priority]
      if (args.status !== undefined) {
        const project = await client.findOne(tracker.class.Project, { _id: issue.space })
        if (project === undefined) throw new Error(`Project of ${args.identifier} not found.`)
        // Scope to the issue's own task type: the project type may model several
        // flows with same-named statuses, and moving the issue into another flow's
        // status leaves it in a state its own flow does not contain.
        update.status = await findStatus(client, project, args.status, issue.kind)
      }
      if (args.description !== undefined) {
        update.description = await client.uploadMarkup(
          tracker.class.Issue,
          issue._id,
          'description',
          args.description,
          'markdown'
        )
      }
      if (Object.keys(update).length === 0) {
        throw new Error('Nothing to update — pass at least one field.')
      }
      await client.updateDoc(tracker.class.Issue, issue.space, issue._id, update)
      return textResult(`Updated ${args.identifier}: ${Object.keys(update).join(', ')}`)
    }
  )
}
