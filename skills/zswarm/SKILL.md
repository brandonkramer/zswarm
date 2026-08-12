---
name: zswarm
description: >-
  Coordinate CLI crews in Zellij panes via zSwarm MCP (list, send, dump, tail,
  wait, status, keys, interrupt, spawn, close, broadcast, signal, signals,
  await, log, worktrees, unworktree, rename, focus, tabs, layout, stack, diff,
  checkpoint, bus). Use when messaging another Codex/Claude/Cursor CLI in a Zellij
  pane, waiting for one to finish, broadcasting to a crew, signalling barriers,
  interrupting, opening a new crew pane, isolating peers in git worktrees,
  reviewing peer diffs/checkpoints, renaming/focusing panes, or dumping short
  scrollback. Local Zellij only — not IDE side-panel chat.
---

# zSwarm

Talk to other **CLI** sessions that live in Zellij panes (Codex CLI, Claude Code,
Cursor CLI, shells). Delivery is `zellij action paste` + Enter into that pane.

## Happy path

```text
zswarm({ op: "list" })
zswarm({ op: "send", to: "reviewer", body: "please review the plan" })
zswarm({ op: "wait", to: "reviewer", for: "idle" })
```

Optional: `session` when multiple Zellij sessions exist, or set `ZSWARM_SESSION`.

`zellij_session_ambiguous` means resolution ran out of answers. The order is
`session` arg → `ZSWARM_SESSION` → `ZELLIJ_SESSION_NAME` (set only inside a
Zellij pane) → the sole live session. Some MCP hosts spawn servers outside the
pane process, so the server inherits no Zellij env and gets by only while
exactly one session is live — the error appears the day a second one starts.
Pass `session` to unblock the call now; set `ZSWARM_SESSION` in the MCP server
config to fix it for good.

CLI backup: `zswarm list|send|dump|tail|wait|status|keys|interrupt|spawn|close|broadcast|signal|signals|await|log|worktrees|unworktree|rename|focus|tabs|layout|stack|diff|checkpoint|bus|sessions`
(same ops; package `@zswarm/cli`).

## Ops

| op | Purpose |
|----|---------|
| `list` | Terminal panes (id, title, command, tab); `verbose` adds cwd/flags |
| `send` | Paste body + Enter into pane (`to` = id / title / command); ack is lean unless `verbose`. Delivery check: `submit` (`auto` default / `double-enter` / `none`); result `submitted: true\|false\|"unverified"`. `expect: "<text>"` refuses unless the screen already shows it |
| `dump` | Full-screen read; capped at 8000 chars (tail) — expensive vs `tail` |
| `tail` | Cheap incremental read since last cursor; `reset: true` returns whole screen |
| `wait` | Block until the pane is quiet or prints `match`; returns `reason` + a 2000-char tail. With the bus one held pipe covers the whole wait and notices in ~50ms instead of up to 600ms |
| `status` | Classify panes busy / waiting / idle / exited; `free[]` = idle ids. `sampleMs: 0` skips sampling — live panes report `running`, no `free[]`. `sinceLast: true` drops the 400ms gap (0.30s vs 0.84s) by asking what moved since your last call |
| `keys` | Key specs (`keys: ["Ctrl c"]`) or literal `chars` (+ `enter`) |
| `interrupt` | `Esc`; `hard: true` sends `Ctrl c` |
| `spawn` | New pane (`newTab: true` for a fresh tab) with `command`, `cwd`, `name`, `direction`, `floating`; `tab` = tab name to open in; `worktree` isolates on a branch |
| `close` | Close a pane |
| `rename` | Retitle a pane (`to` + `name`) or a tab (`tab` + `name`) — address peers as `reviewer`, not `terminal_11` |
| `focus` | Focus a pane; already-focused is a no-op success |
| `tabs` | List tabs with pane counts |
| `layout` | Dump the session layout as KDL |
| `stack` | Stack a comma list of panes (needs 2+) |
| `broadcast` | One body to many panes (`to` list, `tab`, or `all`; narrow with `group`). Same `submit` / `submitted` as `send` |
| `signal` | Post to a durable channel (`channel`, optional `payload`); `clear` resets |
| `signals` | List channels with cumulative counts |
| `await` | Block until a channel reaches `count` posts (`signalled` \| `timeout`) |
| `log` | Delivery log for send/broadcast/keys/interrupt/close |
| `worktrees` | List repo git worktrees, each annotated with panes working in it |
| `unworktree` | Remove a worktree (`path` or `branch`; `worktree` aliases `branch`) |
| `diff` | What a peer changed in its worktree (`path` / `branch` / `cwd`; `stat: true`; `max`) |
| `checkpoint` | Commit a peer worktree so the pane can close and resume (`message`); clean tree is not an error |
| `sessions` | Live Zellij session names |
| `bus` | Event-bus status; `install: true` loads the plugin (once), `clear: true` forgets it |

`submit=auto` (default) checks the paste actually submitted and presses Enter
again if the text is still sitting in a TUI composer. `submit=double-enter`
forces the extra Enter; `submit=none` disables. Multi-line prompts used to stay
queued in the composer while zswarm reported success — check `submitted`.

**Breaking:** `spawn`'s boolean `tab` is now `newTab`; `tab` is a tab **name**.

### Event bus

`zswarm({ op: "bus", install: true })` once per machine loads a Zellij plugin
that is *pushed* pane and tab changes. After that `list` and `status` read it
over one pipe instead of polling, and every reply says `source: "plugin"` or
`source: "zellij"`. It is off until installed, and any failure falls back
silently — so treat it as speed, never as a dependency.

The manifest Zellij pushes has no pane command or cwd, so a bus-served `list`
omits `command`, and `list` with `verbose` / `status --to <command>` keep
polling. Screen text the plugin reads on demand instead: `status` sampling
batches it, `wait` gets a pipe held open until the condition resolves, and
`dump` / `tail` stay on the CLI because one pane is cheaper as a process.

`send`'s `expect` guard exists because a pane that dropped back to a shell will
**run** your message as a command. Nothing reliably tells an agent from a
prompt, so name something the screen must already show:

```text
zswarm({ op: "send", to: "reviewer", body: "…", expect: "Add a follow-up" })
```

Failure is `expect_missing` and nothing is written.

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

## Review loop

Isolate a peer, name it, task it, save its work, tear down:

```text
zswarm({ op: "spawn", command: "claude", worktree: "review-auth", name: "reviewer" })
zswarm({ op: "rename", to: "terminal_11", name: "reviewer" })
zswarm({ op: "send", to: "reviewer", body: "review the auth changes" })
zswarm({ op: "wait", to: "reviewer", for: "idle" })
zswarm({ op: "diff", branch: "review-auth", cwd: "/path/to/repo" })
zswarm({ op: "checkpoint", branch: "review-auth", cwd: "/path/to/repo", message: "review checkpoint" })
zswarm({ op: "close", to: "reviewer" })
zswarm({ op: "unworktree", branch: "review-auth", cwd: "/path/to/repo" })
```

Prefer `diff` / `checkpoint` over reading the worktree by hand. Clean
`checkpoint` returns `committed: false`, `nothingToCommit: true` — not an error.

## Waiting

`wait` polls the pane screen instead of you re-dumping it.

- `for: "idle"` (default) — screen unchanged for `idleMs` (2000).
- `match: "…"` — substring, or `regex: true`; sets `for` to `match`.
- `for: "either"` — whichever lands first. `timeoutMs` defaults to 60000.

Send-then-wait is the normal loop:

```text
zswarm({ op: "send", to: "reviewer", body: "run the tests" })
zswarm({ op: "wait", to: "reviewer", for: "either", match: "FAIL", idleMs: 4000 })
```

Prefer `tail` for cheap incremental polls; reserve `dump` for a one-shot full
screen (or `tail` with `reset: true`).

## CLI Harness Compatibility

zSwarm is verified live against five CLI harnesses: **codex**, **cursor**, **pi**, **opencode**, and **gemini**.

- **Read ops** (`dump`, `tail`, `status`, `wait --for idle`, `expect`) work across all 5 harnesses.
- **Send ops** land on all 5 (`codex` auto-detects `submit=double-enter`, others use `auto`).
- **Replies can take > 60s.** Budget timeouts accordingly; a quiet pane is rarely a failed send.
- **`wait --match` on full-screen TUIs is viewport-and-moment dependent.** Full-screen TUIs own the alternate screen (no scrollback; `--full` is identical). Viewports can transiently redraw during output. Prefer `wait --for idle` (verified 100% in 1 poll across all harnesses) or match pinned UI text.
- **Re-testing**: Run `node scripts/harness-check.mjs <panes...>` to check live conformance.

## Prefix

Unless `raw: true`, sends are prefixed:

```text
[zswarm from=<sender>]
<body>
```

## Rules

1. Target **pane ids or names** from `list` — do not invent transports.
2. Name peers with `rename` right after `spawn`, then target them by name.
3. Prefer `send` + `wait` over polling. Prefer `tail` over repeated `dump`.
4. Check `submitted` on `send`; `false` means the peer never got it.
5. Prefer `diff` / `checkpoint` over reading a worktree by hand.
6. Not for IDE side-panel chats — only Zellij terminal panes.
7. Local machine only (same host as Zellij).
8. Writes refuse zSwarm's own pane (`self_target`) and exited panes (`pane_exited`).
   Override with `allowSelf` / `force` only when you mean it.
9. Policy env vars can block writes (`policy_denied` names the env var) — denial
   is configuration, not a bug.
10. `spawn` takes an executable plus argv — no shell, so no pipes or `&&`.
11. Prefer `worktree` on `spawn` when peers should not share one dirty tree.
    Tear down with `unworktree` after the pane is closed.
12. For crew barriers use `broadcast` + `signal` + `await`, not ad-hoc dumps.
