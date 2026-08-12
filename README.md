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

zswarm({ op: "spawn", command: "claude", cwd: "/repo", name: "reviewer" })
zswarm({ op: "wait", to: "terminal_5", match: "DONE" })
zswarm({ op: "wait", to: "terminal_5", for: "idle", idleMs: 3000 })
zswarm({ op: "keys", to: "terminal_5", keys: ["Ctrl c"] })
zswarm({ op: "keys", to: "terminal_5", chars: "y", enter: true })
zswarm({ op: "interrupt", to: "terminal_5" })      # Esc; hard:true sends Ctrl c
zswarm({ op: "close", to: "terminal_5" })
```

CLI (same ops):

```bash
pnpm run cli -- list
pnpm run cli -- send --to terminal_2 --body ping
pnpm run cli -- dump --to terminal_2 --max 4000
pnpm run cli -- spawn --command "claude" --cwd /repo --name reviewer --floating
pnpm run cli -- wait --to terminal_5 --match DONE --timeout-ms 30000
pnpm run cli -- keys --to terminal_5 --key "Ctrl c"
pnpm run cli -- close --to terminal_5
# after link: pnpm --dir packages/cli exec zswarm list
```

### Ops

| op | Purpose |
|----|---------|
| `list` / `sessions` | Terminal panes in a session / live session names |
| `send` | Paste a message + Enter into a pane |
| `dump` | Read a pane screen (8000 chars of tail by default) |
| `wait` | Block until the pane goes quiet, prints a match, or times out |
| `keys` | Send key specs (`Ctrl c`, `Esc`, `F1`) or literal `chars` |
| `interrupt` | `Esc` by default, `hard` sends `Ctrl c` |
| `spawn` | Open a pane (or `tab`) with a `command`, `cwd`, and `name` |
| `close` | Close a pane |

`spawn` runs the command directly — there is no shell, so pass an executable
that resolves on PATH plus argv-style arguments.

### Write guards

`send`, `keys`, `interrupt`, and `close` refuse to target the pane zSwarm itself
runs in, so a message cannot loop back into the caller. `send` and `keys` also
refuse panes whose command has exited.

| Guard | Error | Override |
|-------|-------|----------|
| Own pane | `self_target` | `allowSelf: true` |
| Exited pane | `pane_exited` | `force: true` |
| Plugin pane | `pane_is_plugin` | — |

## Env

| Variable | Purpose |
|----------|---------|
| `ZSWARM_BIN` / `ZSWARM_PATH` | Absolute path to `zellij` / `zellij.exe` |
| `ZSWARM_SESSION` | Default Zellij session name |
| `ZELLIJ_SESSION_NAME` | Used when already inside Zellij |
| `ZSWARM_SELF_PANE` | Pane to treat as zSwarm's own (defaults to `ZELLIJ_PANE_ID`; `none` disables the guard) |

## License

MIT
