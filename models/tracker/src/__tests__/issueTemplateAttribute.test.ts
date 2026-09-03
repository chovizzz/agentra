//
// Copyright © 2026 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
//

import { type AnyAttribute, type TxCreateDoc } from '@hcengineering/core'
import { Builder } from '@hcengineering/model'
import core from '@hcengineering/model-core'
import tracker from '@hcengineering/tracker'

import { TIssue } from '../types'

//
// The whole tree has never built, so `Issue.template` cannot be checked by
// running the app. It can be checked here: `Builder.createModel` turns the
// decorators into the very `TxCreateDoc<Attribute>` transactions the transactor
// replays, so asserting on those asserts on the shipped model.
//
function issueAttributes (): Map<string, AnyAttribute> {
  const builder = new Builder()
  builder.createModel(TIssue)
  const result = new Map<string, AnyAttribute>()
  for (const tx of builder.getTxes()) {
    if (tx._class !== core.class.TxCreateDoc) continue
    const create = tx as TxCreateDoc<AnyAttribute>
    if (create.objectClass !== core.class.Attribute) continue
    const attr = create.attributes
    if (attr.attributeOf !== tracker.class.Issue) continue
    result.set(attr.name, attr as AnyAttribute)
  }
  return result
}

describe('Issue.template attribute', () => {
  it('is declared on tracker.class.Issue', () => {
    expect(issueAttributes().has('template')).toBe(true)
  })

  // `{ template, childId }` is an object, and `core.class.TypeRecord` is the
  // platform's type for exactly that. Precedent in this same file:
  // `TProjectTargetPreference.props`.
  it('is a TypeRecord', () => {
    expect(issueAttributes().get('template')?.type._class).toBe(core.class.TypeRecord)
  })

  // 🔴 THE POINT OF THE TEST. `issues/edit/ControlPanel.svelte` already renders
  // `template` through a dedicated ObjectBox AND builds a generic attribute bar
  // from `getFiltredKeys`, which drops an attribute only when `hidden === true`
  // (or its key is in a hand written ignore list that does not name this one).
  // Losing `@Hidden()` would render the field twice, and the generic half would
  // look for an editor that does not exist — nothing registers
  // `view.mixin.AttributeEditor` on `core.class.TypeRecord`.
  it('is hidden, so the generic attribute bar never tries to render it', () => {
    expect(issueAttributes().get('template')?.hidden).toBe(true)
  })

  // Provenance is written once, at creation. Nothing may retarget it later.
  it('is read only', () => {
    expect(issueAttributes().get('template')?.readonly).toBe(true)
  })

  // Guard against a careless edit widening the change: the surrounding
  // attributes must keep the shape they had.
  it('leaves the neighbouring attributes untouched', () => {
    const attrs = issueAttributes()
    expect(attrs.get('title')?.type._class).toBe(core.class.TypeString)
    expect(attrs.get('estimation')?.type._class).toBe(tracker.class.TypeEstimation)
    expect(attrs.get('todos')?.type._class).toBe(core.class.Collection)
  })
})
