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

zswarm({ op: "spawn", command: "claude", cwd: "/path/to/repo", name: "reviewer" })
zswarm({ op: "spawn", command: "claude", worktree: "review-auth", name: "reviewer" })
zswarm({ op: "worktrees", cwd: "/path/to/repo" })
zswarm({ op: "unworktree", branch: "review-auth", cwd: "/path/to/repo" })
zswarm({ op: "wait", to: "terminal_5", match: "DONE" })
zswarm({ op: "wait", to: "terminal_5", for: "idle", idleMs: 3000 })
zswarm({ op: "keys", to: "terminal_5", keys: ["Ctrl c"] })
zswarm({ op: "keys", to: "terminal_5", chars: "y", enter: true })
zswarm({ op: "interrupt", to: "terminal_5" })      # Esc; hard:true sends Ctrl c
zswarm({ op: "close", to: "terminal_5" })

zswarm({ op: "broadcast", body: "run tests", all: true, group: "claude" })
zswarm({ op: "tail", to: "terminal_5" })           # incremental since last tail
zswarm({ op: "status" })                           # busy | waiting | idle | exited
zswarm({ op: "signal", channel: "done", payload: "ok" })
zswarm({ op: "signals" })
zswarm({ op: "await", channel: "done", count: 3 })
zswarm({ op: "log", limit: 20, failed: true })
```

CLI (same ops):

```bash
pnpm run cli -- list
pnpm run cli -- send --to terminal_2 --body ping
pnpm run cli -- dump --to terminal_2 --max 4000
pnpm run cli -- spawn --command "claude" --cwd /path/to/repo --name reviewer --floating
pnpm run cli -- spawn --command "claude" --worktree review-auth --name reviewer
pnpm run cli -- worktrees --cwd /path/to/repo
pnpm run cli -- unworktree --branch review-auth --cwd /path/to/repo
pnpm run cli -- wait --to terminal_5 --match DONE --timeout-ms 30000
pnpm run cli -- keys --to terminal_5 --key "Ctrl c"
pnpm run cli -- close --to terminal_5
pnpm run cli -- broadcast --all --group claude --body "run tests"
pnpm run cli -- tail --to terminal_5
pnpm run cli -- status
pnpm run cli -- signal --channel done --payload ok
pnpm run cli -- signals
pnpm run cli -- await --channel done --count 3
pnpm run cli -- log --failed --limit 20
# after link: pnpm --dir packages/cli exec zswarm list
```

### Ops

| op | Purpose |
|----|---------|
| `list` / `sessions` | Terminal panes in a session / live session names |
| `send` | Paste a message + Enter into a pane |
| `dump` | Read a pane screen (8000 chars of tail by default) |
| `tail` | Incremental read since last cursor; prefer over repeated `dump` |
| `wait` | Block until the pane goes quiet, prints a match, or times out |
| `status` | Classify panes as busy / waiting / idle / exited; `free[]` = idle ids |
| `keys` | Send key specs (`Ctrl c`, `Esc`, `F1`) or literal `chars` |
| `interrupt` | `Esc` by default, `hard` sends `Ctrl c` |
| `spawn` | Open a pane (or `tab`) with a `command`, `cwd`, and `name` |
| `close` | Close a pane |
| `broadcast` | One body to many panes (`to` list, `tab`, or `all`; narrow with `group`) |
| `signal` / `signals` | Post to a durable channel (or clear) / list channel counts |
| `await` | Block until a channel reaches `count` posts |
| `log` | Delivery log for send/broadcast/keys/interrupt/close |
| `worktrees` | List the repo's git worktrees, each with panes working in it |
| `unworktree` | Remove a worktree (`path` or `branch`; `worktree` aliases `branch`) |

`spawn` runs the command directly — there is no shell, so pass an executable
that resolves on PATH plus argv-style arguments.

`spawn` with `worktree=<branch>` gives the peer its own git worktree + branch
(overrides `cwd`). Optional `worktreeRoot` and `baseRef`. Worktrees default to
`<repo>-worktrees` beside the repo (`--worktree-root` / `ZSWARM_WORKTREE_ROOT`).
If a worktree already exists at the target path, `spawn` reuses it.

`broadcast` selects with `to=<comma list>`, `tab=<name>`, or `all=true`;
narrow with `group=<substring>` on title or command. Returns `delivered[]`,
`failed[]`, `skipped[]`. Skips (does not error on) plugin panes, exited panes,
and zSwarm's own pane; `force` / `allowSelf` override. Empty selection →
`no_targets`.

`tail` returns only what the pane printed since the last `tail` (per-pane
cursor; handles a scrolled viewport). `reset: true` forgets the cursor and
returns the whole screen. Fields: `text`, `reset`, `fresh`, `chars`.

`status` samples each pane twice (`sampleMs`, default 400) → `busy` /
`waiting` / `idle` / `exited`, plus `free[]`. Optional `to=` for one pane.

`signal` / `signals` / `await` use durable channels under `ZSWARM_STATE_DIR`
(default `~/.zswarm`: `log.jsonl`, `signals.json`, `cursors.json`).
`ZSWARM_LOG=0` turns the delivery log off.

### Write guards

`send`, `keys`, `interrupt`, and `close` refuse to target the pane zSwarm itself
runs in, so a message cannot loop back into the caller. `send` and `keys` also
refuse panes whose command has exited.

| Guard | Error | Override |
|-------|-------|----------|
| Own pane | `self_target` | `allowSelf: true` |
| Exited pane | `pane_exited` | `force: true` |
| Plugin pane | `pane_is_plugin` | — |
| Main worktree | `worktree_is_main` | — |
| Pane still in worktree | `worktree_busy` | `force: true` |
| Dirty worktree | `worktree_dirty` | `force: true` |

## Env

| Variable | Purpose |
|----------|---------|
| `ZSWARM_BIN` / `ZSWARM_PATH` | Absolute path to `zellij` / `zellij.exe` |
| `ZSWARM_SESSION` | Default Zellij session name |
| `ZELLIJ_SESSION_NAME` | Used when already inside Zellij |
| `ZSWARM_SELF_PANE` | Pane to treat as zSwarm's own (defaults to `ZELLIJ_PANE_ID`; `none` disables the guard) |
| `ZSWARM_WORKTREE_ROOT` | Directory for linked worktrees (default `<repo>-worktrees` beside the repo) |
| `ZSWARM_GIT_BIN` | Absolute path to `git` / `git.exe` when not on PATH |
| `ZSWARM_STATE_DIR` | Durable state dir for log / signals / tail cursors (default `~/.zswarm`) |
| `ZSWARM_LOG` | Set to `0` to disable the delivery log |

## License

MIT
