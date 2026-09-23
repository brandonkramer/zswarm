---
"@zswarm/core": patch
"@zswarm/cli": patch
"@zswarm/mcp": patch
---

Windows `serve --install` waits for authenticated hello and host session visibility (not Start-ScheduledTask acceptance), keeps the current-user Interactive logon task, and documents the Tailscale crew recipe (OpenSSH over Tailscale, loopback + token).
