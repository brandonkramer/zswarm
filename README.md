# zSwarm

Coordinate CLI crews in **Zellij** panes: list peers, send a prompt into another
pane, dump short screen content. MCP tool: `zswarm`.

## Monorepo

| Package | Role |
|---------|------|
| `@zswarm/core` | Zellij client + shared `dispatchZswarm` |
| `@zswarm/cli` | `zswarm` CLI |
| `@zswarm/mcp` | MCP server (`zswarm` tool) |

Plugin manifests (`mcp.json`, `skills/`, `.cursor-plugin/`, …) stay at the repo root.

## Requirements

- [Zellij](https://zellij.dev) ≥ 0.42 on PATH (or set `ZSWARM_BIN` / `ZSWARM_PATH`)
- Node ≥ 20
- pnpm

## Install (dev)

```bash
cd /path/to/zswarm
pnpm install
pnpm run build
```

### Cursor

```bash
mkdir -p ~/.cursor/plugins/local
# macOS / Linux:
ln -sfn "$PWD" ~/.cursor/plugins/local/zswarm
# Windows PowerShell:
# New-Item -ItemType Junction -Path "$HOME\.cursor\plugins\local\zswarm" -Target (Get-Location)
```

Enable the plugin; MCP launches via `bin/launch-mcp.mjs` → `packages/mcp`.

### Claude Code

```bash
claude plugin marketplace add "$PWD"
claude plugin install zswarm@zswarm-local
```

### Codex

Point a local marketplace at this directory and enable `zswarm@zswarm-local`.
Set MCP env if needed:

```toml
[plugins."zswarm@zswarm-local".mcp_servers.zswarm.env]
# Windows:
ZSWARM_BIN = '~/AppData/Local/Zellij/zellij.exe'
# macOS (Homebrew or cargo):
# ZSWARM_BIN = '/opt/homebrew/bin/zellij'
# ZSWARM_BIN = '~/.cargo/bin/zellij'
```

## Usage

MCP:

```text
zswarm({ op: "list" })
zswarm({ op: "send", to: "terminal_2", body: "ping" })
zswarm({ op: "dump", to: "terminal_2" })           # capped 8000 chars (tail)
zswarm({ op: "list", verbose: true })              # cwd + focus flags
```

CLI (same ops):

```bash
pnpm run cli -- list
pnpm run cli -- send --to terminal_2 --body ping
pnpm run cli -- dump --to terminal_2 --max 4000
pnpm run cli -- list --verbose
# after link: pnpm --dir packages/cli exec zswarm list
```

## Env

| Variable | Purpose |
|----------|---------|
| `ZSWARM_BIN` / `ZSWARM_PATH` | Absolute path to `zellij` / `zellij.exe` |
| `ZSWARM_SESSION` | Default Zellij session name |
| `ZELLIJ_SESSION_NAME` | Used when already inside Zellij |

## License

MIT
