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

/**
 * Where the CLI points when nothing else says otherwise.
 *
 * Compiled in so `agentra auth login` needs only a token — the flag, the
 * environment and the stored config all still win over these, so pointing the
 * CLI at another deployment stays a one-flag change and never requires a
 * rebuild.
 *
 * These are the last resort in the precedence chain, not a hardcoded target:
 * see `resolveConfig`.
 */
export const DEFAULT_URL = 'https://agentra.49.51.37.69.sslip.io'
export const DEFAULT_WORKSPACE = 'agentra-main'
