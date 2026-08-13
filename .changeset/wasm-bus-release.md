---
"@zswarm/wasm": patch
"@zswarm/core": patch
"@zswarm/cli": patch
"@zswarm/mcp": patch
"@zswarm/pi": patch
"zswarm": patch
---

Publish the rebuilt event-bus wasm. The wall-clock wait fix landed after @zswarm/wasm@0.1.1, and the 0.1.5 release bumped core/CLI/MCP without it, so npm still ships the old plugin.
