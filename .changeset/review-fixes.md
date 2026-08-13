---
"@zswarm/core": patch
"@zswarm/cli": patch
"@zswarm/mcp": patch
"@zswarm/wasm": patch
---

Close the holes the Sol review found: authenticate serve off loopback, stop mixing SSH Zellij with local git, treat readonly/signals/unworktree/Windows quoting as fail-closed, and keep plugin versions on the meta-package.
