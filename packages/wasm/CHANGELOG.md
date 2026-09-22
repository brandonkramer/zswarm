# @zswarm/wasm

## 0.1.3

### Patch Changes

- 55cec73: Improve detached crew spawning and targeting: use explicit tabs, preserve creation IDs, bound observation retries, and establish pane aliases for new tabs. Enforce expectations before keys/chars, expose waiting evidence and stable tab IDs in status, and include effective routing context in responses. Add CLI file/stdin bodies with newline preservation and interactive routing notices. Spawn `live` now describes an observed non-exited pane; inspect the new lifecycle fields for creation, observation, alias readiness, and exit status. Reload an existing bus plugin to obtain stable tab IDs; older instances report unknown IDs. Document the upstream empty-new-tab limit observed in freshly detached Zellij 0.45.1 sessions.

## 0.1.2

### Patch Changes

- 4548c90: Stop the event-bus pane explosion. Install is idempotent per session, `--force`/`--clear` close orphan bus plugins, a silent pipe no longer rotates instance keys, and the wasm plugin no longer re-renders on every PaneUpdate.
- b256e2c: Publish the rebuilt event-bus wasm. The wall-clock wait fix landed after @zswarm/wasm@0.1.1, and the 0.1.5 release bumped core/CLI/MCP without it, so npm still ships the old plugin.

## 0.1.1

### Patch Changes

- cab8206: Close the holes the Sol review found: authenticate serve off loopback, stop mixing SSH Zellij with local git, treat readonly/signals/unworktree/Windows quoting as fail-closed, and keep plugin versions on the meta-package.
