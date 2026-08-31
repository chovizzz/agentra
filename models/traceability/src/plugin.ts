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

import { mergeIds } from '@hcengineering/platform'
import traceability, { traceabilityId } from '@hcengineering/traceability'

// No UI resources package yet (this delivery is model + server skeleton only),
// so the model namespace merges straight off the descriptor. When
// `plugins/traceability-resources` lands, this should merge off its `src/plugin`
// the way `models/agentra-core` does.
export default mergeIds(traceabilityId, traceability, {})
