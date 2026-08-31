//
// Copyright © 2025 Hardcore Engineering Inc.
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

import { Analytics } from '@hcengineering/analytics'
import { type Markup, MeasureContext } from '@hcengineering/core'
import {
  Document,
  Extension,
  afterLoadDocumentPayload,
  afterUnloadDocumentPayload,
  onChangePayload,
  onConnectPayload,
  onDisconnectPayload,
  onLoadDocumentPayload,
  onStoreDocumentPayload
} from '@hocuspocus/server'
import { Transformer } from '@hocuspocus/transformer'
import { Doc as YDoc, applyUpdate, encodeStateAsUpdate } from 'yjs'
import { Context, withContext } from '../context'
import { CollabStorageAdapter } from '../storage/adapter'
import { PlatformRejectedError } from '../storage/errors'

export interface StorageConfiguration {
  ctx: MeasureContext
  adapter: CollabStorageAdapter
  transformer: Transformer
  saveRetryInterval?: number
  /**
   * How many times a platform *refusal* is re-attempted before the document is
   * reconciled back to the last content the platform accepted. A refusal is
   * deterministic, so this is not a retry budget in the usual sense — it only
   * guards against a one-off server error that happened to be reported with a
   * status this service reads as a refusal.
   */
  platformRejectAttempts?: number
}

type DocumentName = string

type ConnectionId = string

interface DocumentUpdates {
  context: Context
  collaborators: Map<ConnectionId, number>
}

export class StorageExtension implements Extension {
  private readonly configuration: StorageConfiguration
  private readonly updates = new Map<DocumentName, DocumentUpdates>()
  private readonly markups = new Map<DocumentName, Record<Markup, Markup>>()
  private readonly promises = new Map<DocumentName, Promise<void>>()

  private readonly saveRetryInterval: number
  private readonly platformRejectAttempts: number
  private stopped = false

  constructor (configuration: StorageConfiguration) {
    this.configuration = configuration
    this.saveRetryInterval = configuration.saveRetryInterval ?? 1000
    this.platformRejectAttempts = configuration.platformRejectAttempts ?? 3
  }

  async onDestroy (): Promise<any> {
    this.stopped = true
    const documents = Array.from(this.promises.keys())
    const promises = Array.from(this.promises.values())

    if (promises.length > 0) {
      const { ctx } = this.configuration
      try {
        ctx.info('waiting for pending document saves', { documents, count: promises.length })
        await Promise.all(promises)
      } catch (error) {
        ctx.error('error while waiting for pending document saves', { documents, error })
      }
    }
  }

  async onChange ({ context, document, documentName }: withContext<onChangePayload>): Promise<any> {
    const { ctx } = this.configuration
    const { connectionId } = context

    if (document.isLoading) {
      ctx.warn('document changed while is loading', { documentName, connectionId })
      return
    }

    if (connectionId === undefined) {
      // 🔴 AN ORIGIN-LESS TRANSACTION IS NOT A CLIENT EDIT. Yjs defaults the
      // transaction origin to `null`, and hocuspocus then reports the change
      // with an empty context, so `connectionId` is `undefined`. Hocuspocus
      // itself refuses to store such an update (`handleDocumentUpdate` returns
      // early when there is no connection); recording it here would put an
      // `undefined` key in `collaborators` that nothing ever clears, leaving
      // the document permanently "dirty". `revertDocument` below transacts
      // exactly like this, which is how this was found.
      ctx.info('ignoring change with no connection', { documentName })
      return
    }

    const updates = this.updates.get(documentName)
    if (updates === undefined) {
      const collaborators = new Map([[connectionId, Date.now()]])
      this.updates.set(documentName, { context, collaborators })
    } else {
      updates.context = context
      updates.collaborators.set(connectionId, Date.now())
    }
  }

  async onLoadDocument ({ context, documentName }: withContext<onLoadDocumentPayload>): Promise<any> {
    const { connectionId } = context

    this.configuration.ctx.info('load document', { documentName, connectionId })
    return await this.loadDocument(documentName, context)
  }

  async afterLoadDocument ({ context, documentName, document }: withContext<afterLoadDocumentPayload>): Promise<any> {
    const { ctx } = this.configuration
    const { connectionId } = context

    try {
      // remember the markup for the document
      this.markups.set(documentName, this.configuration.transformer.fromYdoc(document))
    } catch {
      ctx.warn('document is not of a markup type', { documentName, connectionId })
      this.markups.set(documentName, {})
    }
  }

  async onStoreDocument ({
    context,
    documentName,
    document,
    socketId
  }: withContext<onStoreDocumentPayload>): Promise<void> {
    const { ctx } = this.configuration
    const { connectionId } = context

    const connections = document.getConnectionsCount()
    ctx.info('store document', { documentName, connectionId, connections })

    if (this.hasNoUpdates(documentName)) {
      ctx.info('no changes for document', { documentName, connectionId })
      return
    }

    // `socketId === 'server'` is hocuspocus' own marker for a `DirectConnection`
    // store, i.e. the `updateContent` RPC. That call awaits this hook, so an
    // error thrown here becomes the RPC's error response. Every other caller is
    // the debounced background save, where nothing awaits us and throwing only
    // costs the document its unload — see `performStoreDocument`.
    await this.storeDocument(documentName, document, context, undefined, socketId === 'server')
  }

  async onConnect ({ context, documentName, instance }: withContext<onConnectPayload>): Promise<any> {
    const connections = instance.documents.get(documentName)?.getConnectionsCount() ?? 0
    const params = { documentName, connectionId: context.connectionId, connections }
    this.configuration.ctx.info('connect to document', params)
  }

  async onDisconnect ({ context, documentName, document }: withContext<onDisconnectPayload>): Promise<any> {
    const { ctx } = this.configuration
    const { connectionId } = context

    const connections = document.getConnectionsCount()
    ctx.info('disconnect from document', { documentName, connectionId, connections })

    const noUpdates = this.hasNoUpdates(documentName, connectionId)
    if (noUpdates) {
      ctx.info('no changes for document', { documentName, connectionId })
      return
    }

    if (document.isLoading) {
      ctx.warn('document is loading', { documentName, connectionId })
      return
    }

    await this.storeDocument(documentName, document, context, connectionId)
  }

  async afterUnloadDocument ({ documentName }: afterUnloadDocumentPayload): Promise<any> {
    this.configuration.ctx.info('unload document', { documentName })
    this.updates.delete(documentName)
    this.markups.delete(documentName)
    this.promises.delete(documentName)
  }

  private async loadDocument (documentName: string, context: Context): Promise<YDoc | undefined> {
    const { ctx, adapter } = this.configuration

    try {
      return await ctx.with(
        'load-document',
        {},
        (ctx) => {
          return adapter.loadDocument(ctx, documentName, context)
        },
        {
          workspace: context.wsIds.uuid,
          documentName
        }
      )
    } catch (err: any) {
      Analytics.handleError(err)
      ctx.error('failed to load document', { documentName, error: err })
      throw new Error('Failed to load document')
    }
  }

  private async storeDocument (
    documentName: string,
    document: Document,
    context: Context,
    connectionId?: string,
    propagateRejection: boolean = false
  ): Promise<void> {
    const prev = this.promises.get(documentName)

    const curr = async (): Promise<void> => {
      if (prev !== undefined) {
        // Saves can now end in a rejection (see `performStoreDocument`). A
        // previous save that failed has already reported itself; swallowing it
        // here keeps the chain going so the next save still gets its attempt.
        try {
          await prev
        } catch {
          // intentionally ignored
        }
      }

      // Check whether we still have changes after the previous save
      const noUpdates = this.hasNoUpdates(documentName, connectionId)
      if (!noUpdates) {
        await this.performStoreDocument(documentName, document, context, propagateRejection)
      }
    }

    const promise = curr()
    this.promises.set(documentName, promise)

    try {
      await promise
    } finally {
      if (this.promises.get(documentName) === promise) {
        this.promises.delete(documentName)
      }
    }
  }

  private async performStoreDocument (
    documentName: string,
    document: Document,
    context: Context,
    propagateRejection: boolean
  ): Promise<void> {
    const { ctx, adapter } = this.configuration

    let attempt = 0
    let rejections = 0
    while (true) {
      attempt++
      const now = Date.now()

      try {
        const currMarkup = await ctx.with(
          'save-document',
          {},
          (ctx) =>
            adapter.saveDocument(ctx, documentName, document, context, {
              prev: () => this.markups.get(documentName) ?? {},
              curr: () => this.configuration.transformer.fromYdoc(document)
            }),
          {
            workspace: context.wsIds.uuid,
            documentName
          }
        )

        this.markups.set(documentName, currMarkup ?? {})
        this.clearUpdates(documentName, now)

        return
      } catch (err: any) {
        Analytics.handleError(err)
        ctx.error('failed to save document', { documentName, attempt, error: err })

        if (err instanceof PlatformRejectedError) {
          rejections++
          if (rejections >= this.platformRejectAttempts) {
            // 🔴 A REFUSAL IS TERMINAL, SO IT MUST NOT JOIN THE RETRY LOOP.
            // The loop below exists for storage/transport failures, which a
            // retry can fix. A refusal cannot be retried into an acceptance,
            // and looping on it burns a save every `saveRetryInterval` forever
            // while pinning the document in memory.
            //
            // What is left behind is the real problem: `saveDocument` writes
            // the ydoc BEFORE it talks to the platform, and `loadDocument`
            // prefers the ydoc over the blob ref. So a refused edit stays in
            // collaborator storage and gets served back to editors even though
            // the platform never took it. Put the document back to the content
            // the platform does hold, persist that, and let the editors see it.
            await this.revertDocument(documentName, document, context, err, now)

            if (propagateRejection) {
              // The RPC path awaits this hook, so throwing is what turns a
              // refusal into an error response for the caller.
              throw err
            }

            // 🔴 THE BACKGROUND PATH MUST NOT THROW. Nobody awaits the
            // debounced store, so an error there reaches no user — and
            // hocuspocus skips `afterStoreDocument`, hence `unloadDocument`,
            // whenever `onStoreDocument` rejects. With `unloadImmediately:
            // false` (see `server.ts`) a document whose last connection closed
            // while a save was pending would then sit in `hocuspocus.documents`
            // forever. Returning normally lets it unload; the reconcile above,
            // which every connected editor receives, is the feedback here.
            return
          }
        }

        if (this.stopped) {
          ctx.info('storage extension stopped, skipping document save', { documentName })
          throw new Error('Aborted')
        }

        await new Promise((resolve) => setTimeout(resolve, this.saveRetryInterval))
      }
    }
  }

  /**
   * Bring the in-memory document, and collaborator's own ydoc storage, back to
   * the last content the platform accepted.
   *
   * ⚠️ This is deliberately generic: it is driven by the refusal the platform
   * returned and the attribute named in it, and knows nothing about which class
   * or which guard produced it. Any server-side check that refuses a
   * `TxUpdateDoc` on a collaborative attribute is reconciled the same way.
   *
   * The transaction is applied with no origin, which matters twice over:
   * hocuspocus broadcasts the resulting update to every connected editor (so
   * the author watches the refused text revert, which is the only feedback the
   * background save path has), and it does NOT schedule another store, so this
   * cannot recurse.
   */
  private async revertDocument (
    documentName: string,
    document: Document,
    context: Context,
    rejection: PlatformRejectedError,
    since: number
  ): Promise<void> {
    const { ctx, adapter, transformer } = this.configuration
    const { objectAttr } = rejection

    const accepted = this.markups.get(documentName)?.[objectAttr]
    if (accepted === undefined) {
      // Nothing known-good to go back to — the document was never read as
      // markup. Leave it alone rather than blanking a field we cannot restore.
      ctx.warn('cannot revert refused document, no known accepted content', { documentName, objectAttr })
      return
    }

    try {
      ctx.warn('reverting refused document content', { documentName, objectAttr })

      const update = encodeStateAsUpdate(transformer.toYdoc(accepted, objectAttr))
      document.transact(() => {
        const fragment = document.getXmlFragment(objectAttr)
        fragment.delete(0, fragment.length)
        applyUpdate(document, update)
      })

      // Persist the reverted ydoc. `prev` and `curr` now agree on `objectAttr`,
      // so `saveDocumentToPlatform` short-circuits and no second transaction is
      // sent to the platform.
      await adapter.saveDocument(ctx, documentName, document, context, {
        prev: () => this.markups.get(documentName) ?? {},
        curr: () => transformer.fromYdoc(document)
      })

      // Edits that arrived after this attempt started keep their timestamp and
      // are therefore preserved for the next save, exactly as on the happy path.
      this.clearUpdates(documentName, since)

      // Explicit signal for clients that care to render one. Providers with no
      // stateless handler ignore it, so this is additive.
      document.broadcastStateless(
        JSON.stringify({
          type: 'content-rejected',
          documentName,
          objectAttr,
          status: rejection.status
        })
      )
    } catch (err: any) {
      Analytics.handleError(err)
      ctx.error('failed to revert refused document content', { documentName, objectAttr, error: err })
    }
  }

  private clearUpdates (documentName: string, timestamp: number): void {
    const updates = this.updates.get(documentName)
    if (updates !== undefined) {
      for (const [connectionId, updatedAt] of updates.collaborators.entries()) {
        if (updatedAt < timestamp) {
          updates.collaborators.delete(connectionId)
        }
      }
    }
  }

  private hasNoUpdates (documentName: string, connectionId?: string): boolean {
    const updates = this.updates.get(documentName)
    if (updates === undefined) {
      return true
    }

    if (connectionId !== undefined) {
      return !updates.collaborators.has(connectionId)
    }

    return updates.collaborators.size === 0
  }
}
