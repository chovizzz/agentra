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

import core, { type Doc, type Tx, type TxCreateDoc } from '@hcengineering/core'

import buildModel from '..'

/**
 * Which modules Agentra needs switched ON, asserted against the model the
 * builder actually emits.
 *
 * 🔴 THE FLAG IS THE ONLY OBSERVABLE, AND THAT IS NOT OBVIOUS. A first version
 * of this file tried to prove `enabled` by looking for the module's classes and
 * viewlets in `buildModel().getTxes()` — and passed for the wrong reason.
 * `pluginFilterTx` does NOT run at build time: `lead` is `enabled: false` and
 * still contributes 44 transactions here, viewlets included. The filtering
 * happens later, against `core.class.PluginConfiguration`, so the configuration
 * document is what has to be asserted.
 *
 * 🔴 WHY ASSERT IT AT ALL. `enabled: false` removes a module's whole area from
 * the product, and nothing fails to compile — the symptom is navigation that
 * silently has no Release section. `products` is the one Agentra flipped:
 * upstream ships it disabled, and decision D7 (2026-08-26) turned it on because
 * the entire release loop (Product, ProductVersion, the release gate, every
 * REL-* requirement) is built on it.
 */
const MUST_BE_ENABLED = ['products', 'crm-lite', 'requirements', 'cycle', 'traceability', 'agentra-core']

let configs: Map<string, boolean>
beforeAll(() => {
  const txes: Tx[] = buildModel().getTxes()
  configs = new Map(
    txes
      .filter(
        (tx) =>
          tx._class === core.class.TxCreateDoc &&
          (tx as TxCreateDoc<Doc>).objectClass === core.class.PluginConfiguration
      )
      .map((tx) => {
        const attrs = (tx as TxCreateDoc<any>).attributes
        return [attrs.pluginId as string, attrs.enabled as boolean]
      })
  )
})

describe('models/all: the modules Agentra depends on are switched on', () => {
  it.each(MUST_BE_ENABLED)('%s is enabled', (pluginId) => {
    expect(configs.get(pluginId)).toBe(true)
  })

  it('discriminates — `lead`, which upstream leaves off, still reads false', () => {
    // 🔴 THE CONTROL. Without it this file could assert `true` against a map
    // that answered `true` for everything, which is exactly the failure the
    // first version of this test had. `lead` is the upstream module Agentra
    // replaced with `crm-lite`, and it stays off.
    expect(configs.get('lead')).toBe(false)
  })
})
