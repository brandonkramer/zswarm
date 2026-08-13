---
name: zswarm
description: >-
  Coordinate CLI crews in Zellij panes via zSwarm MCP (list, send, dump, tail,
  wait, status, keys, interrupt, spawn, close, broadcast, signal, signals,
  await, log, worktrees, unworktree, rename, focus, tabs, layout, stack, diff,
  checkpoint, bus, serve). Use when messaging another Codex, Claude Code, Cursor
  CLI, pi, OpenCode, or agy session in a Zellij pane, waiting for one to finish,
  broadcasting to a crew, signalling barriers,
  interrupting, opening a new crew pane, isolating peers in git worktrees,
  reviewing peer diffs/checkpoints, renaming/focusing panes, or dumping short
  scrollback. Same host as Zellij, or ZSWARM_SSH / ZSWARM_SERVE for a remote
  crew — not IDE side-panel chat.
---

# zSwarm

Talk to **CLI** sessions in Zellij panes (Codex, Claude Code, Cursor CLI, pi, OpenCode, agy, shells).
Delivery is `zellij action paste` + Enter. Not IDE side-panel chat.

## Happy path

```text
zswarm({ op: "list" })
zswarm({ op: "send", to: "reviewer", body: "please review the plan" })
zswarm({ op: "wait", to: "reviewer", for: "idle" })
```

`session` when more than one Zellij session is live, or set `ZSWARM_SESSION`.
Resolution: arg → `ZSWARM_SESSION` → `ZELLIJ_SESSION_NAME` → the sole live session.
MCP hosts inherit neither PATH nor Zellij env — absolute interpreter + `ZSWARM_SESSION`.
CLI backup: `zswarm <op>` (`@zswarm/cli`).

## Read when needed

- Ops, submit/expect, bus: [references/ops.md](references/ops.md)
- Remote SSH (Linux / macOS / Windows) / serve: [references/remote.md](references/remote.md)
- Barriers, worktrees, review, wait: [references/workflows.md](references/workflows.md)
- Harness notes: [references/harness.md](references/harness.md)

## Prefix

Unless `raw: true`:

```text
[zswarm from=<sender>]
<body>
```

## Rules

1. Target **pane ids or names** from `list` — do not invent transports.
2. `rename` right after `spawn`, then target by name.
3. Prefer `send` + `wait` over polling. Prefer `tail` over repeated `dump`.
4. Check `submitted` on `send`; `false` means the peer never got it.
5. Prefer `diff` / `checkpoint` over reading a worktree by hand.
6. Zellij terminal panes only — not IDE side-panel chats.
7. Same host as Zellij, or `ZSWARM_SSH` / `ZSWARM_SERVE`. Linux/macOS SSH is
   the same user + `$TMPDIR`. Windows pane attach: `ZSWARM_SSH_MODE=interactive`
   or `zswarm serve` next to Zellij. `file:` wasm stays on the box that owns
   Zellij. Details: [references/remote.md](references/remote.md).
8. Writes refuse own pane (`self_target`) and exited panes (`pane_exited`).
   Override with `allowSelf` / `force` only when you mean it.
9. Policy env vars can block writes (`policy_denied` names the env var).
10. `spawn` is executable + argv — no shell, so no pipes or `&&`.
11. Prefer `worktree` on `spawn` when peers should not share one dirty tree.
    Tear down with `unworktree` after the pane is closed.
12. Crew barriers: `broadcast` + `signal` + `await`, not ad-hoc dumps.
