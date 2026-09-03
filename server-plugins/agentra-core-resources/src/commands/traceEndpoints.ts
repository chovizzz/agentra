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

import type { Class, Doc, Ref } from '@hcengineering/core'
import crmLite from '@hcengineering/crm-lite'
import products from '@hcengineering/products'
import requirements from '@hcengineering/requirements'
import testManagement from '@hcengineering/test-management'
import tracker from '@hcengineering/tracker'
import {
  registerTraceEndpoint,
  registerTraceEndpointRoles,
  type TraceEndpointRegistry
} from '@hcengineering/traceability'

/**
 * The process-local map from a concrete class to its trace role.
 *
 * 🔴 WHY IT LIVES IN A SERVER `-resources` PACKAGE AND NOT IN A MODEL PACKAGE.
 * `registerTraceEndpoint` mutates an in-memory `Map`, and `validateTraceLink`
 * reads that same `Map`. The two therefore have to run in the SAME process. A
 * `models/*` package runs at model-BUILD time — `dev/tool` turns it into a
 * stream of model transactions that the transactor later loads from the
 * database — so a registration performed there would populate a `Map` in the
 * builder process and leave the transactor's copy empty. `validateTraceLink`
 * fails closed on an unknown class (`unknown-source-class`), so the symptom
 * would not be a missing check but a command that refuses every conversion at
 * runtime while every model-side unit test passes.
 *
 * ⚠️ It is deliberately populated EAGERLY at module load rather than from a
 * plugin `addLocation` callback: `@hcengineering/server-agentra-core-resources`
 * is the package the command lives in, so by the time any command body can run,
 * this module has been evaluated. Lazy registration would reintroduce exactly
 * the fail-closed ordering hazard above.
 *
 * ℹ️ When a
 * workspace-wide registry eventually appears in `server-traceability-resources`,
 * this map becomes its seed and every command keeps taking the registry as a
 * parameter, which is why {@link convertLeadToRequirement} accepts an override.
 *
 * @public
 */
export const agentraTraceEndpoints: TraceEndpointRegistry = new Map()

registerTraceEndpoint(agentraTraceEndpoints, crmLite.masterTag.Lead, 'Lead')
registerTraceEndpoint(agentraTraceEndpoints, requirements.masterTag.Requirement, 'Requirement')
registerTraceEndpoint(agentraTraceEndpoints, testManagement.class.TestCase, 'TestCase')
registerTraceEndpoint(agentraTraceEndpoints, testManagement.class.TestResult, 'TestResult')

// The `delivered-in` row of `traceLinkMatrix` is the only one that targets a
// ProductVersion, and the release gate reads those edges to find the work items
// and defects in scope. Without this registration `validateTraceLink` fails
// closed with `unknown-target-class` and no delivery edge can ever be made.
registerTraceEndpoint(agentraTraceEndpoints, products.class.ProductVersion, 'ProductVersion')

// 🔴 ONE CLASS, TWO ROLES. Technical Spec §3.4 forbids a parallel Issue class,
// so a Bug and a Work Item are both `tracker.class.Issue` — they differ by
// TaskType, which is data, not a classifier the registry can key on. Picking
// either role alone would make the other kind's edges fail closed with
// `unknown-source-class`; see `TraceEndpointRegistry` for why that failure is
// invisible in tests that register only their own role.
registerTraceEndpointRoles(agentraTraceEndpoints, tracker.class.Issue, ['Bug', 'WorkItem'])

/**
 * The GitHub pull request class, as a LITERAL id.
 *
 * 🔴 A LITERAL, NOT AN IMPORT, AND THAT IS THE POINT. The class is declared in
 * `services/github/github` (`githubId = 'github'`, `class.GithubPullRequest`),
 * and `plugin()` mints every id as `<plugin>:<kind>:<key>` — so this string is
 * exactly what `github.class.GithubPullRequest` evaluates to. Importing it would
 * add `@hcengineering/github` to this package's dependencies for a 30-character
 * constant, and would drag the whole GitHub integration into the dependency
 * graph of the command layer.
 *
 * ⚠️ THE SPELLING IS THE CONTRACT, and nothing type-checks it. A typo here does
 * not fail to compile; it makes `validateTraceLink` answer
 * `unknown-target-class` and every `fixed-by` edge silently refuse to be
 * created. `plugins/traceability` has no matching declaration to check against
 * either, which is why the derivation is written out above rather than assumed.
 *
 * ⚠️ NOT `tracker.class.Issue`, even though `GithubPullRequest extends Issue`.
 * The registry is an exact-class `Map`, not a hierarchy walk, so the pull
 * request class and the issue class occupy separate entries and a plain Issue
 * can never satisfy the `PullRequest` role.
 *
 * @public
 */
export const GITHUB_PULL_REQUEST_CLASS = 'github:class:GithubPullRequest' as Ref<Class<Doc>>

// The `fixed-by` row of `traceLinkMatrix` is the only one that targets a
// PullRequest. Without this registration `validateTraceLink` fails closed with
// `unknown-target-class` and no fix edge can ever be made.
registerTraceEndpoint(agentraTraceEndpoints, GITHUB_PULL_REQUEST_CLASS, 'PullRequest')
