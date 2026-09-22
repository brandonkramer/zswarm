---
"@zswarm/core": patch
"@zswarm/cli": patch
"@zswarm/wasm": patch
---

Improve detached crew spawning and targeting: use explicit tabs, preserve creation IDs, bound observation retries, and establish pane aliases for new tabs. Enforce expectations before keys/chars, expose waiting evidence and stable tab IDs in status, and include effective routing context in responses. Add CLI file/stdin bodies with newline preservation and interactive routing notices. Spawn `live` now describes an observed non-exited pane; inspect the new lifecycle fields for creation, observation, alias readiness, and exit status. Reload an existing bus plugin to obtain stable tab IDs; older instances report unknown IDs. Document the upstream empty-new-tab limit observed in freshly detached Zellij 0.45.1 sessions.
