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

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

import { TRACE_LINK_METADATA_PROVENANCE, traceLinkMetadata, type TraceLinkMetadataInput } from '../traceLinkMetadata'

const SRC = join(__dirname, '..')

/** Pass-throughs of an already-typed `TraceLinkMetadataInput`. */
const FORWARDS = new Set(['metadata', 'input.metadata'])

function sources (): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') {
          walk(path)
        }
      } else if (entry.name.endsWith('.ts') && entry.name !== 'traceLinkMetadata.ts') {
        out.push(path)
      }
    }
  }
  walk(SRC)
  return out
}

describe('trace link metadata', () => {
  it('drops undefined values instead of persisting the string "undefined"', () => {
    expect(traceLinkMetadata({ command: 'Cmd', idempotencyKey: undefined })).toEqual({ command: 'Cmd' })
  })

  it('keeps the keys it is given', () => {
    expect(traceLinkMetadata({ command: 'Cmd', inheritedFrom: 'edge-1' })).toEqual({
      command: 'Cmd',
      inheritedFrom: 'edge-1'
    })
  })

  it('throws on a key with no provenance classification', () => {
    // The runtime companion to the compile-time check: this is what a
    // JavaScript caller, an `as any`, or a spread of a widened
    // `Record<string, string>` hits.
    const smuggled = { command: 'Cmd', leadStatus: 'Qualifying' } as unknown as TraceLinkMetadataInput
    expect(() => traceLinkMetadata(smuggled)).toThrow(/no provenance classification/)
  })

  it('throws on a key classified endpoint-derived', () => {
    const table = TRACE_LINK_METADATA_PROVENANCE as unknown as Record<string, string>
    const restore = table.command
    table.command = 'endpoint-derived'
    try {
      expect(() => traceLinkMetadata({ command: 'Cmd' })).toThrow(/endpoint-derived/)
    } finally {
      table.command = restore
    }
  })

  it('classifies every key it admits', () => {
    // `satisfies Record<TraceLinkMetadataKey, ...>` already fails the build on a
    // missing entry; this catches the same mistake if the union is ever widened
    // to `string`, which would silently disarm the compile-time half.
    for (const [key, provenance] of Object.entries(TRACE_LINK_METADATA_PROVENANCE)) {
      expect(['command-identity', 'edge-identity', 'endpoint-derived']).toContain(provenance)
      expect(key).not.toEqual('')
    }
  })

  // 🔴 THE HALF THE TYPE SYSTEM CANNOT DO. `TraceLink.metadata` is
  // `Record<string, string>` on the document type, and narrowing it there would
  // break `server-traceability-resources`, which this package does not own. So
  // a bare object literal handed straight to `createDoc` type-checks fine. This
  // scan is what makes the builder mandatory inside this package.
  it('routes every metadata write through traceLinkMetadata', () => {
    const offenders: string[] = []
    for (const file of sources()) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line: string, index: number) => {
        const match = /^\s*metadata\??\s*:\s*(.*)$/.exec(line)
        if (match === null) {
          return
        }
        const rhs = match[1].trim()
        const ok =
          // Built here.
          rhs.startsWith('traceLinkMetadata(') ||
          // A declaration, not a write: `metadata?: TraceLinkMetadataInput`.
          rhs.startsWith('TraceLinkMetadataInput') ||
          // ⚠️ A FORWARD of a value the compiler has already typed
          // `TraceLinkMetadataInput` — `reconcileFixedBy` handing its own input
          // down to `linkFixedBy`. Allowed because tsc covers it, and because
          // the thing this scan exists to stop is an object LITERAL going
          // straight into `createDoc`. Residual gap: a forward of a variable
          // that is typed `Record<string, string>` rather than
          // `TraceLinkMetadataInput` would also pass here, and would then be
          // caught only by the builder's runtime check — if it reaches one.
          FORWARDS.has(rhs)
        if (!ok) {
          offenders.push(`${file}:${index + 1}: ${rhs}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('names only classified keys at the call sites', () => {
    const admitted = new Set(Object.keys(TRACE_LINK_METADATA_PROVENANCE))
    const offenders: string[] = []
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8')
      for (const call of text.matchAll(/traceLinkMetadata\(\{([\s\S]*?)\}\)/g)) {
        for (const key of call[1].matchAll(/(?:^|[\s,{])([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
          if (!admitted.has(key[1])) {
            offenders.push(`${file}: ${key[1]}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  // Regression pins for the three keys that were actually leaking. They are
  // named as strings on purpose: once removed from the union, referencing them
  // any other way would not compile, and the point is to notice a REVIVAL.
  it('never writes an endpoint status, project or class-shape onto an edge', () => {
    const banned = ['leadStatus', 'requirementStatus', 'targetKind']
    const offenders: string[] = []
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8')
      for (const call of text.matchAll(/traceLinkMetadata\(\{([\s\S]*?)\}\)/g)) {
        for (const key of banned) {
          if (new RegExp(`(?:^|[\\s,{])${key}\\s*:`).test(call[1])) {
            offenders.push(`${file}: ${key}`)
          }
        }
      }
      // `project` never appears as a metadata key again either — checked on the
      // whole call because it is a legitimate identifier elsewhere in the file.
      for (const call of text.matchAll(/traceLinkMetadata\(\{([\s\S]*?)\}\)/g)) {
        if (/(?:^|[\s,{])project\s*:/.test(call[1])) {
          offenders.push(`${file}: project`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
