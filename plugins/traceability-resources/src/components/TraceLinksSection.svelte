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
  The traceability block for an object detail page: outgoing edges (this object
  is the source) and incoming edges (this object is the target).

  Reverse navigation is DERIVED on the server from the `docB` index — there is
  no reverse edge, so "incoming" is a second query, not a second data set.

  🔴 Every byte rendered here came out of the server's per-endpoint filter. This
  component issues no `findAll` against `traceability.class.TraceLink` and never
  passes `options.associations` anywhere: the association traversal has no
  per-endpoint filter at all (`spaceSecurity.ts` filters `$lookup` only), so
  reaching for it would hand every workspace member the titles of objects they
  cannot open.
-->
<script lang="ts">
  import type { Doc } from '@hcengineering/core'
  import type { IntlString } from '@hcengineering/platform'
  import { getClient } from '@hcengineering/presentation'
  import { normId, type MaybeVersioned, type TraceLinkKind, type TraceLinkState } from '@hcengineering/traceability'
  import { Label, Spinner } from '@hcengineering/ui'

  import type { TraceDirection, TraceLinkQuery, TraceLinksState } from '../types'
  import {
    emptyTraceLinksState,
    findIncomingTraceLinks,
    findOutgoingTraceLinks,
    groupTraceLinks,
    type TraceLinkGroup
  } from '../utils'
  import traceability from '../plugin'
  import TraceCoveragePresenter from './TraceCoveragePresenter.svelte'
  import TraceLinkPresenter from './TraceLinkPresenter.svelte'

  export let object: Doc
  /** Restrict to a subset of kinds. Undefined means every kind. */
  export let kinds: TraceLinkKind[] | undefined = undefined
  /** Defaults to `['active']` on the server. Pass to include audit history. */
  export let states: TraceLinkState[] | undefined = undefined
  /**
   * Match on `baseId` instead of the concrete `_id`, i.e. show the edges of
   * every version of this object rather than only of the version on screen.
   */
  export let normalize: boolean = false
  /**
   * Offer the `implements` withdrawal entry point on the edges that support one.
   *
   * ⚠️ DEFAULTS TO TRUE. This section IS the traceability block on an object
   * detail page, and a matrix a user can only ever add to is the complaint
   * Task 12a exists to answer. `TraceLinkPresenter` still narrows it to active
   * `implements` edges with both endpoints readable, and the server refuses
   * anything the caller may not touch — so the default widens the entry point,
   * never the authority. Pass `false` for a read-only rendering (an audit view,
   * a printed matrix).
   */
  export let unlinkable: boolean = true

  const client = getClient()

  let outgoing: TraceLinksState = emptyTraceLinksState(true)
  let incoming: TraceLinksState = emptyTraceLinksState(true)
  let loading = true

  // A monotonic token: a slow reply for a previous object must not overwrite the
  // state of the object currently on screen.
  let generation = 0

  async function load (doc: Doc): Promise<void> {
    const token = ++generation
    loading = true
    const query: TraceLinkQuery = {
      doc: doc._id,
      baseId: normId(doc as MaybeVersioned),
      kinds,
      states,
      normalize
    }
    try {
      const [out, inc] = await Promise.all([
        findOutgoingTraceLinks(client, query),
        findIncomingTraceLinks(client, query)
      ])
      if (token !== generation) {
        return
      }
      outgoing = out
      incoming = inc
    } finally {
      if (token === generation) {
        loading = false
      }
    }
  }

  $: void load(object)

  $: outgoingGroups = groupTraceLinks(outgoing.links, 'outgoing')
  $: incomingGroups = groupTraceLinks(incoming.links, 'incoming')
  // The server is the authority on how many edges were withheld.
  $: outgoingRestricted = outgoing.coverage.restricted
  $: incomingRestricted = incoming.coverage.restricted
  // `available: false` means the traceability domain handler is not installed —
  // not "zero links". Rendering an empty, confident section in that case would
  // assert coverage the server never computed, so the block hides itself.
  $: available = outgoing.available && incoming.available
  $: empty =
    outgoingGroups.length === 0 && incomingGroups.length === 0 && outgoingRestricted === 0 && incomingRestricted === 0

  interface Bucket {
    dir: TraceDirection
    label: IntlString
    groups: TraceLinkGroup[]
    state: TraceLinksState
    restricted: number
  }

  // Outgoing edges point AT targets, incoming edges come FROM sources, so the
  // two buckets are labelled with the endpoint role the reader is looking at.
  $: buckets = [
    {
      dir: 'outgoing',
      label: traceability.string.Target,
      groups: outgoingGroups,
      state: outgoing,
      restricted: outgoingRestricted
    },
    {
      dir: 'incoming',
      label: traceability.string.Source,
      groups: incomingGroups,
      state: incoming,
      restricted: incomingRestricted
    }
  ] as Bucket[]
</script>

{#if available && !(empty && !loading)}
  <div class="trace-section">
    <div class="trace-section__header flex-row-center flex-gap-2">
      <span class="trace-section__title"><Label label={traceability.string.Traceability} /></span>
      {#if loading}
        <Spinner size="small" />
      {/if}
    </div>

    {#each buckets as bucket (bucket.dir)}
      {#if bucket.groups.length > 0 || bucket.restricted > 0}
        <div class="trace-section__bucket">
          <div class="trace-section__bucket-header flex-row-center flex-gap-2">
            <span class="trace-section__bucket-title"><Label label={bucket.label} /></span>
            <TraceCoveragePresenter value={bucket.state.coverage} />
          </div>
          {#each bucket.groups as group (group.key)}
            <TraceLinkPresenter
              value={group.links[0]}
              direction={bucket.dir}
              versions={group.links.length}
              {unlinkable}
              on:unlinked={() => {
                // 🔴 RELOAD, do not splice the row out locally. The server owns
                // the coverage numbers (`TraceCoverage`), and a client that
                // dropped a row and left the counts alone would render a block
                // that contradicts itself. Re-reading is also what surfaces the
                // `alreadyRevoked` case, where nothing about this attempt
                // changed anything.
                void load(object)
              }}
            />
          {/each}
          {#if bucket.restricted > 0}
            <!--
              A SINGLE row for everything the caller may not see, carrying no
              number. It is not expanded into per-edge rows and it does not print
              `bucket.restricted`: both the row count and the printed count would
              disclose how many hidden objects this one is attached to, which
              §6.2 rules out as a side channel. The boolean "there is something
              here you cannot see" is the whole of the disclosure.
            -->
            <div class="trace-section__restricted flex-row-center flex-gap-2">
              <Label label={traceability.string.RestrictedLink} />
            </div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style lang="scss">
  .trace-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem 0;
    min-width: 0;
  }
  .trace-section__title {
    font-weight: 500;
    color: var(--theme-caption-color);
  }
  .trace-section__bucket {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .trace-section__bucket-header {
    margin-bottom: 0.25rem;
  }
  .trace-section__bucket-title {
    font-size: 0.75rem;
    color: var(--theme-dark-color);
  }
  .trace-section__restricted {
    padding: 0.25rem 0;
    font-style: italic;
    color: var(--theme-darker-color);
  }
</style>
