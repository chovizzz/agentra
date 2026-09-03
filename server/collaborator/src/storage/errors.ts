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

import platform, { PlatformError, type Status, type StatusCode } from '@hcengineering/platform'

/**
 * Statuses that mean "we never got an answer from the platform", as opposed to
 * "the platform looked at this write and said no".
 *
 * 🔴 THE DIRECTION OF THIS LIST IS DELIBERATE. It is a deny list, so an
 * unrecognised status counts as a refusal. A refusal is reconciled (the ydoc is
 * put back to the content the platform actually holds), which is recoverable —
 * the author sees the revert and can act. Treating a real refusal as transient
 * is what we already have today and it is NOT recoverable: the ydoc keeps
 * serving content the platform rejected, forever, with nobody told.
 *
 * ⚠️ Everything here must be something a retry can plausibly fix, or something
 * that makes the whole workspace unwritable (where reverting one document's
 * text would be noise, not a fix).
 */
const transientStatuses = new Set<StatusCode>([
  platform.status.ConnectionClosed,
  platform.status.InternalServerError,
  platform.status.Unauthorized,
  platform.status.TokenExpired,
  platform.status.TokenNotActive,
  platform.status.MaintenanceWarning,
  platform.status.WorkspaceArchived,
  platform.status.WorkspaceMigration,
  platform.status.WorkspaceNotFound
])

/**
 * Did the platform *decide* to refuse this write?
 *
 * A server-side refusal (a guard middleware that throws) comes back over the
 * transactor socket as a `sendError` response, which the client turns into a
 * `PlatformError` — see `ClientSession.tx` in `@hcengineering/server` and the
 * `promise.reject(new PlatformError(resp.error))` in `client-resources`.
 * A connection that dropped, a DNS failure or a socket timeout arrives as a
 * plain `Error` instead, so `instanceof` alone already separates most of it.
 *
 * @public
 */
export function isPlatformRejection (err: any): err is PlatformError<any> {
  if (!(err instanceof PlatformError)) {
    return false
  }
  return !transientStatuses.has(err.status.code)
}

/**
 * Raised when the platform refused the transaction that carries the document
 * content. Distinct from every other failure in `saveDocument` because it is
 * the only one a retry cannot fix, and the only one where the right answer is
 * to bring the ydoc back in line with the platform instead of keeping it.
 *
 * @public
 */
export class PlatformRejectedError extends Error {
  constructor (
    readonly documentName: string,
    readonly objectAttr: string,
    readonly status: Status<any>,
    readonly cause: any
  ) {
    super(`platform refused content update for '${documentName}': ${cause?.message ?? String(cause)}`)
    this.name = 'PlatformRejectedError'
  }
}
