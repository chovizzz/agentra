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

import {
  createIssue,
  getIssue,
  ISSUE_PRIORITIES,
  listProjects,
  searchIssues,
  updateIssue,
  type IssuePriorityName
} from '@agentra-cli/client'
import type { PlatformClient } from '@hcengineering/api-client'
import { z } from 'zod'

import { jsonResult, textResult, type ToolResult } from './result'

/**
 * MCP binding for the issue domain.
 *
 * Everything below is schema + wording; the behaviour lives in `@agentra-cli/client`
 * so the CLI runs the same code path. Keep the tool names and descriptions stable —
 * agents already registered against this server address them by name.
 */
export function registerIssueTools (server: any, getClient: () => Promise<PlatformClient>): void {
  server.registerTool(
    'agentra_list_projects',
    {
      title: '列出项目',
      description: 'List all tracker projects with their identifier (the prefix used in issue ids).',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async (): Promise<ToolResult> => jsonResult(await listProjects(await getClient()))
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
    async (args: { project?: string, status?: string, title?: string, limit: number }): Promise<ToolResult> =>
      jsonResult(await searchIssues(await getClient(), args))
  )

  server.registerTool(
    'agentra_get_issue',
    {
      title: '读取问题',
      description: 'Read one issue in full, including its description rendered as markdown.',
      inputSchema: { identifier: z.string().describe('Issue identifier, e.g. PLAUD-42') },
      annotations: { readOnlyHint: true }
    },
    async (args: { identifier: string }): Promise<ToolResult> =>
      jsonResult(await getIssue(await getClient(), args.identifier))
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
        priority: z.enum(ISSUE_PRIORITIES).optional(),
        taskType: z.string().optional().describe('Required when the project type has several task types')
      }
    },
    async (args: {
      project: string
      title: string
      description?: string
      status?: string
      priority?: IssuePriorityName
      taskType?: string
    }): Promise<ToolResult> => textResult(`Created ${await createIssue(await getClient(), args)}`)
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
        priority: z.enum(ISSUE_PRIORITIES).optional()
      }
    },
    async (args: {
      identifier: string
      title?: string
      description?: string
      status?: string
      priority?: IssuePriorityName
    }): Promise<ToolResult> => {
      const changed = await updateIssue(await getClient(), args)
      return textResult(`Updated ${args.identifier}: ${changed.join(', ')}`)
    }
  )
}
