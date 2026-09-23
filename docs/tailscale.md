# Tailscale crew (Windows desktop + Linux/macOS controller)

Default path for a **native Windows** Zellij desktop and a controller on the
same tailnet: install `zswarm serve` as a current-user Interactive logon task
on the already-logged-in desktop, keep **loopback + token** auth, and attach
from the controller with **OpenSSH over Tailscale** (`ssh://`).

This is not Tailscale's integrated SSH server. Native Windows uses conventional
[OpenSSH](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-overview)
to the Windows host over the tailnet
([SSH with Tailscale](https://tailscale.com/docs/reference/ssh-over-tailscale);
[Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh) is a
Linux/macOS-CLI feature). If the Zellij crew actually runs in **WSL**, treat it
as a Linux host (Unix sockets / `$TMPDIR`), not this Interactive logon task.

`zswarm serve --install` creates or updates the **owned** `zswarm-serve`
Interactive logon task for the current Windows user, then waits until
authenticated hello and host inspection prove this installation. It does
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
- Windows OpenSSH Server is reachable from the controller over the tailnet.
- A private `ZSWARM_SERVE_TOKEN` is loaded in **both** the desktop process that
  runs `--install` and the controller process that calls `--serve`. Do not put
  the token in the URI, argv, or shell history snippets you paste around.

On the controller:

- An SSH identity and host-key verification that already work
  (`ssh user@crew-host`). zswarm does not disable `StrictHostKeyChecking` or
  prompt for a password (`BatchMode`).
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

## Host (Windows desktop)

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

## Controller

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

## Limits and troubleshooting

| Symptom | What it usually is |
| --- | --- |
| Login / reboot / logout | Interactive tasks need the user logged on. After reboot/logout, log in on that desktop; the AtLogOn trigger starts the task again. Headless boot will not see the crew. |
| `warning` / empty `sessions` | Server listed sessions and found none. Start the crew on the desktop, then `--install --session …` or doctor. |
| `ipc_failed` / wrong desktop | Listener is up but not the desktop IPC. Confirm the task principal is the logged-in account (`Interactive` / `Limited`), not SYSTEM. |
| `session_missing` | Requested name is not live through the server. `zellij list-sessions` on that desktop. |
| Unreachable serve / `serve_unreachable` | Task not running, port not bound, or SSH forward not to that loopback port. |
| `serve_unauthorized` / token mismatch | Same token on install env and controller. Reinstall to rotate. |
| `stale_listener` | Something else answered on the port without this launch identity. Install does **not** kill arbitrary node/port owners. `--clear` the **owned** task or free the port, then retry. |
| `serve_not_ready` after register | Task remains. Retry `--install` or `zswarm doctor`. `--clear` only when you intend to remove it. |

Doctor troubleshooting: [doctor.md](doctor.md).
