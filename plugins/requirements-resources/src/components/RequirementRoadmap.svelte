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
  The Roadmap view of the Requirement collection: scope laid out by the product
  version it is committed to.

  🔴 THIS IS A `view.class.ViewletDescriptor` BODY, NOT A CARD SECTION. The prop
  names are the ones `ViewletContentView.svelte` passes
  (`_class` / `query` / `space` / `config` / `viewlet` / `viewOptions` / …), and
  they are NOT the card panel's `doc` / `readonly` / `hidden`. Getting the two
  contracts confused is a first-render crash, not a layout bug.

  🔴 THE VERSIONS COME FROM `$lookup`, NEVER FROM A SECOND QUERY. `targetVersion`
  is a `Ref<ProductVersion>` and this package has no dependency on
  `@hcengineering/products` — resolving it here would mean adding one. The
  Roadmap viewlet is registered with the same `lookupRequirementOptions` the
  table uses, so every requirement arrives with its version attached and the
  version fields are read STRUCTURALLY. If the lookup is ever dropped from the
  viewlet, every requirement lands in "unscheduled" rather than crashing.

  ⚠️ `isLatest` is NOT re-applied here. It belongs to the viewlet's `baseQuery`,
  the same place the table and list declare it, so all three agree; a second
  copy in the component would drift.
-->
<script lang="ts">
  import type { Class, DocumentQuery, FindOptions, Ref, Space, WithLookup } from '@hcengineering/core'
  import { createQuery } from '@hcengineering/presentation'
  import { requirementStatusOrder, type Requirement, type RequirementStatus } from '@hcengineering/requirements'
  import { Label, Loading, Scroller } from '@hcengineering/ui'

  import RequirementStatusPresenter from './RequirementStatusPresenter.svelte'
  import requirements from '../plugin'

  export let _class: Ref<Class<Requirement>>
  export let query: DocumentQuery<Requirement> | undefined = undefined
  export let space: Ref<Space> | undefined = undefined
  /** Part of the viewlet contract. The roadmap has a fixed layout, so unused. */
  export let config: any = undefined
  export let viewlet: any = undefined
  export let viewOptions: any = undefined
  /**
   * 🔴 THE VIEWLET'S OWN `FindOptions`, forwarded verbatim. This is where the
   * `targetVersion` lookup comes from — the model declares it once (the same
   * `lookupRequirementOptions` the table and list use) and this component never
   * names `products.class.ProductVersion`, which is what keeps
   * `@hcengineering/products` out of this package's dependencies.
   */
  export let options: FindOptions<Requirement> | undefined = undefined

  void config
  void viewlet
  void viewOptions

  /**
   * The slice of a `ProductVersion` this view reads, declared structurally.
   *
   * Everything is optional: the lookup can legitimately come back without a
   * version (nothing is targeted yet) and a deployment can add a version class
   * of its own. A missing `major` sorts the row last rather than throwing.
   */
  interface VersionSlice {
    _id: Ref<any>
    major?: number
    minor?: number
    patch?: number
    codename?: string
  }

  interface RoadmapLane {
    key: string
    version: VersionSlice | undefined
    items: Array<WithLookup<Requirement>>
    counts: Array<[RequirementStatus, number]>
  }

  const docsQuery = createQuery()

  let loading = true
  let lanes: RoadmapLane[] = []

  /**
   * ⚠️ `space` is folded in only when the viewlet was given one. `SpecialView`
   * passes `undefined` for a cross-space browse, and `{ space: undefined }`
   * is a query for documents whose space IS undefined — i.e. none of them.
   */
  function scopedQuery (
    base: DocumentQuery<Requirement> | undefined,
    inSpace: Ref<Space> | undefined
  ): DocumentQuery<Requirement> {
    const scoped: DocumentQuery<Requirement> = { ...(base ?? {}) }
    if (inSpace !== undefined) {
      scoped.space = inSpace
    }
    return scoped
  }

  // 🔴 THE ARGUMENTS ARE PASSED IN RATHER THAN CLOSED OVER. Svelte 4 collects a
  // reactive statement's dependencies from the identifiers it MENTIONS, so a
  // bare `scopedQuery()` would never re-run when `query` or `space` changed and
  // the roadmap would keep rendering the previous space's scope.
  $: scoped = scopedQuery(query, space)

  $: docsQuery.query<Requirement>(
    _class,
    scoped,
    (result) => {
      lanes = buildLanes(result)
      loading = false
    },
    { ...(options ?? {}), sort: { title: 1 } }
  )

  function versionOf (doc: WithLookup<Requirement>): VersionSlice | undefined {
    const looked = (doc.$lookup as any)?.targetVersion
    return looked == null ? undefined : (looked as VersionSlice)
  }

  /** `undefined` sorts AFTER every real version, so unscheduled work ends up last. */
  function versionRank (version: VersionSlice | undefined): number[] {
    if (version === undefined) return [Number.MAX_SAFE_INTEGER, 0, 0]
    return [version.major ?? Number.MAX_SAFE_INTEGER, version.minor ?? 0, version.patch ?? 0]
  }

  function buildLanes (docs: Array<WithLookup<Requirement>>): RoadmapLane[] {
    const byKey = new Map<string, RoadmapLane>()
    for (const doc of docs) {
      const version = versionOf(doc)
      const key = version?._id ?? ''
      let lane = byKey.get(key)
      if (lane === undefined) {
        lane = { key, version, items: [], counts: [] }
        byKey.set(key, lane)
      }
      lane.items.push(doc)
    }
    for (const lane of byKey.values()) {
      lane.counts = countStatuses(lane.items)
    }
    return [...byKey.values()].sort((a, b) => {
      const ra = versionRank(a.version)
      const rb = versionRank(b.version)
      for (let i = 0; i < ra.length; i++) {
        if (ra[i] !== rb[i]) return ra[i] - rb[i]
      }
      return 0
    })
  }

  /**
   * ⚠️ In `requirementStatusOrder`, not in encounter order, and statuses with no
   * requirement in them are dropped rather than shown as zero — an empty status
   * is noise on a roadmap lane, and the canonical order is what the table and
   * the grouped list already use.
   */
  function countStatuses (items: Array<WithLookup<Requirement>>): Array<[RequirementStatus, number]> {
    const counts = new Map<RequirementStatus, number>()
    for (const item of items) {
      counts.set(item.status, (counts.get(item.status) ?? 0) + 1)
    }
    return requirementStatusOrder
      .filter((status) => (counts.get(status) ?? 0) > 0)
      .map((status) => [status, counts.get(status) as number])
  }

  function versionLabel (version: VersionSlice): string {
    const numbers = `${version.major ?? 0}.${version.minor ?? 0}.${version.patch ?? 0}`
    return version.codename != null && version.codename !== '' ? `${numbers} · ${version.codename}` : numbers
  }
</script>

{#if loading}
  <Loading />
{:else if lanes.length === 0}
  <div class="roadmap-empty"><Label label={requirements.string.RoadmapEmpty} /></div>
{:else}
  <Scroller>
    <div class="roadmap">
      {#each lanes as lane (lane.key)}
        <section class="lane">
          <header class="lane__head">
            <span class="lane__title">
              {#if lane.version !== undefined}
                {versionLabel(lane.version)}
              {:else}
                <Label label={requirements.string.RoadmapUnscheduled} />
              {/if}
            </span>
            <span class="lane__total">{lane.items.length}</span>
          </header>

          <div class="lane__counts">
            {#each lane.counts as [status, count] (status)}
              <span class="lane__count">
                <RequirementStatusPresenter value={status} />
                <b>{count}</b>
              </span>
            {/each}
          </div>

          <ul class="lane__items">
            {#each lane.items as item (item._id)}
              <li class="lane__item">
                <RequirementStatusPresenter value={item.status} />
                <span class="lane__item-title">{item.title}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  </Scroller>
{/if}

<style lang="scss">
  .roadmap {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 1rem;
  }
  .roadmap-empty {
    padding: 1rem;
    color: var(--theme-dark-color);
  }
  .lane {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border-left: 2px solid var(--theme-divider-color);
    padding-left: 0.75rem;
  }
  .lane__head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .lane__title {
    font-weight: 600;
    color: var(--theme-caption-color);
  }
  .lane__total {
    font-size: 0.75rem;
    color: var(--theme-dark-color);
  }
  .lane__counts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.75rem;
  }
  .lane__count {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .lane__items {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .lane__item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .lane__item-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
