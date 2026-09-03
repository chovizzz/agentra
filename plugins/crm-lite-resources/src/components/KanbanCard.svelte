<!--
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
-->
<script lang="ts">
  import { AttachmentsPresenter } from '@hcengineering/attachment-resources'
  import { ContactPresenter } from '@hcengineering/contact-resources'
  import type { WithLookup } from '@hcengineering/core'
  import type { Lead } from '@hcengineering/crm-lite'
  import notification from '@hcengineering/notification'
  import { getClient } from '@hcengineering/presentation'
  import { ActionIcon, Component, IconMoreH } from '@hcengineering/ui'
  import type { BuildModelKey } from '@hcengineering/view'
  import { enabledConfig, openDoc, showMenu } from '@hcengineering/view-resources'

  import crmLite from '../plugin'
  import LeadPriorityPresenter from './LeadPriorityPresenter.svelte'
  import LeadStatusPresenter from './LeadStatusPresenter.svelte'

  export let object: WithLookup<Lead>
  export let config: (string | BuildModelKey)[] = []
  export let groupByKey: string = ''

  const client = getClient()

  function showLead (): void {
    void openDoc(client.getHierarchy(), object)
  }
</script>

<div class="flex-col pt-3 pb-3 pr-4 pl-4">
  <div class="flex-between mb-3">
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <div class="fs-title cursor-pointer" on:click={showLead}>{object.title}</div>
    <div class="flex-row-center">
      <div class="mr-2">
        <Component is={notification.component.NotificationPresenter} props={{ value: object }} />
      </div>
      <ActionIcon
        label={crmLite.string.More}
        action={(evt) => {
          showMenu(evt, { object })
        }}
        icon={IconMoreH}
        size={'small'}
      />
    </div>
  </div>

  {#if enabledConfig(config, 'account') && object.$lookup?.account !== undefined}
    <div class="flex-between mb-2">
      <ContactPresenter value={object.$lookup.account} avatarSize={'small'} />
    </div>
  {/if}

  <div class="card-labels mb-2">
    <!-- The column already says the status, so only show it when grouping by
         something else. -->
    {#if groupByKey !== 'status' && enabledConfig(config, 'status')}
      <LeadStatusPresenter value={object.status} size={'small'} kind={'link-bordered'} />
    {/if}
    {#if enabledConfig(config, 'priority')}
      <LeadPriorityPresenter value={object.priority} size={'small'} kind={'link-bordered'} />
    {/if}
  </div>

  <div class="flex-between">
    <div class="flex-row-center gap-3 reverse mr-4">
      {#if enabledConfig(config, 'attachments') && (object.attachments ?? 0) > 0}
        <AttachmentsPresenter value={object.attachments} {object} />
      {/if}
    </div>
    {#if enabledConfig(config, 'owner') && object.$lookup?.owner !== undefined}
      <ContactPresenter value={object.$lookup.owner} avatarSize={'small'} />
    {/if}
  </div>
</div>

<style lang="scss">
  .card-labels {
    display: flex;
    flex-wrap: nowrap;
    min-width: 0;
  }
</style>
