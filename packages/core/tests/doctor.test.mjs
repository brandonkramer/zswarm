process.env.ZSWARM_LOG = "0";
process.env.ZSWARM_BUS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { nodeFixture } from "../test-support/node-fixture.mjs";
import {
  createServeTunnelManager,
  createStateStore,
  createZellijClient,
  dispatchZswarm,
  DOCTOR_HOST_INSPECT_FIELD,
  mcpInputSchema,
  parseCliArgv,
  resetZellijIdentityCache,
  resolveInvocationEnv,
  serveChildEnv,
  startServe,
} from "../dist/index.js";

const MUTATING = [
  "new-pane",
  "rename-pane",
  "rename-tab-by-id",
  "paste",
  "send-keys",
  "write-chars",
  "close-pane",
  "launch-or-focus-plugin",
  "pipe",
  "focus-pane-id",
  "stack-panes",
];

const PANES = [
  {
    id: 1,
    is_plugin: false,
    is_focused: true,
    title: "builder",
    exited: false,
    pane_command: "claude",
    tab_id: 0,
    tab_name: "T",
  },
  {
    id: 0,
    is_plugin: true,
    is_focused: false,
    title: "file:/tmp/zswarm-bus-v3.wasm",
    exited: false,
    tab_id: 0,
    tab_name: "T",
  },
];

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-doctor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function trackingState(t) {
  const dir = tempDir(t);
  const inner = createStateStore({ dir, env: { ZSWARM_LOG: "1" } });
  const writes = [];
  const store = {
    ...inner,
    appendLog: (entry) => {
      writes.push("appendLog");
      return inner.appendLog(entry);
    },
    writeCursor: (...args) => {
      writes.push("writeCursor");
      return inner.writeCursor(...args);
    },
    clearCursor: (...args) => {
      writes.push("clearCursor");
      return inner.clearCursor(...args);
    },
    writeBus: (...args) => {
      writes.push("writeBus");
      return inner.writeBus(...args);
    },
    clearBus: (...args) => {
      writes.push("clearBus");
      return inner.clearBus(...args);
    },
    postSignal: (...args) => {
      writes.push("postSignal");
      return inner.postSignal(...args);
    },
  };
  return { store, writes, dir };
}

function reportOf(result) {
  if (result.ok) return result.data;
  assert.ok(result.error.details, `missing report in ${JSON.stringify(result.error)}`);
  return result.error.details;
}

function checkOf(result, id) {
  const report = reportOf(result);
  const found = report.checks.find((c) => c.id === id);
  assert.ok(found, `missing check ${id} in ${JSON.stringify(report.checks.map((c) => c.id))}`);
  return found;
}

function assertNoMutations(calls) {
  for (const args of calls) {
    const joined = args.join(" ");
    for (const verb of MUTATING) {
      assert.equal(joined.includes(verb), false, `unexpected mutation ${verb}: ${joined}`);
    }
    assert.equal(joined.includes("schtasks"), false, joined);
  }
}

function localClient(t, opts = {}) {
  const calls = [];
  const sessions = opts.sessions ?? "crew [Created 1h ago]\n";
  const panes = opts.panes ?? PANES;
  const hangSessions = opts.hangSessions;
  const client = createZellijClient({
    env: opts.clientEnv ?? {},
    skipIdentityProbe: true,
    exec: async (args) => {
      calls.push(args);
      if (hangSessions && args.includes("list-sessions")) {
        await hangSessions();
      }
      if (opts.exec) return opts.exec(args, calls);
      if (args.includes("list-sessions")) {
        if (opts.sessionCode != null) {
          return { code: opts.sessionCode, stdout: opts.sessionStdout ?? "", stderr: opts.sessionStderr ?? "" };
        }
        return { code: 0, stdout: sessions, stderr: "" };
      }
      if (args.includes("list-panes")) {
        return { code: 0, stdout: JSON.stringify(panes), stderr: "" };
      }
      if (args.includes("--version")) return { code: 0, stdout: "zellij 0.45.1\n", stderr: "" };
      if (args.includes("--help")) return { code: 0, stdout: "list-sessions --no-formatting\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  t.after(() => assertNoMutations(calls));
  return { client, calls };
}

function missingTailscale(env = {}) {
  return { ...env, ZSWARM_TAILSCALE_BIN: join(tmpdir(), "no-such-tailscale-binary") };
}

async function serveDoctor(t, host, clientEnv = {}) {
  const hostEnv = serveChildEnv({
    ZSWARM_SERVE_TOKEN: "secret",
    ZSWARM_SESSION: host.sessionEnv,
    ZSWARM_STATE_DIR: host.stateDir,
    ZSWARM_BUS: host.bus ?? "0",
    ZSWARM_BUS_PLUGIN: host.plugin,
    ...host.env,
  });
  const requests = [];
  const server = await startServe(
    "127.0.0.1:0",
    (req) => {
      requests.push({ ...req });
      return dispatchZswarm(req, host.client, {
        env: hostEnv,
        state: host.state,
        signal: host.signal,
      });
    },
    { token: "secret" },
  );
  t.after(() => server.close());
  const result = await dispatchZswarm(
    { op: "doctor", session: host.clientSession, timeoutMs: host.timeoutMs ?? 2000, ...host.args },
    undefined,
    {
      env: missingTailscale({
        ZSWARM_SERVE: server.label,
        ZSWARM_SERVE_TOKEN: clientEnv.token ?? "secret",
        ZELLIJ_SESSION_NAME: clientEnv.controllerSession,
        ...clientEnv.env,
      }),
      state: clientEnv.state,
      signal: clientEnv.signal,
      serveTunnels: clientEnv.serveTunnels,
    },
  );
  return { result, requests, label: server.label };
}

const SSH_FORWARD_SOURCE = `
import { createServer, connect } from "node:net";
const args = process.argv.slice(2);
function opt(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}
const forward = opt("-L");
const parts = (forward || "").split(":");
const localPort = Number(parts[1]);
const remoteHost = parts[2];
const remotePort = Number(parts[3]);
const server = createServer((client) => {
  const upstream = connect({ host: remoteHost, port: remotePort });
  const fail = () => { client.destroy(); upstream.destroy(); };
  client.on("error", fail);
  upstream.on("error", fail);
  client.once("data", (chunk) => {
    upstream.write(chunk);
    client.pipe(upstream);
    upstream.pipe(client);
  });
});
server.listen(localPort, parts[0]);
process.on("SIGTERM", () => { server.close(); process.exit(0); });
`;

function sshTunnel(t) {
  const dir = tempDir(t);
  const file = join(dir, "ssh-fixture.mjs");
  writeFileSync(file, SSH_FORWARD_SOURCE);
  return {
    file,
    spawn(bin, args, opts) {
      return spawn(process.execPath, [file, ...args], {
        env: opts.env,
        stdio: opts.stdio,
        windowsHide: true,
        detached: false,
      });
    },
  };
}

test("CLI/MCP expose doctor with session and timeout", () => {
  const schema = mcpInputSchema();
  assert.ok(schema.properties.op.enum.includes("doctor"));
  assert.deepEqual(parseCliArgv(["doctor", "--session", "crew", "--timeout-ms", "10000"]), {
    op: "doctor",
    session: "crew",
    timeoutMs: 10000,
  });
  assert.deepEqual(parseCliArgv(["--serve", "127.0.0.1:9419", "doctor", "--session", "crew"]), {
    op: "doctor",
    serveAddress: "127.0.0.1:9419",
    session: "crew",
  });
});

test("local doctor reports a usable crew and does not mutate", async (t) => {
  const { client, calls } = localClient(t);
  const { store, writes, dir } = trackingState(t);
  store.writeBus("crew", { plugin: join(dir, "missing.wasm"), configKey: "zswarm-bus", installedAt: 1 });
  writes.length = 0;
  const snapshot = { sessions: store.readBus("crew"), files: existsSync(join(dir, "bus.json")) };
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 2000 },
    client,
    { env: missingTailscale({ ZSWARM_STATE_DIR: dir, ZSWARM_BUS_PLUGIN: join(dir, "nope.wasm") }), state: store },
  );
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const report = reportOf(result);
  assert.equal(report.route.transport, "local");
  assert.equal(report.route.session, "crew");
  assert.equal(report.route.sessionOrigin, "explicit");
  assert.equal(checkOf(result, "route").state, "ok");
  assert.equal(checkOf(result, "zellij").state, "ok");
  assert.equal(checkOf(result, "session").state, "ok");
  assert.equal(checkOf(result, "bus_artifact").code, "bus_artifact_missing");
  assert.equal(checkOf(result, "bus_marker").code, "bus_marker_stale");
  assert.equal(checkOf(result, "tailscale").state, "skipped");
  assert.equal(store.readBus("crew").configKey, snapshot.sessions.configKey);
  assert.equal(existsSync(join(dir, "bus.json")), snapshot.files);
  assert.deepEqual(writes, []);
  assert.equal(calls.some((a) => a.includes("pipe")), false);
});

test("explicit selector conflicts stay usage errors", async () => {
  const result = await dispatchZswarm(
    { op: "doctor", local: true, ssh: "user@host" },
    undefined,
    { env: missingTailscale() },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "usage");
  assert.equal(result.error.details, undefined);
});

test("--local wins over inherited serve and --ssh wins over inherited serve", async (t) => {
  const localEnv = resolveInvocationEnv(
    { local: true },
    { ZSWARM_SERVE: "127.0.0.1:1", ZSWARM_SSH: "user@host", ZSWARM_SERVE_TOKEN: "secret" },
  );
  assert.equal(localEnv.ZSWARM_SERVE, undefined);
  assert.equal(localEnv.ZSWARM_SSH, undefined);
  const sshEnv = resolveInvocationEnv(
    { ssh: "win@host" },
    { ZSWARM_SERVE: "127.0.0.1:1", ZSWARM_SSH: "old@host" },
  );
  assert.equal(sshEnv.ZSWARM_SSH, "win@host");
  assert.equal(sshEnv.ZSWARM_SERVE, undefined);
  const { client } = localClient(t);
  const local = await dispatchZswarm(
    { op: "doctor", local: true, session: "crew", timeoutMs: 2000 },
    client,
    { env: missingTailscale({ ZSWARM_SERVE: "127.0.0.1:1", ZSWARM_SSH: "user@host" }) },
  );
  assert.equal(checkOf(local, "zellij").state, "ok");
  assert.equal(checkOf(local, "serve").code, "not_applicable");
});

test("server-only default session is not the controller ZELLIJ_SESSION_NAME", async (t) => {
  const { client } = localClient(t, { sessions: "crew [Created 1h ago]\n" });
  const { store, dir } = trackingState(t);
  const { result, requests } = await serveDoctor(t, {
    client,
    state: store,
    stateDir: dir,
    timeoutMs: 3000,
  }, { controllerSession: "controller-pane", env: {} });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(reportOf(result).route.session, null);
  assert.equal(reportOf(result).route.sessionOrigin, "unresolved");
  assert.equal(checkOf(result, "session").code, "session_ok");
  assert.match(checkOf(result, "session").detail, /crew/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].session, undefined);
  assert.equal(requests[0][DOCTOR_HOST_INSPECT_FIELD], "host");
  assert.equal(requests[0].serveAddress, undefined);
  assert.equal(requests[0].ssh, undefined);
  assert.equal(requests[0].local, undefined);
});

test("explicit session is the only session forwarded to serve", async (t) => {
  const { client } = localClient(t);
  const { store, dir } = trackingState(t);
  const { result, requests } = await serveDoctor(
    t,
    { client, state: store, stateDir: dir, clientSession: "crew", timeoutMs: 3000 },
    { controllerSession: "controller-pane" },
  );
  assert.equal(checkOf(result, "session").state, "ok");
  assert.equal(requests[0].session, "crew");
});

test("manual TCP serve doctor uses probe plus host inspect, never invents SSH", async (t) => {
  const { client } = localClient(t);
  const { store, dir } = trackingState(t);
  const { result, requests } = await serveDoctor(t, {
    client,
    state: store,
    stateDir: dir,
    clientSession: "crew",
    timeoutMs: 3000,
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(reportOf(result).route.transport, "serve");
  assert.equal(reportOf(result).route.loopbackTunnel, true);
  assert.equal(checkOf(result, "serve").code, "serve_ok");
  assert.equal(checkOf(result, "ssh").code, "not_applicable");
  assert.ok(reportOf(result).server.capabilities.includes("doctor"));
  assert.equal(requests[0].op, "doctor");
});

test("CLI and MCP share the same doctor dispatch envelope", async (t) => {
  const { client } = localClient(t);
  const parsed = parseCliArgv(["doctor", "--session", "crew", "--timeout-ms", "2000"]);
  const viaCli = await dispatchZswarm(parsed, client, { env: missingTailscale() });
  const viaMcp = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 2000 },
    client,
    { env: missingTailscale() },
  );
  assert.equal(viaCli.ok, viaMcp.ok);
  assert.equal(reportOf(viaCli).route.transport, reportOf(viaMcp).route.transport);
  assert.equal(checkOf(viaCli, "session").code, checkOf(viaMcp, "session").code);
});

test("read-only policy still permits doctor", async (t) => {
  const { client } = localClient(t);
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 2000 },
    client,
    { env: missingTailscale({ ZSWARM_READONLY: "1" }) },
  );
  assert.equal(checkOf(result, "zellij").state, "ok");
  assert.notEqual(result.error?.code, "policy_denied");
});

test("healthy serve with no live session is degraded, not a usable crew", async (t) => {
  const { client } = localClient(t, { sessions: "" });
  const { store, dir } = trackingState(t);
  const { result } = await serveDoctor(t, {
    client,
    state: store,
    stateDir: dir,
    timeoutMs: 3000,
  });
  assert.equal(result.ok, true);
  assert.equal(checkOf(result, "serve").state, "ok");
  assert.equal(checkOf(result, "sessions").state, "warn");
  assert.equal(checkOf(result, "session").state, "warn");
});

test("missing requested session fails doctor with the report in details", async (t) => {
  const { client } = localClient(t, { sessions: "other [Created 1h ago]\n" });
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 2000 },
    client,
    { env: missingTailscale() },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "doctor_failed");
  assert.equal(checkOf(result, "session").code, "session_missing");
  assert.equal(checkOf(result, "zellij").state, "ok");
});

test("missing Zellij binary is a host failure with skipped dependents", async (t) => {
  resetZellijIdentityCache();
  const { client } = localClient(t, {
    exec: async (args) => {
      if (args.includes("--version") || args.includes("list-sessions")) {
        return { code: 127, stdout: "", stderr: "not found" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 2000 },
    client,
    { env: missingTailscale() },
  );
  assert.equal(result.ok, false);
  assert.equal(checkOf(result, "zellij").code, "zellij_missing");
  assert.equal(checkOf(result, "session").state, "skipped");
  assert.equal(checkOf(result, "bus_instance").state, "skipped");
});

test("wrong Zellij binary is distinguished from missing", async (t) => {
  const { client } = localClient(t, {
    exec: async (args) => ({
      code: 1,
      stdout: "",
      stderr: "usage: zswarm <list|send>",
    }),
  });
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 2000 },
    client,
    { env: missingTailscale() },
  );
  assert.equal(checkOf(result, "zellij").code, "zellij_wrong_bin");
});

test("inaccessible IPC skips session claims", async (t) => {
  resetZellijIdentityCache();
  const fixture = nodeFixture(t, `
const cmd = process.argv.at(-1);
if (cmd === 'ps ax -o args=' || String(cmd).startsWith('powershell.exe')) {
  process.stderr.write('process discovery unavailable');
  process.exitCode = 1;
} else if (String(cmd).includes('--version') || String(cmd).includes('--help')) {
  console.log('zellij 0.45.1');
  console.log('list-sessions --no-formatting');
} else {
  console.log('desktop-crew [Created 1h ago] (EXITED - attach to resurrect)');
}
`);
  const result = await dispatchZswarm(
    { op: "doctor", timeoutMs: 3000 },
    undefined,
    {
      env: missingTailscale({
        ZSWARM_SSH: "test-host",
        ZSWARM_SSH_BIN: fixture.binary,
        ZSWARM_REMOTE_BIN: "C:\\\\Tools\\\\zellij.exe",
        ZSWARM_TMP: "auto",
      }),
    },
  );
  assert.equal(checkOf(result, "ssh").state, "ok");
  assert.equal(checkOf(result, "ipc").code, "ipc_unreachable");
  assert.equal(checkOf(result, "session").state, "skipped");
  assert.equal(checkOf(result, "bus_artifact").state, "skipped");
  assert.equal(checkOf(result, "bus_artifact").code, "ipc_unreachable");
});

test("direct SSH bus is unsupported and does not read controller marker as remote", async (t) => {
  resetZellijIdentityCache();
  const { store, dir } = trackingState(t);
  store.writeBus("crew", { plugin: join(dir, "controller.wasm"), configKey: "zswarm-bus", installedAt: 1 });
  const fixture = nodeFixture(t, `
const last = process.argv.at(-1);
if (String(last).includes('--version')) console.log('zellij 0.45.1');
else if (String(last).includes('--help')) console.log('list-sessions --no-formatting');
else if (String(last).includes('list-sessions')) console.log('crew [Created 1h ago]');
else if (String(last).includes('list-panes')) console.log('[]');
`);
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 3000 },
    undefined,
    {
      env: missingTailscale({
        ZSWARM_SSH: "user@host",
        ZSWARM_SSH_BIN: fixture.binary,
        ZSWARM_STATE_DIR: dir,
      }),
      state: store,
    },
  );
  assert.equal(checkOf(result, "ssh").code, "ssh_ok");
  assert.equal(checkOf(result, "session").code, "session_ok");
  assert.equal(checkOf(result, "bus_marker").code, "bus_unsupported_ssh");
  assert.equal(checkOf(result, "bus_artifact").code, "bus_unsupported_ssh");
});

test("interactive SSH does not create scheduled tasks and does not mark session healthy", async (t) => {
  resetZellijIdentityCache();
  const fixture = nodeFixture(t, `console.log('should-not-run'); process.exit(1);`);
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 2000, ssh: "user@host" },
    undefined,
    {
      env: missingTailscale({
        ZSWARM_SSH_BIN: fixture.binary,
        ZSWARM_SSH_MODE: "interactive",
      }),
    },
  );
  assert.equal(checkOf(result, "ssh").code, "ssh_interactive_unsupported");
  assert.equal(checkOf(result, "session").code, "session_unverified");
  assert.equal(checkOf(result, "session").state, "fail");
  assert.equal(result.ok, false);
  assert.equal(fixture.launches.length, 0);
});

test("SSH auth failure is classified and does not fall back", async (t) => {
  resetZellijIdentityCache();
  const fixture = nodeFixture(t, `
process.stderr.write('Permission denied (publickey).');
process.exit(1);
`);
  const result = await dispatchZswarm(
    { op: "doctor", timeoutMs: 3000 },
    undefined,
    {
      env: missingTailscale({
        ZSWARM_SSH: "user@host",
        ZSWARM_SSH_BIN: fixture.binary,
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(checkOf(result, "ssh").code, "ssh_auth");
  assert.equal(checkOf(result, "zellij").state, "skipped");
  assert.equal(checkOf(result, "session").state, "skipped");
  assert.equal(reportOf(result).route.transport, "ssh");
});

test("SSH host-key failure is classified", async (t) => {
  resetZellijIdentityCache();
  const fixture = nodeFixture(t, `
process.stderr.write('Host key verification failed.');
process.exit(255);
`);
  const result = await dispatchZswarm(
    { op: "doctor", timeoutMs: 3000 },
    undefined,
    { env: missingTailscale({ ZSWARM_SSH: "user@host", ZSWARM_SSH_BIN: fixture.binary }) },
  );
  assert.equal(checkOf(result, "ssh").code, "ssh_host_key");
});

test("dead serve endpoint keeps a partial report and does not claim host checks passed", async () => {
  const result = await dispatchZswarm(
    { op: "doctor", timeoutMs: 400 },
    undefined,
    { env: missingTailscale({ ZSWARM_SERVE: "127.0.0.1:1", ZSWARM_SERVE_TOKEN: "secret" }) },
  );
  assert.equal(result.ok, false);
  assert.ok(result.error.code === "doctor_failed" || result.error.code === "timeout");
  assert.ok(result.error.details.checks);
  assert.equal(checkOf(result, "route").state, "ok");
  assert.equal(checkOf(result, "serve").state, "fail");
  assert.equal(checkOf(result, "zellij").state, "skipped");
  assert.equal(checkOf(result, "session").state, "skipped");
});

test("wrong serve token does not run host checks", async (t) => {
  const { client } = localClient(t);
  const { store, dir } = trackingState(t);
  const { result, requests } = await serveDoctor(
    t,
    { client, state: store, stateDir: dir, timeoutMs: 2000 },
    { token: "wrong" },
  );
  assert.equal(checkOf(result, "serve").code, "serve_unauthorized");
  assert.equal(checkOf(result, "zellij").state, "skipped");
  assert.equal(requests.length, 0);
});

test("malformed hello is a serve failure with skipped host checks", async (t) => {
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", () => {
      socket.write(`${JSON.stringify({ ok: true, data: { protocol: 1 } })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((done) => server.close(done)));
  const port = server.address().port;
  const result = await dispatchZswarm(
    { op: "doctor", timeoutMs: 2000 },
    undefined,
    { env: missingTailscale({ ZSWARM_SERVE: `127.0.0.1:${port}`, ZSWARM_SERVE_TOKEN: "secret" }) },
  );
  assert.equal(checkOf(result, "serve").state, "fail");
  assert.ok(["serve_protocol", "serve_hello_unsupported"].includes(checkOf(result, "serve").code));
  assert.equal(checkOf(result, "zellij").state, "skipped");
});

test("older serve peer without doctor skips host checks after authenticated hello", async (t) => {
  const requests = [];
  const server = createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const parsed = JSON.parse(buf.slice(0, nl));
      requests.push(parsed);
      if (parsed.serveControl === "hello") {
        socket.write(`${JSON.stringify({
          ok: true,
          data: {
            protocol: 1,
            serverId: "old-peer",
            hostname: "old",
            platform: "linux",
            version: "0.1.0",
            capabilities: ["hello"],
          },
        })}\n`);
        return;
      }
      socket.write(`${JSON.stringify({
        ok: false,
        error: { code: "usage", message: "zswarm requires op=list|send" },
      })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((done) => server.close(done)));
  const port = server.address().port;
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 2000 },
    undefined,
    { env: missingTailscale({ ZSWARM_SERVE: `127.0.0.1:${port}`, ZSWARM_SERVE_TOKEN: "secret" }) },
  );
  assert.equal(checkOf(result, "serve").code, "serve_ok");
  assert.equal(checkOf(result, "zellij").code, "doctor_unsupported");
  assert.equal(checkOf(result, "session").state, "skipped");
  assert.equal(requests.some((r) => r.op === "doctor"), false);
});

test("ZSWARM_BUS=0 skips live-instance observation", async (t) => {
  const { client } = localClient(t);
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 2000 },
    client,
    { env: missingTailscale({ ZSWARM_BUS: "0" }) },
  );
  assert.equal(checkOf(result, "bus_instance").code, "bus_disabled");
});

test("absent bus instance is advisory unknown/unready, not a required failure", async (t) => {
  const { client } = localClient(t, {
    panes: [{ id: 1, is_plugin: false, title: "builder", exited: false }],
  });
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 2000 },
    client,
    { env: missingTailscale({ ZSWARM_BUS: "1", ZSWARM_BUS_PLUGIN: join(tmpdir(), "no-bus.wasm") }) },
  );
  assert.equal(result.ok, true);
  assert.equal(checkOf(result, "bus_instance").code, "bus_instance_absent");
  assert.equal(checkOf(result, "bus_instance").state, "warn");
});

test("live plugin pane is present with readiness unknown and no pipe", async (t) => {
  const { client, calls } = localClient(t);
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 2000 },
    client,
    { env: missingTailscale({ ZSWARM_BUS: "1" }) },
  );
  assert.equal(checkOf(result, "bus_instance").code, "bus_instance_present");
  assert.match(checkOf(result, "bus_instance").detail, /unknown/i);
  assert.equal(calls.some((a) => a.includes("pipe")), false);
});

test("missing Tailscale CLI is skipped when the route works", async (t) => {
  const { client } = localClient(t);
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 2000 },
    client,
    { env: missingTailscale() },
  );
  assert.equal(checkOf(result, "tailscale").state, "skipped");
  assert.ok(["tailscale_cli_missing", "tailscale_not_applicable"].includes(checkOf(result, "tailscale").code));
  assert.equal(checkOf(result, "zellij").state, "ok");
});

test("unknown Tailscale peer is advisory and cannot override a session failure", async (t) => {
  resetZellijIdentityCache();
  const ts = nodeFixture(t, `
console.log(JSON.stringify({
  BackendState: "Running",
  Self: { HostName: "controller", DNSName: "controller.tailnet.ts.net.", TailscaleIPs: ["100.64.0.1"], Online: true },
  Peer: {
    n1: { HostName: "other", DNSName: "other.tailnet.ts.net.", TailscaleIPs: ["100.64.0.2"], Online: true }
  }
}));
`);
  const ssh = nodeFixture(t, `
const last = process.argv.at(-1);
if (String(last).includes('--version')) console.log('zellij 0.45.1');
else if (String(last).includes('--help')) console.log('list-sessions --no-formatting');
else console.log('other [Created 1h ago]');
`);
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 3000, ssh: "user@missing-peer" },
    undefined,
    {
      env: {
        ZSWARM_TAILSCALE_BIN: ts.binary,
        ZSWARM_SSH_BIN: ssh.binary,
      },
    },
  );
  assert.equal(checkOf(result, "tailscale").code, "tailscale_unmapped");
  assert.equal(checkOf(result, "session").code, "session_missing");
  assert.equal(result.ok, false);
});

test("peer-online Tailscale evidence cannot override failed hello", async (t) => {
  const fixture = nodeFixture(t, `
console.log(JSON.stringify({
  BackendState: "Running",
  Peer: { n1: { HostName: "host", DNSName: "host.tailnet.ts.net.", TailscaleIPs: ["100.64.1.8"], Online: true, Active: true } }
}));
`);
  const result = await dispatchZswarm(
    { op: "doctor", timeoutMs: 400, serveAddress: "ssh://host?servePort=9419" },
    undefined,
    {
      env: {
        ZSWARM_TAILSCALE_BIN: fixture.binary,
        ZSWARM_SERVE_TOKEN: "secret",
        ZSWARM_SSH_BIN: join(tmpdir(), "no-ssh"),
      },
    },
  );
  assert.equal(checkOf(result, "tailscale").code, "tailscale_peer_online");
  assert.equal(checkOf(result, "serve").state, "fail");
  assert.notEqual(result.ok, true);
});

test("loopback serve does not guess a Tailscale peer from 127.0.0.1", async (t) => {
  const fixture = nodeFixture(t, `
console.log(JSON.stringify({
  BackendState: "Running",
  Self: { HostName: "this", TailscaleIPs: ["100.64.0.1"], Online: true },
  Peer: { n1: { HostName: "crew", TailscaleIPs: ["100.64.0.2"], Online: true } }
}));
`);
  const { client } = localClient(t);
  const { store, dir } = trackingState(t);
  const { result } = await serveDoctor(
    t,
    { client, state: store, stateDir: dir, clientSession: "crew", timeoutMs: 3000 },
    { env: { ZSWARM_TAILSCALE_BIN: fixture.binary } },
  );
  assert.equal(checkOf(result, "tailscale").code, "tailscale_loopback");
  assert.equal(checkOf(result, "serve").state, "ok");
});

test("hanging hello times out without a 15s serveCallTimeout floor and skips host checks", async (t) => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  );
  const port = server.address().port;
  const start = Date.now();
  const result = await dispatchZswarm(
    { op: "doctor", timeoutMs: 250 },
    undefined,
    { env: missingTailscale({ ZSWARM_SERVE: `127.0.0.1:${port}`, ZSWARM_SERVE_TOKEN: "secret" }) },
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 4000, `elapsed ${elapsed}ms used serveCallTimeout inflation`);
  assert.equal(result.error.code, "timeout");
  assert.equal(checkOf(result, "zellij").state, "skipped");
  assert.equal(checkOf(result, "session").state, "skipped");
});

test("cancellation during host inspection preserves controller findings and skips later stages", async (t) => {
  const ac = new AbortController();
  let panes = 0;
  const calls = [];
  const client = createZellijClient({
    env: {},
    skipIdentityProbe: true,
    signal: ac.signal,
    exec: async (args) => {
      calls.push(args);
      if (args.includes("list-panes")) panes += 1;
      if (args.includes("list-sessions")) {
        queueMicrotask(() => ac.abort());
        await new Promise((_, reject) => {
          const timer = setInterval(() => {
            if (ac.signal.aborted) {
              clearInterval(timer);
              reject(new Error("operation cancelled"));
            }
          }, 5);
        });
      }
      return { code: 0, stdout: "crew\n", stderr: "" };
    },
  });
  t.after(() => assertNoMutations(calls));
  const result = await dispatchZswarm(
    { op: "doctor", session: "crew", timeoutMs: 5000 },
    client,
    { env: missingTailscale(), signal: ac.signal },
  );
  assert.equal(result.error.code, "cancelled");
  assert.equal(checkOf(result, "route").state, "ok");
  assert.equal(panes, 0);
  assert.equal(checkOf(result, "bus_instance").state, "skipped");
});

test("managed ssh:// doctor releases its lease and leaves a persisted MCP tunnel intact", async (t) => {
  const { client } = localClient(t);
  const { store, dir } = trackingState(t);
  const hostEnv = serveChildEnv({
    ZSWARM_SERVE_TOKEN: "secret",
    ZSWARM_STATE_DIR: dir,
    ZSWARM_BUS: "0",
  });
  const server = await startServe(
    "127.0.0.1:0",
    (req) => dispatchZswarm(req, client, { env: hostEnv, state: store }),
    { token: "secret" },
  );
  t.after(() => server.close());
  const listenPort = Number(server.label.split(":")[1]);
  const tunnel = sshTunnel(t);
  const manager = createServeTunnelManager({ persistIdle: true, spawnSsh: tunnel.spawn });
  t.after(() => manager.closeAll());
  const uri = `ssh://user@host?servePort=${listenPort}`;
  const env = missingTailscale({
    ZSWARM_SERVE_TOKEN: "secret",
    ZSWARM_SSH_BIN: process.execPath,
  });
  const first = await dispatchZswarm(
    { op: "list", serveAddress: uri },
    undefined,
    { env, serveTunnels: manager },
  );
  assert.equal(first.ok, true, JSON.stringify(first.error));
  const owned = manager.ownedCount();
  assert.ok(owned >= 1, "persistIdle should keep the first tunnel");

  let hostDoctor = 0;
  const hanging = await startServe(
    "127.0.0.1:0",
    async (req) => {
      if (req.op === "doctor") {
        hostDoctor += 1;
        await new Promise(() => {});
      }
      return { ok: true, data: { panes: [] } };
    },
    { token: "secret" },
  );
  t.after(() => hanging.close());
  const hangPort = Number(hanging.label.split(":")[1]);
  const hangUri = `ssh://user@host?servePort=${hangPort}`;
  const ac = new AbortController();
  const pending = dispatchZswarm(
    { op: "doctor", serveAddress: hangUri, session: "crew", timeoutMs: 5000 },
    undefined,
    { env, serveTunnels: manager, signal: ac.signal },
  );
  await delay(80);
  ac.abort();
  const cancelled = await pending;
  assert.equal(cancelled.error.code, "cancelled");
  assert.ok(manager.ownedCount() >= owned, "doctor must not closeAll a shared MCP manager");
  const again = await dispatchZswarm(
    { op: "list", serveAddress: uri },
    undefined,
    { env, serveTunnels: manager },
  );
  assert.equal(again.ok, true, JSON.stringify(again.error));
  assert.ok(hostDoctor >= 0);
});
