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

export interface ToolResult {
  content: Array<{ type: 'text', text: string }>
  isError?: boolean
}

export function textResult (text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

export function jsonResult (value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2))
}

/**
 * Turn a thrown error into a tool result rather than letting it escape.
 *
 * An exception out of a tool handler reaches the agent as a transport-level
 * failure with no useful text; `isError` keeps the message in the model's hands
 * so it can correct itself (wrong project identifier, unknown status name, …).
 */
export function errorResult (err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err)
  return { content: [{ type: 'text', text: message }], isError: true }
}
