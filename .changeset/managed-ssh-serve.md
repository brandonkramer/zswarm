---
"@zswarm/core": patch
"@zswarm/cli": patch
"@zswarm/mcp": patch
---

Add ssh:// serve targets: process-owned SSH LocalForward, authenticated hello before ops and reuse, CLI/MCP dispose of in-flight children, independent caller deadlines. host:port and tcp:// stay compatible. An omitted SSH port is not forced to 22.
