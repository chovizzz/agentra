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

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { clearConfig, configPath, readConfig, resolveConfig, writeConfig } from '../config'
import { DEFAULT_URL, DEFAULT_WORKSPACE } from '../defaults'
import { parseLimit, requireOneOf } from '../commands/shared'

describe('config', () => {
  let home: string
  const saved = { ...process.env }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentra-cli-'))
    process.env.XDG_CONFIG_HOME = home
    delete process.env.AGENTRA_URL
    delete process.env.AGENTRA_WORKSPACE
    delete process.env.AGENTRA_TOKEN
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    process.env = { ...saved }
  })

  it('stores under XDG_CONFIG_HOME and reads back', () => {
    const path = writeConfig({ url: 'https://a', workspace: 'w', token: 't' })
    expect(path).toBe(join(home, 'agentra', 'config.json'))
    expect(configPath()).toBe(path)
    expect(readConfig()).toEqual({ url: 'https://a', workspace: 'w', token: 't' })
  })

  it('treats a missing config file as empty rather than as an error', () => {
    expect(readConfig()).toEqual({})
  })

  // The token is the one value that cannot be guessed, so it is the only one
  // whose absence is an error.
  it('asks only for a token when nothing is configured', () => {
    expect(() => resolveConfig()).toThrow(/Not signed in/)
  })

  it('falls back to the compiled-in url and workspace', () => {
    const c = resolveConfig({ token: 't' })
    expect(c.url).toBe(DEFAULT_URL)
    expect(c.workspace).toBe(DEFAULT_WORKSPACE)
  })

  // The defaults are a convenience and must never override what the operator
  // actually configured — otherwise a stored workspace would be silently ignored.
  it('prefers the stored config over the defaults', () => {
    writeConfig({ url: 'https://file', workspace: 'file-ws', token: 't' })
    const c = resolveConfig()
    expect(c.url).toBe('https://file')
    expect(c.workspace).toBe('file-ws')
  })

  // The precedence is what a CI job relies on to point one machine at another
  // workspace without rewriting a config file it does not own.
  it('lets the environment beat the stored file', () => {
    writeConfig({ url: 'https://file', workspace: 'file-ws', token: 'file-token' })
    process.env.AGENTRA_URL = 'https://env'
    expect(resolveConfig().url).toBe('https://env')
    expect(resolveConfig().workspace).toBe('file-ws')
  })

  it('lets a flag beat the environment', () => {
    writeConfig({ url: 'https://file', workspace: 'w', token: 't' })
    process.env.AGENTRA_URL = 'https://env'
    expect(resolveConfig({ url: 'https://flag' }).url).toBe('https://flag')
  })

  // A blank line in a .env file sets the variable to '' — treating that as a value
  // turns "not configured" into a connection error much further downstream.
  it('treats a whitespace-only environment variable as unset', () => {
    writeConfig({ url: 'https://file', workspace: 'w', token: 't' })
    process.env.AGENTRA_URL = '   '
    expect(resolveConfig().url).toBe('https://file')
  })

  it('clears the stored config and reports whether there was one', () => {
    expect(clearConfig()).toBe(false)
    writeConfig({ url: 'https://a', workspace: 'w', token: 't' })
    expect(clearConfig()).toBe(true)
    expect(readConfig()).toEqual({})
  })
})

describe('argument guards', () => {
  it('accepts limits inside the server-supported range', () => {
    expect(parseLimit('1')).toBe(1)
    expect(parseLimit('200')).toBe(200)
  })

  it.each(['0', '201', 'abc', ''])('rejects %p before any connection is opened', (raw) => {
    expect(() => parseLimit(raw)).toThrow(/between 1 and 200/)
  })

  // Silently succeeding on an empty update makes a typo'd flag name look like a
  // successful edit: the command exits 0 and the field is untouched.
  it('rejects an update that would change nothing', () => {
    expect(() => {
      requireOneOf({ title: undefined }, ['title'])
    }).toThrow(/Nothing to update/)
  })

  it('accepts an update with at least one field', () => {
    expect(() => {
      requireOneOf({ title: 'x', status: undefined }, ['title', 'status'])
    }).not.toThrow()
  })
})
