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

import { ProductVersionState } from '@hcengineering/products'

import {
  checkProductVersionCreate,
  isProductVersionState,
  readFieldWrite,
  readProductVersionStateIntent,
  RELEASE_GUARDED_FIELDS,
  serverProductsId
} from '../index'

describe('serverProductsId', () => {
  it('is pinned to the literal the pipeline registers', () => {
    // 🔴 A LITERAL, NOT A REFERENCE. `addLocation(serverProductsId, ...)` in
    // `server/server-pipeline` and this id have to be the same string for a
    // `serverProducts.*` resource to resolve; nothing fails to COMPILE if they
    // drift, the resource simply never loads.
    expect(serverProductsId).toBe('server-products')
  })
})

describe('isProductVersionState', () => {
  it('accepts every declared member', () => {
    for (const state of [
      ProductVersionState.Active,
      ProductVersionState.Released,
      ProductVersionState.Planning,
      ProductVersionState.ReleaseCandidate,
      ProductVersionState.Archived
    ]) {
      expect(isProductVersionState(state)).toBe(true)
    }
  })

  it('rejects the enum member NAMES', () => {
    // 🔴 THE NUMERIC-ENUM TRAP. `ProductVersionState['Released']` is `1`, so a
    // reverse-mapping check without the `typeof === 'number'` clause would
    // accept the string. Same for `Object.values`, which contains the names.
    expect(isProductVersionState('Released')).toBe(false)
    expect(isProductVersionState('Active')).toBe(false)
    expect(Object.values(ProductVersionState)).toContain('Released')
  })

  it('rejects out-of-range numbers and non-values', () => {
    expect(isProductVersionState(5)).toBe(false)
    expect(isProductVersionState(-1)).toBe(false)
    expect(isProductVersionState(1.5)).toBe(false)
    expect(isProductVersionState(undefined)).toBe(false)
    expect(isProductVersionState(null)).toBe(false)
    expect(isProductVersionState(true)).toBe(false)
  })
})

describe('readFieldWrite', () => {
  it('reads a plain assignment', () => {
    expect(readFieldWrite({ state: ProductVersionState.Active }, 'state')).toEqual({
      kind: 'plain',
      value: ProductVersionState.Active
    })
  })

  it('reads a plain assignment of undefined as a write, not as absence', () => {
    expect(readFieldWrite({ state: undefined }, 'state')).toEqual({ kind: 'plain', value: undefined })
  })

  it('returns untouched for an unrelated field', () => {
    expect(readFieldWrite({ patch: 3, readonly: true }, 'state').kind).toBe('untouched')
    expect(readFieldWrite({ $inc: { patch: 1 } }, 'state').kind).toBe('untouched')
  })

  it('reports $unset', () => {
    expect(readFieldWrite({ $unset: { state: '' } }, 'state')).toEqual({ kind: 'unset' })
  })

  it('reports every other operator as opaque, including $set and $inc', () => {
    expect(readFieldWrite({ $set: { state: ProductVersionState.Released } }, 'state')).toEqual({
      kind: 'opaque',
      operator: '$set'
    })
    // 🔴 `state` IS NUMERIC: Active is 0 and Released is 1, so `$inc` by one IS
    // a release with the word `Released` nowhere in the transaction.
    expect(readFieldWrite({ $inc: { state: 1 } }, 'state')).toEqual({ kind: 'opaque', operator: '$inc' })
    expect(readFieldWrite({ $push: { state: 1 } }, 'state')).toEqual({ kind: 'opaque', operator: '$push' })
  })

  it('reports $rename in both directions', () => {
    expect(readFieldWrite({ $rename: { state: 'oldState' } }, 'state')).toEqual({
      kind: 'opaque',
      operator: '$rename'
    })
    // Renaming something else ONTO `state` never mentions `state` as a key.
    expect(readFieldWrite({ $rename: { smuggled: 'state' } }, 'state')).toEqual({
      kind: 'opaque',
      operator: '$rename'
    })
  })

  it('sees a field reached by a MIXED plain/operator payload', () => {
    // 🔴 THE `isOperator` HOLE. `isOperator` demands EVERY key start with `$`,
    // so it answers `false` here — but `TxProcessor.applyUpdate` dispatches per
    // key and really does run the `$inc`. A guard gated on `isOperator` would
    // read this tx as "does not touch state".
    expect(readFieldWrite({ codename: 'x', $inc: { state: 1 } }, 'state')).toEqual({
      kind: 'opaque',
      operator: '$inc'
    })
    expect(readFieldWrite({ codename: 'x', state: 1 }, 'state')).toEqual({ kind: 'plain', value: 1 })
    expect(readFieldWrite({ codename: 'x', $unset: { state: '' } }, 'state')).toEqual({ kind: 'unset' })
  })

  it('is refusal-biased when one payload writes the field twice', () => {
    expect(readFieldWrite({ state: 0, $inc: { state: 1 } }, 'state').kind).toBe('opaque')
    expect(readFieldWrite({ $unset: { state: '' }, state: 0 }, 'state').kind).toBe('unset')
  })

  it('treats a dotted path INTO the field as opaque', () => {
    expect(readFieldWrite({ 'state.smuggled': 1 }, 'state')).toEqual({ kind: 'opaque', operator: 'state.smuggled' })
    // A sibling field that merely starts with the same letters is untouched.
    expect(readFieldWrite({ stateNotes: 'x' }, 'state').kind).toBe('untouched')
  })

  it('survives a malformed operations object', () => {
    expect(readFieldWrite(null as any, 'state').kind).toBe('untouched')
    expect(readFieldWrite({ $set: null } as any, 'state').kind).toBe('untouched')
  })
})

describe('readProductVersionStateIntent', () => {
  it('is untouched when the tx does not mention state', () => {
    expect(readProductVersionStateIntent({ patch: 4 }).kind).toBe('untouched')
  })

  it('allows every state that is not Released', () => {
    for (const state of [
      ProductVersionState.Planning,
      ProductVersionState.Active,
      ProductVersionState.ReleaseCandidate,
      ProductVersionState.Archived
    ]) {
      expect(readProductVersionStateIntent({ state })).toEqual({ kind: 'allowed', state })
    }
  })

  it('lets Released move on to Archived — the guard owns one transition, not a state machine', () => {
    // 🔴 REGRESSION PIN. Making `Released` terminal would strand every shipped
    // version; the classifier deliberately never reads the CURRENT state.
    expect(readProductVersionStateIntent({ state: ProductVersionState.Archived })).toEqual({
      kind: 'allowed',
      state: ProductVersionState.Archived
    })
  })

  it('demands the command for Released', () => {
    expect(readProductVersionStateIntent({ state: ProductVersionState.Released }).kind).toBe('needs-command')
  })

  it('refuses removal of the state', () => {
    const intent = readProductVersionStateIntent({ $unset: { state: '' } })
    expect(intent.kind).toBe('refused')
    expect(intent.kind === 'refused' && intent.verdict.reason).toBe('state-removed')
  })

  it('refuses any operator that reaches state', () => {
    for (const ops of [
      { $set: { state: ProductVersionState.Released } },
      { $inc: { state: 1 } },
      { $rename: { smuggled: 'state' } }
    ]) {
      const intent = readProductVersionStateIntent(ops)
      expect(intent.kind).toBe('refused')
      expect(intent.kind === 'refused' && intent.verdict.reason).toBe('opaque-operation')
    }
  })

  it('refuses a value that is not a state, including the string "Released"', () => {
    for (const value of ['Released', 99, undefined, null, {}]) {
      const intent = readProductVersionStateIntent({ state: value })
      expect(intent.kind).toBe('refused')
      expect(intent.kind === 'refused' && intent.verdict.reason).toBe('unknown-state')
    }
  })
})

describe('checkProductVersionCreate', () => {
  it('refuses Released outright, without any evidence lookup', () => {
    // 🔴 STALE EVIDENCE. Both facts are keyed on the version id and outlive the
    // version (`ProductVersionRemove` collects nothing), so delete-then-recreate
    // at the same `_id` would otherwise pass on a previous release's paperwork.
    const intent = checkProductVersionCreate({ state: ProductVersionState.Released })
    expect(intent.kind).toBe('refused')
    expect(intent.kind === 'refused' && intent.verdict.reason).toBe('release-on-create')
  })

  it('leaves every other create verdict exactly as the classifier gave it', () => {
    expect(checkProductVersionCreate({ state: ProductVersionState.Active })).toEqual({
      kind: 'allowed',
      state: ProductVersionState.Active
    })
    expect(checkProductVersionCreate({ major: 1 }).kind).toBe('untouched')
    expect(checkProductVersionCreate({ state: 'Released' }).kind).toBe('refused')
  })
})

describe('RELEASE_GUARDED_FIELDS', () => {
  it('names state and nothing else', () => {
    // A field added here becomes a document read on every matching tx; a field
    // removed becomes a hole. Pin the list so either is a deliberate edit.
    expect(RELEASE_GUARDED_FIELDS).toEqual(['state'])
  })
})
