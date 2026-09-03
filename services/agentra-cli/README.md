# Agentra CLI

Read and write Agentra issues and test cases from a terminal — or from an agent.

```bash
npm i -g @agentra-cli/cli

pbpaste | agentra auth login --url https://agentra.example.com --workspace agentra-main
agentra auth status
```

The token comes from **设置 → API 令牌** in Agentra. Pipe it on stdin rather than
passing `--token`, so it stays out of your shell history.

## Commands

| | |
|---|---|
| `agentra auth login \| status \| logout` | Credentials, stored in `~/.config/agentra/config.json` (mode 600) |
| `agentra project list` | Tracker projects and their issue-id prefix |
| `agentra issue list \| get \| create \| update` | Issues |
| `agentra test-project list` | Test projects and their suites |
| `agentra case list \| get \| create \| update` | Test cases |
| `agentra skills list \| install` | The agent skills that document this CLI |

Add `--json` to any read command for machine-readable output. Errors go to stderr
with a non-zero exit code, so an empty result and a failure are distinguishable.

There are no delete commands, by design.

## Using it from an agent

```bash
agentra skills install          # → ~/.claude/skills/agentra-{shared,issues,testcases}
agentra skills install --project  # → ./.claude/skills, for one repo
```

`agentra-shared` is the single source of truth for auth and configuration; the two
domain skills reference it rather than repeating it.

## Configuration

| Setting | Config key | Environment | Flag |
|---|---|---|---|
| Front URL (**not** the transactor's) | `url` | `AGENTRA_URL` | `--url` |
| Workspace slug, e.g. `agentra-main` | `workspace` | `AGENTRA_WORKSPACE` | `--workspace` |
| API token | `token` | `AGENTRA_TOKEN` | `--token` |

Flags beat the environment, which beats the config file.

⚠️ **The token has no scopes.** It carries the full permissions of whoever minted
it in that workspace. Use a dedicated account for agents, and revoke from the same
settings page.

## License

EPL-2.0
