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

import { MeasureMetricsContext, type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import { Document } from '@hocuspocus/server'
import { applyUpdate, encodeStateAsUpdate, type Doc as YDoc } from 'yjs'

import type { Context } from '../context'
import { StorageExtension } from '../extensions/storage'
import type { CollabStorageAdapter } from '../storage/adapter'
import { PlatformRejectedError, isPlatformRejection } from '../storage/errors'
import { MarkupTransformer } from '../transformers/markup'

const transformer = new MarkupTransformer()

const approved = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"approved"}]}]}'
const edited = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"edited"}]}]}'

const objectAttr = 'description'

function makeContext (): Context {
  return {
    connectionId: 'conn-1',
    wsIds: { uuid: 'ws' as WorkspaceUuid, url: 'ws', dataId: undefined },
    clientFactory: async () => {
      throw new Error('not used')
    }
  } as unknown as Context
}

// hocuspocus `Document` builds an `Awareness`, which starts a timer. Destroy
// every document we create or jest keeps the event loop alive after the run.
const documents: Document[] = []

afterEach(() => {
  while (documents.length > 0) {
    documents.pop()?.destroy()
  }
})

function makeDocument (name: string, markup: string): Document {
  const document = new Document(name)
  documents.push(document)
  applyUpdate(document, encodeStateAsUpdate(transformer.toYdoc(markup, objectAttr)))
  document.isLoading = false
  return document
}

function setMarkup (document: Document, markup: string): void {
  const update = encodeStateAsUpdate(transformer.toYdoc(markup, objectAttr))
  document.transact(() => {
    const fragment = document.getXmlFragment(objectAttr)
    fragment.delete(0, fragment.length)
    applyUpdate(document, update)
  })
}

function textOf (document: YDoc): string {
  return transformer.fromYdoc(document, objectAttr)
}

interface SaveCall {
  documentName: string
  prev: Record<string, string>
  curr: Record<string, string>
}

class RecordingAdapter implements CollabStorageAdapter {
  readonly calls: SaveCall[] = []

  constructor (private readonly onSave: (call: SaveCall, index: number) => void = () => {}) {}

  async loadDocument (): Promise<YDoc | undefined> {
    return undefined
  }

  async saveDocument (
    ctx: MeasureContext,
    documentName: string,
    document: YDoc,
    context: Context,
    getMarkup: { prev: () => Record<string, string>, curr: () => Record<string, string> }
  ): Promise<Record<string, string> | undefined> {
    const call: SaveCall = { documentName, prev: getMarkup.prev(), curr: getMarkup.curr() }
    const index = this.calls.length
    this.calls.push(call)
    this.onSave(call, index)
    return call.curr
  }
}

function makeExtension (adapter: CollabStorageAdapter, platformRejectAttempts = 1): StorageExtension {
  return new StorageExtension({
    ctx: new MeasureMetricsContext('test', {}),
    adapter,
    transformer,
    saveRetryInterval: 1,
    platformRejectAttempts
  })
}

async function seed (extension: StorageExtension, documentName: string, document: Document): Promise<void> {
  const context = makeContext()
  await extension.afterLoadDocument({ context, documentName, document } as any)

  // Mirror what hocuspocus does on every yjs update, including the empty
  // context it hands over for an origin-less (server-side) transaction — that
  // is the path `revertDocument` takes.
  document.onUpdate((doc, connection) => {
    void extension.onChange({
      context: (connection as any)?.context ?? {},
      document: doc,
      documentName
    } as any)
  })

  setMarkup(document, edited)
  await extension.onChange({ context, document, documentName } as any)
}

function rejection (documentName: string): PlatformRejectedError {
  return new PlatformRejectedError(
    documentName,
    objectAttr,
    new Status(Severity.ERROR, platform.status.UnknownError, { message: 'approved-case-readonly' }),
    new Error('approved-case-readonly')
  )
}

describe('isPlatformRejection', () => {
  it('treats a status the platform answered with as a refusal', () => {
    const err = new PlatformError(new Status(Severity.ERROR, platform.status.UnknownError, { message: 'nope' }))
    expect(isPlatformRejection(err)).toBe(true)
  })

  it('treats a lost connection as transient', () => {
    const err = new PlatformError(new Status(Severity.ERROR, platform.status.ConnectionClosed, {}))
    expect(isPlatformRejection(err)).toBe(false)
  })

  it('treats a plain error as transient', () => {
    expect(isPlatformRejection(new Error('Connection closed'))).toBe(false)
  })
})

describe('StorageExtension platform refusal handling', () => {
  it('does not leave refused content in the ydoc', async () => {
    const documentName = 'ws://testCase:class:TestCase/case-1/description'
    const adapter = new RecordingAdapter((call, index) => {
      if (index === 0) {
        throw rejection(documentName)
      }
    })
    const extension = makeExtension(adapter)
    const document = makeDocument(documentName, approved)

    await seed(extension, documentName, document)
    expect(textOf(document)).toEqual(edited)

    await expect(
      extension.onStoreDocument({ context: makeContext(), documentName, document, socketId: 'server' } as any)
    ).rejects.toBeInstanceOf(PlatformRejectedError)

    // the reconcile save is what collaborator storage ends up holding
    expect(adapter.calls).toHaveLength(2)
    expect(adapter.calls[0].curr[objectAttr]).toEqual(edited)
    expect(adapter.calls[1].curr[objectAttr]).toEqual(approved)

    // and the live document every editor is looking at is back to the accepted text
    expect(textOf(document)).toEqual(approved)
  })

  it('stops retrying a refusal instead of pinning the document forever', async () => {
    const documentName = 'ws://testCase:class:TestCase/case-2/description'
    const adapter = new RecordingAdapter((call, index) => {
      if (index < 2) {
        throw rejection(documentName)
      }
    })
    const extension = makeExtension(adapter, 2)
    const document = makeDocument(documentName, approved)

    await seed(extension, documentName, document)

    await expect(
      extension.onStoreDocument({ context: makeContext(), documentName, document, socketId: 'server' } as any)
    ).rejects.toBeInstanceOf(PlatformRejectedError)

    // two refused attempts, then exactly one reconcile save — not an endless loop
    expect(adapter.calls).toHaveLength(3)
    expect(textOf(document)).toEqual(approved)
  })

  it('reconciles any collaborative document, not one particular class', async () => {
    const documentName = 'ws://card:class:Card/card-1/description'
    const adapter = new RecordingAdapter((call, index) => {
      if (index === 0) {
        throw rejection(documentName)
      }
    })
    const extension = makeExtension(adapter)
    const document = makeDocument(documentName, approved)

    await seed(extension, documentName, document)

    await expect(
      extension.onStoreDocument({ context: makeContext(), documentName, document, socketId: 'server' } as any)
    ).rejects.toBeInstanceOf(PlatformRejectedError)

    expect(textOf(document)).toEqual(approved)
  })

  it('reconciles without throwing on the background save path', async () => {
    const documentName = 'ws://testCase:class:TestCase/case-3/description'
    const adapter = new RecordingAdapter((call, index) => {
      if (index === 0) {
        throw rejection(documentName)
      }
    })
    const extension = makeExtension(adapter)
    const document = makeDocument(documentName, approved)
    const context = makeContext()

    await seed(extension, documentName, document)

    // no `socketId: 'server'`: this is the debounced save, where a throw would
    // only cost the document its unload
    await expect(
      extension.onStoreDocument({ context, documentName, document, socketId: 'sock-1' } as any)
    ).resolves.toBeUndefined()

    expect(textOf(document)).toEqual(approved)
    expect(adapter.calls).toHaveLength(2)

    // and the revert transaction itself did not register as a collaborator edit.
    // It has no yjs origin, so hocuspocus reports it with an empty context and
    // an `undefined` connection id, which nothing would ever clear again.
    const collaborators = (extension as any).updates.get(documentName)?.collaborators as
      | Map<string | undefined, number>
      | undefined
    expect(collaborators?.has(undefined) ?? false).toBe(false)
  })
})

describe('StorageExtension unchanged behaviour', () => {
  it('keeps the accepted content when the platform takes the write', async () => {
    const documentName = 'ws://document:class:Document/doc-1/description'
    const adapter = new RecordingAdapter()
    const extension = makeExtension(adapter)
    const document = makeDocument(documentName, approved)

    await seed(extension, documentName, document)

    await expect(
      extension.onStoreDocument({ context: makeContext(), documentName, document, socketId: 'sock-1' } as any)
    ).resolves.toBeUndefined()

    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0].curr[objectAttr]).toEqual(edited)
    expect(textOf(document)).toEqual(edited)
  })

  it('retries a storage failure and never reverts the author content', async () => {
    const documentName = 'ws://document:class:Document/doc-2/description'
    const adapter = new RecordingAdapter((call, index) => {
      if (index < 2) {
        throw new Error('storage unavailable')
      }
    })
    const extension = makeExtension(adapter)
    const document = makeDocument(documentName, approved)

    await seed(extension, documentName, document)

    await expect(
      extension.onStoreDocument({ context: makeContext(), documentName, document, socketId: 'sock-1' } as any)
    ).resolves.toBeUndefined()

    expect(adapter.calls).toHaveLength(3)
    expect(adapter.calls.every((c) => c.curr[objectAttr] === edited)).toBe(true)
    expect(textOf(document)).toEqual(edited)
  })

  it('does not blank a document it has no accepted content for', async () => {
    const documentName = 'ws://document:class:Document/doc-3/description'
    const adapter = new RecordingAdapter((call, index) => {
      if (index === 0) {
        throw rejection(documentName)
      }
    })
    const extension = makeExtension(adapter)
    const document = makeDocument(documentName, approved)
    const context = makeContext()

    // no afterLoadDocument, so nothing known-good is remembered
    setMarkup(document, edited)
    await extension.onChange({ context, document, documentName } as any)

    await expect(
      extension.onStoreDocument({ context, documentName, document, socketId: 'server' } as any)
    ).rejects.toBeInstanceOf(PlatformRejectedError)

    expect(adapter.calls).toHaveLength(1)
    expect(textOf(document)).toEqual(edited)
  })
})
