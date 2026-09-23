# Tailscale crew (Windows desktop + Linux/macOS controller)

Three supported ways to reach a crew host on the same tailnet (all keep
**mandatory** `ZSWARM_SERVE_TOKEN` auth; Tailnet membership alone is never
zswarm readiness):

1. **Default:** loopback `zswarm serve` + process-owned OpenSSH `ssh://`
   LocalForward (or a manual `-L` tunnel).
2. **Optional direct bind:** `zswarm serve --listen` on a **verified local
   Tailscale IP**; controllers use that address as ordinary `--serve host:port`.
3. **Private TCP Tailscale Serve:** keep the backend on `127.0.0.1`, expose a
   raw TCP frontend with `tailscale serve --tcp=…`, and point controllers at
   `tcp://<host-MagicDNS-or-IP>:<frontend-port>`.

Default path for a **native Windows** Zellij desktop and a controller on the
same tailnet: install `zswarm serve` as a current-user Interactive logon task
on the already-logged-in desktop, keep **loopback + token** auth, and attach
from the controller with **OpenSSH over Tailscale** (`ssh://`).

**Optional direct bind:** instead of loopback, the host may bind
`zswarm serve --listen` to a **verified local Tailscale IP** (from
`tailscale ip -4` / `-6`). Controllers then use that address as a normal
`--serve host:port` endpoint. Token auth remains mandatory; Tailnet membership
does not replace it. Local address verification is **binding evidence only** —
not proof of an individual peer's authorization or a firewall policy. Existing
tailnet ACLs/grants and host network policy still decide reachability;
administrators should restrict the selected TCP port to intended controllers.
Tailscale encrypts the tailnet path; zswarm's JSONL protocol does not add a
separate TLS layer. Binding a tailnet address alone does **not** authenticate
traffic on arbitrary network paths.

**Private TCP Serve** (below) is the third path: useful when you want Tailscale
to own the tailnet listener while the zswarm process stays on loopback (no
SSH LocalForward, no direct Tailscale bind). It is **not** Funnel, HTTPS, or
PROXY-protocol identity.

This is not Tailscale's integrated SSH server. Native Windows uses conventional
[OpenSSH](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-overview)
to the Windows host over the tailnet
([SSH with Tailscale](https://tailscale.com/docs/reference/ssh-over-tailscale);
[Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh) is a
Linux/macOS-CLI feature). If the Zellij crew actually runs in **WSL**, treat it
as a Linux host (Unix sockets / `$TMPDIR`), not this Interactive logon task.

`zswarm serve --install` creates or updates the **owned** `zswarm-serve`
current-user Interactive/Limited logon task, then waits until
authenticated hello and host inspection prove this installation. Identical
command text is not reused unless that principal is still Interactive/Limited;
Highest or missing/incompatible principal configuration is corrected on the
owned task. It does
**not** install or change Tailscale, OpenSSH, tailnet ACLs, or firewalls.
Tests and PR validation use isolated fixtures; they do not operate a live
human-host task or tailnet.

## Prerequisites

On the Windows desktop that already owns a compatible Zellij crew:

- You are logged into that desktop account (Interactive token). The logon task
  is **not** a headless boot/SYSTEM service.
  ([LogonType Interactive](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype);
  [New-ScheduledTaskPrincipal](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal))
- Zellij ≥ 0.42 is on that account's PATH (or `ZSWARM_BIN`), with a live crew
  session.
- Windows OpenSSH Server is reachable from the controller over the tailnet
  (default loopback+SSH recipe), **or** the host will bind a verified Tailscale
  IP for direct TCP (see below).
- A private `ZSWARM_SERVE_TOKEN` is loaded in **both** the desktop process that
  runs `--install` and the controller process that calls `--serve`. Do not put
  the token in the URI, argv, or shell history snippets you paste around.

On the controller:

- An SSH identity and host-key verification that already work
  (`ssh user@crew-host`) when using the default `ssh://` recipe. Direct
  Tailscale-IP endpoints skip SSH but still need the shared token.
- The same private token in that process environment.

## What `ready` means

`zswarm serve --install` registers/updates **only** the owned `zswarm-serve`
task, starts it, then waits on one deadline for:

1. Authenticated protocol-1 **hello** from **this installation's** launch
   identity (not merely TCP connect, `State=Running`, or a zero
   [`Start-ScheduledTask`](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/start-scheduledtask)
   exit — start is asynchronous).
2. Host Zellij/IPC/session visibility **through that server** (doctor host-report
   semantics). Controller-local inspection and direct SSH are not substitutes.

| Result | Meaning |
| --- | --- |
| `installed: true`, `ready: true`, `running: true` | Task is ours, hello matched this launch, host listing worked. `running` is defined from that evidence, not from start acceptance. |
| `--session crew` | That live session must be visible through the installed server. `--session` is a **readiness target**; it does not rewrite the task's default routing. |
| no `--session`, empty `sessions`, `warning` | Healthy authenticated server that can list sessions, **not** a ready crew. |
| `error.code: serve_not_ready` | Registration/start happened, readiness did not. `error.details` has `installed: true`, `ready: false`, task/listen, phase/cause/remedy, and partial inspection. The task is **not** torn down. |
| `timeout` / `cancelled` | Same partial details when known. Interrupted register/start does not claim success or rollback. |

Missing/unready bus is advisory. Installation does **not** install, launch,
nudge, or approve the bus.

## Host (Windows desktop) — default loopback

Load the token privately, then:

```powershell
# Confirm the live crew session (example name: crew)
zellij list-sessions
$env:ZSWARM_SERVE_TOKEN = Get-Content $env:USERPROFILE\.zswarm-serve-token -Raw
# Optional: ZSWARM_BIN, ZSWARM_TMP for this desktop's Zellij/IPC.
zswarm serve --install --listen 127.0.0.1:9419 --session crew --timeout-ms 30000
```

Read the JSON: `data.installed` / `data.ready` / `data.server.launchId` /
`data.sessions`. Without `--session`, look at `data.sessions` and any `warning`.

Same operation over MCP/core (still on the desktop, not from the controller):

```json
{ "op": "serve", "install": true, "listen": "127.0.0.1:9419", "session": "crew", "timeoutMs": 30000 }
```

MCP `process.argv[1]` is the MCP entrypoint. Install resolves a real **CLI**
script (`cli.js` / `zswarm.mjs`) or fails before mutating the task. Set
`ZSWARM_SERVE_CLI` if it cannot be inferred. The task launches
`node "<cli>" serve --listen …`, never MCP with serve arguments.

Then, **only if you want the event bus**, from that same desktop:

```powershell
zswarm --serve 127.0.0.1:9419 bus --install --session crew
```

Approve the plugin permission prompt **in the desktop Zellij UI**. Readiness
does not auto-approve it.

### Token storage

The token is stored in the scheduled task action (`set "ZSWARM_SERVE_TOKEN=…"`).
Output redaction is **not** encryption. The desktop user and local
administrators who can read that task can read the token. Rotate by running
`--install` again with the new token (updates the owned task, then verifies the
new launch identity). `zswarm serve --clear` **stops and unregisters** the owned
`zswarm-serve` task; it will not remove a task owned by a different account.
Clear remains usable when Tailscale is down or a previous Tailscale listen
address was removed — it is ownership-controlled cleanup, not permission to
open a listener.

## Host — optional verified Tailscale bind

Default listen remains loopback and does **not** require Tailscale to be
installed. To bind the Tailscale address itself:

1. Confirm Tailscale is **Running** and read the host's own address
   (`tailscale ip -4` / `tailscale ip -6`). Do not invent a `100.*` value or
   copy a peer's IP.
2. Pass that **literal** address to `--listen`. Wildcards (`0.0.0.0` / `::`),
   hostnames, MagicDNS names, and IPv4-mapped IPv6 forms are refused.
3. zswarm runs a bounded read-only `tailscale status --json --peers=false`,
   requires `BackendState: Running`, and checks exact membership in this node's
   self/local Tailscale addresses **and** OS interface assignment. Peer
   entries, subnet/exit routes, and prefix resemblance are not identity.
4. Bind is exactly that address. Verification/bind failure never falls back to
   `0.0.0.0`, `::`, loopback, SSH, or another transport.
5. Userspace/proxy-only Tailscale without an OS-bindable address is **not**
   supported in this mode — use loopback + managed SSH instead.
6. Verification runs on **every** startup/restart (including each Windows
   logon-task start). Installer-time proof is not a permanent permit. Address
   or profile changes require restart/revalidation; zswarm does not continuously
   monitor identity or automatically rebind after address loss. Startup
   verification timeouts are not lifetime timeouts for a healthy server.
7. Optional: `ZSWARM_TAILSCALE_BIN` points at a non-PATH Tailscale CLI. It is
   persisted in the Windows task env with the same safe quoting rules as other
   host keys and is never placed in token-bearing argv.

Shell examples (replace the command substitutions with your real addresses):

```bash
# Unix host next to Zellij
export ZSWARM_SERVE_TOKEN="$(cat ~/.zswarm-serve-token)"
TS4="$(tailscale ip -4)"
zswarm serve --listen "${TS4}:9419"
# IPv6:
TS6="$(tailscale ip -6)"
zswarm serve --listen "[${TS6}]:9419"
```

```powershell
# Windows desktop account — same explicit binding on the logon task
$env:ZSWARM_SERVE_TOKEN = Get-Content $env:USERPROFILE\.zswarm-serve-token -Raw
$ts4 = (tailscale ip -4).Trim()
zswarm serve --install --listen "${ts4}:9419" --session crew --timeout-ms 30000
```

```json
{ "op": "serve", "install": true, "listen": "<tailscale-ip>:9419", "session": "crew", "timeoutMs": 30000 }
```

Managed `ssh://` still forwards to **remote loopback** only. A server bound
solely to its Tailscale IP is reached with a **direct** serve endpoint, not by
widening `ssh://`. The default loopback + managed-SSH recipe remains available.

## Controller

### Default: managed SSH to remote loopback

Concise default: process-owned `ssh://` LocalForward. Authority port is **SSH**
(omit it to honor `ssh_config` `Port`). `servePort` is the **remote loopback**
serve port (default 9419). Load the same token in this process.

```bash
export ZSWARM_SERVE_TOKEN="$(cat ~/.zswarm-serve-token)"   # private; not in the URI
zswarm --serve 'ssh://user@crew-host?servePort=9419' doctor --session crew --timeout-ms 10000
zswarm --serve 'ssh://user@crew-host?servePort=9419' status --session crew
```

`ssh://` opens a process-owned `ssh -N -T` LocalForward, probes hello, then
forwards ops. It does not start or install remote serve. CLI closes the child
before exit; MCP reuses it until shutdown. There is no SSH fallback if serve is
down. See [performance.md](performance.md) for lease/hello details and
[doctor.md](doctor.md) for layered checks.

Optional manual foreground forward (not the default; no automatic ControlMaster).
Keep this `ssh -N` tunnel in its **own terminal**. While it stays open, run
doctor/status from a **second terminal**:

```bash
ssh -N -T -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:9419:127.0.0.1:9419 user@crew-host
```

Then, in another terminal:

```bash
zswarm --serve 127.0.0.1:9419 doctor --session crew --timeout-ms 10000
```

### Direct Tailscale-IP endpoint

When the host bound a verified Tailscale address, the controller uses that
address directly (same private token). Controllers do **not** need a local
Tailscale CLI for ordinary serve calls:

```bash
export ZSWARM_SERVE_TOKEN="$(cat ~/.zswarm-serve-token)"
# Paste the *host's* Tailscale IPv4 from that machine's `tailscale ip -4`
# (not this controller's address, and not a guessed 100.x value).
HOST_TS="100.64.1.2"
zswarm --serve "${HOST_TS}:9419" doctor --session crew --timeout-ms 10000
zswarm --serve "${HOST_TS}:9419" status --session crew
# IPv6 on the host: use that machine's `tailscale ip -6` the same way:
# zswarm --serve '[fd7a:115c:a1e0::1]:9419' status --session crew
```

Doctor stays inspect-only on direct endpoints. Optional Tailscale diagnostics on
the controller remain optional and are not required for loopback/SSH clients.

## Limits and troubleshooting

| Symptom | What it usually is |
| --- | --- |
| Login / reboot / logout | Interactive tasks need the user logged on. After reboot/logout, log in on that desktop; the AtLogOn trigger starts the task again. Headless boot will not see the crew. |
| `warning` / empty `sessions` | Server listed sessions and found none. Start the crew on the desktop, then `--install --session …` or doctor. |
| `ipc_failed` / wrong desktop | Listener is up but not the desktop IPC. Confirm the task principal is the logged-in account (`Interactive` / `Limited`), not SYSTEM. |
| `session_missing` | Requested name is not live through the server. `zellij list-sessions` on that desktop. |
| Unreachable serve / `serve_unreachable` | Task not running, port not bound, or SSH forward not to that loopback port (or wrong direct Tailscale IP). |
| `serve_unauthorized` / token mismatch | Same token on install env and controller. Reinstall to rotate. |
| `stale_listener` | Something else answered on the port without this launch identity. Install does **not** kill arbitrary node/port owners. `--clear` the **owned** task or free the port, then retry. |
| `serve_not_ready` after register | Task remains. Retry `--install` or `zswarm doctor`. `--clear` only when you intend to remove it. |
| Tailscale bind refused / verify phase | Address not in `tailscale ip`, daemon not Running, OS interface missing the address (userspace-only), wildcard/hostname input, or Self/root IP conflict. Fix Tailscale or use loopback + SSH. Restart serve after address/profile changes. |
| Bind `EADDRNOTAVAIL` / `EADDRINUSE` | No fallback listen. Free the port or restore the Tailscale address, then restart so verification runs again. |

Doctor troubleshooting: [doctor.md](doctor.md).

## Host — private TCP Tailscale Serve (loopback backend)

Use this when controllers should reach the crew over Tailscale's **private raw
TCP** forwarder without SSH LocalForward and without binding zswarm itself to a
Tailscale IP. The zswarm backend stays on **`127.0.0.1`**. Tailscale Serve
([CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve),
[feature overview](https://tailscale.com/docs/features/tailscale-serve))
forwards encrypted tailnet TCP to that loopback listener. zswarm remains
JSONL-over-TCP; it does **not** speak HTTP, infer callers from PROXY headers,
or terminate TLS itself.

Requires Tailscale client **≥ 1.52** (Serve/Funnel CLI redesign). Verify the
flags below on the installed CLI; do not assume every historical syntax still
works.

### Ports and ownership

Use **distinct** backend and frontend ports so a mis-typed controller URI
cannot target the Tailscale listener as if it were the backend (example:
backend `9419`, frontend `19419`). Host zswarm and the Tailscale forwarder have
**separate lifetimes**:

- An installed/ready Windows `zswarm-serve` task is **not** proof that
  `tailscale serve --tcp=…` is configured.
- A configured frontend is **not** proof the desktop crew / zswarm backend is
  ready.
- Controllers need network reachability to the frontend; they do **not** need a
  local Tailscale CLI for ordinary `--serve` calls. The **host** manages its
  own Tailscale CLI/daemon configuration.

### Setup (host)

Load the same private `ZSWARM_SERVE_TOKEN` out of band on host and controller
(never in argv, URI, MCP `serveAddress`, or pasted examples that contain a real
secret).

```bash
# Terminal 1 — loopback zswarm backend (foreground). Replace nothing here:
export ZSWARM_SERVE_TOKEN="$(cat ~/.zswarm-serve-token)"
zswarm serve --listen 127.0.0.1:9419
```

```powershell
# Windows desktop account — verified install still targets loopback:
$env:ZSWARM_SERVE_TOKEN = Get-Content $env:USERPROFILE\.zswarm-serve-token -Raw
zswarm serve --install --listen 127.0.0.1:9419 --session crew --timeout-ms 30000
```

Inspect existing Serve mappings **before** changing anything. Do not overwrite
an unrelated handler, and do not approve a prompt that enables **public**
sharing / Funnel for this recipe:

```bash
tailscale serve status --json
```

Then enable **explicit private raw TCP** on an unused frontend port (example
`19419` → loopback `9419`). Do **not** use default HTTPS, `--http`, `--https`,
`--tls-terminated-tcp`, `--proxy-protocol`, or Tailscale Services / virtual-IP
management for this path.

Choose **one** of the two alternative forwarder lifecycles below — do not run
both for the same port. Backend zswarm and the Tailscale forwarder still have
separate lifetimes and readiness.

**Alternative A — foreground** (second host terminal; session-owned share):

```bash
# Terminal 2 — keep this process running while you want the share:
tailscale serve --tcp=19419 tcp://127.0.0.1:9419
```

Stop by sending Ctrl+C to **that** owning CLI process, then inspect
`tailscale serve status --json` to confirm the selected mapping is gone.
Foreground shares must be restarted after host or Tailscale restart. Do **not**
use `tailscale serve --tcp=19419 off` to stop a different foreground CLI
session: `off` clears parent/background TCP config and does not terminate
another process's nested foreground WatchIPNBus share
([v1.52.0 serve CLI](https://github.com/tailscale/tailscale/blob/v1.52.0/cmd/tailscale/cli/serve_v2.go#L235-L283);
`removeTCPServe` only inspects the selected config's TCP map).

**Alternative B — persistent background** (survives host/Tailscale restart
until port-specific disable):

```bash
tailscale serve --bg --tcp=19419 tcp://127.0.0.1:9419
```

Disable only after `tailscale serve status --json` confirms the selected
mapping is still the one you manage:

```bash
tailscale serve --bg --tcp=19419 off
```

Validate the resulting private mapping and that Funnel is **not** enabled for
the selected endpoint (`tailscale serve status` / `--json`). If the selected
port already has an incompatible handler, decide explicitly — do **not** run
`tailscale serve reset` or otherwise clear unrelated services.

Existing tailnet grants/ACLs and host policy must allow intended controllers to
reach the frontend port. Private binding alone does not identify callers.

### Controller

Replace `crew-host` with the host's real MagicDNS name or Tailscale IP (not a
placeholder sample, and not this controller's address):

```bash
export ZSWARM_SERVE_TOKEN="$(cat ~/.zswarm-serve-token)"
zswarm --serve 'tcp://crew-host:19419' doctor --session crew --timeout-ms 10000
zswarm --serve 'tcp://crew-host:19419' status --session crew
# IPv4 literal:
# zswarm --serve 'tcp://100.64.1.2:19419' doctor --session crew --timeout-ms 10000
# Bracketed IPv6:
# zswarm --serve 'tcp://[fd7a:115c:a1e0::1]:19419' status --session crew
```

```powershell
$env:ZSWARM_SERVE_TOKEN = Get-Content $env:USERPROFILE\.zswarm-serve-token -Raw
zswarm --serve 'tcp://crew-host:19419' doctor --session crew --timeout-ms 10000
zswarm --serve 'tcp://crew-host:19419' status --session crew
```

MCP (token stays in the MCP server environment, not in the tool args):

```json
{ "op": "doctor", "serveAddress": "tcp://crew-host:19419", "session": "crew", "timeoutMs": 10000 }
```

Ordinary ops keep the same `serveAddress` / `ZSWARM_SERVE`.

### Layered readiness

1. **Local authenticated backend** on the host:
   `zswarm --serve 127.0.0.1:9419 doctor --session crew` (same token).
2. **Forwarding config** on the host: `tailscale serve status --json` shows the
   intended private `--tcp` mapping and no Funnel for that endpoint.
3. **Authenticated controller doctor** through the frontend:
   `zswarm --serve 'tcp://crew-host:19419' doctor --session crew`.

Separate failure layers (do not collapse them):

| Layer | Typical symptom |
| --- | --- |
| Wrong / missing token | `serve_unauthorized` — TCP connected; hello/ops refused |
| Backend down, frontend accepting | Connect may succeed; hello/doctor fails within the budget with connect/hello/request phase details — never a successful ready report |
| Frontend missing / wrong port | `serve_unreachable` / `serve_connect` |
| Desktop IPC / session | Host checks fail after hello (`ipc_failed`, `session_missing`, …) |
| Hostname / address | DNS/IP wrong for the **host**; replace sample names |

Cancellation and deadlines stay bounded. There is no SSH fallback and no
mutation replay when a reply is lost after the request was sent (`uncertain`
delivery).

### Automated evidence vs live tailnet

CI models the forwarding hop with an **in-process transparent TCP relay** over
real loopback sockets (JSONL framing, token policy, uncertain delivery). That
is protocol/transport compatibility evidence — **not** a live Tailscale
daemon, ACL, Funnel, or Windows desktop validation. Live Serve setup remains
an operator step on the host.

This guide does **not** configure Funnel, public listeners, HTTPS gateways,
`--tls-terminated-tcp`, or PROXY protocol for zswarm.

## Troubleshooting — abandoned cursor/signal locks

Cursor and signal state use exclusive lock files (`cursors.lock` /
`signals.lock`) under the state directory (`ZSWARM_STATE_DIR`, default
`~/.zswarm`). Contenders **fail closed**: they never rename or unlink a
foreign, abandoned, or ownerless lock to recover it.

If acquisition refuses an abandoned lock:

1. Stop / quiesce **all** writers that use that state directory.
2. Confirm the recorded owner process is gone and no writer holds the file.
3. Remove **only** the affected lock file (preserve state data).
4. Restart / retry.

Do not delete cursors, signals, or other state files as part of lock recovery.
Runtime errors already name the lock path; this note is the published operator
procedure only.
