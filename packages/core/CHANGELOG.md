# @zswarm/core

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
