# @zswarm/cli

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
