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
  import { Label } from '@hcengineering/ui'
  import Feishu from '../icons/Feishu.svelte'
  import login from '../../plugin'

  // ⚠️ A BRAND NAME, NOT UI COPY — which is why it is a bare literal here rather
  // than an `IntlString`, exactly as `Github.svelte` / `Google.svelte` do it.
  // The surrounding sentence IS translated (`login.string.ContinueWith`, which
  // takes `provider` as a parameter), so a Chinese UI reads "继续使用 Feishu".
  //
  // Deployments that want the Chinese mark set `FEISHU_DISPLAY_NAME=飞书` — the
  // server sends it through as `ProviderInfo.displayName` and it lands here,
  // overriding this default.
  export let displayName = 'Feishu'
</script>

<div class="flex-row-center flex-gap-2">
  <Feishu />
  <Label label={login.string.ContinueWith} params={{ provider: displayName }} />
</div>
