<script lang="ts">
  import type { Class, Doc, Ref } from '@hcengineering/core'
  import { getClient, ObjectPopup } from '@hcengineering/presentation'
  import traceability from '@hcengineering/traceability'
  import tracker from '@hcengineering/tracker'
  import view from '@hcengineering/view'
  import { Button, showPanel, showPopup } from '@hcengineering/ui'

  import { createDefect } from '../commands'
  import { findIncomingTraceLinks, isEndpointRenderable } from '../utils'

  export let object: Doc
  export let actual: string | undefined = undefined
  export let kind: 'regular' | 'ghost' | 'primary' = 'regular'
  export let size: 'small' | 'medium' | 'large' = 'small'

  let existing: Ref<Doc> | undefined
  let existingClass: Ref<Class<Doc>> | undefined
  /**
   * A defect covers this object but the viewer may not read it.
   *
   * 🔴 THIS IS NOT THE SAME AS "no defect", and collapsing the two is the bug
   * this flag exists to prevent: the button would read "Create defect", the
   * click would come back refused, and the user would keep clicking. The server
   * reports the same distinction (`CreateDefectResult.restricted`), and the
   * traceability block already renders "a restricted link exists" for exactly
   * this situation.
   */
  let restricted = false
  let running = false

  $: void refresh(object?._id)

  async function refresh (_id: Ref<Doc> | undefined): Promise<void> {
    existing = undefined
    existingClass = undefined
    restricted = false
    if (_id === undefined) return
    const state = await findIncomingTraceLinks(getClient(), { doc: _id, kinds: ['defect-of'] })
    for (const link of state.links) {
      // ⚠️ Only a RENDERABLE source can be opened. A restricted endpoint means
      // the caller may not read the bug, so there is nothing to navigate to —
      // but there is still something to SAY.
      if (isEndpointRenderable(link.source)) {
        existing = link.source._id
        existingClass = link.source._class
        restricted = false
        return
      }
      restricted = true
    }
  }

  function open (): void {
    if (existing === undefined || existingClass === undefined) return
    showPanel(view.component.EditDoc, existing, existingClass, 'content')
  }

  function raise (): void {
    // The project is asked for rather than guessed: a workspace has many tracker
    // projects and filing a defect into the wrong backlog is worse than one
    // extra click.
    showPopup(ObjectPopup, { _class: tracker.class.Project, searchField: 'name' }, undefined, (project) => {
      if (project == null) return
      void file(typeof project === 'string' ? project : project._id)
    })
  }

  async function file (project: Ref<Doc>): Promise<void> {
    running = true
    try {
      const outcome = await createDefect(getClient(), object._id, object._class, project, { actual })
      if (outcome.kind === 'ok') {
        await refresh(object._id)
        // ⚠️ `bug` is ABSENT when a defect exists that this caller may not read.
        // Navigating to `undefined` would open a blank panel and would also undo
        // the point of withholding the id.
        if (outcome.result.bug !== undefined) {
          showPanel(view.component.EditDoc, outcome.result.bug, tracker.class.Issue, 'content')
        } else {
          restricted = true
        }
      } else {
        // Surfaced, never swallowed: a refused command means the defect was NOT
        // filed, and a silent no-op reads as success.
        console.error('traceability: createDefect refused', outcome)
      }
    } finally {
      running = false
    }
  }
</script>

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
<!--
  The `defect-of` entry point, for ALL THREE legal targets — a failed
  TestResult, a TestCase and a Requirement. The matrix row is
  `Bug --defect-of-->
TestResult | TestCase | Requirement`; nothing about this button is result-specific, which is exactly why one component serves
all three. 🔴 IF A DEFECT ALREADY EXISTS THE BUTTON OPENS IT. Task 15: "when a failed result already has a bug, the button
opens the existing one rather than raising a second". The existence check reads the `defect-of` edge — the durable record
— through the server's permission-filtered handler, so a caller who may not see the bug is not told it exists either. -->

<Button
  label={existing !== undefined
    ? traceability.string.OpenDefect
    : restricted
      ? traceability.string.RestrictedLink
      : traceability.string.CreateDefect}
  {kind}
  {size}
  loading={running}
  disabled={restricted}
  id={'trace-defect-button'}
  on:click={() => {
    if (existing !== undefined) open()
    else if (!restricted) raise()
  }}
/>
