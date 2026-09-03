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
 * Two output modes, because the CLI has two audiences.
 *
 * A person reads the table; an agent parses `--json`. The table is deliberately
 * lossy (it truncates), so anything programmatic must ask for JSON rather than
 * scrape columns.
 */
export interface OutputOptions {
  json?: boolean
}

export function emit (value: unknown, options: OutputOptions, columns?: string[]): void {
  if (options.json === true) {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n')
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      process.stdout.write('(none)\n')
      return
    }
    process.stdout.write(renderTable(value as Array<Record<string, unknown>>, columns) + '\n')
    return
  }
  process.stdout.write(renderRecord(value as Record<string, unknown>) + '\n')
}

function cell (value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function truncate (text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

function renderTable (rows: Array<Record<string, unknown>>, columns?: string[]): string {
  const keys = columns ?? Object.keys(rows[0])
  const cells = rows.map((row) => keys.map((k) => truncate(cell(row[k]).replace(/\s+/g, ' '), 60)))
  const widths = keys.map((k, i) => Math.max(k.length, ...cells.map((r) => r[i].length)))
  const line = (parts: string[]): string =>
    parts
      .map((p, i) => p.padEnd(widths[i]))
      .join('  ')
      .trimEnd()
  return [line(keys), line(widths.map((w) => '─'.repeat(w))), ...cells.map(line)].join('\n')
}

function renderRecord (record: Record<string, unknown>): string {
  const keys = Object.keys(record)
  const width = Math.max(...keys.map((k) => k.length))
  return keys
    .map((k) => {
      const raw = record[k]
      const text = typeof raw === 'string' ? raw : cell(raw)
      // Multi-line values (a markdown description, mostly) get their own block so
      // the aligned key column does not shred them.
      if (text.includes('\n')) return `${k.padEnd(width)}  |\n${text.replace(/^/gm, '  ')}`
      return `${k.padEnd(width)}  ${text}`
    })
    .join('\n')
}
