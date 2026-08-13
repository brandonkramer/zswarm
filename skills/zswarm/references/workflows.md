# Workflows

## Barriers

Broadcast a task, each peer signals when done, await N:

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
`<repo>-worktrees` beside the repo (`ZSWARM_WORKTREE_ROOT`). Existing worktree
at the target path is reused. Git binary: `ZSWARM_GIT_BIN`.

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

```text
zswarm({ op: "send", to: "reviewer", body: "run the tests" })
zswarm({ op: "wait", to: "reviewer", for: "either", match: "FAIL", idleMs: 4000 })
```

Prefer `tail` for cheap incremental polls; reserve `dump` for a one-shot full
screen (or `tail` with `reset: true`).
