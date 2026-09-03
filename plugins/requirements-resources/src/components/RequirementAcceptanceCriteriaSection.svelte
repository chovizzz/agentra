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
  The editable "acceptance criteria" block on a Requirement detail page.

  🔴 WHY A SECTION AND NOT A PROPERTIES ROW. `acceptanceCriteria` is declared
  `TypeCollaborativeDoc()` (models/requirements/src/index.ts), i.e. a
  `MarkupBlobRef` pointing at datalake and edited over Y.js — not a value stored
  on the document. `getAttributePresenterClass`
  (packages/presentation/src/utils.ts:695-697) puts that type in the `inplace`
  category, and `models/view/src/index.ts:575-585` registers only
  `ActivityAttributePresenter` and `InlineAttributEditor` for it — there is NO
  `view.mixin.AttributeEditor`. `AttributeBarEditor`
  (packages/presentation/src/components/AttributeBarEditor.svelte) resolves its
  editor through `findAttributeEditorByAttribute`, whose `default:` branch asks
  for exactly that missing mixin, and its whole body is wrapped in `{#if editor}`
  — so the row silently renders NOTHING in the card properties panel.
  `MarkupProperties.svelte` does not pick it up either: it filters on
  `value.type._class === core.class.TypeMarkup`, which a collaborative doc is
  not. This block is therefore the only place the field can be filled.

  ⚠️ The `acceptanceCriteria` entry in the two viewlets' `configOptions.hiddenKeys`
  is UNRELATED and is deliberately left in place: `hiddenKeys` is read only by
  `ViewletSetting.svelte`, the column configurator of a list/table viewlet. A
  blob pointer makes no sense as a column; it never had anything to do with the
  detail panel.

  🔴 PROP NAMES. `EditCardTableOfContents.svelte` renders every section as
  `<Component is={section.component} props={{ doc, readonly, contentDiv, hidden, … }} />`.
  A component declaring `object` would be handed `undefined` and throw.

  🔴 `dispatch('loaded')` IS MANDATORY and is done `onMount` rather than
  forwarded from the editor: `handleScroll` refuses to track scroll position
  until `sections.every(sectionLoaded)`, so a section whose editor never syncs
  (offline collaborator, missing blob) would otherwise freeze the table of
  contents for the WHOLE page. `handleSectionLoaded` is idempotent, so an early
  report costs nothing.
-->
<script lang="ts">
  import type { Card } from '@hcengineering/card'
  import contact from '@hcengineering/contact'
  import type { AnyAttribute } from '@hcengineering/core'
  import { getResource } from '@hcengineering/platform'
  import { getClient, type KeyedAttribute } from '@hcengineering/presentation'
  import { CollaboratorEditor } from '@hcengineering/text-editor-resources'
  import { Label, type AnySvelteComponent } from '@hcengineering/ui'
  import { canChangeDoc, getCollaborationUser } from '@hcengineering/view-resources'
  import { permissionsStore } from '@hcengineering/contact-resources'
  import { createEventDispatcher, onMount } from 'svelte'

  import requirements from '../plugin'

  export let doc: Card
  export let readonly: boolean = false
  export let hidden: boolean = false
  /**
   * The section's own wrapper element, bound by the panel. Handed to the editor
   * as `boundary` so its floating toolbars are clipped to this block instead of
   * to the viewport — the same value `ContentSection` forwards for `content`.
   */
  export let contentDiv: HTMLDivElement | undefined | null = undefined

  const client = getClient()
  const hierarchy = client.getHierarchy()
  const dispatch = createEventDispatcher()

  const user = getCollaborationUser()
  let userComponent: AnySvelteComponent | undefined
  void getResource(contact.component.CollaborationUserAvatar).then((component) => {
    userComponent = component
  })

  /**
   * `findAttribute` rather than `getAttribute`: the latter THROWS when the
   * attribute is absent (foundations/core/src/hierarchy.ts:550-556), and a
   * deployment that removed the attribute should lose the block, not the page.
   */
  let attr: AnyAttribute | undefined
  $: attr = hierarchy.findAttribute(doc._class, 'acceptanceCriteria')
  $: attribute = attr !== undefined ? ({ key: 'acceptanceCriteria', attr } satisfies KeyedAttribute) : undefined

  /**
   * Same three-way gate `ContentSection` applies to `content`, so the criteria
   * cannot be edited in states where the description cannot: an explicitly
   * read-only panel (a superseded card version), a viewer without update
   * permission on the space, or a locked section.
   */
  $: isReadonly =
    readonly ||
    !canChangeDoc(doc._class, doc.space, $permissionsStore) ||
    hierarchy.getAncestors(doc._class).some((p) => doc.readonlySections?.includes(p))

  onMount(() => {
    dispatch('loaded')
  })
</script>

{#if !hidden && attribute !== undefined}
  <div class="section-acceptance-criteria">
    <div class="header">
      <span class="title"><Label label={requirements.string.AcceptanceCriteria} /></span>
    </div>
    <!--
      Re-keyed on the document so switching cards in place tears the Y.js
      provider down instead of reusing a provider bound to the previous card —
      `Description.svelte` keys `ContentEditor` on `doc._id` for the same reason.
    -->
    {#key doc._id}
      <CollaboratorEditor
        {attribute}
        object={doc}
        {user}
        {userComponent}
        readonly={isReadonly}
        boundary={contentDiv ?? undefined}
        overflow={'none'}
        placeholder={requirements.string.AcceptanceCriteriaPlaceholder}
        editorAttributes={{ style: 'min-height: 4rem' }}
      />
    {/key}
  </div>
{/if}

<style lang="scss">
  .section-acceptance-criteria {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0 1rem;
    gap: 0.5rem;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .title {
    font-weight: 500;
  }
</style>
