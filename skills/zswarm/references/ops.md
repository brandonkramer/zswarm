# Ops

MCP: `zswarm({ op, ... })`. CLI: `zswarm <op>`. Same surface.

| op | Purpose |
|----|---------|
| `list` | Terminal panes (id, title, command, tab); `verbose` adds cwd/flags |
| `send` | Paste body + Enter (`to` = id / title / command). `from` labels `[zswarm from=…]` (default: `ZSWARM_FROM`, else the sending pane's title, else `swarm`). `submit`: `auto` (default) / `double-enter` / `none`. Result `submitted: true\|false\|"unverified"`. `expect` refuses unless the screen already shows that substring |
| `dump` | Full-screen read; capped at 8000 chars (tail) — expensive vs `tail` |
| `tail` | Incremental read since last cursor; `reset: true` returns the whole screen |
| `wait` | Block until quiet or `match`; returns `reason` + a 2000-char tail. Bus holds one pipe for the wait |
| `status` | busy / waiting / idle / exited / unknown, with tab names/IDs, tab summary and waiting evidence; `free[]` = idle ids. `sampleMs: 0` skips sampling. `sinceLast: true` skips the 400ms gap |
| `keys` | `expect` is checked before any input. Key specs (`keys: ["Ctrl c"]`) or literal `chars` (+ `enter`) |
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
| `doctor` | Inspect-only local/SSH/serve diagnosis (no install/fix). See [doctor.md](../../../docs/doctor.md) |

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

`zswarm({ op: "bus", install: true })` once per Zellij session. After that
`list` and `status` read a pushed manifest (`source: "plugin"` or `"zellij"`).
Off until installed; any failure falls back silently — speed, not a dependency.
Do not pass `force` to recover from a quiet bus: that used to stack WASM copies.
Approve the existing pane's permission prompt, or `force` only when you mean to
close every bus plugin pane and load one replacement. Keep the floating pane
open; closing it unloads the bus.

The manifest has no pane command or cwd, so a bus-served `list` omits `command`,
and `list` with `verbose` / `status --to <command>` keep polling. `status`
sampling and `wait` use the plugin; `dump` / `tail` stay on the CLI.

## Reliable spawn and handoffs

Keep the returned session + pane ID. Spawn creates once and observes for up to
`observeMs` (default 3000), within one `timeoutMs` budget (default 30000).
`created` is the creation acknowledgment; `observed`, `exited`, `observation`,
`alias.observed`, and `ready` describe what was actually seen. `live` means
observed and not exited; it does not establish application readiness. An
observation timeout can accompany `ok: true`: retry reads before spawning again.
New-tab correlation stays within the returned tab and ambiguous layouts remain
unresolved. `newTab` + `name` also establishes the terminal alias when observed.
Pane lookups retry absence for 1000ms; `observeMs: 0` disables retries.

CLI: `send --body-file PATH` reads a local UTF-8 file before remote forwarding;
`--body-file -` reads stdin. Do not combine with `--body`/`--text`/a positional
body. Newlines are preserved. MCP uses `body`, never its protocol stdin. Paste
still uses argv, so reference a shared file for very large handoffs.

For menus: wait for a match and check `reason`, perform one
`keys --expect TEXT --key Enter`, then wait for the resulting state. `expect`
also applies to `chars` and `interrupt`. It is a fresh case-insensitive screen
check, not an atomic transaction. Serialize input per pane and avoid blind
retries. Waiting evidence is a screen heuristic, not authorization to approve.

Ordinary status uses bus changes without a sample gap by default; first/missing observations are unknown unless a prompt is visible. `sampleMs` explicitly selects two-sample observation (0 = metadata only). Bus change history is shared by the plugin instance. Read-only listings use a 500ms process cache; `fresh: true` bypasses it, and `ZSWARM_CACHE_TTL_MS=0` disables reuse. Writes/spawn settling use fresh metadata. Serve retains caches across client CLI calls.
