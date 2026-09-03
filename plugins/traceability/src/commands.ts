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

import type { Client, Doc, Ref } from '@hcengineering/core'

//
// 🔴 THE CALL SHAPES OF THE `implements` COMMANDS, DECLARED IN THE LEAF
// DESCRIPTOR PACKAGE.
//
// The implementations stay in `@hcengineering/traceability-resources` — this
// package must never import a resources package. Only the TYPES live here, and
// they live here for one reason: `traceability.function.*` below is typed
// `Resource<...>`, so any package that wants to call the command through
// `getResource()` needs the signature WITHOUT taking a build-time dependency on
// the implementation. A caller that had to import the types from
// `traceability-resources` would be back to the dependency the `Resource`
// indirection exists to avoid.
//
// ⚠️ The wire constants (`AGENTRA_OP_*`, `LINK_IMPLEMENTS_KEY_PREFIX`, …) are
// deliberately NOT moved here. They are persisted contract, they have exactly
// one consumer (the command implementation), and moving a string whose value is
// part of the ledger row id buys nothing and risks everything.
//

/**
 * What the UI renders after a command call.
 *
 * `unavailable` is kept apart from `errored`: the first means this deployment
 * has no Agentra command middleware on its pipeline (the domain request falls
 * through to `value: null`), the second means the command ran and refused. A UI
 * that conflated them would tell the user to fix their input when the server
 * simply cannot answer.
 *
 * @public
 */
export type CommandOutcomeView<T> =
  | { kind: 'ok', result: T, replayed: boolean }
  | { kind: 'refused', reason: string, message: string, retryable: boolean }
  | { kind: 'unavailable' }
  | { kind: 'errored', message: string }

/**
 * ⚠️ The field ORDER is the edge direction `WorkItem --implements--> Requirement`.
 * There is no "near end" in a pair; both entry points pass the same two roles.
 *
 * @public
 */
export interface ImplementsPair {
  workItem: Ref<Doc>
  requirement: Ref<Doc>
}

/**
 * @public
 */
export interface LinkImplementsResult {
  workItem: Ref<Doc>
  requirement: Ref<Doc>
  traceLink: Ref<Doc>
  alreadyLinked: boolean
}

/**
 * @public
 */
export interface LinkImplementsBatch {
  linked: number
  /** Pairs that were already asserted — a success, not a failure. */
  alreadyLinked: number
  failures: Array<{ pair: ImplementsPair, outcome: CommandOutcomeView<LinkImplementsResult> }>
}

/**
 * @public
 */
export interface UnlinkImplementsResult {
  workItem: Ref<Doc>
  requirement: Ref<Doc>
  traceLink: Ref<Doc>
  /**
   * `true` when the assertion had ALREADY been withdrawn when this attempt
   * looked. A success, not a failure — and NOT the same as
   * `CommandOutcomeView.replayed`, which is about this caller's own key.
   */
  alreadyRevoked: boolean
}

/**
 * @public
 */
export interface UnlinkImplementsBatch {
  revoked: number
  /** Pairs that were already withdrawn — a success, not a failure. */
  alreadyRevoked: number
  failures: Array<{ pair: ImplementsPair, outcome: CommandOutcomeView<UnlinkImplementsResult> }>
}

/**
 * Signature of `traceability:function:LinkImplements`.
 *
 * ⚠️ The argument ORDER is (work item, requirement), matching the edge
 * direction. The idempotency key is derived from the pair in that order, so a
 * caller that passes the "near" end first lands on a DIFFERENT ledger row than
 * the other entry point and the two directions stop converging.
 *
 * @public
 */
export type LinkImplementsFn = (
  client: Client,
  workItem: Ref<Doc>,
  requirement: Ref<Doc>
) => Promise<CommandOutcomeView<LinkImplementsResult>>

/**
 * Signature of `traceability:function:LinkImplementsPairs`.
 *
 * @public
 */
export type LinkImplementsPairsFn = (client: Client, pairs: readonly ImplementsPair[]) => Promise<LinkImplementsBatch>

/**
 * Signature of `traceability:function:UnlinkImplements`.
 *
 * ⚠️ WITHDRAWING RELEASES THE DELETE PROTECTION on both endpoints: the server's
 * archivable guard refuses to physically delete an object that still carries a
 * NON-revoked edge, so withdrawing the last one makes both ends deletable
 * again. Any caller resolving this resource owes the user that sentence before
 * it runs.
 *
 * @public
 */
export type UnlinkImplementsFn = (
  client: Client,
  workItem: Ref<Doc>,
  requirement: Ref<Doc>
) => Promise<CommandOutcomeView<UnlinkImplementsResult>>
