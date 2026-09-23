---
"@zswarm/core": patch
"@zswarm/cli": patch
"@zswarm/mcp": patch
---

Fix state-lock handoff: a departed observed owner no longer refuses acquisition when the lock was normally released or superseded. Contenders retry exclusive create within the existing wait budget; unchanged abandoned locks still fail closed. Await all 80 writeCursor children before fixture cleanup.
