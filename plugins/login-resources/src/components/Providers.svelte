<script lang="ts">
  import { concatLink } from '@hcengineering/core'
  import { getMetadata } from '@hcengineering/platform'
  import { type ProviderInfo } from '@hcengineering/account-client'
  import { AnySvelteComponent, Button, Grid, Label, deviceOptionsStore, getCurrentLocation } from '@hcengineering/ui'
  import { Analytics } from '@hcengineering/analytics'
  import { onMount } from 'svelte'
  import login from '../plugin'
  import { getProviders } from '../utils'
  import Feishu from './providers/Feishu.svelte'
  import Github from './providers/Github.svelte'
  import Google from './providers/Google.svelte'
  import OpenId from './providers/OpenId.svelte'

  interface Provider {
    name: string
    // ⚠️ OPTIONAL ON PURPOSE, AND IT WAS NOT BEFORE. `providerMap[provider.name]`
    // is an index into a partial record, so it has always been able to come back
    // `undefined`; typing it as always-present is what let the empty-button bug
    // reach the page with no type error and no runtime error. Making the type
    // honest is what forces the `{#if}` in the template below.
    component: AnySvelteComponent | undefined
    displayName?: string
  }

  // 🔴 THE SERVER DECIDES WHICH PROVIDERS EXIST; THIS MAP ONLY DECIDES HOW THEY
  // LOOK. A provider the server enables but this map does not name still gets a
  // button — `getLink` builds `/auth/<name>` from the name alone — it just has
  // nothing inside it. That is exactly what happened to `feishu`: the backend
  // advertised it and the login page rendered an EMPTY button. Keep this map in
  // step with `registerProviders` in `pods/authProviders/src/index.ts`.
  const providerMap: Record<string, AnySvelteComponent> = {
    google: Google,
    github: Github,
    openid: OpenId,
    feishu: Feishu
  }

  let enabledProviders: Provider[] = []

  onMount(() => {
    void getProviders().then((res: ProviderInfo[]) => {
      enabledProviders = res.map((provider) => {
        const component = providerMap[provider.name]
        return {
          ...provider,
          component
        }
      })
    })
  })

  function getColumnsCount (providersCount: number): number {
    if ($deviceOptionsStore.isMobile) {
      return 1
    }
    return providersCount % 2 === 0 ? 2 : 1
  }

  const location = getCurrentLocation()

  function getLink (provider: Provider): string {
    const inviteId = location.query?.inviteId
    const autoJoin = location.query?.autoJoin !== undefined
    const navigateUrl = location.query?.navigateUrl
    const accountsUrl = getMetadata(login.metadata.AccountsUrl) ?? ''
    let path = `/auth/${provider.name}`
    if (inviteId != null) {
      path += `?inviteId=${inviteId}`
      if (autoJoin) {
        path += '&autoJoin'
      }
      if (navigateUrl != null) {
        path += `&navigateUrl=${navigateUrl}`
      }
    }

    return concatLink(accountsUrl, path)
  }

  function handleProviderClick (provider: Provider): void {
    const currentPath = location.path[1]
    const isSignUp = currentPath === 'signup'
    const isJoin = currentPath === 'join'
    const eventPrefix = isSignUp || isJoin ? 'signup' : 'login'
    const eventName: string = `${eventPrefix}.${provider.name}.started`

    Analytics.handleEvent(eventName)
  }
</script>

<div class="container">
  <Grid column={getColumnsCount(enabledProviders.length)} columnGap={1} rowGap={1} alignItems={'center'}>
    {#each enabledProviders as provider}
      <a
        href={getLink(provider)}
        on:click={() => {
          handleProviderClick(provider)
        }}
      >
        <Button kind={'contrast'} shape={'round2'} size={'x-large'} width="100%" stopPropagation={false}>
          <svelte:fragment slot="content">
            {#if provider.component !== undefined}
              <svelte:component this={provider.component} displayName={provider.displayName} />
            {:else}
              <!-- Fallback for a provider `providerMap` does not name. Without it
                   `<svelte:component this={undefined}>` renders NOTHING and the
                   user gets a blank, unlabelled, still-clickable button — a
                   silent failure that looks like a broken page rather than a
                   missing icon. Degrading to the provider's own name keeps the
                   button usable while the icon is added. -->
              <Label label={login.string.ContinueWith} params={{ provider: provider.displayName ?? provider.name }} />
            {/if}
          </svelte:fragment>
        </Button>
      </a>
    {/each}
  </Grid>
</div>

<style lang="scss">
  .container {
    padding-top: 1rem;
  }
</style>
