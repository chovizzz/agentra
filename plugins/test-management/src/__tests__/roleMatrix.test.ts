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

import testManagement from '../plugin'

describe('QA-T019 role matrix ids', () => {
  /**
   * ⚠️ THE LITERAL, NOT "is defined". `plugin()` fills every descriptor key in
   * at import time, so an id that no `createDoc` ever used — or one whose
   * plugin prefix is wrong — is still a truthy `Ref`. Only the exact string
   * catches it, and the exact string is what `models/test-management` and
   * `server-plugins/test-management` must agree on: the model creates the
   * `Permission` under this `_id`, the middleware looks it up by the same one,
   * and a mismatch would silently mean "nobody holds it", i.e. a matrix that
   * refuses everyone including QA.
   */
  it('pins the ManageTestAssets permission id', () => {
    expect(testManagement.permission.ManageTestAssets).toBe('testManagement:permission:ManageTestAssets')
  })

  it('pins the permission label ids', () => {
    expect(testManagement.string.ManageTestAssetsPermission).toBe('testManagement:string:ManageTestAssetsPermission')
    expect(testManagement.string.ManageTestAssetsDescription).toBe('testManagement:string:ManageTestAssetsDescription')
  })
})
