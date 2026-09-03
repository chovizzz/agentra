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

import { type DocUpdateMessage } from '@hcengineering/activity'
import core, {
  type Class,
  type Doc,
  type MeasureContext,
  type Ref,
  type SessionData,
  type TxOperations
} from '@hcengineering/core'
import requirements, { type Requirement } from '@hcengineering/requirements'
import testManagement, { type TestCase } from '@hcengineering/test-management'
import traceability, {
  normId,
  traceLinkId,
  validateTraceLink,
  type TraceEndpointRegistry,
  type TraceLink
} from '@hcengineering/traceability'
import { commandObjectId, type CommandOutcome, type CommandRequest } from '@hcengineering/server-agentra-core'

import { assertCommitted, isDuplicateKeyError } from '../commandMiddleware'
import { traceLinkMetadata } from '../traceLinkMetadata'
import { agentraTraceEndpoints } from './traceEndpoints'
import { type CommandRunner } from './convertLeadToRequirement'
import { applyStepFor, ensureTraceActivity } from './traceCommandSupport'

/**
 * Command name. Part of the persisted contract: it is the first component of
 * every derived `_id` this command produces, so renaming it re-points all of
 * them and a replay would write a second set of objects.
 *
 * @public
 */
export const LINK_VERIFIES = 'LinkVerifies'

/**
 * The INNER claim, keyed on the (test case, requirement) PAIR rather than on
 * the caller's idempotency key.
 *
 * 🔴 WHY BOTH CLAIMS EXIST. The outer ledger row excludes on `(command,
 * idempotencyKey)` — it stops the SAME request running twice and says nothing
 * about two DIFFERENT keys linking the same pair. Task 15 requires that all
 * three UI entry points (test case page, requirement page, bulk dialog) collapse
 * onto one edge, and only the first of those is naturally keyed per pair; a bulk
 * caller that invented a batch key would otherwise race a single-pair caller.
 * Claiming `(LINK_VERIFIES_PAIR, "<case> <requirement>")` moves the exclusion
 * onto the pair itself, where the Postgres primary key on the ledger table can
 * enforce it.
 *
 * ⚠️ The pair claim is BELT, the deterministic edge `_id` is BRACES. Even with
 * no claim at all, two racing creates derive the same `traceLinkId` and one of
 * them takes a `23505`; the claim exists so the loser REPLAYS a result instead
 * of surfacing a duplicate-key error to a user who did nothing wrong.
 *
 * @public
 */
export const LINK_VERIFIES_PAIR = `${LINK_VERIFIES}:pair`

/**
 * Object roles for {@link commandObjectId}. Stable forever — changing one
 * re-points the existence lookup at an id that does not exist, and the replay
 * then creates a duplicate.
 *
 * @public
 */
export const linkVerifiesRoles = {
  testCaseActivity: 'activity:test-case',
  requirementActivity: 'activity:requirement'
} as const

/**
 * The scope string of the pair claim. Exported so the tests assert the exact
 * key the ledger row is derived from rather than re-deriving it by hand.
 *
 * 🔴 SEPARATOR, NOT CONCATENATION. `Ref`s are fixed-length here, but the pair
 * key is written once and read forever; a bare concatenation would stop being
 * injective the moment either side gained a prefix.
 *
 * @public
 */
export function linkVerifiesPairKey (testCase: Ref<Doc>, requirement: Ref<Doc>): string {
  return `${testCase} ${requirement}`
}

/**
 * @public
 */
export interface LinkVerifiesInput {
  testCase: Ref<TestCase>
  requirement: Ref<Requirement>
  idempotencyKey: string
}

/**
 * @public
 */
export interface LinkVerifiesResult extends Record<string, any> {
  testCase: Ref<TestCase>
  requirement: Ref<Requirement>
  traceLink: Ref<TraceLink>
  /**
   * `true` when the edge was already there when this attempt looked.
   *
   * ⚠️ Distinct from `CommandOutcome.replayed`, which means "same idempotency
   * key, result served from the ledger". This flag is about the PAIR having been
   * linked before, under any key and from any of the three entry points.
   */
  alreadyLinked: boolean
}

/**
 * @public
 */
export class LinkVerifiesError extends Error {
  readonly code = 400

  constructor (
    readonly reason:
    | 'test-case-not-found'
    | 'requirement-not-found'
    | 'requirement-not-latest'
    | 'invalid-trace-link'
    | 'link-id-taken',
    message: string
  ) {
    super(message)
    this.name = 'LinkVerifiesError'
  }
}

/**
 * @public
 */
export interface LinkVerifiesContext {
  ctx: MeasureContext<SessionData>
  /** Must carry the CALLING account, so every write is attributed and secured. */
  client: TxOperations
  runner: CommandRunner
  endpoints?: TraceEndpointRegistry
  staleTimeoutMs?: number
}

/**
 * Assert `TestCase --verifies--> Requirement`, exactly once per pair.
 *
 * 🔴 REENTRANCY, NOT ATOMICITY. The edge and the two activity records land as
 * separate database transactions (`PostgresAdapter.tx()` groups by domain and
 * commits each group on its own), so a crash in the middle leaves the ledger row
 * `running`; once stale, another attempt preempts it and re-enters here. EVERY
 * step is therefore `findOne`-then-write over a DERIVED `_id` and nothing uses
 * `generateId()`.
 *
 * 🔴 EVERY `commit()` IS ASSERTED. `ApplyTxMiddleware` reports a rejected
 * `TxApplyIf` by RETURNING `{ result: false }` rather than throwing; an
 * unchecked commit would let the runner record `succeeded` over writes that
 * never landed, and the ledger would replay that phantom forever.
 *
 * @public
 */
/**
 * The outer ledger namespace for one (case, requirement) pair.
 *
 * See the note at the call site. The PAIR is the subject here, so both ids go
 * into the name — binding only one of them would still let a key replay across
 * the other.
 *
 * @public
 */
export function linkVerifiesCommandNamespace (testCase: Ref<TestCase>, requirement: Ref<Requirement>): string {
  return `${LINK_VERIFIES}:${testCase}:${requirement}`
}

export async function linkVerifies (
  context: LinkVerifiesContext,
  input: LinkVerifiesInput
): Promise<CommandOutcome<LinkVerifiesResult>> {
  const { ctx, client, runner } = context
  const endpoints = context.endpoints ?? agentraTraceEndpoints
  // 🔴 THE OUTER COMMAND NAME CARRIES THE SUBJECT, and that is a security
  // property rather than a naming choice. `commandExecutionId` is
  // `sha256(command + ' ' + idempotencyKey)`, so with a CONSTANT command name
  // the ledger row is decided entirely by a key the CALLER supplies. A caller
  // could then present a key that already succeeded for one subject while
  // naming a different one, and `CommandMiddleware.resume` would hand back the
  // first subject's stored result without ever entering the body — past the
  // pre-runner readability check, which only ever sees the subject that was
  // NAMED. Folding the subject into the name makes the two rows disjoint.
  const request: CommandRequest = {
    command: linkVerifiesCommandNamespace(input.testCase, input.requirement),
    idempotencyKey: input.idempotencyKey,
    staleTimeoutMs: context.staleTimeoutMs
  }

  // 🔴 CHECKED BEFORE THE RUNNER, not only inside the body. `CommandMiddleware`
  // replays a `succeeded` row's stored result WITHOUT re-entering the body, and
  // the pair claim is keyed on the two ids the caller supplies — so once anyone
  // links a pair, a caller with no access to either endpoint would otherwise
  // get a clean success back and learn that the link exists. Re-reading here
  // makes the replayed path answer exactly like the fresh one.
  await assertEndpointsReadable(client, input)

  return await runner.run<LinkVerifiesResult>(ctx, request, async () => {
    const inner = await runner.run<LinkVerifiesResult>(
      ctx,
      {
        command: LINK_VERIFIES_PAIR,
        idempotencyKey: linkVerifiesPairKey(input.testCase, input.requirement),
        staleTimeoutMs: context.staleTimeoutMs
      },
      async () => await runLink(ctx, client, endpoints, input)
    )
    return { ...inner.result, alreadyLinked: inner.result.alreadyLinked || inner.replayed }
  })
}

/**
 * Both endpoints must be readable BY THE CALLER, on every path.
 *
 * The same two reads happen again inside {@link runLink}; that is deliberate
 * rather than redundant. This one guards the REPLAY (which never enters the
 * body), the ones inside guard the write and additionally supply the documents.
 */
async function assertEndpointsReadable (client: TxOperations, input: LinkVerifiesInput): Promise<void> {
  const testCase = await client.findOne<TestCase>(testManagement.class.TestCase, { _id: input.testCase })
  if (testCase === undefined) {
    throw new LinkVerifiesError('test-case-not-found', `Test case '${input.testCase}' does not exist`)
  }
  const requirement = await client.findOne<Requirement>(requirements.masterTag.Requirement as Ref<any>, {
    _id: input.requirement
  })
  if (requirement === undefined) {
    throw new LinkVerifiesError('requirement-not-found', `Requirement '${input.requirement}' does not exist`)
  }
}

async function runLink (
  ctx: MeasureContext<SessionData>,
  client: TxOperations,
  endpoints: TraceEndpointRegistry,
  input: LinkVerifiesInput
): Promise<LinkVerifiesResult> {
  // ── Step 0: read BOTH endpoints, each pinned to its own class. ────────────
  // Pinning matters twice over: it stops an id of some unrelated class from
  // being linked, and it routes the read through the caller's security filter,
  // so a caller who may not read the case cannot assert anything about it.
  const testCase = await client.findOne<TestCase>(testManagement.class.TestCase, { _id: input.testCase })
  if (testCase === undefined) {
    throw new LinkVerifiesError('test-case-not-found', `Test case '${input.testCase}' does not exist`)
  }
  const requirement = await client.findOne<Requirement>(requirements.masterTag.Requirement as Ref<any>, {
    _id: input.requirement
  })
  if (requirement === undefined) {
    throw new LinkVerifiesError('requirement-not-found', `Requirement '${input.requirement}' does not exist`)
  }

  // ── Step 0b: only the CURRENT revision may be verified. ───────────────────
  // 🔴 Technical Spec §3.2.1: coverage is measured at "current version" scope —
  // an edge pointing at a superseded revision counts as audit history and never
  // towards the completeness figure. Allowing one to be CREATED would therefore
  // manufacture an edge that no coverage view can ever see, and QA would read
  // the resulting permanent zero as a bug in the coverage code.
  //
  // ⚠️ `isLatest === undefined` is ACCEPTED, not rejected. `VersioningMiddleware`
  // stamps the flag only on documents created through it; a requirement written
  // by a fixture, a migration or an older build carries no flag at all, and
  // treating "absent" as "superseded" would refuse every such requirement.
  if ((requirement as { isLatest?: boolean }).isLatest === false) {
    throw new LinkVerifiesError(
      'requirement-not-latest',
      `Requirement '${requirement._id}' is a superseded revision; link the current one`
    )
  }

  // ── Step 0c: the matrix check, server side. ──────────────────────────────
  const validation = validateTraceLink(
    endpoints,
    'verifies',
    testCase._class,
    requirement._class,
    testCase._id,
    requirement._id
  )
  if (!validation.valid) {
    // Fail closed. `unknown-source-class` here means the endpoint registry was
    // not populated in this process — see `traceEndpoints.ts`.
    throw new LinkVerifiesError(
      'invalid-trace-link',
      `Trace link TestCase --verifies--> Requirement rejected: ${validation.reason ?? 'unknown'}`
    )
  }

  // ── Step 1: the edge (query, then write). ────────────────────────────────
  const linkId = traceLinkId('verifies', testCase._id, requirement._id)
  let link = await client.findOne<TraceLink>(traceability.class.TraceLink, { _id: linkId })
  const alreadyLinked = link !== undefined
  if (link === undefined) {
    const apply = applyStepFor(client, LINK_VERIFIES, 'trace-link')
    await apply.createDoc<TraceLink>(
      traceability.class.TraceLink,
      // Workspace scoped by design; per-endpoint permission filtering happens at
      // READ time in `server-traceability-resources`.
      core.space.Workspace,
      {
        // 🔴 `docA` / `docB`, not `source` / `target`: those two names are the
        // only ones the Postgres relation schema promotes to indexed columns.
        docA: testCase._id,
        sourceClass: testCase._class,
        docB: requirement._id,
        targetClass: requirement._class as Ref<Class<Doc>>,
        kind: 'verifies',
        sourceBaseId: normId(testCase),
        targetBaseId: normId(requirement),
        state: 'active',
        // ⚠️ NO `requirementStatus` — it used to be written here. See
        // `traceLinkMetadata.ts`: a requirement's status is not readable by
        // every account, and this blob is.
        metadata: traceLinkMetadata({
          command: LINK_VERIFIES,
          idempotencyKey: input.idempotencyKey
        })
      },
      linkId
    )
    try {
      assertCommitted(await apply.commit(), 'create verifies link')
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
        // Another attempt won the race between our `findOne` and this write.
        // That is the desired end state, not a failure: re-read and continue so
        // the activity records still get written.
        link = await client.findOne<TraceLink>(traceability.class.TraceLink, { _id: linkId })
        if (link === undefined) {
          throw new LinkVerifiesError(
            'link-id-taken',
            `Derived trace link id '${linkId}' is already held by another document`
          )
        }
      } else {
        throw err
      }
    }
    if (link === undefined) {
      link = await client.findOne<TraceLink>(traceability.class.TraceLink, { _id: linkId })
      if (link === undefined) {
        throw new Error(`Trace link '${linkId}' vanished immediately after being created`)
      }
    }
  }

  // ── Step 2 / 3: Activity on BOTH endpoints (query, then write). ──────────
  // 🔴 `DOMAIN_RELATION` is excluded from Activity, so creating the edge above
  // produced NO history entry on either object.
  const pairKey = linkVerifiesPairKey(input.testCase, input.requirement)
  await ensureTraceActivity(client, LINK_VERIFIES, {
    _id: commandObjectId<DocUpdateMessage>(LINK_VERIFIES_PAIR, pairKey, linkVerifiesRoles.testCaseActivity),
    attachedTo: testCase._id,
    attachedToClass: testCase._class,
    space: testCase.space,
    link: linkId
  })
  await ensureTraceActivity(client, LINK_VERIFIES, {
    _id: commandObjectId<DocUpdateMessage>(LINK_VERIFIES_PAIR, pairKey, linkVerifiesRoles.requirementActivity),
    attachedTo: requirement._id,
    attachedToClass: requirement._class,
    space: requirement.space,
    link: linkId
  })

  ctx.info('agentra verifies link asserted', {
    testCase: testCase._id,
    requirement: requirement._id,
    traceLink: linkId,
    alreadyLinked,
    idempotencyKey: input.idempotencyKey
  })

  return {
    testCase: testCase._id,
    requirement: requirement._id,
    traceLink: linkId,
    alreadyLinked
  }
}
