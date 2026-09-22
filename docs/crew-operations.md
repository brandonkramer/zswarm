## Reliable crew operations

Spawn creates once and observes the result for up to `--observe-ms 3000`, within
one overall `--timeout-ms 30000` budget covering Zellij setup, creation and
observation. A missing pane is never a reason to automatically spawn a duplicate.
`--observe-ms 0` performs one observation without retries.

Spawns explicitly target a tab: `--tab NAME` selects one, otherwise a focused
pane's tab or the first available tab is used, including when no viewer is
attached. `--new-tab --name reviewer` also renames the created terminal to
`reviewer` and observes the alias before returning when the budget permits.
Creation IDs are retained. New-tab resolution is restricted to the returned tab;
it requires a single candidate on two consecutive observations, and multiple
candidates remain unresolved. With zero observation retries a new tab can return
only its tab handle.

| Spawn field | Meaning |
| --- | --- |
| `created` | Zellij acknowledged the creation action |
| `paneId` / `tabId` | Creation/observation handles; retain with transport and session |
| `observed` / `exited` | Pane appeared in the latest observation; exit is `null` if unknown |
| `observation.status` | `observed`, `timeout`, `ambiguous`, or `unresolved` |
| `alias.observed` | A requested terminal name is visible to subsequent lookups |
| `live` | Legacy convenience: observed and not exited; not application readiness |
| `ready` | `unknown`, or `false` for a held exited pane |

`ok: true` can therefore include an observation timeout. Use the returned pane
ID while an alias is pending. Pane lookups retry absence for 1000ms by default
(`--observe-ms` overrides this), within the invocation's timeout budget; ambiguity
fails immediately. A typed ID never falls back to another pane's title.
Cancellation after an acknowledged create includes its handles and `created: true`
in `error.details`, so the controller can inspect that creation before retrying.

In local Linux smoke testing on Zellij 0.45.1, a new tab in a freshly detached
session could remain empty through the observation deadline; direct Zellij
reproduced the same result. Existing-tab shell and command spawns worked without
a viewer. Prefer an initialized existing tab for detached crews. An empty new
tab returns its tab handle and unknown readiness, rather than claiming a terminal
from another tab or creating another worker automatically.

Ordinary `status` includes each peer's `tab` and stable `tabId`, plus a compact
`tabs` summary for the selected peers. No active-tab filter is applied. A running
bus plugin from an older version reports `tabId: null` until reloaded.

For handoffs, read a UTF-8 file or explicit stdin on the caller's machine:

```bash
zswarm --local send --session crew --to reviewer --body-file handoff.md
zswarm send --session crew --to terminal_9 --body-file - < handoff.md
```

File paths are consumed before SSH/serve forwarding. Newlines are preserved.
Exactly one body source is permitted. MCP continues to accept `body`; its stdin
is reserved for the MCP protocol. Zellij paste still uses argv, so downstream
command-length limits remain; use a short handoff referencing a shared file for
very large briefs. Check `submitted` and obtain acknowledgment if unverified.

`send`, `keys` (including `--chars --enter`), and `interrupt` enforce
`--expect TEXT` as a case-insensitive substring immediately before input. A
missing expectation or failed screen read prevents input. For interactive menus:

1. `wait --match TEXT --timeout-ms 10000` and check `reason == "match"`.
2. Perform one `keys --expect TEXT --key Enter` against the same pane ID.
3. Wait for the expected resulting screen and inspect its reason.

Separate reads and input are not atomic. Serialize input per pane and avoid
blind key retries or relying on a menu option's position. Status exposes
`waiting: { reason, evidence, source: "screen" }` for recognized prompts and
structured approval menus. This is screen evidence, not a semantic approval
event. Quiet output does not establish readiness. Unknown/missing observations
stay out of `free`; `--sample-ms 0` does not detect prompts.

Dedicated crew Zellij configurations can set `show_startup_tips false` and
`show_release_notes false`. Correct TERM in the environment that starts the
worker. Terminal dumps do not establish the state of every Zellij overlay;
there is deliberately no generic overlay boolean. Preserve exit output for
diagnosis, and use cooperative ready/done signals where possible.

Every dispatched response includes `context` with effective `transport`,
`host`, `session`, and configuration `origin`. For serve, `context.host`
is the endpoint (possibly a local tunnel) and `context.server` identifies the
server's routing and resolved session when supported. Configuration errors before
routing resolves have no context. Interactive CLI calls print a concise routing
notice to stderr; stdout remains JSON.
Serve forwards an explicit session argument; otherwise session defaults are
resolved on the server, not copied from the caller's environment.

`--local` clears SSH, serve and remote IPC for one invocation and preserves the
parent environment. Session selection still follows `--session` →
`ZSWARM_SESSION` → `ZELLIJ_SESSION_NAME` → sole live session. Use a launcher
with fixed `--local --session crew` for local work, and scope remote environment
variables to the remote launcher. Configure MCP server environments explicitly.
SSH alone does not share git/barrier state: remote worktrees and `signal/await`
require `serve` on the host that owns the crew.

Ordinary status prefers bus change observations when available. See [polling performance](performance.md) for explicit sampling, listing cache controls, and the recommended Windows serve/tunnel setup.
