# zSwarm

Coordinate CLI crews in **Zellij** panes: list peers, send a prompt into another
pane, dump short screen content. MCP tool: `zswarm`.

## Monorepo

| Package | Role |
|---------|------|
| `zswarm` | Everything below; what `npm i -g zswarm` installs |
| `@zswarm/core` | Zellij client + shared `dispatchZswarm` |
| `@zswarm/cli` | `zswarm` CLI |
| `@zswarm/mcp` | MCP server (`zswarm` tool) |
| `@zswarm/wasm` | Compiled Zellij event-bus plugin |
| `@zswarm/pi` | MCP bridge for harnesses with extensions but no MCP client |


## Requirements

- [Zellij](https://zellij.dev) ≥ 0.42 on PATH (or set `ZSWARM_BIN` / `ZSWARM_PATH`)
- Node ≥ 20

## Install

```bash
npm i -g zswarm
zswarm list
```

That gives you the `zswarm` command, the `zswarm-mcp` server, and the event bus.
Works on macOS, Linux, and Windows.

Turn the bus on once per machine so `list` and `status` read pushed state
instead of polling:

```bash
zswarm bus --install        # approve the prompt it opens
```

### As an MCP server

`zswarm-mcp` speaks stdio and comes with the install above. The config below
covers the two things a host may not pass through — see
[MCP host configuration](#mcp-host-configuration):

```json
{
  "mcpServers": {
    "zswarm": {
      "command": "/abs/path/to/zswarm-mcp",
      "env": { "ZSWARM_SESSION": "<session-name>" }
    }
  }
}
```

Harnesses with extensions but no MCP client: `pi install npm:@zswarm/pi`.

### From a checkout

```bash
pnpm install
pnpm run build
pnpm run cli -- list
```

Local plugin manifests (`mcp.json`, `skills/`, `.cursor-plugin/`, …) live at the
repo root, and `bin/launch-mcp.mjs` is the entry point a host execs.


### MCP host configuration

Two things a host may not pass to the server it spawns, and cannot infer:

| Missing | Symptom | Fix |
|---|---|---|
| Zellij env | `zellij_session_ambiguous` once a second session exists | set `ZSWARM_SESSION` |
| `PATH` | `exec: "zswarm-mcp": executable file not found in $PATH` | absolute path, never a bare name |

From a checkout the entry point is `bin/launch-mcp.mjs`, which needs an
interpreter:

```json
{
  "mcpServers": {
    "zswarm": {
      "command": "/abs/path/to/node",
      "args": ["/abs/path/to/zswarm/bin/launch-mcp.mjs"],
      "env": { "ZSWARM_SESSION": "<session-name>" }
    }
  }
}
```

TOML hosts take the same key under `[mcp_servers.zswarm.env]`.

Hosts that spawn the server inside the pane inherit both and need neither. With
one live session the ambiguity is invisible — resolution succeeds by
elimination — so it surfaces the day a second session starts. A launch failure
appears only in the host's own MCP log, since zswarm never ran.

Session resolution order:

```
  session arg → ZSWARM_SESSION → ZELLIJ_SESSION_NAME → sole live session
                                 (set only inside a pane)
```

### Harnesses without MCP

Some ship no MCP client by design, arguing a CLI plus a README is the better
interface. `@zswarm/cli` covers those. For harnesses that take extensions,
`packages/pi` is a generic MCP-to-extension bridge — it spawns a stdio server,
enumerates `tools/list`, and registers everything it finds.

Being driven *as a target* needs no integration at all: `send`, `dump`, `tail`,
`wait`, and `status` are terminal I/O.

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
zswarm list
zswarm send --to terminal_2 --body ping
zswarm send --to reviewer --body "look again" --submit auto
zswarm dump --to terminal_2 --max 4000
zswarm spawn --command "claude" --cwd /path/to/repo --name reviewer --floating
zswarm spawn --command "claude" --worktree review-auth --name reviewer
zswarm spawn --command "claude" --tab crew --name builder
zswarm spawn --command "claude" --new-tab --name solo
zswarm worktrees --cwd /path/to/repo
zswarm unworktree --branch review-auth --cwd /path/to/repo
zswarm wait --to terminal_5 --match DONE --timeout-ms 30000
zswarm keys --to terminal_5 --key "Ctrl c"
zswarm close --to terminal_5
zswarm broadcast --all --group claude --body "run tests"
zswarm tail --to terminal_5
zswarm status
zswarm signal --channel done --payload ok
zswarm signals
zswarm await --channel done --count 3
zswarm log --failed --limit 20
zswarm rename --to terminal_11 --name reviewer
zswarm rename --tab "Tab #1" --name crew
zswarm focus --to reviewer
zswarm tabs
zswarm layout --max 4000
zswarm stack --to terminal_2,terminal_3
zswarm diff --branch review-auth --cwd /path/to/repo
zswarm diff --path /path/to/repo-worktrees/review-auth --stat
zswarm checkpoint --branch review-auth --cwd /path/to/repo --message wip
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

`send` accepts `expect=<text>`: the target pane's screen must contain it before
zswarm writes anything. A pane that has dropped back to a shell prompt will
**run** a message as a command — this happened during development — and nothing
reliably distinguishes an agent from a prompt, so the guard is explicit rather
than clever. Failure is `expect_missing`.

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

`list` and `status` normally cost a zellij process per question, plus two
`dump-screen` calls per pane for `status`. A Zellij plugin can hold that state
instead — Zellij pushes changes into it, and one `zellij pipe` reads it back.

```bash
zswarm bus --install   # loads the plugin, approve the prompt once
zswarm bus             # enabled? ready? how many pushes?
zswarm bus --clear     # forget it; back to polling
```

Off until installed (remembered in `~/.zswarm/bus.json`), and every reply
carries `source: "plugin" | "zellij"`. The pane `--install` opens only renders
the permission prompt — close it once approved.

| Path | Served by | Measured |
|---|---|---|
| `list`, `status` panes | pushed state, free to read | — |
| `status` sampling | batched scrollback, one pipe | 0.055s + 0.0143s/pane vs 0.050s/pane polled |
| `wait` | one pipe held open, 50ms polls | 3348ms / 1 process vs 3782ms / 6 |
| `status --since-last` | "moved since you last asked" | 0.30s vs 0.84s |
| `dump`, `tail` | polling | one pane is cheaper as a process |

`--since-last` answers a different question than sampling does — ask twice
quickly and everything reads idle — so it is opt-in.

The manifest carries no command or cwd, so a bus-served `list` omits `command`
rather than reporting null; `--verbose` and `status --to <command>` always poll.
A `regex` needle the plugin declines, and `wait` falls back on its own.

Rebuilding needs Rust; the artifact is committed so users do not:

```bash
pnpm run build:plugin      # needs Rust + the wasm32-wasip1 target
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

## Tested harnesses

Verified live against codex, cursor, pi, opencode, and gemini. All work as
targets; `codex` needs a second Enter to submit, which zSwarm handles itself.

Re-run against live panes: `node scripts/harness-check.mjs <pane> ...`


## Env

| Variable | Purpose |
|----------|---------|
| `ZSWARM_BIN` / `ZSWARM_PATH` | Absolute path to `zellij` / `zellij.exe` |
| `ZSWARM_SESSION` | Default Zellij session name; effectively required for MCP hosts that spawn the server outside the Zellij pane (see [MCP host configuration](#mcp-host-configuration)) |
| `ZELLIJ_SESSION_NAME` | Used when already inside Zellij; only set inside a pane |
| `ZSWARM_MCP_SERVERS` | JSON map of stdio MCP servers for the bundled extension bridge (default: zswarm's own server) |
| `ZSWARM_SELF_PANE` | Pane to treat as zSwarm's own (defaults to `ZELLIJ_PANE_ID`; `none` disables the guard) |
| `ZSWARM_WORKTREE_ROOT` | Directory for linked worktrees (default `<repo>-worktrees` beside the repo) |
| `ZSWARM_GIT_BIN` | Absolute path to `git` / `git.exe` when not on PATH |
| `ZSWARM_STATE_DIR` | Durable state dir for log / signals / tail cursors / bus marker (default `~/.zswarm`) |
| `ZSWARM_BUS` | `0` never asks the event bus; `1` asks it without `bus --install` |
| `ZSWARM_BUS_PLUGIN` | Path to the plugin wasm (default: resolved from `@zswarm/wasm`) |
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
