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

import type { Card } from '@hcengineering/card'
import requirements from '@hcengineering/requirements'
import { getClient } from '@hcengineering/presentation'

/**
 * `checkVisibility` for the Requirement traceability section.
 *
 * 🔴 A `card.class.CardSection` is GLOBAL — the class carries no `attachTo`, and
 * `getCardSections` (plugins/card-resources/src/card.ts) reads every section
 * document there is and filters only on this callback. Scoping a section to a
 * MasterTag therefore has to happen here; without it the block would be queried
 * on every card of every type in the workspace.
 *
 * `isDerived` rather than `_class === Requirement`, so a deployment that derives
 * its own tag from Requirement keeps the section.
 *
 * ⚠️ Deliberately says nothing about permissions. Whether the viewer may see any
 * given edge is decided by the server's per-endpoint filter and rendered by
 * `TraceLinksSection` itself (which degrades to a single "restricted link" row);
 * a visibility check that also tried to guess at access would either duplicate
 * that logic or contradict it.
 *
 * 🔴 Kept out of `./utils` on purpose: `utils.ts` is imported directly by the
 * node-environment unit tests, and `@hcengineering/presentation` drags the
 * browser/Svelte runtime in with it.
 *
 * @public
 */
export async function checkRequirementTraceLinksVisibility (doc: Card): Promise<boolean> {
  return getClient().getHierarchy().isDerived(doc._class, requirements.masterTag.Requirement)
}
