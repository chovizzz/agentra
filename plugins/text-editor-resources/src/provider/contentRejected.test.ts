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

import { handleStatelessPayload, parseContentRejected } from './contentRejected'

const valid = JSON.stringify({
  type: 'content-rejected',
  documentName: 'doc-1',
  objectAttr: 'description',
  status: "'description' cannot be changed on an approved test case"
})

describe('parseContentRejected', () => {
  it('recognises the collaborator payload', () => {
    expect(parseContentRejected(valid)).toEqual({ documentName: 'doc-1', objectAttr: 'description' })
  })

  it('never carries the server reason through', () => {
    // The `status` field is developer-facing untranslated English; it must not
    // reach anything that could render it.
    expect(Object.keys(parseContentRejected(valid) ?? {}).sort()).toEqual(['documentName', 'objectAttr'])
  })

  it.each([
    ['not json at all', 'ping'],
    ['empty string', ''],
    ['a json scalar', '"content-rejected"'],
    ['a json array', '["content-rejected"]'],
    ['null', 'null'],
    ['another stateless message', JSON.stringify({ type: 'something-else', documentName: 'd', objectAttr: 'a' })],
    ['no type', JSON.stringify({ documentName: 'd', objectAttr: 'a' })],
    ['missing documentName', JSON.stringify({ type: 'content-rejected', objectAttr: 'a' })],
    ['missing objectAttr', JSON.stringify({ type: 'content-rejected', documentName: 'd' })],
    ['non-string documentName', JSON.stringify({ type: 'content-rejected', documentName: 7, objectAttr: 'a' })],
    ['non-string objectAttr', JSON.stringify({ type: 'content-rejected', documentName: 'd', objectAttr: {} })]
  ])('ignores %s', (_name, payload) => {
    expect(parseContentRejected(payload)).toBeUndefined()
  })

  it.each([[undefined], [null], [42], [{ type: 'content-rejected' }]])('ignores a non-string payload %p', (payload) => {
    expect(parseContentRejected(payload)).toBeUndefined()
  })

  it('does not resolve a prototype-polluting payload into a message', () => {
    expect(parseContentRejected('{"__proto__":{"type":"content-rejected"}}')).toBeUndefined()
  })
})

describe('handleStatelessPayload', () => {
  it('notifies exactly once for an expected payload', () => {
    const notify = jest.fn()
    expect(handleStatelessPayload(valid, notify)).toBe(true)
    expect(notify).toHaveBeenCalledTimes(1)
    // Nothing from the payload is passed to the caller's notifier.
    expect(notify).toHaveBeenCalledWith()
  })

  it('stays silent on malformed and unrelated payloads', () => {
    const notify = jest.fn()
    for (const payload of ['', 'ping', '[]', 'null', JSON.stringify({ type: 'awareness' }), undefined]) {
      expect(handleStatelessPayload(payload, notify)).toBe(false)
    }
    expect(notify).not.toHaveBeenCalled()
  })
})
