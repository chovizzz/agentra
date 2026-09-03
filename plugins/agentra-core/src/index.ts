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

import type { Class, Doc, Mixin, PersonId, Ref, Timestamp } from '@hcengineering/core'
import type { Asset, IntlString, Metadata, Plugin } from '@hcengineering/platform'
import type { AnyComponent } from '@hcengineering/ui'
import { plugin } from '@hcengineering/platform'

/**
 * A deliberately semantics-free document used only to prove that the whole
 * registration chain (rush -> model -> migration -> ui resources -> assets ->
 * server resources) is wired up end to end.
 *
 * Real Agentra modules replace this with their own classes; they do NOT extend it.
 *
 * @public
 */
export interface AgentraMarker extends Doc {
  // Stable, human readable identity of the marker. Unique per workspace.
  key: string
  // When the marker was produced by the migration.
  producedOn: Timestamp
}

/**
 * SYS-005's archive flag, as a MIXIN rather than as fields on every business
 * class.
 *
 * 🔴 A MIXIN, NOT A BASE CLASS. Lead and Requirement are `MasterTag`s of
 * `card.class.Card`, Issue is a `Task` and TestCase is a plain `Doc` — there is
 * no common ancestor below `core.class.Doc` to put the fields on, and Agentra
 * may not edit those four modules' schemas anyway. A mixin extending
 * `core.class.Doc` applies to all of them from this side.
 *
 * 🔴 NONE OF THESE ATTRIBUTES MAY CARRY `@Index`. A mixin attribute is stored
 * under the DOTTED key `<mixinId>.<attr>` (`TxProcessor.updateMixin4Doc` nests
 * the payload under `doc[mixinId]`), so an index declared on the bare name
 * `archived` indexes a column that no query ever names and can never hit.
 * Query it as {@link archivableKey}`('archived')`.
 *
 * @public
 */
export interface Archivable extends Doc {
  /** `true` while the object is archived. Absent means "never archived". */
  archived: boolean
  archivedOn?: Timestamp
  archivedBy?: PersonId
  /**
   * How many archive/restore transitions this object has been through.
   *
   * 🔴 NOT A STATISTIC — it is what makes the flag WRITABLE MORE THAN ONCE
   * under an idempotency ledger. The archive command's claim is keyed on
   * `(target, generation)`; without the generation, archive -> restore ->
   * archive would present the FIRST archive's key again, `CommandMiddleware`
   * would answer it out of the ledger without re-entering the body, and the
   * object would stay restored while the caller was told it had been archived.
   *
   * It is also what makes the server-side field guard forgery-proof for a
   * REPEATABLE transition: the guard demands a ledger row derived from
   * `(lock, target, the generation this very transaction writes)`, and that row
   * is unforgeable because `CommandMiddleware.tx` refuses every client CUD on
   * `CommandExecution` and `commandExecutionId` is a SHA-256 prefix.
   */
  archiveGeneration: number
}

/**
 * @public
 */
export const agentraCoreId = 'agentra-core' as Plugin

/**
 * @public
 */
const agentraCore = plugin(agentraCoreId, {
  class: {
    AgentraMarker: '' as Ref<Class<AgentraMarker>>
  },
  ids: {
    // Deterministic id for the single bootstrap marker. Using a fixed id (rather
    // than `generateId()`) is what makes the migration idempotent under
    // concurrency: a second migrator inserting the same `_id` collides instead
    // of silently producing a duplicate document.
    BootstrapMarker: '' as Ref<AgentraMarker>,
    McpSettingsCategory: '' as Ref<Doc>
  },
  mixin: {
    /**
     * {@link Archivable}. Classifier kind `core.class.Mixin`, NOT
     * `core.class.Class` — `@Mixin` in `models/agentra-core` emits it that way,
     * and a plain `@Model` would make it a standalone class nothing could be
     * stamped with.
     */
    Archivable: '' as Ref<Mixin<Archivable>>
  },
  string: {
    AgentraCore: '' as IntlString,
    ConfigLabel: '' as IntlString,
    ConfigDescription: '' as IntlString,
    Archived: '' as IntlString,
    ArchivedOn: '' as IntlString,
    ArchivedBy: '' as IntlString,
    ArchiveGeneration: '' as IntlString,
    Archive: '' as IntlString,
    Restore: '' as IntlString,
    ShowArchived: '' as IntlString,
    ArchiveConfirmation: '' as IntlString,
    RestoreConfirmation: '' as IntlString,
    ArchiveInsteadOfDelete: '' as IntlString,
    Mcp: '' as IntlString,
    McpDescription: '' as IntlString,
    McpEndpoint: '' as IntlString,
    McpAddCommand: '' as IntlString,
    McpAddCommandHint: '' as IntlString,
    McpNotConfigured: '' as IntlString,
    McpTools: '' as IntlString,
    McpToolsRead: '' as IntlString,
    McpToolsWrite: '' as IntlString,
    McpNoDelete: '' as IntlString,
    McpAuth: '' as IntlString,
    McpAuthDescription: '' as IntlString,
    McpCopied: '' as IntlString,
    McpCopy: '' as IntlString,
    McpOneClick: '' as IntlString,
    McpOneClickHint: '' as IntlString,
    McpCli: '' as IntlString,
    McpOtherClients: '' as IntlString,
    McpOtherClientsHint: '' as IntlString,
    McpCodexCaveat: '' as IntlString,
    McpInstallIn: '' as IntlString,
    McpClaudeCodeHint: '' as IntlString,
    McpCodexNoDeeplink: '' as IntlString
  },
  icon: {
    AgentraCore: '' as Asset
  },
  component: {
    /** Settings -> MCP: how to point an agent at this workspace. */
    McpSettings: '' as AnyComponent
  },
  metadata: {
    /**
     * Public base URL of the MCP server, e.g. `https://mcp.example.com`.
     *
     * Empty when the deployment has no MCP server — the settings page says so
     * rather than printing a command that cannot work. It travels the same way
     * `GITHUB_URL` does: compose -> front's `config.json` -> `setMetadata` in
     * `dev/prod/src/platform.ts`.
     */
    McpUrl: '' as Metadata<string>
  }
})

/**
 * The persisted key of one {@link Archivable} attribute.
 *
 * 🔴 EVERY QUERY AND EVERY `TxUpdateDoc` MUST GO THROUGH THIS. Mixin data is
 * nested under `doc[<mixinId>]`, so `{ archived: true }` on the base class
 * matches nothing at all — silently, because `findProperty` simply reads
 * `undefined` and moves on. `getObjectValue` walks the dotted path, which is
 * why the dotted spelling works on both the adapter and the in-memory sides.
 *
 * ⚠️ Reads through `hierarchy.as(doc, mixin)` are the ONE exception: that proxy
 * re-prefixes for you, so an action `query` whose `target` IS the mixin uses the
 * bare name (`filterActions` in `plugins/view-resources/src/actions.ts:299`).
 *
 * @public
 */
export function archivableKey (attr: keyof Archivable & string): string {
  return `${agentraCore.mixin.Archivable}.${attr}`
}

/**
 * The list-default filter: everything that is not archived.
 *
 * 🔴 `$ne: true`, NOT `=== false`. `findProperty` matches a literal `false`
 * only against a stored `false`; a document that never carried the mixin reads
 * `undefined` and would be filtered OUT of the default list — i.e. every
 * document created after the SYS-005 migration would vanish from every list.
 * Absence means "not archived", and `$ne` is the only spelling that says so.
 *
 * ⚠️ An action whose `target` IS the mixin is the one place to use the bare
 * attribute name instead: `filterActions` matches such an action's `query`
 * against `hierarchy.as(doc, mixin)`, a proxy that re-prefixes for you
 * (`plugins/view-resources/src/actions.ts:299`).
 *
 * @public
 */
export function notArchivedQuery (): Record<string, any> {
  return { [archivableKey('archived')]: { $ne: true } }
}

/**
 * The "show archived" half of the same switch.
 *
 * @public
 */
export function archivedQuery (): Record<string, any> {
  return { [archivableKey('archived')]: true }
}

/**
 * The four classes SYS-005 makes archivable, as WIRE LITERALS.
 *
 * 🔴 LITERALS RATHER THAN IMPORTS, DELIBERATELY. `agentra-core` is the
 * FOUNDATION package — `models/all/src/index.ts:198` registers it before
 * crm-lite, tracker, requirements and test-management — so importing those
 * four would invert the dependency direction, and adding them to
 * `package.json` would rewrite `pnpm-lock.yaml`. `crm-lite-resources` and
 * `traceability-resources` copy their wire types for the same reason.
 *
 * 🔴 A LITERAL DOES NOT FAIL TO COMPILE WHEN IT IS WRONG. That is what
 * `server-plugins/agentra-core-resources/src/__tests__/deleteGuard.test.ts`
 * is for: that package DOES depend on all four, so it asserts each constant
 * below is identical to the real `Ref`. Both halves are required — this one
 * pins the string, that one pins it to the thing it is supposed to name.
 *
 * ⚠️ Lead and Requirement are `MasterTag`s (`crm-lite:masterTag:Lead`), not
 * `class`. `test-management`'s plugin id is CAMEL CASE (`testManagement`), not
 * kebab.
 *
 * @public
 */
export const ARCHIVABLE_LEAD = 'crm-lite:masterTag:Lead' as Ref<Class<Doc>>

/**
 * @public
 */
export const ARCHIVABLE_REQUIREMENT = 'requirements:masterTag:Requirement' as Ref<Class<Doc>>

/**
 * @public
 */
export const ARCHIVABLE_ISSUE = 'tracker:class:Issue' as Ref<Class<Doc>>

/**
 * @public
 */
export const ARCHIVABLE_TEST_CASE = 'testManagement:class:TestCase' as Ref<Class<Doc>>

/**
 * @public
 */
export const ARCHIVABLE_CLASSES: readonly Ref<Class<Doc>>[] = [
  ARCHIVABLE_LEAD,
  ARCHIVABLE_REQUIREMENT,
  ARCHIVABLE_ISSUE,
  ARCHIVABLE_TEST_CASE
]

/**
 * @public
 */
export default agentraCore
