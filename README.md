# zSwarm

Coordinate CLI AI crews across **Zellij** terminal panes. Control agents, pass prompts between panes, manage git worktrees, inspect outputs, and sync crew tasks via CLI or Model Context Protocol (MCP).

```text
                       you ──▶ any agent ──┐
                                           │ zswarm({op:"send", to:"reviewer"})
                                           ▼
      every pane can call zswarm ──▶ ┌─────────┐
      so agents drive each other     │ zswarm  │
                                     │ cli/mcp │
                                     └────┬────┘
                       paste + Enter ┌────┴────┐ read screen / pushed state
                                     ▼         ▼
 ══ this machine ══════════════════════════════╗ ══ ssh user@build-01 ═════════╗
   zellij "crew"                               ║   zellij "ci"                 ║
                                               ║                               ║
   ┌────────────┐  send   ┌────────────┐       ║   ┌────────────┐              ║
   │ codex      │────────▶│ claude     │───────╫──▶│ opencode   │              ║
   │ builder    │◀────────│ reviewer   │  send ║   │ test-runner│              ║
   │ wt:feat-a  │ signal  │ wt:rev-a   │       ║   │ wt:feat-a  │              ║
   └────────────┘         └────────────┘       ║   └──────┬─────┘              ║
   ┌────────────┐         ┌────────────┐       ║   ┌──────▼─────┐              ║
   │ cursor     │         │ agy        │       ║   │ pi         │              ║
   │ refactor   │         │ docs       │       ║   │ deploy     │              ║
   │ wt:feat-b  │         │ wt:docs    │       ║   │ cwd:/srv   │              ║
   └────────────┘         └────────────┘       ║   └────────────┘              ║
 ═══════════════════════════════════════════════╝ ══════════════════════════════╝
     one pane = one agent + one role + optionally its own worktree
     any pane can drive any other, on this machine or across the ssh boundary
```

---

## ⚡ Quick Start

### Requirements
- **Zellij** ≥ 0.42 on `PATH` (or set `ZSWARM_BIN` / `ZSWARM_PATH`)
- **Node.js** ≥ 20

### Installation
```bash
npm i -g zswarm
zswarm list
```

Enable the optional Zellij event-bus plugin once per machine for zero-polling state updates:
```bash
zswarm bus --install
```

### MCP Server Setup
Configure `zswarm-mcp` (stdio MCP server bundled with the package) in your MCP host:

```json
{
  "mcpServers": {
    "zswarm": {
      "command": "/absolute/path/to/zswarm-mcp",
      "env": {
        "ZSWARM_SESSION": "my-zellij-session"
      }
    }
  }
}
```
> **Note:** Use the absolute path to `zswarm-mcp` and specify `ZSWARM_SESSION` to prevent ambiguous session errors when multiple Zellij sessions run.

---

## Usage & Quick Syntax

Every operation is supported both via **CLI** (`zswarm <op> [flags]`) and **MCP** (`zswarm({ op: "<op>", ... })`).

### Essential Examples

```bash
# 1. Inspect Panes & Status
zswarm list                                     # List active panes
zswarm status                                   # Check status: busy | waiting | idle | exited

# 2. Spawn Panes & Worktrees
zswarm spawn --command "claude" --name reviewer # Spawn agent pane
zswarm spawn --command "codex" --worktree feature-auth --name auth-dev   # Isolated git worktree pane

# 3. Pass Prompts & Input
zswarm send --to reviewer --body "Review changes in src/" --submit auto
zswarm keys --to reviewer --key "Ctrl c"        # Send special keys / interrupts

# 4. Read Outputs & Wait
zswarm dump --to reviewer --max 4000            # Read recent screen tail
zswarm tail --to reviewer                       # Incremental read since last check
zswarm wait --to reviewer --match "DONE"        # Block until pattern matched or pane idle

# 5. Coordinate Crew & Sync Signals
zswarm broadcast --all --group builder --body "Run test suite"  # group matches pane title or command
zswarm signal --channel tests --payload ok      # Send signal to durable channel
zswarm await --channel tests --count 3          # Wait for 3 worker signals
```

---

## 📋 Operations Reference

| Operation | Purpose | Key Parameters / Flags |
|---|---|---|
| `list` / `sessions` | List panes or live Zellij sessions | `verbose` |
| `status` | Panes classified by state (`idle`, `busy`, `waiting`, `exited`) | `to`, `sampleMs`, `since-last` |
| `spawn` | Launch command in new pane, tab, or git worktree | `command`, `name`, `cwd`, `worktree`, `tab`, `newTab` |
| `send` | Send text / prompt into a pane | `to`, `body`, `submit` (`auto`\|`double-enter`\|`none`), `expect` |
| `dump` | Read screen content (screen tail) | `to`, `max` (default 8000) |
| `tail` | Incremental screen read since last cursor | `to`, `reset` |
| `wait` | Block until quiet, pattern match, or idle | `to`, `match`, `for` (`idle`), `idleMs`, `timeoutMs` |
| `broadcast` | Send one prompt to multiple panes | `to`, `tab`, `all`, `group`, `body` |
| `keys` / `interrupt` | Send key combos (`Ctrl c`, `Esc`) or raw chars | `to`, `keys`, `chars`, `enter`, `hard` |
| `close` | Close a pane | `to`, `force` |
| `signal` / `signals` / `await` | Durable message channels & barrier sync | `channel`, `payload`, `count` |
| `worktrees` / `unworktree` | List or remove managed git worktrees | `cwd`, `branch`, `path`, `force` |
| `diff` / `checkpoint` | Inspect peer worktree patch or autocommit WIP | `branch`, `path`, `stat`, `message` |
| `rename` / `focus` | Retitle pane/tab or focus pane | `to`, `tab`, `name` |
| `tabs` / `layout` / `stack` | Inspect tabs, layout KDL, or stack panes | `to`, `max` |
| `bus` / `log` | Event bus plugin management & delivery log | `install`, `clear`, `failed`, `limit` |

---

## 🛡️ Safety & Policy Guards

- **Self-Target Guard:** Operations refuse to modify zSwarm's own pane (`allowSelf: true` to override).
- **Execution & Exited Guards:** Prevents writing to exited panes (`force: true` to override).
- **Prompt Safety (`expect`):** `send --expect <text>` ensures target pane screen contains `<text>` before writing (prevents accidental shell execution).
- **Submission Verification (`submit`):** `auto` verifies text submission into TUI composers and retries Enter if unsubmitted.

### Environment Security Controls

| Env Variable | Effect |
|---|---|
| `ZSWARM_READONLY=1` | Disable all write ops (`send`, `spawn`, `close`, etc.) |
| `ZSWARM_ALLOW_PANES` / `ZSWARM_DENY_PANES` | Comma-separated list/patterns of allowed/denied pane titles |
| `ZSWARM_ALLOW_SPAWN=0` | Disable spawning new panes |
| `ZSWARM_ALLOW_CLOSE=0` | Disable closing panes |
| `ZSWARM_ALLOW_WORKTREE_REMOVE=0` | Disable removing git worktrees |

---

## ⚙️ Environment Variables

| Variable | Description |
|---|---|
| `ZSWARM_BIN` / `ZSWARM_PATH` | Path to `zellij` executable |
| `ZSWARM_SESSION` | Default Zellij session name |
| `ZELLIJ_SESSION_NAME` | Active Zellij session (set automatically inside Zellij panes) |
| `ZSWARM_WORKTREE_ROOT` | Directory for linked worktrees (default: `<repo>-worktrees`) |
| `ZSWARM_STATE_DIR` | State storage directory for logs, signals, and cursors (default: `~/.zswarm`) |
| `ZSWARM_SSH` | `user@host` — Route Zellij commands across SSH |
| `ZSWARM_REMOTE_BIN` | Remote `zellij` binary (`zellij.exe` on Windows) |
| `ZSWARM_TMP` | Remote IPC temp directory, or `auto` to parse live `zellij --server` paths |
| `ZSWARM_SSH_MODE` | `interactive` — Windows only: run each CLI call in the desktop session (scheduled task, same idea as `schtasks /IT`) |
| `ZSWARM_REMOTE_SHELL` | `cmd` or `sh` — override remote quoting (inferred from `.exe` / Windows tmp / interactive) |
| `ZSWARM_SERVE` | `127.0.0.1:9419` — Forward ops to `zswarm serve` (usually over an SSH tunnel) |
| `ZSWARM_SERVE_TOKEN` | Shared secret for `zswarm serve`. Required to listen off loopback; send the same value on the client |

### Remote crews

Linux/macOS SSH works when it is the same user and `$TMPDIR`. Windows OpenSSH is session 0; live Zellij is usually the interactive desktop session. `ZSWARM_TMP=auto` points at that TEMP (enough to list sessions). Pane attach on Windows uses named pipes in the desktop session, so use `ZSWARM_SSH_MODE=interactive` or run `zswarm serve` next to Zellij.

```bash
# Linux/macOS, same user:
ZSWARM_SSH=user@host zswarm list

# Point SSH at the interactive TEMP (auto reads zellij --server …)
ZSWARM_SSH=user@host ZSWARM_TMP=auto zswarm sessions

# Windows: run the CLI inside the desktop session. Discovers TEMP unless ZSWARM_TMP is set.
ZSWARM_SSH=user@host ZSWARM_SSH_MODE=interactive zswarm list

# Any OS: run zswarm next to Zellij; another machine talks over a tunnel
# On the host, in the session that owns Zellij:
zswarm serve --listen 127.0.0.1:9419
# Windows, once: zswarm serve --install
# On the client:
ssh -fN -L 9419:127.0.0.1:9419 user@host
ZSWARM_SERVE=127.0.0.1:9419 zswarm list
```

`file:` plugin URLs stay on the machine that owns Zellij. A client with `ZSWARM_SERVE` never sends a local wasm path across the tunnel.

```json
{
  "mcpServers": {
    "zswarm": {
      "command": "/absolute/path/to/zswarm-mcp",
      "env": {
        "ZSWARM_SERVE": "127.0.0.1:9419",
        "ZSWARM_SESSION": "crew"
      }
    }
  }
}
```

---

## 📦 Monorepo Structure

| Package | Purpose |
|---|---|
| `zswarm` | Main meta-package (`npm i -g zswarm`) |
| `@zswarm/core` | Core Zellij client and shared dispatch engine |
| `@zswarm/cli` | `zswarm` command line interface |
| `@zswarm/mcp` | Stdio MCP server (`zswarm-mcp`) |
| `@zswarm/wasm` | Precompiled Rust event-bus WASM plugin |
| `@zswarm/pi` | Extension bridge for harnesses without native MCP support |

---

## 📜 License

[MIT](LICENSE)
