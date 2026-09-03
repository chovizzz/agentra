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

import { type Doc, type Tx } from '@hcengineering/core'
import { type TriggerControl } from '@hcengineering/server-core'

export * from './inheritance'
export * from './middleware'
export * from './query'
// NOT re-exported: `./readFilter` is implementation detail of the `findAll`
// endpoint-visibility guard in `./middleware`. Its helpers (projection widening,
// field stripping, endpoint extraction, total adjustment) are shaped by that one
// caller and would become a public contract the moment they leave this package.
// `middleware.ts` imports them directly; the tests exercise them through it.

/**
 * Endpoint-removal trigger.
 *
 * Deleting either end of a trace edge must NOT delete the edge — the edge is an
 * audit fact. The cleanup path flips `state` to `orphaned` instead (a human
 * withdrawal sets `revoked`).
 *
 * Left as a skeleton in this delivery: the tx matching and the state flip are
 * wired once the endpoint modules (Requirement, TestCase, Bug, ProductVersion)
 * exist to match against.
 *
 * @public
 */
export async function onTraceEndpointRemoved (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  control.ctx.info('traceability endpoint removal transactions observed', { count: txes.length })
  return []
}

/**
 * Cascade-delete participant for TraceLink.
 *
 * Returns nothing on purpose: a trace edge owns no children, and it must never
 * cascade INTO its endpoints.
 *
 * @public
 */
export async function traceLinkRemove (doc: Doc): Promise<Doc[]> {
  return []
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    OnTraceEndpointRemoved: onTraceEndpointRemoved
  },
  function: {
    TraceLinkRemove: traceLinkRemove
  }
})
