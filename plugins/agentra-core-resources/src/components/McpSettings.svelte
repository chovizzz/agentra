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

  const SERVER_NAME = 'agentra'

  /**
   * The whole config a client needs is the URL — this server authenticates with
   * OAuth and registers clients dynamically, so there is no key, token or client
   * id to hand over. That is what makes a one-click link possible at all: the
   * link carries nothing secret and is the same for everybody.
   */
  const remoteConfig = { url: endpoint }

  // Deeplinks differ per app in both shape AND encoding, so they are spelled out
  // rather than derived:
  //   Cursor  — base64 of the config object   (cursor.com/docs/context/mcp/install-links)
  //   VS Code — URL-encoded JSON, and it wants an explicit `type`
  //             (Cursor infers "remote" from the presence of `url` and has no
  //             `type` field for it at all, so the two cannot share one object.)
  const b64 = (o: unknown): string => btoa(JSON.stringify(o))
  const enc = (o: unknown): string => encodeURIComponent(JSON.stringify(o))

  interface OneClick {
    id: string
    label: string
    href: string
    hint?: typeof agentraCore.string.McpClaudeCodeHint
  }

  $: oneClick = (endpoint === ''
    ? []
    : [
        {
          id: 'claude-code',
          label: 'Claude Code',
          // `claude-cli://open?q=` only PRE-FILLS the prompt box — a deep link
          // never executes anything on its own. The leading `!` is Claude Code's
          // bash prefix, so pressing Enter runs the command directly instead of
          // asking a model to run it. That keeps the click as literal as the
          // Cursor/VS Code ones: the app shows what will happen and waits.
          href: `claude-cli://open?q=${encodeURIComponent(`!claude mcp add --transport http ${SERVER_NAME} ${endpoint}`)}`,
          hint: agentraCore.string.McpClaudeCodeHint
        },
        {
          id: 'cursor',
          label: 'Cursor',
          href: `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${b64(remoteConfig)}`
        },
        {
          id: 'vscode',
          label: 'VS Code',
          href: `vscode:mcp/install?name=${SERVER_NAME}&config=${enc({ type: 'http', url: endpoint })}`
        },
        {
          id: 'vscode-insiders',
          label: 'VS Code Insiders',
          href: `vscode-insiders:mcp/install?name=${SERVER_NAME}&config=${enc({ type: 'http', url: endpoint })}`
        }
      ]) as OneClick[]

  interface Snippet {
    id: string
    label: string
    text: string
    note?: typeof agentraCore.string.McpCodexNoDeeplink
    caveat?: typeof agentraCore.string.McpCodexCaveat
  }

  $: snippets = (endpoint === ''
    ? []
    : [
        {
          id: 'claude',
          label: 'Claude Code',
          text: `claude mcp add --transport http ${SERVER_NAME} ${endpoint}`
        },
        {
          id: 'codex',
          label: 'Codex',
          text: `codex mcp add ${SERVER_NAME} --url ${endpoint}`,
          // Two separate limitations, both worth stating: Codex has no install
          // deeplink at all (its only URL scheme opens an existing thread), and
          // even once added it authenticates with a static bearer token rather
          // than the MCP OAuth flow this server requires.
          note: agentraCore.string.McpCodexNoDeeplink,
          caveat: agentraCore.string.McpCodexCaveat
        }
      ]) as Snippet[]

  // The de-facto shape every remaining client reads (Cline, Windsurf, Zed, …).
  $: manualJson = JSON.stringify({ mcpServers: { [SERVER_NAME]: remoteConfig } }, null, 2)

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
      <span class="mcp-label"><Label label={agentraCore.string.McpOneClick} /></span>
      <div class="mcp-buttons">
        {#each oneClick as c (c.id)}
          <a class="mcp-button" href={c.href}>
            <Label label={agentraCore.string.McpInstallIn} params={{ client: c.label }} />
          </a>
        {/each}
      </div>
      <p class="mcp-hint"><Label label={agentraCore.string.McpOneClickHint} /></p>
      {#each oneClick.filter((c) => c.hint !== undefined) as c (c.id)}
        <p class="mcp-hint">{c.label}: <Label label={c.hint} /></p>
      {/each}
    </section>

    <section class="mcp-section">
      <span class="mcp-label"><Label label={agentraCore.string.McpCli} /></span>
      {#each snippets as sn (sn.id)}
        <div class="mcp-snippet">
          <span class="mcp-snippet-name">{sn.label}</span>
          <button class="mcp-code" on:click={() => copy(sn.text)}>
            <span class="mcp-code-text">{sn.text}</span>
            <span class="mcp-code-action">
              <Label label={copied === sn.text ? agentraCore.string.McpCopied : agentraCore.string.McpCopy} />
            </span>
          </button>
          {#if sn.note !== undefined}
            <p class="mcp-hint"><Label label={sn.note} /></p>
          {/if}
          {#if sn.caveat !== undefined}
            <p class="mcp-caveat"><Label label={sn.caveat} /></p>
          {/if}
        </div>
      {/each}
      <p class="mcp-hint"><Label label={agentraCore.string.McpAddCommandHint} /></p>
    </section>

    <section class="mcp-section">
      <span class="mcp-label"><Label label={agentraCore.string.McpOtherClients} /></span>
      <button class="mcp-code mcp-code-block" on:click={() => copy(manualJson)}>
        <pre class="mcp-code-text">{manualJson}</pre>
        <span class="mcp-code-action">
          <Label label={copied === manualJson ? agentraCore.string.McpCopied : agentraCore.string.McpCopy} />
        </span>
      </button>
      <p class="mcp-hint"><Label label={agentraCore.string.McpOtherClientsHint} /></p>
    </section>

    <section class="mcp-section">
      <span class="mcp-label"><Label label={agentraCore.string.McpEndpoint} /></span>
      <button class="mcp-code" on:click={() => copy(endpoint)}>
        <span class="mcp-code-text">{endpoint}</span>
        <span class="mcp-code-action">
          <Label label={copied === endpoint ? agentraCore.string.McpCopied : agentraCore.string.McpCopy} />
        </span>
      </button>
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
  .mcp-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .mcp-button {
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--theme-caption-color);
    background: var(--theme-button-default);
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.375rem;
    text-decoration: none;

    &:hover {
      background: var(--theme-button-hovered);
    }
  }
  .mcp-snippet {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .mcp-snippet + .mcp-snippet {
    margin-top: 0.75rem;
  }
  .mcp-snippet-name {
    font-size: 0.8125rem;
    color: var(--theme-content-color);
  }
  .mcp-code-block {
    align-items: flex-start;
  }
  .mcp-code-block .mcp-code-text {
    margin: 0;
    white-space: pre;
  }
  .mcp-caveat {
    margin: 0;
    font-size: 0.75rem;
    color: var(--theme-warning-color, var(--theme-dark-color));
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
