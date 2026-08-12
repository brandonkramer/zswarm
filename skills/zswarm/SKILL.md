---
name: zswarm
description: >-
  Coordinate CLI crews in Zellij panes via zSwarm MCP (list, send, dump, tail,
  wait, status, keys, interrupt, spawn, close, broadcast, signal, signals,
  await, log, worktrees, unworktree). Use when messaging another
  Codex/Claude/Cursor CLI in a Zellij pane, waiting for one to finish,
  broadcasting to a crew, signalling barriers, interrupting, opening a new
  crew pane, isolating peers in git worktrees, or dumping short scrollback.
  Local Zellij only — not IDE side-panel chat.
---

# zSwarm

Talk to other **CLI** sessions that live in Zellij panes (Codex CLI, Claude Code,
Cursor CLI, shells). Delivery is `zellij action paste` + Enter into that pane.

## Happy path

```text
zswarm({ op: "list" })
zswarm({ op: "send", to: "terminal_2", body: "please review the plan" })
zswarm({ op: "wait", to: "terminal_2", for: "idle" })
```

Optional: `session` when multiple Zellij sessions exist, or set `ZSWARM_SESSION`.
CLI backup: `zswarm list|send|dump|tail|wait|status|keys|interrupt|spawn|close|broadcast|signal|signals|await|log|worktrees|unworktree|sessions`
(same ops; package `@zswarm/cli`).

## Ops

| op | Purpose |
|----|---------|
| `list` | Terminal panes (id, title, command, tab); `verbose` adds cwd/flags |
| `send` | Paste body + Enter into pane (`to` = id / title / command); ack is lean unless `verbose` |
| `dump` | Full-screen read; capped at 8000 chars (tail) — expensive vs `tail` |
| `tail` | Cheap incremental read since last cursor; `reset: true` returns whole screen |
| `wait` | Block until the pane is quiet or prints `match`; returns `reason` + a 2000-char tail |
| `status` | Classify panes busy / waiting / idle / exited; `free[]` = idle ids |
| `keys` | Key specs (`keys: ["Ctrl c"]`) or literal `chars` (+ `enter`) |
| `interrupt` | `Esc`; `hard: true` sends `Ctrl c` |
| `spawn` | New pane (or `tab`) with `command`, `cwd`, `name`, `direction`, `floating`; `worktree` isolates on a branch |
| `close` | Close a pane |
| `broadcast` | One body to many panes (`to` list, `tab`, or `all`; narrow with `group`) |
| `signal` | Post to a durable channel (`channel`, optional `payload`); `clear` resets |
| `signals` | List channels with cumulative counts |
| `await` | Block until a channel reaches `count` posts (`signalled` \| `timeout`) |
| `log` | Delivery log for send/broadcast/keys/interrupt/close |
| `worktrees` | List repo git worktrees, each annotated with panes working in it |
| `unworktree` | Remove a worktree (`path` or `branch`; `worktree` aliases `branch`) |
| `sessions` | Live Zellij session names |

## Crew coordination

Barrier pattern — broadcast a task, each peer signals when done, await N:

```text
zswarm({ op: "signal", channel: "done", clear: true })
zswarm({ op: "broadcast", body: "finish your slice, then signal done", all: true, group: "claude" })
zswarm({ op: "await", channel: "done", count: 3, timeoutMs: 600000 })
```

`status` to see who is free; `tail` (not `dump`) to poll what a peer printed.
State under `ZSWARM_STATE_DIR` (default `~/.zswarm`): `log.jsonl`, `signals.json`,
`cursors.json`. `ZSWARM_LOG=0` disables the delivery log.

`broadcast` skips plugin / exited / own pane (never errors on those);
`force` / `allowSelf` override. Empty selection → `no_targets`.

## Worktrees

`spawn` with `worktree=<branch>` gives the peer its own git worktree + branch
(overrides `cwd`). Optional `worktreeRoot`, `baseRef`. Defaults: worktrees under
`<repo>-worktrees` beside the repo (`ZSWARM_WORKTREE_ROOT` / `--worktree-root`).
Existing worktree at the target path is reused. Git binary: `ZSWARM_GIT_BIN`.

```text
zswarm({ op: "spawn", command: "claude", worktree: "review-auth", name: "reviewer" })
zswarm({ op: "worktrees", cwd: "/path/to/repo" })
zswarm({ op: "unworktree", branch: "review-auth", cwd: "/path/to/repo" })
```

`unworktree` refuses the main worktree (`worktree_is_main`), a worktree still
used by a pane (`worktree_busy`), or one with uncommitted changes
(`worktree_dirty`). `force: true` overrides busy/dirty only.

## Waiting

`wait` polls the pane screen instead of you re-dumping it.

- `for: "idle"` (default) — screen unchanged for `idleMs` (2000).
- `match: "…"` — substring, or `regex: true`; sets `for` to `match`.
- `for: "either"` — whichever lands first. `timeoutMs` defaults to 60000.

Send-then-wait is the normal loop:

```text
zswarm({ op: "send", to: "terminal_5", body: "run the tests" })
zswarm({ op: "wait", to: "terminal_5", for: "either", match: "FAIL", idleMs: 4000 })
```

Prefer `tail` for cheap incremental polls; reserve `dump` for a one-shot full
screen (or `tail` with `reset: true`).

## Prefix

Unless `raw: true`, sends are prefixed:

```text
[zswarm from=<sender>]
<body>
```

## Rules

1. Target **pane ids** from `list` — do not invent transports.
2. Prefer `send` + `wait` over polling. Prefer `tail` over repeated `dump`.
3. Not for IDE side-panel chats — only Zellij terminal panes.
4. Local machine only (same host as Zellij).
5. Writes refuse zSwarm's own pane (`self_target`) and exited panes (`pane_exited`).
   Override with `allowSelf` / `force` only when you mean it.
6. `spawn` takes an executable plus argv — no shell, so no pipes or `&&`.
7. Prefer `worktree` on `spawn` when peers should not share one dirty tree.
   Tear down with `unworktree` after the pane is closed.
8. For crew barriers use `broadcast` + `signal` + `await`, not ad-hoc dumps.
