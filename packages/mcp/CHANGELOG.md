# @zswarm/mcp

## 0.1.8

### Patch Changes

- bc662c6: Add inspect-only `zswarm doctor` for local, direct SSH, and serve routes: layered controller/host checks, authenticated hello, lease-safe ssh://, no pane/plugin/state mutations.
- 572135d: Fix state-lock handoff: a departed observed owner no longer refuses acquisition when the lock was normally released or superseded. Contenders retry exclusive create within the existing wait budget; unchanged abandoned locks still fail closed. Await all 80 writeCursor children before fixture cleanup.
- 63e9959: Add ssh:// serve targets: process-owned SSH LocalForward, authenticated hello before ops and reuse, CLI/MCP dispose of in-flight children, independent caller deadlines. host:port and tcp:// stay compatible. An omitted SSH port is not forced to 22.
- bac6a60: Document and test private raw TCP Tailscale Serve: keep `zswarm serve` on loopback, forward with `tailscale serve --tcp=…`, and reach it via existing `--serve`/`tcp://` endpoints with mandatory token auth. No Funnel, HTTPS gateway, or PROXY protocol.
- 6a088ce: Allow `zswarm serve --listen` to bind an explicit local Tailscale IP after fresh daemon + OS ownership checks. Loopback remains the default; token auth stays mandatory; Windows install revalidates on every startup and clear still works when Tailscale is down.
- a5a4885: Windows `serve --install` waits for authenticated hello and host session visibility (not Start-ScheduledTask acceptance), keeps the current-user Interactive logon task, and documents the Tailscale crew recipe (OpenSSH over Tailscale, loopback + token).
- Updated dependencies [8613f5c]
- Updated dependencies [bc662c6]
- Updated dependencies [572135d]
- Updated dependencies [63e9959]
- Updated dependencies [bac6a60]
- Updated dependencies [00c7bff]
- Updated dependencies [6a088ce]
- Updated dependencies [a5a4885]
  - @zswarm/core@0.1.8

## 0.1.7

### Patch Changes

- Updated dependencies [618630e]
  - @zswarm/core@0.1.7

## 0.1.6

### Patch Changes

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

- Updated dependencies [6dec454]
  - @zswarm/core@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [5d1beea]
  - @zswarm/core@0.1.1
