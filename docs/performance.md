# Polling crews efficiently

For frequent status calls, run `zswarm serve` on the machine and desktop session
that owns Zellij, and reach it through an SSH tunnel. This keeps discovery,
listing caches and the event bus beside the crew. Windows interactive SSH still
works for occasional commands, but each uncached Zellij action requires a
scheduled desktop task.

Set `ZSWARM_SERVE_TOKEN` to the same private value on the server and controller.
On Windows, start the server from the logged-in desktop (PowerShell):

```powershell
$env:ZSWARM_SERVE_TOKEN = '<shared token>'
zswarm serve --listen 127.0.0.1:9419
```

On a Unix host, the equivalent server command is:

```bash
ZSWARM_SERVE_TOKEN='<shared token>' zswarm serve --listen 127.0.0.1:9419
```

On the controller, keep a tunnel running, then use its existing endpoint:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:9419:127.0.0.1:9419 user@host
# In the controller's other terminal, with ZSWARM_SERVE_TOKEN already set:
zswarm --serve 127.0.0.1:9419 status --session crew
```

`--serve ADDRESS` overrides inherited SSH/serve destinations for one call;
`--local`, `--ssh`, and `--serve` are mutually exclusive. It connects to an
existing endpoint and does not launch a tunnel or server. MCP accepts
`serveAddress`, or set `ZSWARM_SERVE` in the MCP server environment. An explicit
session travels with the request; other session defaults belong to the server.
There is no automatic switch to a different host if the endpoint fails.
If embedding `startServe` yourself, pass `serveChildEnv(process.env)` to the
handler's `dispatchZswarm` environment, as the CLI does, so inherited routing
does not forward requests back into the server.

Direct SSH status includes `polling.recommendation` explaining the serve path;
interactive CLI use also prints this advice on stderr. `polling.busAvailable`
and `polling.reason` expose bus availability. JSON stdout stays machine-readable.
The event bus cannot be used through direct SSH because its WASM URL is local to
the Zellij host; a serve endpoint on that host can use it.

Install the bus once in the owning session with `zswarm bus --install --session
crew`, then approve that plugin's permission request. An installed, ready bus
is preferred automatically for ordinary status:

| Request | Observation |
| --- | --- |
| `status` with a ready bus | Manifest plus one batch of changes/screens; no sample sleep or per-pane dump processes |
| `status --since-last` | Explicitly request that same change observation; fall back if unavailable |
| `status --sample-ms 400` | Two observations separated by the requested interval |
| `status --sample-ms 0` | Metadata only: running/exited; no activity or prompt classification |
| `status` without a usable bus | Bounded, concurrent screen sampling with a 400ms gap per pane |

Zellij pushes pane/tab manifests into the plugin. Screen changes are still a
request/reply observation through that plugin, rather than a streaming output
subscription. The plugin's change baseline is shared by callers of that plugin
instance, so `sinceLast` means since the preceding bus observation. Use explicit
sampling when a controller needs its own fixed observation interval. First or
missing observations stay `unknown` and out of `free`; a visible recognized
prompt can already be `waiting`. An older plugin that does not answer change
requests falls back to sampling. Bus failures suppress retries for five seconds
for that session/plugin/context only, then recover automatically.

Session, pane and tab listings are cached for **500ms**, across dispatch calls in
the same MCP/serve process. Set `ZSWARM_CACHE_TTL_MS=0` to disable reuse or select
another TTL up to 5000ms. `--fresh` bypasses listing reuse for one request.
Standalone CLI processes do not share a disk cache; repeated CLI calls through
serve benefit from the server's persistent cache.

Cache keys include transport, host, binary, SSH options, session, resolved IPC
namespace and user/environment routing context. Spawn/close/rename/tab/focus,
stack, plugin launch and input mutations invalidate listings before and after
the action, even on failure. Bus manifest revisions invalidate them too. Reads
that overlap invalidation cannot refill the cache with their old observation.
Write-target checks and spawn/alias settling always read fresh metadata; screen
reads used by `--expect` are never cached. External changes without a bus can
remain visible in read-only listing results until the TTL expires.

Positive automatic SSH IPC discovery is reused for **15 seconds** in-process.
Failures, cancellations and expired probes are not shared or cached. Each
caller's failure diagnostics remain its own. Known Windows routing avoids an
irrelevant Unix fallback; ambiguous platforms keep both discovery probes.
Each high-level client keeps its resolved IPC namespace for its lifetime so a
lookup and subsequent write cannot be redirected by another caller's discovery.
Dispatch creates a client per request; when using a long-lived SDK client,
recreate it after the remote IPC directory moves.
Identity and capability checks run in parallel after IPC preparation, and
verbose status overlaps its independent metadata and bus reads. These stages
share the operation deadline. In-flight promises are never reused across
callers with different timeout or cancellation budgets.

For direct SSH, existing OpenSSH connection multiplexing can be configured in
`~/.ssh/config` or `ZSWARM_SSH_OPTS` where the controller's SSH implementation
supports it. zswarm does not create control sockets or rewrite SSH config.
Explicit sessions, a persistent serve process, and the bus provide the main
improvements without requiring multiplexing.
