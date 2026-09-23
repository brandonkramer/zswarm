# @zswarm/core

## 0.1.8

### Patch Changes

- 8613f5c: Refuse `bus --install` / `--clear` over direct SSH with `bus_remote_unsupported` before session discovery or marker writes. Run those mutations on the Zellij host or through `--serve`; read-only remote bus reports are unchanged.
- bc662c6: Add inspect-only `zswarm doctor` for local, direct SSH, and serve routes: layered controller/host checks, authenticated hello, lease-safe ssh://, no pane/plugin/state mutations.
- 572135d: Fix state-lock handoff: a departed observed owner no longer refuses acquisition when the lock was normally released or superseded. Contenders retry exclusive create within the existing wait budget; unchanged abandoned locks still fail closed. Await all 80 writeCursor children before fixture cleanup.
- 63e9959: Add ssh:// serve targets: process-owned SSH LocalForward, authenticated hello before ops and reuse, CLI/MCP dispose of in-flight children, independent caller deadlines. host:port and tcp:// stay compatible. An omitted SSH port is not forced to 22.
- bac6a60: Document and test private raw TCP Tailscale Serve: keep `zswarm serve` on loopback, forward with `tailscale serve --tcp=…`, and reach it via existing `--serve`/`tcp://` endpoints with mandatory token auth. No Funnel, HTTPS gateway, or PROXY protocol.
- 00c7bff: Add authenticated serve hello (protocol 1) and transport diagnostics: probeServe, UTF-8 JSONL reply caps sized for dump/status (8MiB capture, no silent truncate), required success `data`, and connect/hello/request error details without SSH fallback.
- 6a088ce: Allow `zswarm serve --listen` to bind an explicit local Tailscale IP after fresh daemon + OS ownership checks. Loopback remains the default; token auth stays mandatory; Windows install revalidates on every startup and clear still works when Tailscale is down.
- a5a4885: Windows `serve --install` waits for authenticated hello and host session visibility (not Start-ScheduledTask acceptance), keeps the current-user Interactive logon task, and documents the Tailscale crew recipe (OpenSSH over Tailscale, loopback + token).

## 0.1.7

### Patch Changes

- 618630e: Prefer bus change observations for ordinary status, with explicit sampling and bounded fallback. Cache completed session/pane/tab listings briefly across MCP/serve calls, isolate routing/IPC contexts, and invalidate on mutations and bus revisions while keeping write targeting fresh. Reuse positive SSH IPC discovery, parallelize identity/capability and verbose status discovery under shared deadlines, and add --serve routing plus practical Windows serve/tunnel guidance. First bus observations are unknown until change history exists unless a recognized prompt is visible.

## 0.1.6

### Patch Changes

- 55cec73: Improve detached crew spawning and targeting: use explicit tabs, preserve creation IDs, bound observation retries, and establish pane aliases for new tabs. Enforce expectations before keys/chars, expose waiting evidence and stable tab IDs in status, and include effective routing context in responses. Add CLI file/stdin bodies with newline preservation and interactive routing notices. Spawn `live` now describes an observed non-exited pane; inspect the new lifecycle fields for creation, observation, alias readiness, and exit status. Reload an existing bus plugin to obtain stable tab IDs; older instances report unknown IDs. Document the upstream empty-new-tab limit observed in freshly detached Zellij 0.45.1 sessions.
- Updated dependencies [55cec73]
  - @zswarm/wasm@0.1.3

## 0.1.5

### Patch Changes

- 4548c90: Stop the event-bus pane explosion. Install is idempotent per session, `--force`/`--clear` close orphan bus plugins, a silent pipe no longer rotates instance keys, and the wasm plugin no longer re-renders on every PaneUpdate.
- b256e2c: Publish the rebuilt event-bus wasm. The wall-clock wait fix landed after @zswarm/wasm@0.1.1, and the 0.1.5 release bumped core/CLI/MCP without it, so npm still ships the old plugin.
- Updated dependencies [4548c90]
- Updated dependencies [b256e2c]
  - @zswarm/wasm@0.1.2

## 0.1.4

### Patch Changes

- a5eb887: Review follow-up: gate release on master CI, ship policy env vars, locate MCP without a tracked dist, keep wasm in lockstep, and fix wait clocks, empty sessions, SSH quoting, and Pi call timeouts.
- 8ae6839: Default send/broadcast `from` to the sending pane's title (or `ZSWARM_FROM`) instead of always `swarm`.

## 0.1.3

### Patch Changes

- cab8206: Close the holes the Sol review found: authenticate serve off loopback, stop mixing SSH Zellij with local git, treat readonly/signals/unworktree/Windows quoting as fail-closed, and keep plugin versions on the meta-package.
- Updated dependencies [cab8206]
  - @zswarm/wasm@0.1.1

## 0.1.2

### Patch Changes

- 6dec454: Point remote SSH at the live Zellij IPC temp (`ZSWARM_TMP=auto`), optionally run the CLI in the Windows desktop session (`ZSWARM_SSH_MODE=interactive`), and add `zswarm serve` so a client can talk to a worker next to Zellij over a tunnel.

## 0.1.1

### Patch Changes

- 5d1beea: Nudge Zellij into pushing a manifest to a cold plugin, and accept flags before the op.
  
  Zellij pushes a pane manifest on change and never on subscribe, and the plugin
  API cannot ask for one, so a freshly launched bus instance sat at `ready:false`
  in a quiet session and every call fell back to polling. Renaming a pane to the
  title it already has is an invisible change that forces the push.
  
  `parseCliArgv` also took the first argument as the op unconditionally, so
  `zswarm --session crew list` reported `--session` as an unknown op.
  
  Both landed in git before the meta-package was published, but the wrapper shipped
  pinning the previous versions, so neither reached npm.
