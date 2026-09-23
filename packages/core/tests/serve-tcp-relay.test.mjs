process.env.ZSWARM_LOG = "0";
process.env.ZSWARM_BUS = "0";

/**
 * Private TCP Tailscale Serve compatibility: an in-process transparent TCP
 * relay models the Tailscale Serve forwarding hop over real loopback sockets.
 * This is protocol/transport evidence — not a live Tailscale daemon/ACL test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callServe,
  createStateStore,
  createZellijClient,
  dispatchZswarm,
  DOCTOR_FAILED_CODE,
  parseListenAddress,
  probeServe,
  serveChildEnv,
  startServe,
} from "../dist/index.js";

const TOKEN = "relay-secret";

function missingTailscale() {
  return async () => ({ code: 127, stdout: "", stderr: "ENOENT: tailscale" });
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-tcp-relay-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function checkById(report, id) {
  const checks = report?.checks ?? report;
  return (Array.isArray(checks) ? checks : []).find((row) => row.id === id);
}

function hostClient(t, opts = {}) {
  const sessions = opts.sessions ?? "crew [Created 1] (current)\n";
  const panes = opts.panes ?? [
    {
      id: 1,
      is_plugin: false,
      is_focused: true,
      title: "builder",
      exited: false,
      is_floating: false,
      tab_id: 0,
      tab_name: "T",
      pane_command: "claude.exe",
    },
  ];
  const exec = async (args) => {
    if (args[0] === "--version") return { code: 0, stdout: "zellij 0.42.2", stderr: "" };
    if (args.includes("--help")) {
      return { code: 0, stdout: "Usage: zellij list-sessions [--no-formatting]\n", stderr: "" };
    }
    if (args.includes("list-sessions")) return { code: 0, stdout: sessions, stderr: "" };
    if (args.includes("list-panes")) {
      return { code: 0, stdout: JSON.stringify(panes), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return createZellijClient({ env: opts.env ?? {}, exec, skipIdentityProbe: true });
}

/**
 * Transparent byte-forwarding frontend → backend relay (models Tailscale Serve
 * --tcp). Chunked writes exercise framing across the hop. Closes all owned
 * sockets/listeners on every outcome.
 */
function createTransparentTcpRelay(t, backendLabel, options = {}) {
  const backend = parseListenAddress(backendLabel);
  const owned = new Set();
  let closed = false;
  let acceptCount = 0;
  let upstreamAttempts = 0;
  let bytesDown = 0;
  let bytesUp = 0;
  const chunkSize = options.chunkSize ?? 0;

  const pipeChunked = (src, dst, direction) => {
    src.on("data", (chunk) => {
      if (closed || dst.destroyed) return;
      if (direction === "down") bytesDown += chunk.length;
      else bytesUp += chunk.length;
      if (!chunkSize || chunk.length <= chunkSize) {
        dst.write(chunk);
        return;
      }
      for (let i = 0; i < chunk.length; i += chunkSize) {
        if (dst.destroyed) return;
        dst.write(chunk.subarray(i, Math.min(i + chunkSize, chunk.length)));
      }
    });
    src.on("end", () => {
      if (!dst.destroyed) dst.end();
    });
    src.on("error", () => {
      if (!dst.destroyed) dst.destroy();
    });
    dst.on("error", () => {
      if (!src.destroyed) src.destroy();
    });
  };

  return new Promise((resolve, reject) => {
    const server = createServer((client) => {
      acceptCount += 1;
      owned.add(client);
      client.on("close", () => owned.delete(client));
      if (options.dropAfterAccept) {
        client.destroy();
        return;
      }
      upstreamAttempts += 1;
      const upstream = connect({ host: backend.host, port: backend.port });
      owned.add(upstream);
      upstream.on("close", () => owned.delete(upstream));
      upstream.on("connect", () => {
        if (options.dropAfterUpstreamConnect) {
          upstream.destroy();
          client.destroy();
          return;
        }
        if (options.dropReplyAfterRequest) {
          // Forward the request to the backend, but never deliver a reply.
          pipeChunked(client, upstream, "up");
          upstream.on("data", () => {
            if (!client.destroyed) client.end();
          });
          upstream.on("end", () => {
            if (!client.destroyed) client.end();
          });
          return;
        }
        pipeChunked(client, upstream, "up");
        pipeChunked(upstream, client, "down");
      });
      upstream.on("error", () => {
        if (!client.destroyed) client.destroy();
      });
      client.on("error", () => {
        if (!upstream.destroyed) upstream.destroy();
      });
    });

    const close = () =>
      new Promise((done, fail) => {
        closed = true;
        for (const sock of [...owned]) {
          try {
            sock.destroy();
          } catch {
            // ignore
          }
        }
        owned.clear();
        server.close((err) => (err ? fail(err) : done()));
      });

    t.after(async () => {
      await close().catch(() => {});
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        label: `127.0.0.1:${port}`,
        tcpUri: `tcp://127.0.0.1:${port}`,
        port,
        close,
        stats: () => ({
          acceptCount,
          upstreamAttempts,
          bytesDown,
          bytesUp,
          openSockets: owned.size,
          closed,
        }),
      });
    });
  });
}

async function startBackend(t, dispatch, token = TOKEN) {
  const server = await startServe("127.0.0.1:0", dispatch, { token });
  t.after(() => server.close());
  return server;
}

async function doctorBackend(t, serverEnv = {}) {
  const dir = tempDir(t);
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  const client = hostClient(t);
  const server = await startServe(
    "127.0.0.1:0",
    (request) =>
      dispatchZswarm(request, client, {
        env: serveChildEnv({ ZSWARM_STATE_DIR: dir, ...serverEnv }),
        state: store,
        tailscaleStatus: missingTailscale(),
      }),
    { token: TOKEN },
  );
  t.after(() => server.close());
  return { server, dir, store };
}

test("relay: authenticated hello and ordinary op via dispatch / serveAddress / tcp://", async (t) => {
  let dispatched = 0;
  const backend = await startBackend(t, async (args) => {
    dispatched += 1;
    assert.equal(args.serveToken, undefined);
    return { ok: true, data: { op: args.op, via: "relay" } };
  });
  const relay = await createTransparentTcpRelay(t, backend.label);

  const hello = await probeServe(relay.label, { token: TOKEN, timeoutMs: 3_000 });
  assert.equal(hello.ok, true, JSON.stringify(hello));
  assert.equal(hello.data.protocol, 1);
  assert.ok(Array.isArray(hello.data.capabilities));

  const viaEnv = await dispatchZswarm(
    { op: "list" },
    undefined,
    { env: { ZSWARM_SERVE: relay.label, ZSWARM_SERVE_TOKEN: TOKEN } },
  );
  assert.equal(viaEnv.ok, true, JSON.stringify(viaEnv));
  assert.equal(viaEnv.data.op, "list");
  assert.equal(viaEnv.context.transport, "serve");

  const viaFlag = await dispatchZswarm(
    { op: "sessions", serveAddress: relay.tcpUri },
    undefined,
    { env: { ZSWARM_SERVE_TOKEN: TOKEN } },
  );
  assert.equal(viaFlag.ok, true, JSON.stringify(viaFlag));
  assert.equal(viaFlag.data.op, "sessions");

  assert.equal(dispatched, 2);
  assert.ok(relay.stats().acceptCount >= 3);
});

test("relay: missing/wrong token never dispatches; correct token keeps doctor host findings", async (t) => {
  let dispatched = 0;
  const { server } = await doctorBackend(t, { ZSWARM_SESSION: "crew" });
  const counting = await startBackend(t, async () => {
    dispatched += 1;
    return { ok: true, data: { leaked: true } };
  });
  const relayCount = await createTransparentTcpRelay(t, counting.label);
  const relayDoctor = await createTransparentTcpRelay(t, server.label);

  const missing = await dispatchZswarm(
    { op: "list" },
    undefined,
    { env: { ZSWARM_SERVE: relayCount.label } },
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "serve_unauthorized");
  assert.equal(dispatched, 0);

  const wrong = await dispatchZswarm(
    { op: "list", serveAddress: relayCount.tcpUri },
    undefined,
    { env: { ZSWARM_SERVE_TOKEN: "wrong-token" } },
  );
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, "serve_unauthorized");
  assert.equal(dispatched, 0);

  const doctor = await dispatchZswarm(
    { op: "doctor", serveAddress: relayDoctor.tcpUri, session: "crew", timeoutMs: 5_000 },
    undefined,
    { env: { ZSWARM_SERVE_TOKEN: TOKEN }, tailscaleStatus: missingTailscale() },
  );
  assert.equal(doctor.ok, true, JSON.stringify(doctor));
  assert.equal(checkById(doctor.data, "serve").code, "serve_hello_ok");
  assert.equal(checkById(doctor.data, "session").code, "session_present");
  assert.equal(doctor.data.route.session, "crew");
  assert.equal(doctor.data.server.protocol, 1);
});

test("relay: fragmented JSONL and Unicode survive; large replies are not request-capped", async (t) => {
  const unicode = "café 犬 🐕 — framing";
  const large = "x".repeat(Math.ceil(1.2 * 1024 * 1024));
  const backend = await startBackend(t, async (args) => {
    if (args.op === "ping") {
      return { ok: true, data: { note: unicode } };
    }
    if (args.op === "dump") {
      return {
        ok: true,
        data: {
          session: "crew",
          to: "1",
          text: large,
          truncated: false,
          chars: large.length,
          max: 0,
        },
      };
    }
    return { ok: false, error: { code: "failed", message: `unexpected ${args.op}` } };
  });
  // Force sub-byte-of-multibyte and multi-chunk framing across the hop.
  const relay = await createTransparentTcpRelay(t, backend.label, { chunkSize: 7 });

  const ping = await callServe(relay.tcpUri, { op: "ping" }, { timeoutMs: 5_000, token: TOKEN });
  assert.equal(ping.ok, true, JSON.stringify(ping));
  assert.equal(ping.data.note, unicode);

  const dump = await dispatchZswarm(
    { op: "dump", to: "1", max: 0, serveAddress: relay.label },
    undefined,
    { env: { ZSWARM_SERVE_TOKEN: TOKEN } },
  );
  assert.equal(dump.ok, true, dump.ok ? "" : dump.error.message);
  assert.equal(dump.data.text.length, large.length);
  assert.ok(relay.stats().bytesDown > 1024 * 1024);
  assert.ok(relay.stats().bytesUp > 0);
});

test("relay: listening frontend with unavailable backend is not ready", async (t) => {
  // Occupy then free a port so the label is unused (backend never listens).
  const placeholder = await new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(`127.0.0.1:${port}`));
    });
  });
  const relay = await createTransparentTcpRelay(t, placeholder);

  const started = Date.now();
  const probe = await probeServe(relay.tcpUri, { token: TOKEN, timeoutMs: 1_500 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4_000, `unready backend must settle within budget (${elapsed}ms)`);
  assert.equal(probe.ok, false);
  assert.ok(
    probe.error.code === "serve_unreachable" ||
      probe.error.code === "serve_protocol" ||
      probe.error.code === "timeout",
    probe.error.code,
  );
  assert.notEqual(probe.error.details?.delivery, "replied");

  const doctor = await dispatchZswarm(
    { op: "doctor", serveAddress: relay.label, session: "crew", timeoutMs: 1_500 },
    undefined,
    { env: { ZSWARM_SERVE_TOKEN: TOKEN }, tailscaleStatus: missingTailscale() },
  );
  assert.equal(doctor.ok, false);
  assert.equal(doctor.error.code, DOCTOR_FAILED_CODE);
  const serve = checkById(doctor.error.details, "serve");
  assert.equal(serve.state, "fail");
  assert.ok(
    ["serve_connect", "serve_hello", "serve_protocol", "serve_unreachable", "timeout"].some(
      (c) => serve.code === c || serve.code?.startsWith("serve_"),
    ),
    serve.code,
  );
  assert.equal(checkById(doctor.error.details, "zellij_binary")?.state, "skipped");
});

test("relay: lost reply after mutating request is uncertain with no replay", async (t) => {
  let dispatched = 0;
  const backend = await startBackend(t, async (args) => {
    dispatched += 1;
    return { ok: true, data: { op: args.op, applied: true } };
  });
  const relay = await createTransparentTcpRelay(t, backend.label, {
    dropReplyAfterRequest: true,
  });

  const lost = await callServe(
    relay.label,
    { op: "send", to: "1", body: "mutate-once" },
    { timeoutMs: 2_000, token: TOKEN },
  );
  assert.equal(lost.ok, false, JSON.stringify(lost));
  assert.ok(
    lost.error.code === "serve_protocol" || lost.error.code === "timeout",
    lost.error.code,
  );
  assert.equal(lost.error.details.delivery, "uncertain");
  assert.equal(lost.error.details.phase, "request");
  assert.match(lost.error.details.remedy, /uncertain|Do not retry/i);
  assert.equal(dispatched, 1, "must not replay or double-dispatch");

  // Explicit backend rejection is distinct from uncertain loss.
  const rejecting = await startBackend(t, async () => ({
    ok: false,
    error: { code: "policy", message: "denied by policy" },
  }));
  const relayOk = await createTransparentTcpRelay(t, rejecting.label);
  const denied = await callServe(relayOk.label, { op: "send", to: "1", body: "x" }, {
    timeoutMs: 2_000,
    token: TOKEN,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "policy");
  assert.equal(denied.error.details?.delivery, undefined);
});

test("relay: cancellation and timeout clean up owned fixtures; direct path still works", async (t) => {
  let entered = false;
  const backend = await startBackend(t, async () => {
    entered = true;
    return new Promise(() => {});
  });
  const relay = await createTransparentTcpRelay(t, backend.label);

  const abort = new AbortController();
  const pending = callServe(relay.tcpUri, { op: "ping" }, {
    timeoutMs: 30_000,
    token: TOKEN,
    signal: abort.signal,
  });
  const waitStart = Date.now();
  while (!entered && Date.now() - waitStart < 2_000) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(entered, true);
  abort.abort();
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, "cancelled");
  assert.equal(cancelled.error.details.delivery, "uncertain");

  // Direct (non-relay) loopback still works — unrelated path unchanged.
  const direct = await callServe(backend.label, { op: "ping" }, {
    timeoutMs: 500,
    token: TOKEN,
  });
  assert.equal(direct.ok, false);
  assert.ok(direct.error.code === "timeout" || direct.error.code === "cancelled");

  await relay.close();
  assert.equal(relay.stats().closed, true);
  assert.equal(relay.stats().openSockets, 0);

  // After relay shutdown, frontend is gone; backend remains.
  const deadFrontend = await probeServe(relay.label, { token: TOKEN, timeoutMs: 800 });
  assert.equal(deadFrontend.ok, false);
  assert.equal(deadFrontend.error.code, "serve_unreachable");
});

test("relay: state dir fixtures are cleaned and lock files are not left open", async (t) => {
  const { server, dir } = await doctorBackend(t, { ZSWARM_SESSION: "crew" });
  const relay = await createTransparentTcpRelay(t, server.label, { chunkSize: 11 });
  const result = await dispatchZswarm(
    { op: "doctor", serveAddress: relay.tcpUri, session: "crew", timeoutMs: 5_000 },
    undefined,
    { env: { ZSWARM_SERVE_TOKEN: TOKEN }, tailscaleStatus: missingTailscale() },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  await relay.close();
  // No abandoned lock files from these doctor reads.
  assert.equal(existsSync(join(dir, "cursors.lock")), false);
  assert.equal(existsSync(join(dir, "signals.lock")), false);
});
