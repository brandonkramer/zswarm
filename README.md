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
zswarm({ op: "send", to: "reviewer", body: "look again", submit: "auto" })
zswarm({ op: "dump", to: "terminal_2" })           # capped 8000 chars (tail)
zswarm({ op: "list", verbose: true })              # cwd + focus flags

zswarm({ op: "spawn", command: "claude", cwd: "/path/to/repo", name: "reviewer" })
zswarm({ op: "spawn", command: "claude", worktree: "review-auth", name: "reviewer" })
zswarm({ op: "spawn", command: "claude", tab: "crew", name: "builder" })
zswarm({ op: "spawn", command: "claude", newTab: true, name: "solo" })
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

zswarm({ op: "rename", to: "terminal_11", name: "reviewer" })
zswarm({ op: "rename", tab: "Tab #1", name: "crew" })
zswarm({ op: "focus", to: "reviewer" })
zswarm({ op: "tabs" })
zswarm({ op: "layout" })                           # KDL; max caps (keeps head)
zswarm({ op: "stack", to: "terminal_2,terminal_3" })
zswarm({ op: "diff", branch: "review-auth", cwd: "/path/to/repo" })
zswarm({ op: "diff", path: "/path/to/repo-worktrees/review-auth", stat: true })
zswarm({ op: "checkpoint", branch: "review-auth", cwd: "/path/to/repo", message: "wip" })
```

CLI (same ops):

```bash
pnpm run cli -- list
pnpm run cli -- send --to terminal_2 --body ping
pnpm run cli -- send --to reviewer --body "look again" --submit auto
pnpm run cli -- dump --to terminal_2 --max 4000
pnpm run cli -- spawn --command "claude" --cwd /path/to/repo --name reviewer --floating
pnpm run cli -- spawn --command "claude" --worktree review-auth --name reviewer
pnpm run cli -- spawn --command "claude" --tab crew --name builder
pnpm run cli -- spawn --command "claude" --new-tab --name solo
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
pnpm run cli -- rename --to terminal_11 --name reviewer
pnpm run cli -- rename --tab "Tab #1" --name crew
pnpm run cli -- focus --to reviewer
pnpm run cli -- tabs
pnpm run cli -- layout --max 4000
pnpm run cli -- stack --to terminal_2,terminal_3
pnpm run cli -- diff --branch review-auth --cwd /path/to/repo
pnpm run cli -- diff --path /path/to/repo-worktrees/review-auth --stat
pnpm run cli -- checkpoint --branch review-auth --cwd /path/to/repo --message wip
# after link: pnpm --dir packages/cli exec zswarm list
```

### Ops

| op | Purpose |
|----|---------|
| `list` / `sessions` | Terminal panes in a session / live session names |
| `send` | Paste a message + Enter into a pane; verifies submit (see below) |
| `dump` | Read a pane screen (8000 chars of tail by default) |
| `tail` | Incremental read since last cursor; prefer over repeated `dump` |
| `wait` | Block until the pane goes quiet, prints a match, or times out |
| `status` | Classify panes as busy / waiting / idle / exited; `free[]` = idle ids |
| `keys` | Send key specs (`Ctrl c`, `Esc`, `F1`) or literal `chars` |
| `interrupt` | `Esc` by default, `hard` sends `Ctrl c` |
| `spawn` | Open a pane with a `command`, `cwd`, and `name`; `tab` = tab name, `newTab` = new tab |
| `close` | Close a pane |
| `broadcast` | One body to many panes (`to` list, `tab`, or `all`; narrow with `group`) |
| `signal` / `signals` | Post to a durable channel (or clear) / list channel counts |
| `await` | Block until a channel reaches `count` posts |
| `log` | Delivery log for send/broadcast/keys/interrupt/close |
| `worktrees` | List the repo's git worktrees, each with panes working in it |
| `unworktree` | Remove a worktree (`path` or `branch`; `worktree` aliases `branch`) |
| `rename` | Retitle a pane (`to` + `name`) or a tab (`tab` + `name`) |
| `focus` | Focus a pane by id/title/command; already focused → `already: true` |
| `tabs` | List tabs (`id`, `name`, pane count, `active`, swap layout) |
| `layout` | Dump the session layout as KDL (`max` caps, keeps the head) |
| `stack` | Stack a comma list of panes into one stack (≥ 2) |
| `diff` | Peer worktree changes (`path` / `branch` / `cwd`; `stat`; `max` default 8000) |
| `checkpoint` | Commit everything in a peer worktree (`message=`); clean → `committed: false` |
| `bus` | Report the event bus; `install: true` loads it, `clear: true` forgets it |

**Breaking:** `spawn`'s boolean `tab` is now `newTab`. `tab` is a tab **name**
(used by `broadcast` to target a tab, by `rename` to retitle one, and by `spawn`
to place the pane).

`send` / `broadcast` verify submission (fixes silent non-delivery into TUI
composers). `submit=auto` (default): paste, wait `settleMs` (default 300),
check whether the text is still in the composer, press Enter again if so.
Result includes `submitted: true | false | 'unverified'`.
`submit=double-enter` always sends the extra Enter; `submit=none` is the old
fire-and-forget behaviour.

`spawn` runs the command directly — there is no shell, so pass an executable
that resolves on PATH plus argv-style arguments.

`spawn` with `worktree=<branch>` gives the peer its own git worktree + branch
(overrides `cwd`). Optional `worktreeRoot` and `baseRef`. Worktrees default to
`<repo>-worktrees` beside the repo (`--worktree-root` / `ZSWARM_WORKTREE_ROOT`).
If a worktree already exists at the target path, `spawn` reuses it.

`broadcast` selects with `to=<comma list>`, `tab=<name>`, or `all=true`;
narrow with `group=<substring>` on title or command. Returns `delivered[]`,
`failed[]`, `skipped[]`. Skips (does not error on) plugin panes, exited panes,
zSwarm's own pane, and policy-denied panes; `force` / `allowSelf` override the
pane guards. Empty selection → `no_targets`.

`tail` returns only what the pane printed since the last `tail` (per-pane
cursor; handles a scrolled viewport). `reset: true` forgets the cursor and
returns the whole screen. Fields: `text`, `reset`, `fresh`, `chars`.

`status` samples each pane twice (`sampleMs`, default 400) → `busy` /
`waiting` / `idle` / `exited`, plus `free[]`. Optional `to=` for one pane.
`sampleMs=0` skips sampling: every live pane reports `running`, there is no
`free[]`, and the answer comes from the event bus when it is installed.

### Event bus

`list` and `status` normally cost one zellij process per question, plus two
`dump-screen` calls per pane for `status`. A small Zellij plugin can hold that
state instead: Zellij pushes pane and tab changes into it, and one `zellij pipe`
call reads the current picture back out of memory.

```bash
zswarm bus --install   # loads the plugin, approve its permission prompt once
zswarm bus             # enabled? ready? how many pushes so far?
zswarm bus --clear     # forget it; everything goes back to polling
```

Install is remembered in `~/.zswarm/bus.json`, so until you run it the bus is
off and nothing pays for a pipe that was never going to answer. Every reply
carries `source: "plugin" | "zellij"` so you can tell which path served it.

The pane `--install` opens exists only to render the permission prompt — close
it once you have approved. Later calls relaunch the plugin headless, and the
first one after a relaunch waits for Zellij to push it a manifest.

What the bus can and cannot serve:

```
  pushed by Zellij            not an event
  ────────────────            ────────────
  pane opened / closed        pane output text
  pane exited                 pane cwd
  focus moved                 pane command
  tab added / renamed         floating

  → list, status              → dump, tail, wait, list --verbose
```

Because the manifest carries no command, a bus-served `list` omits `command`
rather than reporting it as null, and `status --to <command>` falls back to
polling. `--verbose` always polls.

Rebuilding the plugin needs Rust; the compiled artifact is committed so users
do not:

```bash
cd plugin/zswarm-events
rustup target add wasm32-wasip1
cargo build --release --target wasm32-wasip1
cp target/wasm32-wasip1/release/zswarm-events.wasm ../prebuilt/zswarm-bus.wasm
```

`signal` / `signals` / `await` use durable channels under `ZSWARM_STATE_DIR`
(default `~/.zswarm`: `log.jsonl`, `signals.json`, `cursors.json`).
`ZSWARM_LOG=0` turns the delivery log off.

`diff` targets a peer worktree by `path=`, `branch=`, or `cwd=`. `stat=true`
for stat only; `max` caps the patch (default 8000). Untracked files included.

`checkpoint` commits everything in a peer worktree so its pane can close and
resume. `message=` sets the commit message. A clean tree is not an error
(`committed: false`, `nothingToCommit: true`). Missing git author identity →
`git_identity` (message names the fix).

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

### Policy

All default permissive. Denials use `policy_denied`; the message names the env
var responsible. `broadcast` skips policy-denied panes instead of failing the
whole call.

| Env | Effect |
|-----|--------|
| `ZSWARM_READONLY=1` | Block every write op (`send`, `broadcast`, `keys`, `interrupt`, `spawn`, `close`, `unworktree`) |
| `ZSWARM_ALLOW_PANES` | Comma list; pane id or case-insensitive title substring must match |
| `ZSWARM_DENY_PANES` | Same matching; deny beats allow |
| `ZSWARM_ALLOW_SPAWN=0` | Disable `spawn` |
| `ZSWARM_ALLOW_CLOSE=0` | Disable `close` |
| `ZSWARM_ALLOW_WORKTREE_REMOVE=0` | Disable `unworktree` |

Remote crew over SSH: `ZSWARM_SSH=user@host` routes every zellij call through
ssh (`BatchMode=yes` unless you set your own). Optional: `ZSWARM_SSH_BIN`,
`ZSWARM_SSH_OPTS` (whitespace split), `ZSWARM_REMOTE_BIN` (default `zellij`).

## Env

| Variable | Purpose |
|----------|---------|
| `ZSWARM_BIN` / `ZSWARM_PATH` | Absolute path to `zellij` / `zellij.exe` |
| `ZSWARM_SESSION` | Default Zellij session name |
| `ZELLIJ_SESSION_NAME` | Used when already inside Zellij |
| `ZSWARM_SELF_PANE` | Pane to treat as zSwarm's own (defaults to `ZELLIJ_PANE_ID`; `none` disables the guard) |
| `ZSWARM_WORKTREE_ROOT` | Directory for linked worktrees (default `<repo>-worktrees` beside the repo) |
| `ZSWARM_GIT_BIN` | Absolute path to `git` / `git.exe` when not on PATH |
| `ZSWARM_STATE_DIR` | Durable state dir for log / signals / tail cursors / bus marker (default `~/.zswarm`) |
| `ZSWARM_BUS` | `0` never asks the event bus; `1` asks it without `bus --install` |
| `ZSWARM_BUS_PLUGIN` | Path to the plugin wasm (default `plugin/prebuilt/zswarm-bus.wasm`) |
| `ZSWARM_LOG` | Set to `0` to disable the delivery log |
| `ZSWARM_READONLY` | `1` blocks write ops (see Policy) |
| `ZSWARM_ALLOW_PANES` | Comma allow-list for pane id / title substring |
| `ZSWARM_DENY_PANES` | Comma deny-list; beats allow |
| `ZSWARM_ALLOW_SPAWN` | `0` disables `spawn` |
| `ZSWARM_ALLOW_CLOSE` | `0` disables `close` |
| `ZSWARM_ALLOW_WORKTREE_REMOVE` | `0` disables `unworktree` |
| `ZSWARM_SSH` | `user@host` — route zellij through ssh |
| `ZSWARM_SSH_BIN` | ssh binary override |
| `ZSWARM_SSH_OPTS` | Extra ssh args (whitespace split) |
| `ZSWARM_REMOTE_BIN` | Remote zellij path (default `zellij`) |

## License

MIT
