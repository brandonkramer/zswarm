# Ops

MCP: `zswarm({ op, ... })`. CLI: `zswarm <op>`. Same surface.

| op | Purpose |
|----|---------|
| `list` | Terminal panes (id, title, command, tab); `verbose` adds cwd/flags |
| `send` | Paste body + Enter (`to` = id / title / command). `submit`: `auto` (default) / `double-enter` / `none`. Result `submitted: true\|false\|"unverified"`. `expect` refuses unless the screen already shows that substring |
| `dump` | Full-screen read; capped at 8000 chars (tail) — expensive vs `tail` |
| `tail` | Incremental read since last cursor; `reset: true` returns the whole screen |
| `wait` | Block until quiet or `match`; returns `reason` + a 2000-char tail. Bus holds one pipe for the wait |
| `status` | busy / waiting / idle / exited; `free[]` = idle ids. `sampleMs: 0` skips sampling. `sinceLast: true` skips the 400ms gap |
| `keys` | Key specs (`keys: ["Ctrl c"]`) or literal `chars` (+ `enter`) |
| `interrupt` | `Esc`; `hard: true` sends `Ctrl c` |
| `spawn` | New pane (`newTab: true` for a fresh tab) with `command`, `cwd`, `name`, `direction`, `floating`; `tab` = tab name; `worktree` isolates on a branch |
| `close` | Close a pane |
| `rename` | Retitle a pane (`to` + `name`) or a tab (`tab` + `name`) |
| `focus` | Focus a pane; already-focused is a no-op success |
| `tabs` | List tabs with pane counts |
| `layout` | Dump the session layout as KDL |
| `stack` | Stack a comma list of panes (needs 2+) |
| `broadcast` | One body to many panes (`to` list, `tab`, or `all`; narrow with `group`) |
| `signal` | Post to a channel (`channel`, optional `payload`); `clear` resets |
| `signals` | List channels with cumulative counts |
| `await` | Block until a channel reaches `count` posts |
| `log` | Delivery log for send/broadcast/keys/interrupt/close |
| `worktrees` | List repo git worktrees, annotated with panes working in them |
| `unworktree` | Remove a worktree (`path` or `branch`; `worktree` aliases `branch`) |
| `diff` | What a peer changed in its worktree |
| `checkpoint` | Commit a peer worktree (`message`); clean tree is not an error |
| `sessions` | Live Zellij session names |
| `bus` | Event-bus status; `install: true` loads the plugin, `clear: true` forgets it |
| `serve` | Listen for remote zswarm (`--listen`). `--install` / `--clear` = Windows logon task. MCP cannot listen; set `ZSWARM_SERVE` on the client. See [remote.md](remote.md) |

`submit=auto` retries Enter if the paste is still sitting in a TUI composer.
`submit=double-enter` always sends the extra Enter; `submit=none` skips the check.
Check `submitted` — a queued composer used to report success.

**Breaking:** `spawn`'s boolean `tab` is now `newTab`; `tab` is a tab **name**.

## expect

A pane that dropped back to a shell will **run** your message as a command.
Name something the screen must already show:

```text
zswarm({ op: "send", to: "reviewer", body: "…", expect: "Add a follow-up" })
```

Failure is `expect_missing` and nothing is written.

## Event bus

`zswarm({ op: "bus", install: true })` once per machine. After that `list` and
`status` read a pushed manifest (`source: "plugin"` or `"zellij"`). Off until
installed; any failure falls back silently — speed, not a dependency.

The manifest has no pane command or cwd, so a bus-served `list` omits `command`,
and `list` with `verbose` / `status --to <command>` keep polling. `status`
sampling and `wait` use the plugin; `dump` / `tail` stay on the CLI.
