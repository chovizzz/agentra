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

import { Command } from 'commander'

import { authCommand } from './commands/auth'
import { issueCommand, projectCommand } from './commands/issue'
import { skillsCommand } from './commands/skills'
import { caseCommand, testProjectCommand } from './commands/testcase'

const VERSION = '0.1.1'

function buildProgram (): Command {
  return new Command('agentra')
    .description('Read and write Agentra issues and test cases from a terminal or an agent')
    .version(VERSION)
    .option('--url <url>', 'Override the configured Agentra front URL')
    .option('--workspace <slug>', 'Override the configured workspace slug')
    .option('--token <token>', 'Override the configured token; prefer AGENTRA_TOKEN')
    .addCommand(authCommand())
    .addCommand(projectCommand())
    .addCommand(issueCommand())
    .addCommand(testProjectCommand())
    .addCommand(caseCommand())
    .addCommand(skillsCommand())
}

async function main (): Promise<void> {
  await buildProgram().parseAsync(process.argv)
}

void main().catch((err) => {
  // Errors go to stderr and exit non-zero so a script or an agent can tell a
  // failure from an empty result — both of which print nothing on stdout.
  process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n')
  process.exit(1)
})

export { buildProgram }
