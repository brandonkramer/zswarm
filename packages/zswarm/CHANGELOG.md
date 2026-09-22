# zswarm

## 0.1.7

### Patch Changes

- Updated dependencies [55cec73]
  - @zswarm/cli@0.1.6
  - @zswarm/mcp@0.1.6

## 0.1.6

### Patch Changes

- 4548c90: Stop the event-bus pane explosion. Install is idempotent per session, `--force`/`--clear` close orphan bus plugins, a silent pipe no longer rotates instance keys, and the wasm plugin no longer re-renders on every PaneUpdate.
- b256e2c: Publish the rebuilt event-bus wasm. The wall-clock wait fix landed after @zswarm/wasm@0.1.1, and the 0.1.5 release bumped core/CLI/MCP without it, so npm still ships the old plugin.
- Updated dependencies [4548c90]
- Updated dependencies [b256e2c]
  - @zswarm/cli@0.1.5
  - @zswarm/mcp@0.1.5

## 0.1.5

### Patch Changes

- a5eb887: Review follow-up: gate release on master CI, ship policy env vars, locate MCP without a tracked dist, keep wasm in lockstep, and fix wait clocks, empty sessions, SSH quoting, and Pi call timeouts.
- 8ae6839: Default send/broadcast `from` to the sending pane's title (or `ZSWARM_FROM`) instead of always `swarm`.
- Updated dependencies [a5eb887]
- Updated dependencies [8ae6839]
  - @zswarm/cli@0.1.4
  - @zswarm/mcp@0.1.4

## 0.1.4

### Patch Changes

- Updated dependencies [cab8206]
  - @zswarm/cli@0.1.3
  - @zswarm/mcp@0.1.3

## 0.1.3

### Patch Changes

- Updated dependencies [6dec454]
  - @zswarm/cli@0.1.2
  - @zswarm/mcp@0.1.2

## 0.1.2

### Patch Changes

- @zswarm/cli@0.1.1
  - @zswarm/mcp@0.1.1
