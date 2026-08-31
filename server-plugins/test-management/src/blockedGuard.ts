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

import core, {
  TxProcessor,
  type Class,
  type Doc,
  type MeasureContext,
  type Ref,
  type Tx,
  type TxApplyIf,
  type TxCreateDoc,
  type TxCUD,
  type TxUpdateDoc
} from '@hcengineering/core'
import {
  BaseMiddleware,
  type Middleware,
  type MiddlewareCreator,
  type PipelineContext,
  type TxMiddlewareResult
} from '@hcengineering/server-core'
import testManagement, { TestRunStatus, type TestResult } from '@hcengineering/test-management'

/**
 * @public
 */
export type BlockedGuardReason = 'blocked-requires-reason' | 'opaque-operation'

/**
 * @public
 */
export class BlockedGuardError extends Error {
  readonly code = 400

  constructor (
    readonly reason: BlockedGuardReason,
    message: string,
    readonly txClass?: string
  ) {
    super(message)
    this.name = 'BlockedGuardError'
  }
}

/**
 * How one field is being written, so an operator write is never mistaken for a
 * plain value.
 *
 * 🔴 `$unset`, `$push` and friends CANNOT be evaluated as "the value after this
 * write". Treating an operator write as `undefined` would let
 * `{ $unset: { blockedReason: '' } }` strip the justification off a blocked
 * result, which is exactly the record this guard exists to forbid — reached by
 * a second write instead of the first.
 */
type FieldWrite =
  | { kind: 'untouched' }
  | { kind: 'plain', value: unknown }
  | { kind: 'unset' }
  | { kind: 'opaque', operator: string }

function readFieldWrite (ops: Record<string, any>, field: string): FieldWrite {
  if (Object.prototype.hasOwnProperty.call(ops, field)) {
    return { kind: 'plain', value: ops[field] }
  }
  for (const [key, value] of Object.entries(ops)) {
    if (!key.startsWith('$') || value == null || typeof value !== 'object') continue
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue
    if (key === '$unset') return { kind: 'unset' }
    return { kind: 'opaque', operator: key }
  }
  return { kind: 'untouched' }
}

function hasReason (value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Server-side enforcement of "a Blocked result must say why".
 *
 * 🔴 WHY A MIDDLEWARE AND NOT A TRIGGER. `TriggersMiddleware.processDerived`
 * runs AFTER the write has landed and swallows trigger exceptions, so a trigger
 * can comment on a transaction but never refuse one. `SnapshotGuardMiddleware`
 * next door is the in-tree precedent.
 *
 * 🔴 WHY SERVER SIDE AT ALL. The client can prompt for the reason, but the
 * status is also set by the automation import, by `client.update` from a script
 * and by any future viewlet. A blocked result with no reason is
 * indistinguishable from an untested one to a release gate, so the pipeline —
 * the only choke point all writers share — is where the rule belongs.
 *
 * @public
 */
export class BlockedReasonGuardMiddleware extends BaseMiddleware implements Middleware {
  private constructor (context: PipelineContext, next?: Middleware) {
    super(context, next)
  }

  static create: MiddlewareCreator = async (_ctx, context, next): Promise<Middleware> => {
    return new BlockedReasonGuardMiddleware(context, next)
  }

  async tx (ctx: MeasureContext, txes: Tx[]): Promise<TxMiddlewareResult> {
    await this.validate(ctx, txes)
    return await this.provideTx(ctx, txes)
  }

  private async validate (ctx: MeasureContext, txes: Tx[], depth: number = 0): Promise<void> {
    if (depth > 8) {
      throw new Error('test-management: refusing to validate a pathologically nested TxApplyIf')
    }
    for (const tx of txes) {
      if (this.context.hierarchy.isDerived(tx._class, core.class.TxApplyIf)) {
        await this.validate(ctx, (tx as TxApplyIf).txes, depth + 1)
        continue
      }
      if (!TxProcessor.isExtendsCUD(tx._class)) continue
      const cud = tx as TxCUD<Doc>
      if (!this.isTestResultClass(cud.objectClass)) continue
      if (cud._class === core.class.TxCreateDoc) {
        this.validateCreate(cud as TxCreateDoc<TestResult>)
      } else if (cud._class === core.class.TxUpdateDoc) {
        await this.validateUpdate(ctx, cud as TxUpdateDoc<TestResult>)
      }
    }
  }

  private validateCreate (tx: TxCreateDoc<TestResult>): void {
    const attributes = tx.attributes as Partial<TestResult>
    if (attributes?.status !== TestRunStatus.Blocked) return
    if (!hasReason(attributes?.blockedReason)) {
      throw new BlockedGuardError(
        'blocked-requires-reason',
        'A blocked test result must carry a non-empty blockedReason',
        tx._class
      )
    }
  }

  private async validateUpdate (ctx: MeasureContext, tx: TxUpdateDoc<TestResult>): Promise<void> {
    const ops = tx.operations as Record<string, any>
    const statusWrite = readFieldWrite(ops, 'status')
    const reasonWrite = readFieldWrite(ops, 'blockedReason')
    if (statusWrite.kind === 'untouched' && reasonWrite.kind === 'untouched') return

    // An operator reaching either field cannot be evaluated, and nothing
    // legitimate does it.
    if (statusWrite.kind === 'opaque') {
      throw new BlockedGuardError(
        'opaque-operation',
        `'${statusWrite.operator}' may not be used on a test result status`,
        tx._class
      )
    }
    if (reasonWrite.kind === 'opaque') {
      throw new BlockedGuardError(
        'opaque-operation',
        `'${reasonWrite.operator}' may not be used on a blocked reason`,
        tx._class
      )
    }

    const current = (
      await this.provideFindAll<TestResult>(
        ctx,
        tx.objectClass,
        { _id: tx.objectId },
        {
          limit: 1
        }
      )
    )[0]
    if (current === undefined) {
      // Nothing to protect: an update addressed at an absent `_id` writes no
      // row, and refusing here would be a false negative for the legitimate
      // create-then-update batch whose create has not been applied yet.
      return
    }

    const statusAfter = statusWrite.kind === 'plain' ? (statusWrite.value as TestRunStatus) : current.status
    const reasonAfter =
      reasonWrite.kind === 'unset'
        ? undefined
        : reasonWrite.kind === 'plain'
          ? reasonWrite.value
          : current.blockedReason

    if (statusAfter === TestRunStatus.Blocked && !hasReason(reasonAfter)) {
      throw new BlockedGuardError(
        'blocked-requires-reason',
        `Test result '${tx.objectId}' cannot be Blocked without a non-empty blockedReason`,
        tx._class
      )
    }
  }

  /**
   * ⚠️ `hasClass` FIRST. An unknown classifier makes `isDerived` walk an empty
   * ancestor chain and return `false` silently, so a stale or forged
   * `objectClass` would slip past the guard rather than being rejected.
   */
  private isTestResultClass (_class: Ref<Class<Doc>>): boolean {
    const hierarchy = this.context.hierarchy
    if (_class === undefined || !hierarchy.hasClass(_class)) {
      return false
    }
    return hierarchy.isDerived(_class, testManagement.class.TestResult as Ref<Class<Doc>>)
  }
}
