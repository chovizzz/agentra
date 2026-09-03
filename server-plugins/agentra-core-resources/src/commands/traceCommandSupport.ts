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

import activity, { type DocUpdateMessage } from '@hcengineering/activity'
import type { ApplyOperations, Doc, Ref, Space, TxOperations } from '@hcengineering/core'
import traceability, { type TraceLink } from '@hcengineering/traceability'

import { assertCommitted } from '../commandMiddleware'

/**
 * Open an apply block for one command step.
 *
 * 🔴 WHAT `assertCommitted` CAN AND CANNOT SEE — read before adding a step.
 *
 * `ApplyOperations.commit()` has a fast path that skips `TxApplyIf` entirely
 * when the block holds exactly one transaction, no match clauses AND no measure
 * name; that path returns a hard-coded `{ result: true }` whatever the write
 * did. The measure name below is what forces the real `TxApplyIf` round trip,
 * and it is necessary.
 *
 * ⚠️ It is NOT sufficient on its own. `ApplyTxMiddleware.tx` only calls
 * `verifyApplyIf` when `scope != null`; with a null scope it hard-codes
 * `passed: true` and the block can never come back `success: false`. So
 * `{ result: false }` is reachable ONLY for a step that supplies BOTH a `scope`
 * and a `match`/`notMatch` clause. For plain create steps the real arbiter is
 * the primary key on `("workspaceId", _id)`, which THROWS out of `provideTx`
 * rather than returning false; `assertCommitted` is kept on them as a cheap
 * guard against that contract changing, not as their protection.
 *
 * ⚠️ `match` IS NOT A DATABASE CONDITIONAL UPDATE. It is `ApplyTxMiddleware`
 * doing a read-then-write inside ONE transactor process, and `scopes` is a
 * per-process `Map`; across replicas it excludes nothing. The only genuine
 * cross-process mutual exclusion available here is a primary-key conflict
 * (Postgres `23505`) on a derived `_id`.
 *
 * @public
 */
export function applyStepFor (client: TxOperations, command: string, step: string, scope?: string): ApplyOperations {
  return client.apply(scope, `${command}:${step}`)
}

/**
 * @public
 */
export interface TraceActivityRequest {
  /** DERIVED id, so a replay finds the record instead of writing a second one. */
  _id: Ref<DocUpdateMessage>
  attachedTo: Ref<Doc>
  attachedToClass: Ref<any>
  space: Ref<Space>
  link: Ref<TraceLink>
  /**
   * What happened to the edge. `'create'` announces a new assertion,
   * `'remove'` announces a withdrawal (`state: 'revoked'`).
   *
   * ⚠️ `'remove'` does NOT mean the row was deleted — a trace edge is never
   * physically removed. It is the vocabulary `DocUpdateMessage` offers for "this
   * relationship no longer holds", and it is what makes the revocation render
   * differently from the creation in a timeline that shows both.
   */
  action?: DocUpdateMessage['action']
}

/**
 * One activity record announcing a trace edge on one endpoint.
 *
 * 🔴 REQUIRED, NOT DECORATIVE. `DOMAIN_RELATION` is excluded from both the
 * fulltext index and Activity, so writing a `TraceLink` produces no history
 * entry at all; without these records the edge is invisible in both endpoints'
 * timelines and the audit trail Task 15 exists to produce does not exist.
 *
 * A `DocUpdateMessage` rather than an `ActivityInfoMessage`: the latter needs an
 * `IntlString`, which would mean a translation key in a client-side assets
 * package, whereas `action: 'create'` over `objectClass = TraceLink` states the
 * same fact using only ids and renders through the ordinary create viewlet.
 *
 * @public
 */
export async function ensureTraceActivity (
  client: TxOperations,
  command: string,
  request: TraceActivityRequest
): Promise<void> {
  const found = await client.findOne<DocUpdateMessage>(activity.class.DocUpdateMessage, { _id: request._id })
  if (found !== undefined) {
    return
  }
  const apply = applyStepFor(client, command, 'activity')
  await apply.addCollection<Doc, DocUpdateMessage>(
    activity.class.DocUpdateMessage,
    request.space,
    request.attachedTo,
    request.attachedToClass,
    'activity',
    {
      objectId: request.link,
      objectClass: traceability.class.TraceLink,
      action: request.action ?? 'create'
    },
    request._id
  )
  assertCommitted(await apply.commit(), `record activity on ${request.attachedTo}`)
}
