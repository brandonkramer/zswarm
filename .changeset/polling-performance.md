---
"@zswarm/core": patch
"@zswarm/cli": patch
---

Prefer bus change observations for ordinary status, with explicit sampling and bounded fallback. Cache completed session/pane/tab listings briefly across MCP/serve calls, isolate routing/IPC contexts, and invalidate on mutations and bus revisions while keeping write targeting fresh. Reuse positive SSH IPC discovery, parallelize identity/capability and verbose status discovery under shared deadlines, and add --serve routing plus practical Windows serve/tunnel guidance. First bus observations are unknown until change history exists unless a recognized prompt is visible.
