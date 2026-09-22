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

On the controller, either keep a tunnel running and use its existing endpoint,
or pass an `ssh://` URI so zswarm owns a one-shot LocalForward:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:9419:127.0.0.1:9419 user@host
# In the controller's other terminal, with ZSWARM_SERVE_TOKEN already set:
zswarm --serve 127.0.0.1:9419 status --session crew

# One-shot attach (desktop serve must already be running; this does not install
# or start it). Authority port is SSH; servePort is remote 127.0.0.1 (default 9419):
zswarm --serve 'ssh://Administrator@host:22?servePort=9419' status --session crew
# MCP: ZSWARM_SERVE='ssh://host?servePort=9419' and the same ZSWARM_SERVE_TOKEN.
```

`host:port` and `tcp://host:port` still mean an already-open loopback endpoint.
`ssh://` is parsed separately: zswarm spawns foreground `ssh -N -T` with
`-L 127.0.0.1:<ephemeral>:127.0.0.1:<servePort>`, `ExitOnForwardFailure`, and
keepalives. Host-key verification stays on. `ZSWARM_SSH_BIN` / `ZSWARM_SSH_OPTS`
are honored; ControlMaster/daemonize that would outlive the tracked child is
rejected. TCP connect is not readiness — `probeServe` (hello) must succeed
before any application op. Wrong token, auth, or hello never dispatches.
CLI disposes the child on success, failure, and cancel before exit. MCP reuses
a healthy owned tunnel until stdin EOF. Reconnect only happens before a request
is sent; a lost reply is `uncertain` and is never retried. Serve never falls
back to direct `ZSWARM_SSH`.

`--serve ADDRESS` overrides inherited SSH/serve destinations for one call;
`--local`, `--ssh`, and `--serve` are mutually exclusive. MCP accepts
`serveAddress`, or set `ZSWARM_SERVE` in the MCP server environment. An explicit
session travels with the request; other session defaults belong to the server.
There is no automatic switch to a different host if the endpoint fails.
If embedding `startServe` yourself, pass `serveChildEnv(process.env)` to the
handler's `dispatchZswarm` environment, as the CLI does, so inherited routing
does not forward requests back into the server.

## Serve hello and transport errors

After token auth, and before any application op, `zswarm serve` answers a reserved
hello control without touching Zellij, the bus, or a session:

```json
{ "serveControl": "hello", "serveToken": "<token>" }
```

`{ "op": "hello", "serveToken": "<token>" }` is accepted for compatibility. A
request must not include both `serveControl` and `op`. Unknown controls return
`serve_protocol` and never run an application op as a side effect.

A successful hello `data` object is:

| Field | Meaning |
| --- | --- |
| `protocol` | `1` |
| `serverId` | Opaque id unique to this `startServe` instance |
| `hostname` | Server hostname |
| `platform` | `process.platform` |
| `version` | `@zswarm/core` package version |
| `capabilities` | Currently `["hello"]` only |

`probeServe(target, { token, timeoutMs, signal })` sends that hello and validates
protocol 1 plus the hello capability. A legacy serve, a malformed hello, or
another protocol number is an explicit diagnostic failure — never a false
healthy. Ordinary commands still work against a legacy serve without probing
hello first.

Wrong or missing tokens keep `serve_unauthorized` with no hello metadata.

`callServe` keeps its callers and `OpsResult` shape. Client-side transport
failures add `error.details`:

| Field | Meaning |
| --- | --- |
| `phase` | `connect`, `hello`, or `request` |
| `endpoint` | `host:port` label |
| `delivery` | `not_sent`, `uncertain` (request written, no complete reply), or `replied` |
| `remedy` | Conservative next step |

`delivery: "uncertain"` means the remote outcome is unknown; do not retry.
Connect and hello waits are bounded inside the overall deadline so a long
`wait`/`await` budget is not spent on a dead TCP handshake. A socket EOF or
truncated JSONL settles promptly. Serve failures never fall back to SSH.
Authorization and application errors keep `serve_unauthorized` / their app
codes and are not labeled as a dead tunnel.

Success JSONL replies must include an own `data` field (`null` is valid).
`{ "ok": true }` and a success envelope that only carries `error` are
`serve_protocol` (complete frame, `delivery: "replied"`). Incomplete frames
stay `uncertain`.

### Reply size

Limits are **UTF-8 bytes of the complete JSONL frame, including the
terminating newline**. Split multibyte sequences are reassembled before
decode. The cap is not a silent truncate.

| Limit | Default | Meaning |
| --- | --- | --- |
| Zellij capture | 8MiB (`maxBuffer`) | `dump --max 0` / `--full` can return this much pane text |
| Ordinary serve reply | 16MiB + 256KiB | 8MiB capture with JSON newline escaping (2×) plus envelope slack |
| Hello reply | 16KiB | Independent of dump-sized ops |
| Serve request | 1MiB | Unchanged JSONL request bound |

`ZSWARM_SERVE_MAX_REPLY_BYTES` on the **caller** (CLI or MCP environment)
overrides the ordinary reply cap. Hello stays on its own 16KiB cap. A frame
over the cap fails promptly with `serve_protocol` and does not echo the
body. Control-heavy dumps that JSON-escape beyond the default (for example
`\uXXXX`) can raise that env var; they still fail closed rather than
truncate.

Protocol codes:

| Code | Meaning |
| --- | --- |
| `serve_protocol` | Unknown/ambiguous control, or malformed/truncated/incomplete JSONL |
| `serve_incompatible` | Hello `protocol` is not `1` |
| `serve_hello_unsupported` | Endpoint answered but does not speak hello |
| `serve_unreachable` | TCP connect failed before a request was sent |
| `serve_unauthorized` | Missing or wrong token |
| `timeout` | Connect, hello, or request deadline |

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
`ssh://` serve tunnels are the exception: they force a foreground-owned child
(`ControlMaster=no`) so the LocalForward cannot outlive the process that
spawned it. Explicit sessions, a persistent serve process, and the bus provide
the main improvements without requiring multiplexing.
