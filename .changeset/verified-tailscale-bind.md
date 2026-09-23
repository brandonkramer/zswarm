---
"@zswarm/core": patch
"@zswarm/cli": patch
"@zswarm/mcp": patch
---

Allow `zswarm serve --listen` to bind an explicit local Tailscale IP after fresh daemon + OS ownership checks. Loopback remains the default; token auth stays mandatory; Windows install revalidates on every startup and clear still works when Tailscale is down.
