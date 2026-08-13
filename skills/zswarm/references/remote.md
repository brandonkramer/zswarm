# Remote crews

Client (MCP or CLI) talks to Zellij on another machine. `file:` wasm stays on
the host that owns Zellij.

## Linux / macOS

Same user, same `$TMPDIR` — SSH is enough:

```bash
ZSWARM_SSH=user@host zswarm list
ZSWARM_SSH=user@host zswarm send --to reviewer --body "please review"
```

If the remote Zellij uses a different socket dir than the SSH login's `$TMPDIR`:

```bash
ZSWARM_SSH=user@host ZSWARM_TMP=auto zswarm list
# or set ZSWARM_TMP to that directory explicitly
```

`auto` reads live `zellij --server` paths (`ps` on Unix). `serve` (below) is
optional when SSH already sees the sockets.

## Windows

OpenSSH is session 0; live Zellij is usually the desktop session. Named pipes
live there, so SSH + TEMP can **list sessions** but not attach panes.

```text
ZSWARM_SSH=user@host ZSWARM_TMP=auto                 → sessions
ZSWARM_SSH=user@host ZSWARM_SSH_MODE=interactive     → list/send
```

`interactive` is Windows-only: `schtasks /IT` in the desktop session. Discovers
TEMP unless `ZSWARM_TMP` is set. `ZSWARM_REMOTE_BIN=zellij.exe` if `zellij` is
not on the remote PATH. `ZSWARM_REMOTE_SHELL=cmd|sh` overrides quoting.

## Serve (any OS)

Run zswarm **next to Zellij**; the client talks over a tunnel. Use this when
SSH is a different session than Zellij, or when MCP should not spawn `ssh` per
op.

```bash
# On the host, in the session that owns Zellij:
ZSWARM_SERVE_TOKEN=secret zswarm serve --listen 127.0.0.1:9419
# Token is required on loopback too: another local OS user can connect to 127.0.0.1.
# Non-loopback listen is refused; off-machine access is an SSH tunnel to 127.0.0.1.
# Windows logon task, once: zswarm serve --install (persists ZSWARM_SERVE_TOKEN into the task env)

# On the client:
ssh -fN -L 9419:127.0.0.1:9419 user@host
ZSWARM_SERVE=127.0.0.1:9419 ZSWARM_SERVE_TOKEN=secret zswarm list
```

`ZSWARM_SSH` only forwards Zellij. Git worktrees, `diff`, and `checkpoint` stay
local — use `serve` on the host that owns the repo if those ops should run there.

MCP: set `ZSWARM_SERVE` (and usually `ZSWARM_SESSION`) in the server env. Do
**not** call `op: "serve"` to listen — that is CLI-only. Other ops forward.
A client with `ZSWARM_SERVE` never sends a local wasm path across the tunnel.
