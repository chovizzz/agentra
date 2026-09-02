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
  import { getMetadata } from '@hcengineering/platform'
  import { copyTextToClipboard } from '@hcengineering/presentation'
  import { Icon, Label } from '@hcengineering/ui'

  import agentraCore from '../plugin'

  // Empty when the deployment ships no MCP server. Saying so beats printing a
  // command that silently cannot work.
  const base = (getMetadata(agentraCore.metadata.McpUrl) ?? '').replace(/\/$/, '')
  const endpoint = base !== '' ? `${base}/mcp` : ''
  const addCommand = endpoint !== '' ? `claude mcp add --transport http agentra ${endpoint}` : ''

  let copied: string | undefined

  async function copy (text: string): Promise<void> {
    await copyTextToClipboard(text)
    copied = text
    setTimeout(() => {
      // Only clear if nothing else was copied in the meantime, so a second copy
      // does not get its confirmation cut short by the first one's timer.
      if (copied === text) copied = undefined
    }, 2000)
  }
</script>

<div class="mcp-root">
  <div class="mcp-header">
    <Icon icon={agentraCore.icon.AgentraCore} size="medium" />
    <span class="mcp-title"><Label label={agentraCore.string.Mcp} /></span>
  </div>
  <p class="mcp-desc"><Label label={agentraCore.string.McpDescription} /></p>

  {#if endpoint === ''}
    <p class="mcp-empty"><Label label={agentraCore.string.McpNotConfigured} /></p>
  {:else}
    <section class="mcp-section">
      <span class="mcp-label"><Label label={agentraCore.string.McpEndpoint} /></span>
      <button class="mcp-code" title={copied === endpoint ? '' : undefined} on:click={() => copy(endpoint)}>
        <span class="mcp-code-text">{endpoint}</span>
        <span class="mcp-code-action">
          <Label label={copied === endpoint ? agentraCore.string.McpCopied : agentraCore.string.McpCopy} />
        </span>
      </button>
    </section>

    <section class="mcp-section">
      <span class="mcp-label"><Label label={agentraCore.string.McpAddCommand} /></span>
      <button class="mcp-code" on:click={() => copy(addCommand)}>
        <span class="mcp-code-text">{addCommand}</span>
        <span class="mcp-code-action">
          <Label label={copied === addCommand ? agentraCore.string.McpCopied : agentraCore.string.McpCopy} />
        </span>
      </button>
      <p class="mcp-hint"><Label label={agentraCore.string.McpAddCommandHint} /></p>
    </section>

    <section class="mcp-section">
      <span class="mcp-label"><Label label={agentraCore.string.McpAuth} /></span>
      <p class="mcp-hint"><Label label={agentraCore.string.McpAuthDescription} /></p>
    </section>

    <section class="mcp-section">
      <span class="mcp-label"><Label label={agentraCore.string.McpTools} /></span>
      <ul class="mcp-list">
        <li><Label label={agentraCore.string.McpToolsRead} /></li>
        <li><Label label={agentraCore.string.McpToolsWrite} /></li>
      </ul>
      <p class="mcp-note"><Label label={agentraCore.string.McpNoDelete} /></p>
    </section>
  {/if}
</div>

<style lang="scss">
  .mcp-root {
    padding: 2rem 2.5rem;
    max-width: 48rem;
  }
  .mcp-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .mcp-title {
    font-weight: 600;
    font-size: 1.25rem;
    color: var(--theme-caption-color);
  }
  .mcp-desc {
    margin: 0.5rem 0 1.75rem;
    color: var(--theme-content-color);
  }
  .mcp-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1.75rem;
  }
  .mcp-label {
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--theme-dark-color);
  }
  .mcp-code {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    width: 100%;
    padding: 0.75rem 1rem;
    text-align: left;
    font-family: var(--mono-font);
    font-size: 0.8125rem;
    color: var(--theme-caption-color);
    background: var(--theme-bg-color);
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.5rem;
    cursor: pointer;

    &:hover {
      border-color: var(--theme-navpanel-divider);
    }
  }
  .mcp-code-text {
    // The command is long; let it scroll inside the box rather than push the
    // page sideways.
    overflow-x: auto;
    white-space: nowrap;
  }
  .mcp-code-action {
    flex-shrink: 0;
    font-family: var(--body-font);
    font-size: 0.75rem;
    color: var(--theme-dark-color);
  }
  .mcp-hint,
  .mcp-note,
  .mcp-empty {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--theme-dark-color);
  }
  .mcp-note {
    margin-top: 0.5rem;
  }
  .mcp-list {
    margin: 0;
    padding-left: 1.25rem;
    color: var(--theme-content-color);
    font-size: 0.875rem;

    li + li {
      margin-top: 0.25rem;
    }
  }
</style>
