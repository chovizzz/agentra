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

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { Command } from 'commander'

import { emit, type OutputOptions } from '../output'

/**
 * The skills ship inside the package so `npm i -g @agentra-cli/cli` carries them.
 *
 * How far `skills/` sits above this file depends on how the code was built: the
 * published artifact is one esbuild bundle at `bundle/bundle.js` (one level), while
 * `rushx build` emits `lib/commands/skills.js` (two) and ts-node runs it straight
 * from `src/commands/` (also two). Walking up until the directory turns up is what
 * keeps all three working — a hard-coded depth is right for exactly one of them.
 */
function bundledSkillsDir (): string {
  const tried: string[] = []
  let current = __dirname
  for (let up = 0; up < 4; up++) {
    const candidate = resolve(current, 'skills')
    tried.push(candidate)
    if (existsSync(candidate)) return candidate
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  throw new Error(`Bundled skills not found. Looked in:\n  ${tried.join('\n  ')}\nThis looks like a broken install.`)
}

interface SkillInfo {
  name: string
  description: string
}

function readSkill (dir: string, name: string): SkillInfo {
  const text = readFileSync(join(dir, name, 'SKILL.md'), 'utf8')
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? ''
  // A one-line summary is enough here; parsing the whole YAML would pull in a
  // dependency for a listing that only ever shows two fields.
  const description = /description:\s*>-?\n([\s\S]*?)(?=\n\w|$)/
    .exec(frontmatter)?.[1]
    ?.split('\n')
    .map((l) => l.trim())
    .join(' ')
    .trim()
  return { name, description: description ?? '' }
}

function listBundled (): SkillInfo[] {
  const dir = bundledSkillsDir()
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md')))
    .map((e) => readSkill(dir, e.name))
}

export function skillsCommand (): Command {
  const skills = new Command('skills').description('The agent skills that document this CLI')

  skills
    .command('list')
    .description('Show the skills bundled with this CLI')
    .option('--json', 'Machine-readable output')
    .action((opts: OutputOptions) => {
      emit(listBundled(), opts, ['name', 'description'])
    })

  skills
    .command('install')
    .description('Copy the skills into an agent’s skills directory')
    .option('-d, --dir <path>', 'Target directory (default: ~/.claude/skills)')
    .option('--project', 'Install into ./.claude/skills instead, for this repo only')
    .action((opts: { dir?: string, project?: boolean }) => {
      const target =
        opts.dir ??
        (opts.project === true ? join(process.cwd(), '.claude', 'skills') : join(homedir(), '.claude', 'skills'))
      mkdirSync(target, { recursive: true })

      const source = bundledSkillsDir()
      const installed: string[] = []
      for (const skill of listBundled()) {
        // Overwrite: an install is how you take an upgrade, and a stale SKILL.md
        // describing commands that no longer exist is worse than no skill at all.
        cpSync(join(source, skill.name), join(target, skill.name), { recursive: true })
        installed.push(skill.name)
      }
      process.stdout.write(`Installed ${installed.length} skills into ${target}:\n`)
      for (const name of installed) process.stdout.write(`  ${name}\n`)
    })

  return skills
}
