# Harness notes

Verified live against **codex**, **cursor**, **pi**, **opencode**, and **gemini** (`agy`).

- **Read** (`dump`, `tail`, `status`, `wait --for idle`, `expect`) works on all five.
- **Send** lands on all five (`codex` auto-detects `submit=double-enter`, others `auto`).
- **Replies can take > 60s.** Budget timeouts; a quiet pane is rarely a failed send.
- **`wait --match` on a redrawing TUI is viewport-and-moment dependent.** Those apps
  own the alternate screen (no scrollback; `--full` is identical). Prefer
  `wait --for idle` or match text the harness keeps pinned.
- Re-test: `node scripts/harness-check.mjs <panes...>`

Reaching zswarm from a harness is separate from driving one:

- **4 of 5 have an MCP client** — they reach zswarm once session and interpreter
  path are explicit in the server config.
- **1 ships no MCP client** — use `@zswarm/cli`, or the generic MCP bridge at
  `.pi/extensions/zswarm-mcp.ts` (`ZSWARM_MCP_SERVERS`).
- **Being a target needs no integration.** All five are drivable with
  `send` / `dump` / `tail` / `wait` / `status`.
