# @zswarm/cli

## 0.1.6

### Patch Changes

- 55cec73: Improve detached crew spawning and targeting: use explicit tabs, preserve creation IDs, bound observation retries, and establish pane aliases for new tabs. Enforce expectations before keys/chars, expose waiting evidence and stable tab IDs in status, and include effective routing context in responses. Add CLI file/stdin bodies with newline preservation and interactive routing notices. Spawn `live` now describes an observed non-exited pane; inspect the new lifecycle fields for creation, observation, alias readiness, and exit status. Reload an existing bus plugin to obtain stable tab IDs; older instances report unknown IDs. Document the upstream empty-new-tab limit observed in freshly detached Zellij 0.45.1 sessions.
- Updated dependencies [55cec73]
  - @zswarm/core@0.1.6

## 0.1.5

### Patch Changes

- 4548c90: Stop the event-bus pane explosion. Install is idempotent per session, `--force`/`--clear` close orphan bus plugins, a silent pipe no longer rotates instance keys, and the wasm plugin no longer re-renders on every PaneUpdate.
- b256e2c: Publish the rebuilt event-bus wasm. The wall-clock wait fix landed after @zswarm/wasm@0.1.1, and the 0.1.5 release bumped core/CLI/MCP without it, so npm still ships the old plugin.
- Updated dependencies [4548c90]
- Updated dependencies [b256e2c]
  - @zswarm/core@0.1.5

## 0.1.4

### Patch Changes

- a5eb887: Review follow-up: gate release on master CI, ship policy env vars, locate MCP without a tracked dist, keep wasm in lockstep, and fix wait clocks, empty sessions, SSH quoting, and Pi call timeouts.
- 8ae6839: Default send/broadcast `from` to the sending pane's title (or `ZSWARM_FROM`) instead of always `swarm`.
- Updated dependencies [a5eb887]
- Updated dependencies [8ae6839]
  - @zswarm/core@0.1.4

## 0.1.3

### Patch Changes

- cab8206: Close the holes the Sol review found: authenticate serve off loopback, stop mixing SSH Zellij with local git, treat readonly/signals/unworktree/Windows quoting as fail-closed, and keep plugin versions on the meta-package.
- Updated dependencies [cab8206]
  - @zswarm/core@0.1.3

## 0.1.2

### Patch Changes

- 6dec454: Point remote SSH at the live Zellij IPC temp (`ZSWARM_TMP=auto`), optionally run the CLI in the Windows desktop session (`ZSWARM_SSH_MODE=interactive`), and add `zswarm serve` so a client can talk to a worker next to Zellij over a tunnel.
- Updated dependencies [6dec454]
  - @zswarm/core@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [5d1beea]
  - @zswarm/core@0.1.1
