---
"@zswarm/core": patch
"@zswarm/cli": patch
"@zswarm/mcp": patch
---

Document and test private raw TCP Tailscale Serve: keep `zswarm serve` on loopback, forward with `tailscale serve --tcp=…`, and reach it via existing `--serve`/`tcp://` endpoints with mandatory token auth. No Funnel, HTTPS gateway, or PROXY protocol.
