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

import activity, { type DocUpdateMessage } from '@hcengineering/activity'
import core, {
  type ApplyOperations,
  type Doc,
  type MarkupBlobRef,
  type MeasureContext,
  type Ref,
  type SessionData,
  type Space,
  type TxOperations
} from '@hcengineering/core'
import crmLite, { canTransitionLead, type Lead, type LeadStatus } from '@hcengineering/crm-lite'
import requirements, { type Requirement } from '@hcengineering/requirements'
import traceability, {
  normId,
  traceLinkId,
  validateTraceLink,
  type TraceEndpointRegistry,
  type TraceLink
} from '@hcengineering/traceability'
import {
  commandObjectId,
  commandRunnerContextVar,
  type CommandBody,
  type CommandOutcome,
  type CommandRequest
} from '@hcengineering/server-agentra-core'
import type { PipelineContext } from '@hcengineering/server-core'

import { assertCommitted, isDuplicateKeyError } from '../commandMiddleware'
import { traceLinkMetadata } from '../traceLinkMetadata'
import { agentraTraceEndpoints } from './traceEndpoints'

/**
 * Command name. Also the first component of every derived `_id` this command
 * produces, so it is part of the persisted contract: renaming it re-points all
 * of them and a replay would build a second Requirement.
 *
 * @public
 */
export const CONVERT_LEAD_TO_REQUIREMENT = 'ConvertLeadToRequirement'

/**
 * The name of the INNER claim, the one keyed on the Lead rather than on the
 * caller's idempotency key.
 *
 * 🔴 WHY THERE ARE TWO CLAIMS. The ledger excludes on `(command,
 * idempotencyKey)`, which stops the SAME request running twice — it says
 * nothing about two DIFFERENT keys converting the same Lead. Task 9 requires
 * that "the same lead converted concurrently by the same or different clients
 * yields exactly one Requirement and one `converted-to` link", and a
 * read-then-create check on the edge cannot deliver that: both callers read no
 * edge, both create one. Claiming `(CONVERT_LEAD_LOCK, leadId)` moves the
 * exclusion onto the Lead itself, where the Postgres primary key can enforce
 * it, and every object this command produces is derived from the LEAD id so the
 * two callers converge on the same `_id`s even if they do race.
 *
 * The outer claim is still needed: it is what makes a retry of one request
 * replay its own stored result, and what turns a same-key concurrent retry into
 * a 409 instead of a second body run.
 *
 * @public
 */
export const CONVERT_LEAD_LOCK = `${CONVERT_LEAD_TO_REQUIREMENT}:lead`

/**
 * Object roles for {@link commandObjectId}. Stable forever, same reason.
 *
 * ⚠️ They are derived against `(CONVERT_LEAD_LOCK, leadId)`, NOT against the
 * caller's idempotency key. Keying them on the request would give two requests
 * for one Lead two different Requirement ids, which is precisely the duplicate
 * this command has to prevent.
 *
 * @public
 */
export const convertLeadRoles = {
  requirement: 'requirement',
  leadActivity: 'activity:lead',
  requirementActivity: 'activity:requirement'
} as const

/**
 * The one status a Lead may legally be converted from.
 *
 * Not a constant of convenience — it is `leadTransitions` read back: only
 * `Qualifying` lists `Converted` as a successor. The command still asks
 * {@link canTransitionLead} rather than comparing against this value, so the
 * state machine stays the single source of truth.
 */
const CONVERTED: LeadStatus = 'Converted'

/**
 * @public
 */
export interface ConvertLeadToRequirementInput {
  lead: Ref<Lead>
  /**
   * Typed off `Requirement` rather than importing `@hcengineering/products`:
   * the ref only ever travels from the caller into the new card, so borrowing
   * the field's own type keeps this package free of a dependency it would
   * otherwise carry for one `Ref`.
   */
  product?: Requirement['product']
  /**
   * Recorded on the edge, NOT consumed in V1. Splitting a Requirement into Work
   * Items is Task 12; carrying the target project through now means the split
   * does not have to guess it later. Typed `Ref<Doc>` to avoid a `tracker`
   * dependency for a value this command never dereferences.
   */
  project?: Ref<Doc>
  owner?: Requirement['owner']
  idempotencyKey: string
}

/**
 * @public
 */
export interface ConvertLeadToRequirementResult extends Record<string, any> {
  lead: Ref<Lead>
  requirement: Ref<Requirement>
  traceLink: Ref<TraceLink>
  /**
   * `true` when this call resolved to a Requirement an EARLIER conversion had
   * already produced, rather than building one. QA CRM-T005: the button opens
   * the original requirement rather than creating a second one.
   *
   * ⚠️ Distinct from `CommandOutcome.replayed`, which means "same idempotency
   * key, result served from the ledger". This flag is about the LEAD having
   * been converted before, under any key.
   */
  alreadyConverted: boolean
}

/**
 * The slice of `CommandMiddleware` a command body needs. Declared structurally
 * so tests (and any future runner) are not forced to construct a whole
 * pipeline middleware.
 *
 * @public
 */
export interface CommandRunner {
  run: <T extends Record<string, any>>(
    ctx: MeasureContext<SessionData>,
    request: CommandRequest,
    body: CommandBody<T>
  ) => Promise<CommandOutcome<T>>
}

/**
 * Reach the runner the middleware published on the pipeline.
 *
 * 🔴 Throws rather than falling back to a private claim mechanism. A command
 * that quietly ran without the ledger would be neither idempotent nor
 * exclusive, and the damage (duplicate Requirements) is invisible until someone
 * counts them.
 *
 * @public
 */
export function getCommandRunner (context: PipelineContext): CommandRunner {
  const runner = context.contextVars[commandRunnerContextVar]
  if (runner === undefined || typeof runner.run !== 'function') {
    throw new Error(
      `Agentra command runner is not registered on the pipeline (contextVars['${commandRunnerContextVar}'])`
    )
  }
  return runner as CommandRunner
}

/**
 * @public
 */
export interface ConvertLeadToRequirementContext {
  ctx: MeasureContext<SessionData>
  /** Must carry the CALLING account, so every write is attributed and secured. */
  client: TxOperations
  runner: CommandRunner
  /** Defaults to the process-local registry; overridable for tests. */
  endpoints?: TraceEndpointRegistry
  /** Overrides the runner's default stale-claim timeout. */
  staleTimeoutMs?: number
}

/**
 * Raised for the input-level refusals, so a caller can tell "you asked for
 * something impossible" apart from "the write failed".
 *
 * @public
 */
export class ConvertLeadError extends Error {
  readonly code = 400

  constructor (
    readonly reason:
    | 'lead-not-found'
    | 'illegal-transition'
    | 'invalid-trace-link'
    | 'converted-without-link'
    | 'requirement-id-taken',
    message: string
  ) {
    super(message)
    this.name = 'ConvertLeadError'
  }
}

/**
 * Convert a Lead into a Requirement, exactly once per `idempotencyKey`.
 *
 * 🔴 REENTRANCY, NOT ATOMICITY. `PostgresAdapter.tx()` groups transactions by
 * domain and each group lands as its own `BEGIN`/`COMMIT`, so the four writes
 * below (Requirement, trace edge, Lead status, two activity records) are
 * several unrelated database transactions. A crash in the middle leaves the
 * ledger row `running`; once it goes stale another attempt preempts it and
 * re-enters this body, which is why EVERY step is a `findOne`-then-write over a
 * DERIVED `_id`. Nothing here may use `generateId()`.
 *
 * 🔴 EVERY `commit()` IS ASSERTED. `ApplyTxMiddleware` reports a rejected
 * `TxApplyIf` by RETURNING `{ result: false }`; it does not throw. An unchecked
 * commit would let the runner mark the execution `succeeded` over writes that
 * never landed, and the ledger would then replay that phantom result forever.
 *
 * @public
 */
/**
 * The outer ledger namespace for one subject.
 *
 * See the note at the call site: a constant command name would let a key that
 * succeeded for one subject replay under another.
 *
 * @public
 */
export function convertLeadCommandNamespace (lead: Ref<Lead>): string {
  return `${CONVERT_LEAD_TO_REQUIREMENT}:${lead}`
}

export async function convertLeadToRequirement (
  context: ConvertLeadToRequirementContext,
  input: ConvertLeadToRequirementInput
): Promise<CommandOutcome<ConvertLeadToRequirementResult>> {
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
    command: convertLeadCommandNamespace(input.lead),
    idempotencyKey: input.idempotencyKey,
    staleTimeoutMs: context.staleTimeoutMs
  }

  // 🔴 CHECKED BEFORE THE RUNNER, not only inside the body. `CommandMiddleware`
  // replays a `succeeded` row's stored result WITHOUT re-entering the body, and
  // BOTH claims this command uses are keyed on data the caller supplies — the
  // outer one on a key the client derives from the lead, the inner one on the
  // lead itself. So once any authorised user converts a lead, an unauthorised
  // caller naming the same lead would otherwise be handed that user's stored
  // result: the Requirement and TraceLink refs included, and the mere fact of
  // the conversion. Re-reading here makes the replayed path answer exactly like
  // the fresh one.
  //
  // The same read happens again inside the body; that is deliberate rather than
  // redundant. This one guards the REPLAY, the one inside guards the write and
  // additionally supplies the document.
  await assertLeadReadable(client, input.lead)

  return await runner.run<ConvertLeadToRequirementResult>(ctx, request, async () => {
    // Inner claim, keyed on the Lead. Three outcomes, all of them correct:
    //  - free       -> run the body;
    //  - succeeded  -> replay the ORIGINAL conversion, i.e. "open the existing
    //                  requirement" (CRM-T005), without writing anything;
    //  - running    -> `CommandInProgressError` (409) rather than a silent
    //                  success (CRM-T006);
    //  - failed / stale -> preempted, and the body re-enters to finish a
    //                  conversion an earlier key abandoned half done.
    const inner = await runner.run<ConvertLeadToRequirementResult>(
      ctx,
      { command: CONVERT_LEAD_LOCK, idempotencyKey: input.lead, staleTimeoutMs: context.staleTimeoutMs },
      async () => await runConversion(ctx, client, endpoints, input)
    )
    return { ...inner.result, alreadyConverted: inner.result.alreadyConverted || inner.replayed }
  })
}

/**
 * The lead must be readable BY THE CALLER, on every path.
 *
 * ⚠️ Pinned to `crmLite.masterTag.Lead` rather than looked up by id alone: the
 * class pin is what routes the read through the caller's security filter for
 * the right class, and it stops an id of some unrelated class from answering.
 */
async function assertLeadReadable (client: TxOperations, lead: Ref<Lead>): Promise<void> {
  const found = await client.findOne<Lead>(crmLite.masterTag.Lead as Ref<any>, { _id: lead })
  if (found === undefined) {
    throw new ConvertLeadError('lead-not-found', `Lead '${lead}' does not exist`)
  }
}

async function runConversion (
  ctx: MeasureContext<SessionData>,
  client: TxOperations,
  endpoints: TraceEndpointRegistry,
  input: ConvertLeadToRequirementInput
): Promise<ConvertLeadToRequirementResult> {
  // 🔴 Derived from the LEAD, not from the request. See `CONVERT_LEAD_LOCK`.
  const requirementId = commandObjectId<Requirement>(CONVERT_LEAD_LOCK, input.lead, convertLeadRoles.requirement)

  // ── Step 0: read the Lead. ────────────────────────────────────────────────
  const lead = await client.findOne<Lead>(crmLite.masterTag.Lead as Ref<any>, { _id: input.lead })
  if (lead === undefined) {
    throw new ConvertLeadError('lead-not-found', `Lead '${input.lead}' does not exist`)
  }

  // ── Step 0b: has an EARLIER conversion already claimed this Lead? ─────────
  // Answered from the edge, never from `status === 'Converted'` alone: the
  // status is set AFTER the edge (see the ordering below), so a Lead that is
  // Converted always has its edge, while a Lead that has an edge may not yet be
  // Converted. Reading the edge is therefore the strictly earlier signal and
  // the one that survives a partial run.
  const existing = await client.findAll<TraceLink>(traceability.class.TraceLink, {
    docA: lead._id,
    kind: 'converted-to',
    state: 'active'
  })
  const foreign = existing.find((link) => link.docB !== requirementId)
  if (foreign !== undefined) {
    // A DIFFERENT idempotency key already converted this Lead. Resolve to the
    // original Requirement and write nothing — QA CRM-T005 ("Converted lead
    // opens the existing requirement"). Doing anything else here would either
    // duplicate the requirement or silently rewrite history.
    return {
      lead: lead._id,
      requirement: foreign.docB as Ref<Requirement>,
      traceLink: foreign._id,
      alreadyConverted: true
    }
  }

  // ── Step 0c: validate BEFORE writing anything. ───────────────────────────
  // Ordering is load bearing. Creating the Requirement first and only then
  // discovering that the Lead cannot leave its current state would strand an
  // orphan card that no edge points at and no replay would ever clean up.
  if (lead.status !== CONVERTED && !canTransitionLead(lead.status, CONVERTED)) {
    throw new ConvertLeadError(
      'illegal-transition',
      `Lead '${lead._id}' cannot be converted from status '${lead.status}'`
    )
  }
  if (lead.status === CONVERTED && existing.length === 0) {
    // Converted but with no edge at all, and not our own partial run either
    // (that case would have matched `requirementId` above). Something set the
    // status outside this command; converting now would fabricate an audit
    // trail. Refuse loudly instead.
    throw new ConvertLeadError(
      'converted-without-link',
      `Lead '${lead._id}' is already Converted but carries no 'converted-to' trace link`
    )
  }

  const linkId = traceLinkId('converted-to', lead._id, requirementId)
  const validation = validateTraceLink(
    endpoints,
    'converted-to',
    lead._class,
    requirements.masterTag.Requirement as Ref<any>,
    lead._id,
    requirementId
  )
  if (!validation.valid) {
    // Fail closed. `unknown-source-class` here means the endpoint registry was
    // not populated in this process — see `traceEndpoints.ts`.
    throw new ConvertLeadError(
      'invalid-trace-link',
      `Trace link Lead --converted-to--> Requirement rejected: ${validation.reason ?? 'unknown'}`
    )
  }

  // ── Step 1: the Requirement (query, then write). ─────────────────────────
  const requirementSpace = requirements.space.Requirements as Ref<Space>
  let requirement = await client.findOne<Requirement>(requirements.masterTag.Requirement as Ref<any>, {
    _id: requirementId
  })
  if (requirement === undefined) {
    const apply = applyStep(client, 'requirement')
    await apply.createDoc<Requirement>(
      requirements.masterTag.Requirement as Ref<any>,
      requirementSpace,
      {
        title: lead.title,
        // Empty markup is stored as the empty ref, exactly as `createCard`
        // does; a collaborative blob is only allocated when there is content.
        content: '' as MarkupBlobRef,
        blobs: {},
        parentInfo: [],
        rank: '',
        status: 'Draft',
        priority: lead.priority,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        ...(input.product !== undefined ? { product: input.product } : {})
      },
      requirementId
    )
    // 🔴 The `findOne` above is pinned to the Requirement class, so a document
    // of ANOTHER class sitting on the derived id would read as absent and the
    // create would then collide on `PRIMARY KEY("workspaceId", _id)`. A probing
    // read cannot close that gap — there is no cross-domain `findOne` on this
    // pipeline (`core.class.Doc` has no domain to route to) — so the collision
    // is caught here and translated instead of surfacing as a raw `23505`.
    try {
      assertCommitted(await apply.commit(), 'create requirement')
    } catch (err: unknown) {
      if (isDuplicateKeyError(err)) {
        throw new ConvertLeadError(
          'requirement-id-taken',
          `Derived requirement id '${requirementId}' is already held by another document`
        )
      }
      throw err
    }
    requirement = await client.findOne<Requirement>(requirements.masterTag.Requirement as Ref<any>, {
      _id: requirementId
    })
    if (requirement === undefined) {
      throw new Error(`Requirement '${requirementId}' vanished immediately after being created`)
    }
  }

  // ── Step 2: the trace edge (query, then write). ──────────────────────────
  let link = await client.findOne<TraceLink>(traceability.class.TraceLink, { _id: linkId })
  if (link === undefined) {
    const apply = applyStep(client, 'trace-link')
    await apply.createDoc<TraceLink>(
      traceability.class.TraceLink,
      // The edge is workspace scoped by design; per-endpoint permission
      // filtering happens at READ time in `server-traceability-resources`.
      core.space.Workspace,
      {
        // 🔴 `docA` / `docB`, not `source` / `target`. Those two names are the
        // only ones the Postgres relation schema promotes to indexed columns.
        docA: lead._id,
        sourceClass: lead._class,
        docB: requirementId,
        targetClass: requirements.masterTag.Requirement as Ref<any>,
        kind: 'converted-to',
        sourceBaseId: normId(lead),
        targetBaseId: normId(requirement),
        state: 'active',
        // ⚠️ NO `leadStatus`, AND NO `project`. Both used to be written here.
        // See `traceLinkMetadata.ts`: this blob is readable by every account in
        // the workspace, so the lead's status and the target project were on
        // offer to people with access to neither.
        metadata: traceLinkMetadata({
          command: CONVERT_LEAD_TO_REQUIREMENT,
          idempotencyKey: input.idempotencyKey
        })
      },
      linkId
    )
    assertCommitted(await apply.commit(), 'create trace link')
    link = await client.findOne<TraceLink>(traceability.class.TraceLink, { _id: linkId })
    if (link === undefined) {
      throw new Error(`Trace link '${linkId}' vanished immediately after being created`)
    }
  }

  // ── Step 3: the Lead status (compare-and-swap, not a blind write). ───────
  // 🔴 The `status` read at Step 0 is stale by the time we get here — the
  // Requirement and the edge were written in between. A bare `updateDoc` would
  // happily stamp `Converted` over a `Disqualified` a salesperson set meanwhile.
  // `match` turns the write into a real CAS: `ApplyTxMiddleware.verifyApplyIf`
  // re-reads the Lead and refuses the whole `TxApplyIf` if the status moved,
  // which `assertCommitted` then surfaces as a failure the replay can redo.
  if (lead.status !== CONVERTED) {
    const apply = applyStep(client, 'lead-status', `${CONVERT_LEAD_LOCK} ${lead._id}`)
    apply.match<Lead>(lead._class, { _id: lead._id, status: lead.status })
    await apply.updateDoc<Lead>(lead._class, lead.space, lead._id, { status: CONVERTED })
    assertCommitted(await apply.commit(), 'set lead status to Converted')
  }

  // ── Step 3b: freeze the converted Lead. ─────────────────────────────────
  // 🔴 THE ONLY PLACE THIS CAN BE DONE. The generic card panel decides
  // read-only-ness from `readonly || doc.readonly || doc.readonlyFields`
  // (`EditCardNew.svelte:161`, `CardAttributes.svelte:81`) and knows nothing
  // about a Lead's status, so `account` / `contact` / `owner` / `nextActionAt` /
  // title / content stay freely editable no matter what the CRM package locks in
  // its own two editors. The marker has to be written as data, and the
  // conversion command is the only writer that knows the lead just became
  // terminal.
  //
  // 🔴 `readonlyFields`, NOT `readonly`. `readonly` is `VersionableDoc.readonly`,
  // and `VersioningMiddleware.setVersionData` WRITES it to mean "this is a
  // superseded, non-latest revision"
  // (`foundations/server/packages/middleware/src/versioning.ts:134-138`).
  // Stamping it on the CURRENT revision would overload a field the platform
  // owns. `readonlyFields` is the purpose-built list, is written by nobody else,
  // and reaches the same places: listing `title` also flips the panel-wide
  // `_readonly`, which cascades to the content editor and the tag editor.
  //
  // ⚠️ ONLY `Converted`. `Disqualified` deliberately stays editable —
  // `server-plugins/crm-lite/src/leadGuard.ts` explicitly permits editing the
  // disqualification reason, and freezing the form would contradict the server.
  //
  // Reentrant: the list is compared before it is written, so a replay of an
  // already-frozen lead writes nothing.
  await ensureLeadFrozen(client, lead._id, lead._class, lead.space)

  // ── Step 4 / 5: Activity on BOTH endpoints (query, then write). ──────────
  // 🔴 `DOMAIN_RELATION` is excluded from Activity, so creating the edge above
  // produced NO history entry on either card. Without these two records the
  // conversion is invisible in both the Lead's and the Requirement's timeline.
  const leadActivityId = commandObjectId<DocUpdateMessage>(CONVERT_LEAD_LOCK, input.lead, convertLeadRoles.leadActivity)
  await ensureTraceActivity(client, leadActivityId, lead._id, lead._class, lead.space, linkId)

  const requirementActivityId = commandObjectId<DocUpdateMessage>(
    CONVERT_LEAD_LOCK,
    input.lead,
    convertLeadRoles.requirementActivity
  )
  await ensureTraceActivity(
    client,
    requirementActivityId,
    requirement._id,
    requirement._class,
    requirement.space,
    linkId
  )

  ctx.info('agentra lead converted', {
    lead: lead._id,
    requirement: requirementId,
    traceLink: linkId,
    idempotencyKey: input.idempotencyKey
  })

  return {
    lead: lead._id,
    requirement: requirementId,
    traceLink: linkId,
    alreadyConverted: false
  }
}

/**
 * Open an apply block for one command step.
 *
 * 🔴 WHAT `assertCommitted` CAN AND CANNOT SEE — read this before adding a step.
 *
 * `ApplyOperations.commit()` has a fast path that skips `TxApplyIf` entirely
 * when the block holds exactly one transaction, no match clauses AND no measure
 * name; that path returns a hard-coded `{ result: true }` whatever the write
 * did. Every step here is a single transaction, so the measure name is what
 * forces the real `TxApplyIf` round trip. That much is necessary.
 *
 * ⚠️ It is NOT sufficient on its own. `ApplyTxMiddleware.tx` only calls
 * `verifyApplyIf` when `scope != null`; with a null scope it hard-codes
 * `passed: true` and the block can never come back `success: false`. So
 * `{ result: false }` is reachable ONLY for a step that supplies BOTH a `scope`
 * and a `match`/`notMatch` clause — the Lead status CAS below is the one that
 * does. For the create steps the arbiter is the primary key on
 * `("workspaceId", _id)`, which THROWS out of `provideTx` rather than returning
 * false; `assertCommitted` is kept on them as a cheap guard against that
 * contract changing, not as their real protection.
 *
 * A `scope` also serialises same-scope applies inside the process, which is why
 * the Lead CAS scopes on the lead id.
 */
function applyStep (client: TxOperations, step: string, scope?: string): ApplyOperations {
  return client.apply(scope, `${CONVERT_LEAD_TO_REQUIREMENT}:${step}`)
}

/**
 * The fields a converted Lead stops accepting edits on.
 *
 * 🔴 `title` IS NOT OPTIONAL IN THIS LIST even though the CRM package never
 * asked for it. `EditCardNew.svelte:161` derives the PANEL-WIDE `_readonly` from
 * `doc.readonlyFields?.includes('title')`, and that value is what disables the
 * content editor and the tag editor. Drop `title` and the body of the lead card
 * stays editable while every attribute row is locked — the half-frozen form the
 * coordinator flagged.
 *
 * The remaining entries are the Lead's own business attributes. Listing them
 * explicitly (rather than "everything") keeps collection-side activity, comments
 * and attachments working, which a converted lead still legitimately receives.
 *
 * @public
 */
export const CONVERTED_LEAD_READONLY_FIELDS = [
  'title',
  'account',
  'contact',
  'owner',
  'nextActionAt',
  'pipeline',
  'status',
  'priority',
  'source',
  'disqualifyReason'
]

/**
 * Stamp the read-only marker on a converted Lead, at most once.
 *
 * ⚠️ Compares before writing, so this participates in the command's reentrancy
 * exactly like every other step: a replay over an already-frozen lead issues no
 * transaction at all.
 */
async function ensureLeadFrozen (
  client: TxOperations,
  _id: Ref<Lead>,
  _class: Ref<any>,
  space: Ref<Space>
): Promise<void> {
  const current = await client.findOne<Lead>(_class, { _id })
  if (current === undefined) {
    return
  }
  const existing = current.readonlyFields ?? []
  const missing = CONVERTED_LEAD_READONLY_FIELDS.filter((field) => !existing.includes(field))
  if (missing.length === 0) {
    return
  }
  const apply = applyStep(client, 'lead-readonly')
  await apply.updateDoc<Lead>(_class, space, _id, {
    readonlyFields: [...existing, ...missing]
  })
  assertCommitted(await apply.commit(), 'freeze converted lead')
}

/**
 * One activity record announcing the trace edge on one endpoint.
 *
 * A `DocUpdateMessage` rather than an `ActivityInfoMessage`: the latter needs an
 * `IntlString`, which would mean adding a translation key to the client-side
 * assets package, whereas `action: 'create'` over `objectClass = TraceLink`
 * states the same fact using only ids and renders through the ordinary
 * create-message viewlet.
 */
async function ensureTraceActivity (
  client: TxOperations,
  _id: Ref<DocUpdateMessage>,
  attachedTo: Ref<Doc>,
  attachedToClass: Ref<any>,
  space: Ref<Space>,
  linkId: Ref<TraceLink>
): Promise<void> {
  const found = await client.findOne<DocUpdateMessage>(activity.class.DocUpdateMessage, { _id })
  if (found !== undefined) {
    return
  }
  const apply = applyStep(client, 'activity')
  await apply.addCollection<Doc, DocUpdateMessage>(
    activity.class.DocUpdateMessage,
    space,
    attachedTo,
    attachedToClass,
    'activity',
    {
      objectId: linkId,
      objectClass: traceability.class.TraceLink,
      action: 'create'
    },
    _id
  )
  assertCommitted(await apply.commit(), `create activity on ${attachedTo}`)
}
