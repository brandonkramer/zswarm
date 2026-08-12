---
name: zswarm
description: >-
  Coordinate CLI crews in Zellij panes via zSwarm MCP (list, send, dump, wait,
  keys, interrupt, spawn, close, worktrees, unworktree). Use when messaging
  another Codex/Claude/Cursor CLI in a Zellij pane, waiting for one to finish,
  interrupting it, opening a new crew pane, isolating peers in git worktrees,
  or dumping short scrollback. Local Zellij only — not IDE side-panel chat.
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
CLI backup: `zswarm list|send|dump|wait|keys|interrupt|spawn|close|worktrees|unworktree|sessions`
(same ops; package `@zswarm/cli`).

## Ops

| op | Purpose |
|----|---------|
| `list` | Terminal panes (id, title, command, tab); `verbose` adds cwd/flags |
| `send` | Paste body + Enter into pane (`to` = id / title / command); ack is lean unless `verbose` |
| `dump` | Read pane screen; capped at 8000 chars (tail) by default — `max`, `head`, `full` |
| `wait` | Block until the pane is quiet or prints `match`; returns `reason` + a 2000-char tail |
| `keys` | Key specs (`keys: ["Ctrl c"]`) or literal `chars` (+ `enter`) |
| `interrupt` | `Esc`; `hard: true` sends `Ctrl c` |
| `spawn` | New pane (or `tab`) with `command`, `cwd`, `name`, `direction`, `floating`; `worktree` isolates on a branch |
| `close` | Close a pane |
| `worktrees` | List repo git worktrees, each annotated with panes working in it |
| `unworktree` | Remove a worktree (`path` or `branch`; `worktree` aliases `branch`) |
| `sessions` | Live Zellij session names |

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

## Prefix

Unless `raw: true`, sends are prefixed:

```text
[zswarm from=<sender>]
<body>
```

## Rules

1. Target **pane ids** from `list` — do not invent transports.
2. Prefer `send` + `wait` over polling `dump`. If you dump, avoid `full`; keep default `max`.
3. Not for IDE side-panel chats — only Zellij terminal panes.
4. Local machine only (same host as Zellij).
5. Writes refuse zSwarm's own pane (`self_target`) and exited panes (`pane_exited`).
   Override with `allowSelf` / `force` only when you mean it.
6. `spawn` takes an executable plus argv — no shell, so no pipes or `&&`.
7. Prefer `worktree` on `spawn` when peers should not share one dirty tree.
   Tear down with `unworktree` after the pane is closed.
