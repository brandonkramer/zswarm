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

MCP: set `ZSWARM_SERVE` in the MCP server env. Pass `session` explicitly or
configure `ZSWARM_SESSION` on the host running `serve`. Do **not** call
`op: "serve"` to listen — that is CLI-only. Other ops forward.
A client with `ZSWARM_SERVE` never sends a local wasm path across the tunnel.

## Invocation routing

`--local` clears SSH, serve, and remote IPC for this call only. It preserves the
parent environment and inherited session selection; use `--session` explicitly
when switching hosts. `--ssh user@host` overrides the inherited destination and
serve for this call. Passing both flags is a usage error.

Normal responses carry `context`: transport, host, resolved session, and the
origin of those settings. Serve responses also identify the server's context
when supported, because the endpoint may be a local tunnel. Interactive CLI
routing notices go to stderr; stdout stays JSON. Scope remote env vars to the
remote launcher and give local crew wrappers fixed `--local --session` flags.
Configure each MCP server's environment explicitly.

Dedicated crew Zellij configs can disable startup distractions with
`show_startup_tips false` and `show_release_notes false`. Correct TERM on the
host that starts workers. Terminal screen reads do not prove the presence or
absence of all Zellij overlays; inspect held exit output before recovery.
