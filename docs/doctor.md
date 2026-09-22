# `zswarm doctor`

Inspect-only, layered diagnostics for **local**, **direct SSH**, and **serve**
routes. Doctor identifies the failing layer and the actual host/session. It
does not install, repair, or mutate a crew.

Native Windows is **OpenSSH over Tailscale**. Tailscale's integrated SSH server
is not required.

## CLI and MCP

```bash
zswarm doctor --session crew --timeout-ms 10000
zswarm --serve 'ssh://Administrator@host?servePort=9419' doctor --session crew --timeout-ms 10000
zswarm --serve 127.0.0.1:9419 doctor --session crew --timeout-ms 10000
zswarm --ssh user@host doctor --session crew --timeout-ms 10000
```

MCP (same single `zswarm` tool):

```json
{ "op": "doctor", "serveAddress": "ssh://host?servePort=9419", "session": "crew", "timeoutMs": 10000 }
```

Routing matches every other op: `--local` / `--ssh` / `--serve` are exclusive;
an explicit selector wins over inherited `ZSWARM_SERVE` / `ZSWARM_SSH`.
Simultaneous explicit selectors remain `usage`. Doctor runs **before** ordinary
serve forwarding and **before** mandatory session resolution, so a dead tunnel
still reports controller findings.

`--session` is forwarded to the host only when it is explicit. A controller's
inherited `ZELLIJ_SESSION_NAME` never selects the server's session. The server
may still apply its own `ZSWARM_SESSION` / host-default session.

`--timeout-ms` is one overall deadline (default **10000**). Doctor does **not**
inflate that budget with `serveCallTimeout`'s 15s minimum. Optional Tailscale
is capped so SSH/hello/session keep time.

## Report shape

Success puts the report in `data`. Required-check failures use
`error.code="doctor_failed"` with the **same report** in `error.details` and a
nonzero CLI exit. Cancellation and overall timeout keep `cancelled` / `timeout`
and a partial report. Input/usage errors keep existing codes (`usage`,
`bad_arg`, `bad_ssh`, …) and are not rewritten as `doctor_failed`.

```json
{
  "route": {
    "transport": "serve",
    "endpoint": "ssh://Administrator@host?servePort=9419",
    "session": "crew",
    "sessionOrigin": "explicit"
  },
  "server": {
    "protocol": 1,
    "serverId": "…",
    "hostname": "netcup",
    "platform": "win32",
    "version": "0.1.7",
    "capabilities": ["hello"]
  },
  "checks": [
    {
      "id": "route",
      "scope": "controller",
      "state": "ok",
      "code": "route_selected",
      "elapsedMs": 0,
      "detail": {},
      "remedy": null
    }
  ]
}
```

`scope` is `controller` or `host`. Loopback (`127.0.0.1`) is the **tunnel**, not
the crew host — use `server.hostname` plus host checks.

Check `state` is `ok` | `warn` | `fail` | `skipped`. Stable **ids** and
**codes** matter; wording may evolve.

### Required vs advisory

| Check id | Required? | Notes |
| --- | --- | --- |
| `route` | yes if `fail` | Selected transport, endpoint, session origin |
| `ssh` | yes on `--ssh` / `ssh://` when `fail` | Connect / auth / host-key / forward |
| `serve` | yes on serve routes when `fail` | Hello, token, protocol. TCP connect alone is not readiness |
| `zellij_binary` | yes when inspected and `fail` | Missing/wrong/incompatible binary |
| `session` | yes when explicit, inherited, or host-default | Missing requested/default session fails. No selected session + no live sessions is a **warning** |
| `tailscale` | advisory | Optional peer/online evidence |
| `zellij_ipc` | advisory unless `fail` on resolved SSH IPC | Wrong/inaccessible IPC |
| `zellij_sessions` | advisory | Visible sessions vs none |
| `bus_artifact` / `bus_marker` / `bus_instance` | advisory | Degraded performance, not an unusable crew |

Skipped host checks after a failed upstream stage use
`skipped_upstream` (or `doctor_unsupported` on older serve peers). After
authenticated hello, an empty or malformed host doctor report is
`host_report_invalid`; missing `zellij_binary` / session coverage is
`host_report_incomplete`; auth/protocol/transport failures on the host
request are `host_request_*` on the host layer (serve hello stays
`serve_hello_ok`). Doctor never claims an unperformed host/session check
passed and never falls back to another route.

`--timeout-ms` is enforced through host inspection. An expired budget
returns `timeout` (not `ok: true`), including when host listing overruns
an injected clock. Cancellation and timeout keep any completed host
findings in `error.details`.

## Sample reports

Healthy serve through an existing tunnel:

```json
{
  "ok": true,
  "data": {
    "route": {
      "transport": "serve",
      "endpoint": "127.0.0.1:9419",
      "session": "crew",
      "sessionOrigin": "explicit"
    },
    "server": { "protocol": 1, "hostname": "netcup", "platform": "win32" },
    "checks": [
      { "id": "route", "state": "ok", "code": "route_selected" },
      { "id": "tailscale", "state": "skipped", "code": "tailscale_unmappable" },
      { "id": "ssh", "state": "skipped", "code": "ssh_not_applicable" },
      { "id": "serve", "state": "ok", "code": "serve_hello_ok" },
      { "id": "zellij_binary", "scope": "host", "state": "ok", "code": "zellij_ok" },
      { "id": "session", "scope": "host", "state": "ok", "code": "session_present" },
      { "id": "bus_instance", "scope": "host", "state": "ok", "code": "bus_instance_observed", "detail": { "readiness": "unknown" } }
    ]
  }
}
```

Degraded (healthy serve, bus missing): `ok: true` with `bus_marker` / `bus_instance` `warn`.
Missing/unready bus is not `doctor_failed`.

Failure (explicit session missing):

```json
{
  "ok": false,
  "error": {
    "code": "doctor_failed",
    "message": "session:session_missing",
    "details": {
      "route": { "transport": "serve", "session": "crew", "sessionOrigin": "explicit" },
      "checks": [
        { "id": "serve", "state": "ok", "code": "serve_hello_ok" },
        { "id": "session", "scope": "host", "state": "fail", "code": "session_missing",
          "remedy": "Start the requested Zellij session on the crew host (the account that owns the desktop session), or pass --session for a live session." }
      ]
    }
  }
}
```

Wrong token keeps `serve` `fail` `serve_unauthorized` and skips host checks.
Dead endpoint: `serve_connect`. Incompatible/legacy hello: `serve_hello_unsupported` /
`serve_incompatible` / `serve_protocol`. Older serve that speaks hello but not
doctor: host checks `doctor_unsupported` with an upgrade remedy.

## Tailscale (optional)

Doctor runs `tailscale status --json` when budget remains (capped, bounded
output). See the [Tailscale CLI](https://tailscale.com/docs/reference/tailscale-cli).
The JSON object includes `Self` and `Peer` entries with `HostName`, `DNSName`,
`Online`, and `TailscaleIPs`.

- Missing CLI, denied/unavailable daemon, or an unmappable alias/manual tunnel
  is `skipped` and **does not** invalidate a working route.
- Doctor never guesses a remote peer from `127.0.0.1` or a `100.*` prefix
  alone. A match requires exact address or name evidence from that JSON.
- Peer-online evidence cannot override failed SSH / hello / session checks.

Doctor never installs Tailscale, logs in, or changes network exposure.

## Inspect-only limits

Doctor does **not**:

- install, clear, or fix serve/bus/scheduled tasks
- launch or pipe to the event-bus plugin (a pipe can load an instance)
- rename, focus, close, or spawn panes (including the bus snapshot nudge)
- write state markers, cursors, or delivery logs
- invoke the Windows interactive scheduled-task SSH path

`busSnapshot()` is not used. Plugin readiness is `unknown` unless a live plugin
**pane** is already visible; silence does not mean permissions are pending.
Direct SSH reports `bus_remote_unsupported` with a serve remedy and does not
read the controller's bus artifact/marker as remote facts.

On `ZSWARM_SSH_MODE=interactive`, host/session layers are skipped with a serve
remedy; a requested session is never reported healthy. Use serve on the desktop
account instead.

`ZSWARM_READONLY=1` still allows doctor. `ZSWARM_BUS=0` is reported as disabled
bus policy.

## Leases

Managed `ssh://` reuses `createServeTunnelManager` / `acquire` / authenticated
hello. Doctor **releases its lease**. It does not `closeAll` a shared MCP
manager, so another in-flight caller keeps its tunnel.

## Remedies

| Symptom | What to do |
| --- | --- |
| `serve_connect` / dead tunnel | Start `zswarm serve --listen 127.0.0.1:9419` on the crew host; check the SSH LocalForward |
| `serve_unauthorized` | Same `ZSWARM_SERVE_TOKEN` on host and controller |
| `serve_hello_unsupported` | Upgrade zswarm serve (protocol 1 hello) |
| `doctor_unsupported` | Upgrade zswarm serve so it implements `op=doctor` |
| `host_report_invalid` / `host_report_incomplete` | Hello succeeded but host doctor did not return usable host/session checks. Upgrade zswarm serve |
| `host_request_unauthorized` / `host_request_protocol` / `host_request_connect` | Host doctor request failed after hello. Same token; check serve framing/reachability; do not treat hello as host inspection |
| `ssh_auth` / `ssh_host_key` | Fix OpenSSH identity / known_hosts; doctor does not prompt or disable host-key checks |
| `session_missing` | Start the named Zellij session on the desktop account that owns the crew |
| `zellij_missing` / `zellij_wrong_bin` | Install Zellij ≥ 0.42; point `ZSWARM_BIN` / `ZSWARM_REMOTE_BIN` at **zellij**, not zswarm |
| `ipc_failed` | `ZSWARM_TMP` for the desktop TEMP (or `auto`); a listener is not a usable crew |
| `bus_remote_unsupported` | Run serve on the crew host; direct SSH cannot use the local event bus |
| `ssh_interactive_uninspected` | Do not use the interactive scheduled-task path for doctor; use serve |
| `tailscale_*` skipped | Advisory only; ignore if SSH/serve/session are healthy |
