//
// Copyright © 2023, 2024 Hardcore Engineering Inc.
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
import { type Blob, type Ref } from '@hcengineering/core'
import { translate } from '@hcengineering/platform'
import { getCurrentLanguage } from '@hcengineering/theme'
import { addNotification, NotificationSeverity } from '@hcengineering/ui'
import { HocuspocusProvider, type HocuspocusProviderConfiguration } from '@hocuspocus/provider'

import ContentRejectedNotification from '../components/ContentRejectedNotification.svelte'
import plugin from '../plugin'

import { handleStatelessPayload } from './contentRejected'
import { type Provider } from './types'

/**
 * One toast at a time: repeated rejections replace the standing one instead of
 * stacking a column of identical warnings while somebody keeps typing.
 */
const CONTENT_REJECTED_GROUP = 'text-editor-content-rejected'

/**
 * Tell the user their edit was rolled back.
 *
 * ⚠️ THE WORDING IS OURS, NEVER THE SERVER'S. The rejection carries a `status`
 * string like `'description' cannot be changed on an approved test case` —
 * untranslated English aimed at a developer reading a log, and, being untrusted
 * wire data, not something to render at all. `handleStatelessPayload` therefore
 * hands over nothing and this shows two `IntlString`s.
 */
async function notifyContentRejected (): Promise<void> {
  const language = getCurrentLanguage()
  addNotification(
    await translate(plugin.string.ContentChangeRejectedTitle, {}, language),
    await translate(plugin.string.ContentChangeRejected, {}, language),
    ContentRejectedNotification,
    undefined,
    NotificationSeverity.Warning,
    CONTENT_REJECTED_GROUP
  )
}

export type HocuspocusCollabProviderConfiguration = HocuspocusProviderConfiguration &
Required<Pick<HocuspocusProviderConfiguration, 'token'>> &
Omit<HocuspocusProviderConfiguration, 'parameters'> & {
  parameters: HocuspocusCollabProviderURLParameters
}

export interface HocuspocusCollabProviderURLParameters {
  content: Ref<Blob> | null
}

export class HocuspocusCollabProvider extends HocuspocusProvider implements Provider {
  readonly loaded: Promise<void>

  constructor (configuration: HocuspocusCollabProviderConfiguration) {
    const parameters: Record<string, any> = {}

    const content = configuration.parameters?.content
    if (content !== null && content !== undefined && content !== '') {
      parameters.content = content
    }

    const hocuspocusConfig: HocuspocusProviderConfiguration = {
      ...configuration,
      parameters
    }
    super(hocuspocusConfig)

    this.loaded = new Promise((resolve) => {
      this.on('synced', resolve)
    })

    // The collaborator rolls the ydoc back when the platform refuses a save and
    // says so on the stateless channel (`server/collaborator/src/extensions/
    // storage.ts`). With nobody listening the content just snaps back to the
    // previous value with no explanation, which reads as a bug.
    //
    // ⚠️ ADDITIVE. `HocuspocusProvider`'s constructor already subscribes
    // `configuration.onStateless`, and this is a second listener rather than a
    // replacement, so a caller passing its own handler keeps it. `destroy()`
    // calls `removeAllListeners()`, so it goes away with the provider.
    //
    // ⚠️ EVERY VIEWER OF THE DOCUMENT SEES THIS, not only the person whose edit
    // was refused: `storage.ts` calls `broadcastStateless` with no connection
    // filter, and the payload names no connection, so there is nothing here to
    // narrow it with. The wording is therefore about the DOCUMENT rather than
    // about "you" — a bystander watching the content roll back needs the same
    // explanation anyway. Narrowing it would have to happen server side.
    this.on('stateless', ({ payload }: { payload: string }) => {
      handleStatelessPayload(payload, () => {
        void notifyContentRejected()
      })
    })
  }

  destroy (): void {
    super.destroy()
    this.configuration.websocketProvider.disconnect()
  }
}
