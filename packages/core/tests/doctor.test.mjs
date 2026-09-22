process.env.ZSWARM_LOG = "0";
process.env.ZSWARM_BUS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createServeTunnelManager,
  createStateStore,
  createZellijClient,
  DEFAULT_DOCTOR_TIMEOUT_MS,
  dispatchZswarm,
  DOCTOR_FAILED_CODE,
  DOCTOR_SCOPE_FIELD,
  DOCTOR_SCOPE_HOST,
  loadPolicy,
  mcpInputSchema,
  OP_NAMES,
  parseCliArgv,
  probeServe,
  serveChildEnv,
  startServe,
} from "../dist/index.js";

const MUTATION_NEEDLES = [
  "pipe",
  "launch-or-focus-plugin",
  "rename-pane",
  "rename-tab-by-id",
  "new-pane",
  "new-tab",
  "close-pane",
  "focus-pane-id",
  "stack-panes",
  "paste",
  "send-keys",
  "write-chars",
  "schtasks",
];

const SSH_FORWARD_SOURCE = `
import { createServer, connect } from "node:net";
import { existsSync } from "node:fs";
const args = process.argv.slice(2);
function opt(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}
const forward = opt("-L");
const parts = forward.split(":");
const localHost = parts[0];
const localPort = Number(parts[1]);
const remoteHost = parts[2];
const remotePort = Number(parts[3]);
const gate = process.env.SSH_FIXTURE_GATE;
if (gate) {
  while (!existsSync(gate)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}
const server = createServer((client) => {
  const upstream = connect({ host: remoteHost, port: remotePort });
  const fail = () => { client.destroy(); upstream.destroy(); };
  client.on("error", fail);
  upstream.on("error", fail);
  client.pipe(upstream);
  upstream.pipe(client);
});
server.listen(localPort, localHost);
process.on("SIGTERM", () => { server.close(); process.exit(0); });
`;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-doctor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function snapshotState(dir) {
  const files = ["bus.json", "cursors.json", "log.jsonl", "signals.json"];
  const out = {};
  for (const name of files) {
    const path = join(dir, name);
    out[name] = existsSync(path) ? readFileSync(path, "utf8") : null;
  }
  return out;
}

function missingTailscale() {
  return async () => ({ code: 127, stdout: "", stderr: "ENOENT: tailscale" });
}

function wrapState(store) {
  const writes = [];
  return {
    store: {
      ...store,
      appendLog: (...args) => {
        writes.push(["appendLog", args]);
        return store.appendLog(...args);
      },
      writeCursor: (...args) => {
        writes.push(["writeCursor", args]);
        return store.writeCursor(...args);
      },
      writeBus: (...args) => {
        writes.push(["writeBus", args]);
        return store.writeBus(...args);
      },
      clearBus: (...args) => {
        writes.push(["clearBus", args]);
        return store.clearBus(...args);
      },
      postSignal: (...args) => {
        writes.push(["postSignal", args]);
        return store.postSignal(...args);
      },
    },
    writes,
  };
}

function hostClient(t, opts = {}) {
  const calls = [];
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
    {
      id: 9,
      is_plugin: true,
      is_focused: false,
      title: "file:///tmp/zswarm-bus-v3.wasm",
      exited: false,
      is_floating: true,
      tab_id: 0,
      tab_name: "T",
    },
  ];
  const version = opts.version ?? "zellij 0.42.2";
  const help = opts.help ?? "Usage: zellij list-sessions [--no-formatting]\n";
  const exec = async (args) => {
    calls.push(args);
    if (args[0] === "--version") return { code: 0, stdout: version, stderr: "" };
    if (args.includes("--help")) return { code: 0, stdout: help, stderr: "" };
    if (args.includes("list-sessions")) {
      if (opts.sessionError) return opts.sessionError;
      return { code: 0, stdout: sessions, stderr: "" };
    }
    if (args.includes("list-panes")) {
      if (opts.paneError) return opts.paneError;
      return { code: 0, stdout: JSON.stringify(panes), stderr: "" };
    }
    if (opts.exec) return opts.exec(args);
    return { code: 0, stdout: "", stderr: "" };
  };
  const client = createZellijClient({ env: opts.env ?? {}, exec, skipIdentityProbe: true });
  t.after(() => {
    for (const args of calls) {
      const joined = args.join(" ");
      for (const needle of MUTATION_NEEDLES) {
        assert.equal(
          joined.includes(needle),
          false,
          `doctor invoked mutation (${needle}): ${joined}`,
        );
      }
    }
  });
  return { client, calls };
}

function checkById(report, id) {
  const checks = report?.checks ?? report;
  return (Array.isArray(checks) ? checks : []).find((row) => row.id === id);
}

async function listenRaw(onSocket) {
  return new Promise((resolve, reject) => {
    const server = createServer(onSocket);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        label: `127.0.0.1:${port}`,
        close: () =>
          new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

function listenLegacy(handler) {
  return listenRaw((socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const parsed = JSON.parse(buf.slice(0, nl));
      const result = handler(parsed);
      socket.write(`${JSON.stringify(result)}\n`);
    });
  });
}

function sshFixture(t, extraEnv = {}) {
  const dir = tempDir(t);
  const file = join(dir, "ssh-fixture.mjs");
  writeFileSync(file, SSH_FORWARD_SOURCE);
  const launches = [];
  return {
    file,
    launches,
    spawn(bin, args, opts) {
      const child = spawn(process.execPath, [file, ...args], {
        ...opts,
        env: { ...process.env, ...extraEnv, ...(opts?.env ?? {}) },
      });
      launches.push({ bin, args, child });
      return child;
    },
  };
}

test("schema and CLI parse doctor with the shared surface", () => {
  assert.ok(OP_NAMES.includes("doctor"));
  assert.deepEqual(mcpInputSchema().properties.op.enum, [...OP_NAMES]);
  assert.equal(Object.hasOwn(mcpInputSchema().properties, DOCTOR_SCOPE_FIELD), false);
  assert.deepEqual(
    parseCliArgv(["--serve", "127.0.0.1:9419", "doctor", "--session", "crew", "--timeout-ms", "10000"]),
    { op: "doctor", serveAddress: "127.0.0.1:9419", session: "crew", timeoutMs: 10000 },
  );
  assert.deepEqual(parseCliArgv(["--ssh", "user@host", "doctor", "--session", "crew"]), {
    op: "doctor",
    ssh: "user@host",
    session: "crew",
  });
  assert.equal(DEFAULT_DOCTOR_TIMEOUT_MS, 10_000);
});

test("explicit selector conflicts stay usage", async () => {
  const result = await dispatchZswarm(
    { op: "doctor", local: true, ssh: "user@host" },
    undefined,
    { env: {}, tailscaleStatus: missingTailscale() },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "usage");
  assert.equal(result.error.details, undefined);
});

test("local route with explicit session is healthy and inspect-only", async (t) => {
  const dir = tempDir(t);
  const wasm = join(dir, "zswarm-bus-v3.wasm");
  writeFileSync(wasm, "wasm");
  const { client, calls } = hostClient(t);
  const base = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  base.writeBus("crew", { plugin: wasm, configKey: "zswarm-bus", installedAt: 1 });
  const wrapped = wrapState(base);
  const before = snapshotState(dir);
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 5000 },
    client,
    {
      env: { ZSWARM_BUS_PLUGIN: wasm, ZSWARM_STATE_DIR: dir },
      state: wrapped.store,
      tailscaleStatus: missingTailscale(),
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const report = result.data;
  assert.equal(report.route.transport, "local");
  assert.equal(report.route.session, "crew");
  assert.equal(report.route.sessionOrigin, "explicit");
  assert.equal(checkById(report, "route").code, "route_selected");
  assert.equal(checkById(report, "ssh").code, "ssh_not_applicable");
  assert.equal(checkById(report, "serve").code, "serve_not_applicable");
  assert.equal(checkById(report, "zellij_binary").code, "zellij_ok");
  assert.equal(checkById(report, "session").code, "session_present");
  assert.equal(checkById(report, "bus_artifact").code, "bus_artifact_present");
  assert.equal(checkById(report, "bus_marker").code, "bus_marker_present");
  assert.equal(checkById(report, "bus_instance").code, "bus_instance_observed");
  assert.equal(checkById(report, "bus_instance").detail.readiness, "unknown");
  assert.deepEqual(wrapped.writes, []);
  assert.deepEqual(snapshotState(dir), before);
  assert.ok(calls.some((args) => args.includes("list-sessions")));
  assert.equal(calls.some((args) => args.includes("pipe")), false);
});

test("read-only policy still permits doctor", async (t) => {
  const { client } = hostClient(t);
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew" },
    client,
    {
      env: { ZSWARM_READONLY: "1" },
      policy: loadPolicy({ ZSWARM_READONLY: "1" }),
      tailscaleStatus: missingTailscale(),
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(checkById(result.data, "session").state, "ok");
});

test("no visible sessions without a selected session is a warning", async (t) => {
  const { client } = hostClient(t, { sessions: "" });
  const result = await dispatchZswarm(
    { op: "doctor" },
    client,
    { env: {}, tailscaleStatus: missingTailscale() },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(checkById(result.data, "zellij_sessions").code, "sessions_none");
  assert.equal(checkById(result.data, "session").state, "warn");
});

test("missing explicitly selected session is doctor_failed", async (t) => {
  const { client } = hostClient(t, { sessions: "other [Created 1]\n" });
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew" },
    client,
    { env: {}, tailscaleStatus: missingTailscale() },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DOCTOR_FAILED_CODE);
  const report = result.error.details;
  assert.equal(checkById(report, "session").code, "session_missing");
  assert.equal(checkById(report, "serve").code, "serve_not_applicable");
});

test("missing or wrong Zellij binary fails the host binary check", async (t) => {
  const { client } = hostClient(t, {
    sessionError: { code: 127, stdout: "", stderr: "not found" },
  });
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew" },
    client,
    { env: {}, tailscaleStatus: missingTailscale() },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DOCTOR_FAILED_CODE);
  assert.ok(["zellij_missing", "zellij_unreachable", "zellij_wrong_bin"].includes(
    checkById(result.error.details, "zellij_binary").code,
  ));
});

test("direct SSH reports bus unsupported and does not read controller bus files", async (t) => {
  const dir = tempDir(t);
  const wasm = join(dir, "zswarm-bus-v3.wasm");
  writeFileSync(wasm, "wasm");
  const { client, calls } = hostClient(t);
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  store.writeBus("crew", { plugin: wasm, configKey: "k", installedAt: 1 });
  const wrapped = wrapState(store);
  const result = await dispatchZswarm(
    { op: "doctor", ssh: "user@host", session: "crew" },
    client,
    {
      env: { ZSWARM_BUS_PLUGIN: wasm, ZSWARM_STATE_DIR: dir },
      state: wrapped.store,
      tailscaleStatus: missingTailscale(),
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.route.transport, "ssh");
  assert.equal(checkById(result.data, "ssh").code, "ssh_ready");
  assert.equal(checkById(result.data, "bus_artifact").code, "bus_remote_unsupported");
  assert.equal(checkById(result.data, "bus_marker").code, "bus_remote_unsupported");
  assert.equal(checkById(result.data, "bus_instance").code, "bus_remote_unsupported");
  assert.equal(wrapped.writes.length, 0);
  assert.equal(calls.some((args) => args.includes("pipe")), false);
});

test("interactive SSH skips host inspection without claiming a healthy session", async () => {
  const result = await dispatchZswarm(
    { op: "doctor", ssh: "Administrator@host", session: "crew" },
    undefined,
    {
      env: { ZSWARM_SSH_MODE: "interactive" },
      tailscaleStatus: missingTailscale(),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DOCTOR_FAILED_CODE);
  const report = result.error.details;
  assert.equal(checkById(report, "ssh").code, "ssh_interactive_uninspected");
  assert.equal(checkById(report, "session").state, "skipped");
  assert.notEqual(checkById(report, "session").state, "ok");
});

test("explicit --ssh wins over inherited serve and does not call the serve endpoint", async (t) => {
  let served = 0;
  const server = await startServe("127.0.0.1:0", async () => {
    served += 1;
    return { ok: true, data: { op: "should-not-run" } };
  }, { token: "secret" });
  t.after(() => server.close());
  const { client } = hostClient(t);
  const result = await dispatchZswarm(
    { op: "doctor", ssh: "user@host", session: "crew" },
    client,
    {
      env: { ZSWARM_SERVE: server.label, ZSWARM_SERVE_TOKEN: "secret" },
      tailscaleStatus: missingTailscale(),
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.route.transport, "ssh");
  assert.equal(served, 0);
  assert.equal(checkById(result.data, "serve").code, "serve_not_applicable");
});

async function serveDoctor(t, hostOpts = {}, serverEnv = {}) {
  const host = hostClient(t, hostOpts);
  const dir = tempDir(t);
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  const wrapped = wrapState(store);
  const server = await startServe(
    "127.0.0.1:0",
    (request) =>
      dispatchZswarm(request, host.client, {
        env: serveChildEnv({ ZSWARM_STATE_DIR: dir, ...serverEnv }),
        state: wrapped.store,
        tailscaleStatus: missingTailscale(),
      }),
    { token: "secret" },
  );
  t.after(() => server.close());
  return { server, host, store: wrapped, dir };
}

test("manual TCP serve doctor: CLI/MCP parity and host session default", async (t) => {
  const { server, store } = await serveDoctor(t, {}, { ZSWARM_SESSION: "crew" });
  const env = { ZSWARM_SERVE: server.label, ZSWARM_SERVE_TOKEN: "secret" };
  const viaEnv = await dispatchZswarm(
    { op: "doctor", timeoutMs: 4000 },
    undefined,
    { env, tailscaleStatus: missingTailscale() },
  );
  const viaFlag = await dispatchZswarm(
    { op: "doctor", serveAddress: server.label, timeoutMs: 4000 },
    undefined,
    { env: { ZSWARM_SERVE_TOKEN: "secret" }, tailscaleStatus: missingTailscale() },
  );
  for (const result of [viaEnv, viaFlag]) {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.context.transport, "serve");
    assert.equal(checkById(result.data, "ssh").code, "ssh_not_applicable");
    assert.equal(checkById(result.data, "serve").code, "serve_hello_ok");
    assert.equal(checkById(result.data, "session").code, "session_present");
    assert.equal(result.data.route.session, "crew");
    assert.equal(result.data.server.protocol, 1);
    assert.ok(
      ["tailscale_unmappable", "tailscale_skipped"].includes(checkById(result.data, "tailscale").code),
    );
  }
  assert.deepEqual(store.writes, []);
});

test("controller inherited ZELLIJ_SESSION_NAME does not select the server session", async (t) => {
  const { server } = await serveDoctor(
    t,
    { sessions: "host-crew [Created 1]\n" },
    { ZSWARM_SESSION: "host-crew" },
  );
  const result = await dispatchZswarm(
    { op: "doctor", timeoutMs: 4000 },
    undefined,
    {
      env: {
        ZSWARM_SERVE: server.label,
        ZSWARM_SERVE_TOKEN: "secret",
        ZELLIJ_SESSION_NAME: "controller-crew",
      },
      tailscaleStatus: missingTailscale(),
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.route.sessionOrigin === "explicit", false);
  assert.notEqual(result.data.route.session, "controller-crew");
  assert.equal(checkById(result.data, "session").detail.session, "host-crew");
});

test("dead serve endpoint: partial report, no fallback, no host checks", async () => {
  const result = await dispatchZswarm(
    { op: "doctor", serveAddress: "127.0.0.1:1", timeoutMs: 800 },
    undefined,
    {
      env: { ZSWARM_SERVE_TOKEN: "secret", ZSWARM_SSH: "unused@host" },
      tailscaleStatus: missingTailscale(),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DOCTOR_FAILED_CODE);
  const report = result.error.details;
  assert.equal(checkById(report, "route").state, "ok");
  assert.equal(checkById(report, "serve").state, "fail");
  assert.equal(checkById(report, "serve").code, "serve_connect");
  assert.equal(checkById(report, "zellij_binary").state, "skipped");
});

test("wrong token: unauthorized serve, skipped host, no unauthenticated dispatch", async (t) => {
  let dispatched = 0;
  const server = await startServe("127.0.0.1:0", async () => {
    dispatched += 1;
    return { ok: true, data: { leaked: true } };
  }, { token: "right" });
  t.after(() => server.close());
  const result = await dispatchZswarm(
    { op: "doctor", timeoutMs: 3000 },
    undefined,
    {
      env: { ZSWARM_SERVE: server.label, ZSWARM_SERVE_TOKEN: "wrong" },
      tailscaleStatus: missingTailscale(),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DOCTOR_FAILED_CODE);
  assert.equal(checkById(result.error.details, "serve").code, "serve_unauthorized");
  assert.equal(checkById(result.error.details, "session").state, "skipped");
  assert.equal(dispatched, 0);
});

test("legacy serve without hello is a useful partial failure", async (t) => {
  const legacy = await listenLegacy((parsed) => {
    if (parsed.op === "hello" || parsed.serveControl === "hello") {
      return { ok: true, data: { session: "nope" } };
    }
    return { ok: true, data: { forwarded: parsed.op } };
  });
  t.after(() => legacy.close());
  const result = await dispatchZswarm(
    { op: "doctor", timeoutMs: 3000 },
    undefined,
    {
      env: { ZSWARM_SERVE: legacy.label, ZSWARM_SERVE_TOKEN: "secret" },
      tailscaleStatus: missingTailscale(),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DOCTOR_FAILED_CODE);
  const serve = checkById(result.error.details, "serve");
  assert.ok(
    ["serve_hello_unsupported", "serve_protocol"].includes(serve.code),
    serve.code,
  );
  assert.equal(checkById(result.error.details, "zellij_binary").state, "skipped");
});

test("older hello peer lacking doctor skips host checks with upgrade evidence", async (t) => {
  const { client } = hostClient(t);
  const server = await startServe(
    "127.0.0.1:0",
    async (request) => {
      if (request.op === "doctor") {
        return {
          ok: false,
          error: { code: "usage", message: "zswarm requires op=list|sessions|send" },
        };
      }
      return { ok: true, data: { ignored: true } };
    },
    { token: "secret" },
  );
  t.after(() => server.close());
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 4000 },
    undefined,
    {
      env: { ZSWARM_SERVE: server.label, ZSWARM_SERVE_TOKEN: "secret" },
      tailscaleStatus: missingTailscale(),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DOCTOR_FAILED_CODE);
  assert.equal(checkById(result.error.details, "serve").code, "serve_hello_ok");
  assert.equal(checkById(result.error.details, "zellij_binary").code, "doctor_unsupported");
  assert.equal(checkById(result.error.details, "session").state, "skipped");
  assert.equal(client.zellijPath.length > 0, true);
});

test("healthy serve with missing requested session fails; bus remains advisory", async (t) => {
  const { server } = await serveDoctor(t, { sessions: "other [Created 1]\n" });
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 4000 },
    undefined,
    {
      env: { ZSWARM_SERVE: server.label, ZSWARM_SERVE_TOKEN: "secret" },
      tailscaleStatus: missingTailscale(),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DOCTOR_FAILED_CODE);
  assert.equal(checkById(result.error.details, "serve").code, "serve_hello_ok");
  assert.equal(checkById(result.error.details, "session").code, "session_missing");
});

test("absent bus artifact, stale marker, and disabled bus stay advisory", async (t) => {
  const { client } = hostClient(t, {
    panes: [
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
    ],
  });
  const dir = tempDir(t);
  const missingWasm = join(dir, "gone.wasm");
  const store = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  store.writeBus("crew", { plugin: missingWasm, configKey: "k", installedAt: 1 });
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew" },
    client,
    {
      env: { ZSWARM_BUS: "0", ZSWARM_BUS_PLUGIN: join(dir, "nope.wasm") },
      state: store,
      tailscaleStatus: missingTailscale(),
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(checkById(result.data, "bus_artifact").state, "warn");
  assert.equal(checkById(result.data, "bus_marker").code, "bus_marker_stale");
  assert.equal(checkById(result.data, "bus_instance").code, "bus_disabled");
});

test("missing Tailscale CLI is skipped when the route works", async (t) => {
  const { client } = hostClient(t);
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew" },
    client,
    { env: {}, tailscaleStatus: missingTailscale() },
  );
  assert.equal(result.ok, true);
  assert.equal(checkById(result.data, "tailscale").state, "skipped");
  assert.ok(
    ["tailscale_cli_missing", "tailscale_unmappable", "tailscale_skipped"].includes(
      checkById(result.data, "tailscale").code,
    ),
  );
});

test("peer-online Tailscale evidence cannot override a missing session", async (t) => {
  const { client } = hostClient(t, { sessions: "other [Created 1]\n" });
  const result = await dispatchZswarm(
    { op: "doctor", ssh: "netcup", session: "crew" },
    client,
    {
      env: {},
      tailscaleStatus: async () => ({
        code: 0,
        stdout: JSON.stringify({
          Self: { HostName: "box", DNSName: "box.tailnet.ts.net.", Online: true, TailscaleIPs: ["100.64.0.1"] },
          Peer: {
            k: { HostName: "netcup", DNSName: "netcup.tailnet.ts.net.", Online: true, TailscaleIPs: ["100.64.0.2"] },
          },
        }),
        stderr: "",
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, DOCTOR_FAILED_CODE);
  assert.equal(checkById(result.error.details, "tailscale").code, "tailscale_peer_online");
  assert.equal(checkById(result.error.details, "session").code, "session_missing");
});

test("doctor does not invent an SSH destination for host:port serve", async (t) => {
  const fixture = sshFixture(t);
  const { server } = await serveDoctor(t);
  const manager = createServeTunnelManager({ persistIdle: true, spawnSsh: fixture.spawn });
  t.after(() => manager.closeAll());
  const result = await dispatchZswarm(
    { op: "doctor", timeoutMs: 4000 },
    undefined,
    {
      env: { ZSWARM_SERVE: server.label, ZSWARM_SERVE_TOKEN: "secret" },
      serveTunnels: manager,
      tailscaleStatus: missingTailscale(),
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fixture.launches.length, 0);
  assert.equal(checkById(result.data, "ssh").code, "ssh_not_applicable");
});

test("managed ssh:// doctor reuses the tunnel manager, probes hello, and releases the lease", async (t) => {
  const fixture = sshFixture(t);
  const { server, store } = await serveDoctor(t);
  const env = { ZSWARM_SERVE_TOKEN: "secret" };
  const uri = `ssh://netcup?servePort=${Number(server.label.split(":")[1])}`;
  const manager = createServeTunnelManager({ persistIdle: true, spawnSsh: fixture.spawn });
  t.after(() => manager.closeAll());
  const keeper = await manager.acquire(uri, {
    env,
    token: "secret",
    timeoutMs: 4000,
  });
  assert.equal(keeper.ok, true);
  const ownedBefore = manager.ownedCount();
  const result = await dispatchZswarm(
    {
      op: "doctor",
      serveAddress: uri,
      session: "crew",
      timeoutMs: 5000,
    },
    undefined,
    {
      env,
      serveTunnels: manager,
      tailscaleStatus: missingTailscale(),
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(checkById(result.data, "ssh").code, "ssh_ready");
  assert.equal(checkById(result.data, "serve").code, "serve_hello_ok");
  assert.equal(checkById(result.data, "session").code, "session_present");
  assert.equal(manager.ownedCount(), ownedBefore);
  const still = await probeServe(keeper.handle.localTarget, { token: "secret", timeoutMs: 2000 });
  assert.equal(still.ok, true, JSON.stringify(still));
  await keeper.handle.release();
  assert.deepEqual(store.writes, []);
});

test("cancelled doctor at host stage preserves partial results and releases the ssh lease", async (t) => {
  const fixture = sshFixture(t);
  let releaseHost;
  const hostGate = new Promise((resolve) => {
    releaseHost = resolve;
  });
  const server = await startServe(
    "127.0.0.1:0",
    async (request) => {
      if (request.op === "doctor") {
        await hostGate;
        return { ok: false, error: { code: "cancelled", message: "operation cancelled" } };
      }
      return { ok: true, data: {} };
    },
    { token: "secret" },
  );
  t.after(() => server.close());
  const manager = createServeTunnelManager({ persistIdle: false, spawnSsh: fixture.spawn });
  t.after(() => manager.closeAll());
  const ac = new AbortController();
  const port = Number(server.label.split(":")[1]);
  const pending = dispatchZswarm(
    { op: "doctor", serveAddress: `ssh://netcup?servePort=${port}`, session: "crew", timeoutMs: 8000 },
    undefined,
    {
      env: { ZSWARM_SERVE_TOKEN: "secret" },
      serveTunnels: manager,
      signal: ac.signal,
      tailscaleStatus: missingTailscale(),
    },
  );
  const waitUntil = Date.now() + 5_000;
  while (manager.ownedCount() < 1 && Date.now() < waitUntil) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  ac.abort();
  releaseHost();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "cancelled");
  const report = result.error.details;
  assert.equal(checkById(report, "route").state, "ok");
  assert.ok(checkById(report, "serve"));
  assert.equal(manager.ownedCount(), 0);
});

test("short doctor timeout is not inflated to serveCallTimeout's 15s minimum", async (t) => {
  const hung = await listenRaw((socket) => {
    socket.on("data", () => {});
  });
  t.after(() => hung.close());
  const started = Date.now();
  const result = await dispatchZswarm(
    { op: "doctor", timeoutMs: 400 },
    undefined,
    {
      env: { ZSWARM_SERVE: hung.label, ZSWARM_SERVE_TOKEN: "secret" },
      tailscaleStatus: missingTailscale(),
    },
  );
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.ok(elapsed < 8_000, `doctor used ${elapsed}ms; 15s inflation leaked`);
  assert.ok(["timeout", DOCTOR_FAILED_CODE].includes(result.error.code), result.error.code);
});

test("host-only doctorScope stays local and does not recurse", async (t) => {
  const { client } = hostClient(t);
  const result = await dispatchZswarm(
    { op: "doctor", [DOCTOR_SCOPE_FIELD]: DOCTOR_SCOPE_HOST, session: "crew" },
    client,
    {
      env: { ZSWARM_SERVE: "127.0.0.1:1", ZSWARM_SSH: "user@host" },
      tailscaleStatus: async () => {
        throw new Error("tailscale must not run on host scope");
      },
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.route.transport, "local");
  assert.equal(checkById(result.data, "tailscale"), undefined);
  assert.equal(checkById(result.data, "zellij_binary").code, "zellij_ok");
});
