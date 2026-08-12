---
name: zswarm
description: >-
  Coordinate CLI crews in Zellij panes via zSwarm MCP (list, send, dump).
  Use when messaging another Codex/Claude/Cursor CLI in a Zellij pane, listing
  panes, or dumping short scrollback. Local Zellij only — not IDE side-panel chat.
---

# zSwarm

Talk to other **CLI** sessions that live in Zellij panes (Codex CLI, Claude Code,
Cursor CLI, shells). Delivery is `zellij action paste` + Enter into that pane.

## Happy path

```text
zswarm({ op: "list" })
zswarm({ op: "send", to: "terminal_2", body: "please review the plan" })
```

Optional: `session` when multiple Zellij sessions exist, or set `ZSWARM_SESSION`.
CLI backup: `zswarm list|send|dump|sessions` (same ops; package `@zswarm/cli`).

## Ops

| op | Purpose |
|----|---------|
| `list` | Terminal panes (id, title, command, tab); `verbose` adds cwd/flags |
| `send` | Paste body + Enter into pane (`to` = id / title / command); ack is lean unless `verbose` |
| `dump` | Read pane screen; capped at 8000 chars (tail) by default — `max`, `head`, `full` |
| `sessions` | Live Zellij session names |

## Prefix

Unless `raw: true`, sends are prefixed:

```text
[zswarm from=<sender>]
<body>
```

## Rules

1. Target **pane ids** from `list` — do not invent transports.
2. Prefer `send` over `dump`. If you dump, avoid `full`; keep default `max` unless needed.
3. Not for IDE side-panel chats — only Zellij terminal panes.
4. Local machine only (same host as Zellij).
