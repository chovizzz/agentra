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

// ───────────────────────────────────────────────────────────────────────────
// The collaborator's `content-rejected` stateless message.
//
// The server rolls a ydoc back when the platform refuses a save (see
// `server/collaborator/src/extensions/storage.ts`) and broadcasts a stateless
// message saying so. The rollback alone is visible as content jumping back to
// the previous value with NO explanation, which reads as a bug; this module
// turns the message into something a caller can show.
//
// 🔴 KEPT FREE OF UI AND OF `@hocuspocus/provider` ON PURPOSE. The parsing is
// the part that has to be right, and keeping it here makes it assertable from a
// plain node test — importing the provider or a `.svelte` toast would drag an
// ESM bundle into the test environment for no gain.
// ───────────────────────────────────────────────────────────────────────────

/**
 * A `content-rejected` message, once it has been proven to be one.
 *
 * ⚠️ `status` IS DELIBERATELY NOT PART OF THIS TYPE. The server puts its
 * rejection reason there (`'description' cannot be changed on an approved test
 * case`) — untranslated English written for a developer reading a log. Parsing
 * it into a field would invite a caller to render it, so it is dropped here
 * rather than carried and then ignored.
 *
 * @public
 */
export interface ContentRejectedMessage {
  documentName: string
  objectAttr: string
}

const CONTENT_REJECTED = 'content-rejected'

/**
 * Recognise a `content-rejected` payload, or return `undefined`.
 *
 * 🔴 THE PAYLOAD IS UNTRUSTED INPUT. It arrives over the websocket as an opaque
 * string that anything on the other end may have written, so every step fails
 * closed: not JSON, not an object, wrong `type`, or a non-string field and the
 * message is simply not recognised. Nothing from the payload is ever handed on
 * as text to render.
 *
 * @public
 */
export function parseContentRejected (payload: unknown): ContentRejectedMessage | undefined {
  if (typeof payload !== 'string') {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    // Stateless messages are a shared channel — other senders put other shapes,
    // including non-JSON, on it. Not ours, nothing to report.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const message = parsed as Record<string, unknown>
  if (message.type !== CONTENT_REJECTED) {
    return undefined
  }
  const { documentName, objectAttr } = message
  if (typeof documentName !== 'string' || typeof objectAttr !== 'string') {
    return undefined
  }
  return { documentName, objectAttr }
}

/**
 * Route one stateless payload to `notify`, exactly once, when it is ours.
 *
 * ⚠️ `notify` TAKES NO ARGUMENT. Everything the message carries is either an
 * internal identifier (`documentName`) or a schema attribute name
 * (`objectAttr`), neither of which means anything to the person typing; the
 * wording is the caller's and is fixed. That also means a hostile payload can
 * at most cause an extra toast with our own text in it, never text of its own.
 *
 * @public
 */
export function handleStatelessPayload (payload: unknown, notify: () => void): boolean {
  if (parseContentRejected(payload) === undefined) {
    return false
  }
  notify()
  return true
}
