# zswarm doctor

Inspect-only diagnosis of a **local**, **direct SSH**, or **serve** route. Doctor never
installs, repairs, launches plugins, writes state, or creates Windows scheduled
tasks. It answers whether the selected transport can see a usable Zellij crew,
and it keeps controller evidence separate from host evidence.

Loopback (`127.0.0.1`) can be a tunnel, not the crew host.

## CLI and MCP

```bash
zswarm doctor --session crew --timeout-ms 10000
zswarm --serve 'ssh://Administrator@host?servePort=9419' doctor --session crew --timeout-ms 10000
zswarm --serve 127.0.0.1:9419 doctor --session crew --timeout-ms 10000
zswarm --ssh user@host doctor --session crew --timeout-ms 10000
```

```json
{ "op": "doctor", "serveAddress": "ssh://host?servePort=9419", "session": "crew", "timeoutMs": 10000 }
```

Routing is the same as every other op: `--local` / `--ssh` / `--serve` are mutually
exclusive; `--local` and `--ssh` override inherited `ZSWARM_SERVE`. Only an
**explicit** `--session` is forwarded over serve. A controller
`ZELLIJ_SESSION_NAME` does not select the server's session. Server-side
`ZSWARM_SESSION` / `ZELLIJ_SESSION_NAME` / sole live session still apply on the
host.

`--timeout-ms` is one overall deadline (default **10000**). It is **not** inflated
by serve's usual 15s minimum. Optional Tailscale is capped so it cannot starve
SSH/hello/host checks. Cancellation and expiry stop later stages, keep a partial
report, and release an owned `ssh://` lease without calling `closeAll` on a
shared MCP manager.

## Report contract

Success (`ok: true`) puts the report in `data`. Required-check failures use
`error.code = "doctor_failed"` with the same report in `error.details` and a
nonzero CLI exit. Overall timeout/cancellation keep `timeout` / `cancelled` and
still include a partial report. A collected report is never replaced by a bare
transport error. Input/usage errors keep existing codes (`usage`, `bad_arg`, …).

```json
{
  "route": {
    "transport": "serve",
    "target": "ssh://Administrator@host?servePort=9419",
    "session": "crew",
    "sessionOrigin": "explicit",
    "selector": "--serve",
    "loopbackTunnel": true
  },
  "server": {
    "hostname": "win-crew",
    "platform": "win32",
    "version": "0.1.7",
    "protocol": 1,
    "serverId": "…",
    "capabilities": ["hello", "doctor"]
  },
  "checks": [
    {
      "id": "route",
      "scope": "controller",
      "state": "ok",
      "code": "route_selected",
      "elapsedMs": 0,
      "detail": "…",
      "remedy": ""
    }
  ]
}
```

Stable check **ids** and **codes** matter; wording may evolve.

| id | scope | required? | meaning |
| --- | --- | --- | --- |
| `route` | controller | yes | Selected transport, endpoint/destination, session origin |
| `tailscale` | controller | no | `tailscale status --json` peer/online evidence |
| `serve` | controller | when serve | Authenticated hello (TCP connect is not readiness) |
| `ssh` | controller | when direct SSH | OpenSSH connect/auth/host-key (not Tailscale SSH) |
| `zellij` | host | when performed | Binary identity / `list-sessions --no-formatting` |
| `ipc` | host | when performed | Configured or resolved IPC temp/socket evidence |
| `sessions` | host | no | Visible live sessions |
| `session` | host | when a session is selected or host-default | Requested / host-default session exists |
| `bus_artifact` | host | no | Host-local wasm file |
| `bus_marker` | host | no | Per-session install marker |
| `bus_instance` | host | no | Visible plugin pane; readiness unknown without a safe pipe |

**Required** means a `state: "fail"` on that check makes the op `doctor_failed`
(unless the overall call already ended as `timeout` / `cancelled`).
`skipped` is not success and not a required failure. Unperformed host/session
checks are never reported `ok`.

`state` values: `ok`, `warn`, `fail`, `skipped`.

Degraded/unknown results are explicit: empty sessions without a selected session
are `warn`; missing bus is `warn`/advisory; plugin readiness is
`bus_instance_unknown` or “present but readiness unknown”. Direct SSH reports
`bus_unsupported_ssh` rather than reading the controller’s wasm/marker as remote
facts.

## Sample reports

### Healthy local

```json
{
  "ok": true,
  "data": {
    "route": {
      "transport": "local",
      "target": "builder",
      "session": "crew",
      "sessionOrigin": "explicit",
      "selector": "--session",
      "loopbackTunnel": false
    },
    "checks": [
      { "id": "route", "scope": "controller", "state": "ok", "code": "route_selected" },
      { "id": "tailscale", "scope": "controller", "state": "skipped", "code": "tailscale_not_applicable" },
      { "id": "serve", "scope": "controller", "state": "skipped", "code": "not_applicable" },
      { "id": "ssh", "scope": "controller", "state": "skipped", "code": "not_applicable" },
      { "id": "zellij", "scope": "host", "state": "ok", "code": "zellij_ok" },
      { "id": "ipc", "scope": "host", "state": "ok", "code": "ipc_default" },
      { "id": "sessions", "scope": "host", "state": "ok", "code": "sessions_ok" },
      { "id": "session", "scope": "host", "state": "ok", "code": "session_ok" },
      { "id": "bus_artifact", "scope": "host", "state": "ok", "code": "bus_artifact_ok" },
      { "id": "bus_marker", "scope": "host", "state": "ok", "code": "bus_marker_ok" },
      { "id": "bus_instance", "scope": "host", "state": "ok", "code": "bus_instance_present" }
    ]
  }
}
```

### Degraded (healthy serve, no selected session, bus absent)

```json
{
  "ok": true,
  "data": {
    "route": { "transport": "serve", "session": null, "sessionOrigin": "unresolved" },
    "checks": [
      { "id": "serve", "scope": "controller", "state": "ok", "code": "serve_ok" },
      { "id": "sessions", "scope": "host", "state": "warn", "code": "sessions_empty" },
      { "id": "session", "scope": "host", "state": "warn", "code": "sessions_empty" },
      { "id": "bus_instance", "scope": "host", "state": "warn", "code": "bus_instance_absent" }
    ]
  }
}
```

Advisory Tailscale `ok` / `skipped` never overrides a failed SSH, hello, or
session check.

### Failure (missing requested session)

```json
{
  "ok": false,
  "error": {
    "code": "doctor_failed",
    "message": "doctor failed (session:session_missing)",
    "details": {
      "route": { "transport": "local", "session": "crew", "sessionOrigin": "explicit" },
      "checks": [
        { "id": "zellij", "scope": "host", "state": "ok", "code": "zellij_ok" },
        { "id": "session", "scope": "host", "state": "fail", "code": "session_missing",
          "remedy": "Create or attach that Zellij session on the crew host. A reachable listener is not a usable crew." }
      ]
    }
  }
}
```

## Stage codes and remedies

Serve/SSH failures distinguish **connect**, **auth**, **host-key**, **forward**,
**hello**, and **protocol** when those are observable:

| code | typical remedy |
| --- | --- |
| `serve_unauthorized` | Same `ZSWARM_SERVE_TOKEN` on server and caller |
| `serve_unreachable` / `ssh_connect` | Serve listening / OpenSSH destination reachable. No route fallback |
| `ssh_auth` | Agent or key for this OpenSSH destination |
| `ssh_host_key` | Verify `known_hosts`; doctor does not change keys |
| `ssh_forward` | Remote loopback serve and LocalForward |
| `serve_hello_unsupported` / `doctor_unsupported` | Upgrade `zswarm serve` on the crew host |
| `serve_incompatible` / `serve_protocol` | Upgrade both sides; do not retry blindly |
| `zellij_missing` / `zellij_wrong_bin` | Install Zellij ≥ 0.42; do not point `ZSWARM_BIN` at zswarm |
| `ipc_unreachable` | Set `ZSWARM_TMP` to desktop TEMP, or use serve |
| `session_missing` | Start/attach that session on the **host** |
| `session_unverified` | Interactive SSH is not inspected; run serve on the crew host |
| `bus_unsupported_ssh` | Run serve on the crew host to observe the host-local bus |
| `tailscale_cli_missing` / `tailscale_unmapped` | Advisory; does not fail a working route |

Windows crews use **OpenSSH over Tailscale**. Doctor does not require Tailscale’s
integrated SSH server and never runs `tailscale up`, login, or config changes.

## Read-only limits

Doctor is allowed under `ZSWARM_READONLY=1`. It still honors host policy and
does **not**:

- install, clear, or fix anything
- load/reload the event-bus plugin or pipe to it (`busSnapshot` can launch or
  nudge a plugin; doctor does not call it)
- rename, focus, close, or spawn panes
- write state markers or cursors
- create Windows scheduled tasks or temp IPC files (`ZSWARM_SSH_MODE=interactive`
  is reported as unsupported for host inspection)
- dump pane screens, broad environment, or secrets

A plugin pane that is already visible may be listed. That is not readiness: a
pipe can load an instance, so readiness stays unknown unless a verified
existing-instance-only mechanism exists. Silence does not mean permissions are
pending.

Older serve peers without the `doctor` capability are reported
`doctor_unsupported` with dependent host checks `skipped`. Doctor does not send
unauthenticated host checks and does not recurse into another serve/SSH target.
