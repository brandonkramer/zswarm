---
"@zswarm/core": patch
"@zswarm/cli": patch
---

Point remote SSH at the live Zellij IPC temp (`ZSWARM_TMP=auto`), optionally run the CLI in the Windows desktop session (`ZSWARM_SSH_MODE=interactive`), and add `zswarm serve` so a client can talk to a worker next to Zellij over a tunnel.
