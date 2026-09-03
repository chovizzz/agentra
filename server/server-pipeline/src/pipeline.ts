/* eslint-disable @typescript-eslint/unbound-method */
import card from '@hcengineering/card'
import {
  DOMAIN_BENCHMARK,
  DOMAIN_BLOB,
  DOMAIN_MODEL,
  DOMAIN_TRANSIENT,
  DOMAIN_TX,
  Hierarchy,
  ModelDb,
  systemAccountUuid,
  type Branding,
  type Class,
  type Doc,
  type MeasureContext,
  type Ref,
  type Tx,
  type WorkspaceIds
} from '@hcengineering/core'
import {
  ApplyTxMiddleware,
  BroadcastMiddleware,
  ConfigurationMiddleware,
  ContextNameMiddleware,
  DBAdapterInitMiddleware,
  DBAdapterMiddleware,
  DomainFindMiddleware,
  DomainTxMiddleware,
  FindSecurityMiddleware,
  FullTextMiddleware,
  GuestPermissionsMiddleware,
  IdentityMiddleware,
  LiveQueryMiddleware,
  LookupMiddleware,
  LowLevelMiddleware,
  MarkDerivedEntryMiddleware,
  ModelMiddleware,
  ModifiedMiddleware,
  IdentifierMiddleware,
  NormalizeTxMiddleware,
  PluginConfigurationMiddleware,
  PrivateMiddleware,
  QueryJoinMiddleware,
  QueueMiddleware,
  RankMiddleware,
  SpacePermissionsMiddleware,
  SpaceSecurityMiddleware,
  VersioningMiddleware,
  TriggersMiddleware,
  TxMiddleware,
  TxOrderingMiddleware,
  UserStatusMiddleware
} from '@hcengineering/middleware'
import {
  createBenchmarkAdapter,
  createInMemoryAdapter,
  createNullAdapter,
  createPipeline,
  type BroadcastOps,
  type DbAdapterFactory,
  type DbConfiguration,
  type Middleware,
  type MiddlewareCreator,
  type Pipeline,
  type PipelineContext,
  type PipelineFactory,
  type PlatformQueue,
  type StorageAdapter,
  type WorkspaceDestroyAdapter
} from '@hcengineering/server-core'
import { generateToken } from '@hcengineering/server-token'
import { createStorageDataAdapter } from './blobStorage'
import { CommunicationMiddleware, type CommunicationApiFactory } from './communication'

import { RatingMiddleware } from '@hcengineering/server-rating'
import { AgentraCommandRequestMiddleware, CommandMiddleware } from '@hcengineering/server-agentra-core-resources'
import { TraceabilityMiddleware } from '@hcengineering/server-traceability-resources'
import { LeadGuardMiddleware } from '@hcengineering/server-crm-lite'
import { BlockedReasonGuardMiddleware, SnapshotGuardMiddleware } from '@hcengineering/server-test-management'
import { ProductVersionReleaseGuardMiddleware } from '@hcengineering/server-products-resources'

/**
 * @public
 */

export function getTxAdapterFactory (
  metrics: MeasureContext,
  dbUrl: string,
  workspace: WorkspaceIds,
  branding: Branding | null,
  opt: {
    disableTriggers?: boolean
    usePassedCtx?: boolean

    externalStorage: StorageAdapter
  },
  extensions?: Partial<DbConfiguration>
): DbAdapterFactory {
  const conf = getConfig(metrics, dbUrl, metrics, opt, extensions)
  const adapterName = conf.domains[DOMAIN_TX] ?? conf.defaultAdapter
  const adapter = conf.adapters[adapterName]
  return adapter.factory
}

function addMessagesToFullText (fulltext: MiddlewareCreator): MiddlewareCreator {
  return async (ctx: MeasureContext, context: PipelineContext, next?: Middleware) => {
    const result: FullTextMiddleware = (await fulltext(ctx, context, next)) as FullTextMiddleware
    result.addExtraFind = (baseClass, childClasses) => {
      if (context.hierarchy.isDerived(baseClass, card.class.Card)) {
        // Using Card as base class because messages are the same for any card subclass
        childClasses.add(`${card.class.Card}%message` as Ref<Class<Doc>>)
      }
    }
    return result
  }
}

/**
 * @public
 */

export function createServerPipeline (
  metrics: MeasureContext,
  dbUrl: string,
  model: Tx[],
  opt: {
    fulltextUrl?: string
    disableTriggers?: boolean
    usePassedCtx?: boolean
    adapterSecurity?: boolean

    externalStorage: StorageAdapter

    queue?: PlatformQueue

    extraLogging?: boolean // If passed, will log every request/etc.
    pipelineContextVars?: Record<string, any>
    communicationApiFactory?: CommunicationApiFactory
  },
  extensions?: Partial<DbConfiguration>
): PipelineFactory {
  return (ctx, workspace, broadcast, branding) => {
    const metricsCtx = opt.usePassedCtx === true ? ctx : metrics
    const wsMetrics = metricsCtx.newChild('🧲 session', {}, { span: false })
    const conf = getConfig(metrics, dbUrl, wsMetrics, opt, extensions)

    const middlewares: MiddlewareCreator[] = [
      LookupMiddleware.create,
      NormalizeTxMiddleware.create,
      IdentityMiddleware.create,
      ModifiedMiddleware.create,
      RankMiddleware.create,
      FindSecurityMiddleware.create,
      PluginConfigurationMiddleware.create,
      PrivateMiddleware.create,
      (ctx: MeasureContext, context: PipelineContext, next?: Middleware) =>
        SpaceSecurityMiddleware.create(opt.adapterSecurity ?? false, ctx, context, next),
      SpacePermissionsMiddleware.create,
      GuestPermissionsMiddleware.create,
      ConfigurationMiddleware.create,
      ContextNameMiddleware.create,
      MarkDerivedEntryMiddleware.create,
      ...(opt.communicationApiFactory !== undefined
        ? [CommunicationMiddleware.create(opt.communicationApiFactory)]
        : []),
      UserStatusMiddleware.create,
      ApplyTxMiddleware.create, // Extract apply
      VersioningMiddleware.create,
      IdentifierMiddleware.create, // After ApplyTx to ensure that it pass
      RatingMiddleware.create, // Rating editing restrictions
      // Agentra idempotent commands. Same slot as RatingMiddleware: after
      // ApplyTxMiddleware, so TxApplyIf is already flattened and there is no
      // need to recurse into `TxApplyIf.txes`, and before TxMiddleware, so a
      // rejected ledger write never reaches the transaction domain.
      CommandMiddleware.create,
      // Agentra domain-request handlers. Both answer client->server calls the
      // same way CommunicationMiddleware does, and both reach their data through
      // `context.head` rather than `provideFindAll`/`provideTx`, so placement in
      // this list does NOT determine what they can read or write: going through
      // the head re-enters the full chain (FindSecurity, Private, SpaceSecurity,
      // SpacePermissions, GuestPermissions) with the CALLER's session context.
      // They sit here so the command handler is next to the CommandMiddleware
      // whose runner it uses.
      AgentraCommandRequestMiddleware.create,
      // Agentra CRM lead state machine. Must sit AFTER ApplyTxMiddleware (so
      // TxApplyIf is already flattened and the wrapped status write is visible
      // as a plain TxUpdateDoc) and BEFORE TxMiddleware (so a refused write
      // never reaches the transaction domain). It also has to be BELOW nothing
      // in particular with respect to the command middlewares: the conversion
      // command writes through `context.head`, i.e. the top of the chain, so it
      // passes this guard wherever the guard is placed.
      LeadGuardMiddleware.create,
      // Agentra test case snapshot immutability. Same slot and the same two
      // constraints as LeadGuardMiddleware: AFTER ApplyTxMiddleware (so
      // TxApplyIf is already flattened) and BEFORE TxMiddleware (so a refused
      // write never reaches the transaction domain).
      //
      // ⚠️ It also sits BELOW MarkDerivedEntryMiddleware, which is what makes
      // `context.derived` route trigger-emitted cascade removals back through
      // it — see SnapshotGuardMiddleware's class comment for why that is
      // load bearing rather than incidental.
      SnapshotGuardMiddleware.create,
      // "A blocked test result must say why". Same slot and the same two
      // constraints as the two guards above: AFTER ApplyTxMiddleware so a
      // TxApplyIf is already flattened, BEFORE TxMiddleware so a refused write
      // never reaches the transaction domain.
      BlockedReasonGuardMiddleware.create,
      // Agentra release gate: `ProductVersion.state` may only become
      // `Released` by way of the `ReleaseProductVersion` command (PRD REL-003,
      // Technical Spec §3.6). Same slot and the same two constraints as the
      // three guards above: AFTER ApplyTxMiddleware, so the command's own
      // compare-and-swap `TxApplyIf` arrives here already flattened into a
      // plain TxUpdateDoc; BEFORE TxMiddleware, so a refused write never
      // reaches the transaction domain.
      //
      // ℹ️ Placement relative to CommandMiddleware is NOT load bearing, and the
      // comment that used to claim otherwise was wrong: `provideFindAll`
      // descends all the way to the adapter from either side, so the ledger row
      // is visible above or below, and the release command issues its writes
      // through `context.head` — the top of the chain — so they re-enter here
      // wherever here is. It sits below only to keep the Agentra guards
      // together.
      ProductVersionReleaseGuardMiddleware.create,
      TraceabilityMiddleware.create,
      TxMiddleware.create, // Store tx into transaction domain
      ...(opt.disableTriggers === true ? [] : [TriggersMiddleware.create]),
      ...(opt.fulltextUrl !== undefined
        ? [
            addMessagesToFullText(
              FullTextMiddleware.create(
                opt.fulltextUrl,
                generateToken(systemAccountUuid, workspace.uuid, { service: 'transactor' })
              )
            )
          ]
        : []),
      LowLevelMiddleware.create,
      TxOrderingMiddleware.create(),
      QueryJoinMiddleware.create,
      LiveQueryMiddleware.create,
      DomainFindMiddleware.create,
      DomainTxMiddleware.create,
      ...(opt.queue !== undefined ? [QueueMiddleware.create(opt.queue)] : []),
      DBAdapterInitMiddleware.create,
      ModelMiddleware.create(model),
      DBAdapterMiddleware.create(conf), // Configure DB adapters
      BroadcastMiddleware.create(broadcast)
    ]

    const hierarchy = new Hierarchy()
    const modelDb = new ModelDb(hierarchy)
    const context: PipelineContext = {
      workspace,
      branding,
      modelDb,
      hierarchy,
      queue: opt.queue,
      storageAdapter: opt.externalStorage,
      contextVars: opt.pipelineContextVars ?? {}
    }
    return createPipeline(ctx, middlewares, context)
  }
}

/**
 * @public
 */

export function createBackupPipeline (
  metrics: MeasureContext,
  dbUrl: string,
  systemTx: Tx[],
  opt: {
    usePassedCtx?: boolean
    adapterSecurity?: boolean

    externalStorage: StorageAdapter
  }
): PipelineFactory {
  return (ctx, workspace, broadcast, branding) => {
    const metricsCtx = opt.usePassedCtx === true ? ctx : metrics
    const wsMetrics = metricsCtx.newChild('🧲 backup', {}, { span: false })
    const conf = getConfig(metrics, dbUrl, wsMetrics, {
      ...opt,
      disableTriggers: true
    })

    const middlewares: MiddlewareCreator[] = [
      LowLevelMiddleware.create,
      ContextNameMiddleware.create,
      // ConnectionMgrMiddleware.create,
      DomainFindMiddleware.create,
      DBAdapterInitMiddleware.create,
      ModelMiddleware.create(systemTx),
      DBAdapterMiddleware.create(conf)
    ]

    const hierarchy = new Hierarchy()
    const modelDb = new ModelDb(hierarchy)
    const context: PipelineContext = {
      workspace,
      branding,
      modelDb,
      hierarchy,
      storageAdapter: opt.externalStorage,
      contextVars: {}
    }
    return createPipeline(ctx, middlewares, context)
  }
}

export function createEmptyBroadcastOps (): BroadcastOps {
  return {
    broadcast: (): void => {},
    broadcastSessions: (): void => {}
  }
}

export async function getServerPipeline (
  ctx: MeasureContext,
  model: Tx[],
  dbUrl: string,
  wsUrl: WorkspaceIds,
  storageAdapter: StorageAdapter,
  opt?: {
    queue?: PlatformQueue
    disableTriggers?: boolean
    communicationApiFactory?: CommunicationApiFactory
  }
): Promise<Pipeline> {
  const pipelineFactory = createServerPipeline(ctx, dbUrl, model, {
    externalStorage: storageAdapter,
    usePassedCtx: true,
    disableTriggers: opt?.disableTriggers ?? false,
    adapterSecurity: isAdapterSecurity(dbUrl),
    queue: opt?.queue,
    communicationApiFactory: opt?.communicationApiFactory
  })

  return await pipelineFactory(ctx, wsUrl, createEmptyBroadcastOps(), null)
}

const txAdapterFactories: Record<string, DbAdapterFactory> = {}
const adapterFactories: Record<string, DbAdapterFactory> = {}
const destroyFactories: Record<string, (url: string) => WorkspaceDestroyAdapter> = {}
const adapterSecurityState = new Set<string>()

export function isAdapterSecurity (name: string): boolean {
  for (const it of adapterSecurityState) {
    if (name.startsWith(it)) {
      return true
    }
  }
  return false
}
export function setAdapterSecurity (name: string, state: boolean): void {
  if (state) {
    adapterSecurityState.add(name)
  } else {
    adapterSecurityState.delete(name)
  }
}

export function registerTxAdapterFactory (name: string, factory: DbAdapterFactory, useAsDefault: boolean = true): void {
  txAdapterFactories[name] = factory
  if (useAsDefault) {
    txAdapterFactories[''] = factory
  }
}

export function registerAdapterFactory (name: string, factory: DbAdapterFactory, useAsDefault: boolean = true): void {
  adapterFactories[name] = factory
  if (useAsDefault) {
    adapterFactories[''] = factory
  }
}

export function registerDestroyFactory (
  name: string,
  factory: (url: string) => WorkspaceDestroyAdapter,
  useAsDefault: boolean = true
): void {
  destroyFactories[name] = factory
  if (useAsDefault) {
    destroyFactories[''] = factory
  }
}

function matchTxAdapterFactory (dbUrl: string): DbAdapterFactory {
  for (const [k, v] of Object.entries(txAdapterFactories)) {
    if (k !== '' && dbUrl.startsWith(k)) {
      return v
    }
  }
  return txAdapterFactories['']
}

function matchAdapterFactory (dbUrl: string): DbAdapterFactory {
  for (const [k, v] of Object.entries(adapterFactories)) {
    if (k !== '' && dbUrl.startsWith(k)) {
      return v
    }
  }
  return adapterFactories['']
}

export function getWorkspaceDestroyAdapter (dbUrl: string): WorkspaceDestroyAdapter {
  for (const [k, v] of Object.entries(destroyFactories)) {
    if (dbUrl.startsWith(k)) {
      return v(dbUrl)
    }
  }
  return destroyFactories[''](dbUrl)
}

export function getConfig (
  metrics: MeasureContext,
  dbUrl: string,
  ctx: MeasureContext,
  opt: {
    disableTriggers?: boolean
    usePassedCtx?: boolean

    externalStorage: StorageAdapter
  },
  extensions?: Partial<DbConfiguration>
): DbConfiguration {
  const metricsCtx = opt.usePassedCtx === true ? ctx : metrics
  const wsMetrics = metricsCtx.newChild('🧲 session', {}, { span: false })
  const conf: DbConfiguration = {
    domains: {
      [DOMAIN_TX]: 'Tx',
      [DOMAIN_TRANSIENT]: 'InMemory',
      [DOMAIN_BLOB]: 'StorageData',
      [DOMAIN_MODEL]: 'Null',
      [DOMAIN_BENCHMARK]: 'Benchmark',
      ...extensions?.domains
    },
    metrics: wsMetrics,
    defaultAdapter: extensions?.defaultAdapter ?? 'Main',
    adapters: {
      Tx: {
        factory: matchTxAdapterFactory(dbUrl),
        url: dbUrl
      },
      Main: {
        factory: matchAdapterFactory(dbUrl),
        url: dbUrl
      },
      Null: {
        factory: createNullAdapter,
        url: ''
      },
      InMemory: {
        factory: createInMemoryAdapter,
        url: ''
      },
      StorageData: {
        factory: createStorageDataAdapter,
        url: ''
      },
      Benchmark: {
        factory: createBenchmarkAdapter,
        url: ''
      },
      ...extensions?.adapters
    },
    serviceAdapters: extensions?.serviceAdapters ?? {}
  }
  return conf
}
