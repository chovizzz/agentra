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

import {
  ProductVersionState,
  frozenProductVersionStates,
  isFrozenProductVersionState,
  parentStateOnChildVersion,
  productVersionStates,
  userSelectableProductVersionStates
} from '../types'

describe('ProductVersionState: the persisted numbers', () => {
  it('pins every member to its stored value', () => {
    // 🔴 THESE LITERALS ARE THE POINT. `ProductVersion.state` stores the NUMBER,
    // so reordering the enum silently rewrites every historical row — no error,
    // no migration, just a database in which `Released` now reads as something
    // else. Asserting the numbers is what turns that into a red test.
    expect(ProductVersionState.Active).toBe(0)
    expect(ProductVersionState.Released).toBe(1)
    expect(ProductVersionState.Planning).toBe(2)
    expect(ProductVersionState.ReleaseCandidate).toBe(3)
    expect(ProductVersionState.Archived).toBe(4)
  })

  it('lists every member in lifecycle order, not numeric order', () => {
    expect(productVersionStates).toEqual([
      ProductVersionState.Planning,
      ProductVersionState.Active,
      ProductVersionState.ReleaseCandidate,
      ProductVersionState.Released,
      ProductVersionState.Archived
    ])
    // Every member of the enum is offered by the state editor; a member that is
    // declared but unlisted is unreachable from the UI.
    const members = Object.values(ProductVersionState).filter((it) => typeof it === 'number')
    const byValue = (a: number, b: number): number => a - b
    expect([...productVersionStates].sort(byValue)).toEqual([...(members as number[])].sort(byValue))
  })
})

describe('release-gate bypass regression (PRD REL-003)', () => {
  it('does NOT release the parent when a child version is forked off it', () => {
    // 🔴 THE REGRESSION THIS FILE EXISTS FOR.
    // `CreateProductVersion.svelte` used to freeze the parent with
    // `state: ProductVersionState.Released`. That gave anyone who could create
    // a child version a way to mark the parent RELEASED without the readiness
    // gate, the approval or the audit record ever running — REL-003 was
    // unenforceable while that line stood. `Released` must be reachable only
    // through the server-side `ReleaseProductVersion` command.
    expect(parentStateOnChildVersion).not.toBe(ProductVersionState.Released)
    expect(parentStateOnChildVersion).toBe(ProductVersionState.Archived)
  })

  it('freezes the forked-off parent all the same', () => {
    // Archiving must still lock the parent: its documents were copied forward
    // to the child, so editing it would edit a superseded line.
    expect(isFrozenProductVersionState(parentStateOnChildVersion)).toBe(true)
    expect(frozenProductVersionStates).toEqual([ProductVersionState.Released, ProductVersionState.Archived])
  })

  it('does NOT offer Released in the state dropdown', () => {
    // 🔴 THE SECOND DOOR. `ProductVersionStateEditor` is the registered
    // `AttributeEditor` for this attribute, so a `Released` entry in its list
    // is the same bypass as the create-child one: pick it and the version is
    // released with no gate, no approval and no audit record.
    expect(userSelectableProductVersionStates).not.toContain(ProductVersionState.Released)
    expect(userSelectableProductVersionStates).toEqual([
      ProductVersionState.Planning,
      ProductVersionState.Active,
      ProductVersionState.ReleaseCandidate,
      ProductVersionState.Archived
    ])
  })

  it('leaves the pre-release states editable', () => {
    expect(isFrozenProductVersionState(ProductVersionState.Planning)).toBe(false)
    expect(isFrozenProductVersionState(ProductVersionState.Active)).toBe(false)
    expect(isFrozenProductVersionState(ProductVersionState.ReleaseCandidate)).toBe(false)
  })
})
