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
//
// A local copy of `view-resources`' `SimpleNotification`, which is not
// reachable from here: `@hcengineering/view-resources` is not a dependency of
// this package and `SimpleNotification` is not registered as an `AnyComponent`
// on the `view` descriptor either, so there is nothing to look up by ref.
//
// ⚠️ It renders `notification.title` / `notification.subTitle` and NOTHING from
// the wire — those two are always our own translated `IntlString`s. See
// `provider/contentRejected.ts` for why that matters.
-->
<script lang="ts">
  import { type Notification, NotificationToast } from '@hcengineering/ui'

  export let notification: Notification
  export let onRemove: () => void
</script>

<NotificationToast title={notification.title} severity={notification.severity} onClose={onRemove}>
  <svelte:fragment slot="content">
    {notification.subTitle}
  </svelte:fragment>
</NotificationToast>
