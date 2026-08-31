//
// Copyright © 2025 Hardcore Engineering Inc.
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
 * Regression test for ApplyTxMiddleware
 *
 * A batch that mixes plain transactions with a TxApplyIf used to drop every plain
 * transaction queued before the first TxApplyIf: the pending buffer was cleared
 * before being forwarded, so the next middleware received an empty array and the
 * caller still saw a successful result.
 */

import core, {
  type Class,
  ClassifierKind,
  type Doc,
  generateId,
  Hierarchy,
  MeasureMetricsContext,
  type MeasureContext,
  ModelDb,
  type Ref,
  type Space,
  type Tx,
  type TxCUD,
  TxFactory
} from '@hcengineering/core'
import type { PipelineContext, TxMiddlewareResult } from '@hcengineering/server-core'
import { ApplyTxMiddleware } from '../applyTx'

interface TestDoc extends Doc {
  name: string
}

const testDocClass = 'test:class:TestDoc' as Ref<Class<TestDoc>>
const testSpace = 'test:space' as Ref<Space>

function registerClass (hierarchy: Hierarchy, _id: Ref<Class<Doc>>, ext?: Ref<Class<Doc>>): void {
  hierarchy.tx({
    _id: generateId(),
    _class: core.class.TxCreateDoc,
    space: core.space.Tx,
    objectId: _id,
    objectClass: core.class.Class,
    objectSpace: core.space.Model,
    modifiedOn: 0,
    modifiedBy: core.account.System,
    attributes: { kind: ClassifierKind.CLASS, extends: ext, label: '' as any }
  } as any)
}

describe('ApplyTxMiddleware', () => {
  let ctx: MeasureContext
  let middleware: ApplyTxMiddleware
  let forwarded: Tx[]
  let txFactory: TxFactory

  beforeEach(async () => {
    ctx = new MeasureMetricsContext('test', {})
    forwarded = []

    const hierarchy = new Hierarchy()
    // The middleware dispatches on hierarchy.isDerived, so the tx classifiers it
    // discriminates on must exist in the hierarchy.
    registerClass(hierarchy, core.class.Tx)
    registerClass(hierarchy, core.class.TxCUD, core.class.Tx)
    registerClass(hierarchy, core.class.TxCreateDoc, core.class.TxCUD)
    registerClass(hierarchy, core.class.TxApplyIf, core.class.Tx)

    const pipelineContext: PipelineContext = {
      workspace: { uuid: 'test-workspace' as any, url: 'test', dataId: 'test' as any },
      hierarchy,
      modelDb: new ModelDb(hierarchy),
      branding: null as any,
      adapterManager: {} as any,
      storageAdapter: {} as any,
      contextVars: {},
      lastTx: '',
      lastHash: '',
      broadcastEvent: async () => {}
    }

    const nextMiddleware = {
      tx: async (_ctx: MeasureContext, txes: Tx[]): Promise<TxMiddlewareResult> => {
        forwarded.push(...txes)
        return {}
      },
      handleBroadcast: async (): Promise<void> => {}
    }

    middleware = (await ApplyTxMiddleware.create(ctx, pipelineContext, nextMiddleware as any)) as ApplyTxMiddleware
    txFactory = new TxFactory(core.account.System)
  })

  function createDocTx (name: string): TxCUD<Doc> {
    return txFactory.createTxCreateDoc<TestDoc>(testDocClass, testSpace, { name }, generateId())
  }

  function applyIfTx (inner: TxCUD<Doc>[]): Tx {
    return txFactory.createTxApplyIf(testSpace, undefined, [], [], inner, undefined)
  }

  it('should forward plain txes queued before a TxApplyIf', async () => {
    const before = createDocTx('before')
    const inner = createDocTx('inner')

    await middleware.tx(ctx, [before, applyIfTx([inner])])

    const names = forwarded.map((tx: any) => tx.attributes?.name)
    expect(names).toContain('before')
    expect(names).toContain('inner')
  })

  it('should preserve order across several plain/apply segments', async () => {
    const txes = [
      createDocTx('a'),
      createDocTx('b'),
      applyIfTx([createDocTx('c')]),
      createDocTx('d'),
      applyIfTx([createDocTx('e')]),
      createDocTx('f')
    ]

    await middleware.tx(ctx, txes)

    expect(forwarded.map((tx: any) => tx.attributes?.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('should forward a batch containing no TxApplyIf unchanged', async () => {
    await middleware.tx(ctx, [createDocTx('x'), createDocTx('y')])

    expect(forwarded.map((tx: any) => tx.attributes?.name)).toEqual(['x', 'y'])
  })
})
