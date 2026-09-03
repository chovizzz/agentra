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
  The delivery TIMELINE of one object: every trace edge on it, oldest first, so
  a reader can see the order in which the work was proposed, built, verified and
  shipped.

  🔴 PROP NAME. `EditCardTableOfContents.svelte` renders every
  `card.class.CardSection` as `<Component is={section.component}
  props={{ doc, readonly, hidden, ... }} />`, so the card arrives as `doc`.
  A component declaring `object` is handed `undefined` and throws on first
  render.

  🔴 `dispatch('loaded')` IS MANDATORY. `handleScroll` waits for
  `sections.every(sectionLoaded)`, so a section that never reports in freezes
  the table of contents for the WHOLE page.

  🔴 THE CLOCK IS THE FAR ENDPOINT'S OWN `createdOn`, NOT THE EDGE'S. A
  `TraceLinkView` carries no timestamp of its own (see `./types.ts` — the server
  projects `_id`, `kind`, `state` and the two endpoints, and nothing else), and
  widening that projection to add one would be a server change on a
  permission-filtered surface. The far endpoint's document is already in hand
  whenever it is visible, and "when the linked artefact appeared" is the axis a
  delivery timeline actually wants.

  🔴 A RESTRICTED EDGE IS NEVER PLACED ON THE AXIS. It has no visible endpoint
  and therefore no timestamp, and inventing one — "now", or the anchor's own
  date — would tell the reader WHEN something they may not read happened. All of
  them collapse into ONE contentless row, WITHOUT A COUNT, exactly as
  `TraceCoveragePresenter` and `RequirementDeliverySection` do: Technical Spec
  §6.2 treats the number of hidden objects as a side channel in its own right.
-->
<script lang="ts">
  import type { Doc, Ref, Timestamp } from '@hcengineering/core'
  import { getClient } from '@hcengineering/presentation'
  import { Label } from '@hcengineering/ui'
  import { createEventDispatcher, onMount } from 'svelte'

  import TraceLinkKindPresenter from './TraceLinkKindPresenter.svelte'
  import traceability from '../plugin'
  import type { TraceDirection, TraceLinkView } from '../types'
  import { farEndpoint, findIncomingTraceLinks, findOutgoingTraceLinks, isRestrictedLink } from '../utils'

  /** The card. Named `doc` because that is what the panel passes. */
  export let doc: Doc | undefined = undefined
  export let hidden: boolean = false
  /** Part of the section contract. A timeline is read-only in every state. */
  export let readonly: boolean = false

  void readonly

  interface TimelineEntry {
    _id: Ref<Doc>
    link: TraceLinkView
    direction: TraceDirection
    at: Timestamp
    title: string
  }

  const client = getClient()
  const dispatch = createEventDispatcher()

  let entries: TimelineEntry[] = []
  let restricted = false
  /**
   * 🔴 "The server cannot answer" is NOT "there is nothing here". `available`
   * comes back false when the traceability domain handler is not installed in
   * the deployment's pipeline, and a timeline that rendered its empty state
   * then would claim an object has no history when nobody asked.
   */
  let available = true

  $: void reloadFor(doc?._id)

  async function reloadFor (_id: Ref<Doc> | undefined): Promise<void> {
    if (_id === undefined) return
    await reload()
  }

  /**
   * ⚠️ THE EDGES CANNOT BE LIVE-QUERIED. They are read through the server's
   * permission-filtered domain request rather than through `findAll`, so there
   * is no `createQuery` that watches them — same as every other traceability
   * block in this delivery.
   */
  async function reload (): Promise<void> {
    if (doc === undefined) return
    const outgoing = await findOutgoingTraceLinks(client, { doc: doc._id })
    const incoming = await findIncomingTraceLinks(client, { doc: doc._id })
    available = outgoing.available && incoming.available
    const all = [
      ...outgoing.links.map((link) => ({ link, direction: 'outgoing' as TraceDirection })),
      ...incoming.links.map((link) => ({ link, direction: 'incoming' as TraceDirection }))
    ]
    restricted = all.some((it) => isRestrictedLink(it.link))
    entries = all
      .filter((it) => !isRestrictedLink(it.link))
      .map(({ link, direction }) => entryOf(link, direction))
      .filter((it): it is TimelineEntry => it !== undefined)
      .sort((a, b) => a.at - b.at)
  }

  /**
   * `undefined` for an edge whose far endpoint is visible but carries no
   * document — the shape the server produces for an endpoint that has been
   * deleted out from under the edge. Dropping it is honest; forcing it onto the
   * axis at time zero is not.
   */
  function entryOf (link: TraceLinkView, direction: TraceDirection): TimelineEntry | undefined {
    const far = farEndpoint(link, direction)
    const target = far.doc
    if (target === undefined) return undefined
    const at = target.createdOn ?? target.modifiedOn
    if (at === undefined) return undefined
    return {
      _id: link._id,
      link,
      direction,
      at,
      title: (target as any).title ?? (target as any).name ?? far._id
    }
  }

  function formatDate (at: Timestamp): string {
    return new Date(at).toLocaleDateString()
  }

  onMount(() => {
    dispatch('loaded')
  })
</script>

{#if !hidden}
  <div class="trace-timeline">
    <div class="trace-timeline__head">
      <span class="trace-timeline__title"><Label label={traceability.string.Timeline} /></span>
    </div>

    {#if !available}
      <div class="trace-timeline__warning"><Label label={traceability.string.TimelineUnavailable} /></div>
    {:else if entries.length === 0 && !restricted}
      <div class="trace-timeline__warning"><Label label={traceability.string.TimelineEmpty} /></div>
    {/if}

    {#if available}
      <ol class="trace-timeline__list">
        {#each entries as entry (entry._id)}
          <li class="trace-timeline__entry">
            <span class="trace-timeline__at">{formatDate(entry.at)}</span>
            <TraceLinkKindPresenter kind={entry.link.kind} />
            <span class="trace-timeline__label">{entry.title}</span>
          </li>
        {/each}
      </ol>

      {#if restricted}
        <!--
          🔴 EXISTENCE ONLY. No count, no date, no kind — see the header note.
        -->
        <div class="trace-timeline__restricted"><Label label={traceability.string.RestrictedLink} /></div>
      {/if}
    {/if}
  </div>
{/if}

<style lang="scss">
  .trace-timeline {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0 1rem;
    gap: 0.5rem;
  }
  .trace-timeline__title {
    font-weight: 500;
  }
  .trace-timeline__warning {
    color: var(--theme-warning-color);
  }
  .trace-timeline__list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin: 0;
    padding: 0;
    list-style: none;
    border-left: 2px solid var(--theme-divider-color);
  }
  .trace-timeline__entry {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-left: 0.75rem;
    min-width: 0;
  }
  .trace-timeline__at {
    font-size: 0.75rem;
    color: var(--theme-dark-color);
    white-space: nowrap;
  }
  .trace-timeline__label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trace-timeline__restricted {
    color: var(--theme-dark-color);
    font-style: italic;
  }
</style>
