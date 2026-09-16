---
"@zswarm/core": patch
"@zswarm/cli": patch
"@zswarm/mcp": patch
"@zswarm/pi": patch
"@zswarm/wasm": patch
"zswarm": patch
---

Stop the event-bus pane explosion. Install is idempotent per session, `--force`/`--clear` close orphan bus plugins, a silent pipe no longer rotates instance keys, and the wasm plugin no longer re-renders on every PaneUpdate.
