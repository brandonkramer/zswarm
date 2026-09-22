process.env.ZSWARM_LOG = "0";
process.env.ZSWARM_BUS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeSshTunnelOpts,
  buildSshTunnelArgv,
  createServeTunnelManager,
  DEFAULT_SSH_PORT,
  DEFAULT_SSH_SERVE_PORT,
  describeServeTarget,
  dispatchZswarm,
  formatSshServeTarget,
  forwardServe,
  isSshServeTarget,
  parseCliArgv,
  parseListenAddress,
  parseSshServeTarget,
  probeServe,
  redactSshUserinfo,
  resolveInvocationEnv,
  serveTunnelCacheKey,
  SSH_SERVE_REMOTE_HOST,
  SSH_TUNNEL_KEEPALIVE_COUNT,
  SSH_TUNNEL_KEEPALIVE_INTERVAL_S,
  startServe,
  stripControllerRouting,
} from "../dist/index.js";

const SSH_FORWARD_SOURCE = `
import { createServer, connect } from "node:net";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
function opt(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}
const forward = opt("-L");
if (!forward) {
  console.error("missing -L");
  process.exit(2);
}
const parts = forward.split(":");
if (parts.length !== 4) {
  console.error("bad -L " + forward);
  process.exit(2);
}
const localHost = parts[0];
const localPort = Number(parts[1]);
const remoteHost = parts[2];
const remotePort = Number(parts[3]);
if (process.env.SSH_FIXTURE_FAIL_FIRST) {
  const stamp = process.env.SSH_FIXTURE_FAIL_FIRST;
  if (!existsSync(stamp)) {
    writeFileSync(stamp, "1");
    console.error("Address already in use");
    process.exit(1);
  }
}
const listenOnly = process.env.SSH_FIXTURE_LISTEN_ONLY === "1";
const dropAfterHello = process.env.SSH_FIXTURE_DROP_AFTER_HELLO === "1";
if (process.env.SSH_FIXTURE_PIDFILE) {
  writeFileSync(process.env.SSH_FIXTURE_PIDFILE, String(process.pid));
}
const gate = process.env.SSH_FIXTURE_GATE;
if (gate) {
  while (!existsSync(gate)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}
let dataConnections = 0;
const server = createServer((client) => {
  if (listenOnly) return;
  const openUpstream = (firstChunk) => {
    const upstream = connect({ host: remoteHost, port: remotePort });
    const fail = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", fail);
    upstream.on("error", fail);
    if (firstChunk) upstream.write(firstChunk);
    client.pipe(upstream);
    upstream.pipe(client);
  };
  client.once("data", (chunk) => {
    dataConnections += 1;
    if (dropAfterHello && dataConnections > 1) {
      client.destroy();
      return;
    }
    openUpstream(chunk);
  });
});
server.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
server.listen(localPort, localHost);
if (process.env.SSH_FIXTURE_STOP_LISTEN) {
  const stopAt = process.env.SSH_FIXTURE_STOP_LISTEN;
  const poll = setInterval(() => {
    if (!existsSync(stopAt)) return;
    clearInterval(poll);
    try {
      unlinkSync(stopAt);
    } catch {
      /* already consumed */
    }
    server.close(() => {
      try {
        writeFileSync(stopAt + ".done", "1");
      } catch {
        /* test already cleaned up */
      }
    });
    setInterval(() => {}, 1 << 30);
  }, 20);
}
process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
`;

function sshFixture(t, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-ssh-tunnel-"));
  const file = join(dir, "ssh-fixture.mjs");
  writeFileSync(file, SSH_FORWARD_SOURCE);
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const launches = [];
  return {
    file,
    launches,
    env,
    spawn(bin, args, opts) {
      const child = spawn(process.execPath, [file, ...args], {
        ...opts,
        env: { ...process.env, ...env, ...(opts?.env ?? {}) },
      });
      launches.push({ bin, args, env: opts?.env, child });
      return child;
    },
  };
}

function occupyPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

test("parseSshServeTarget reads authority as SSH and servePort as remote loopback", () => {
  const parsed = parseSshServeTarget("ssh://Administrator@host:22?servePort=9419");
  assert.deepEqual(parsed, {
    user: "Administrator",
    host: "host",
    sshPort: 22,
    servePort: 9419,
    destination: "Administrator@host",
  });
  assert.equal(formatSshServeTarget(parsed), "ssh://Administrator@host:22?servePort=9419");
  assert.deepEqual(parseSshServeTarget("ssh://host"), {
    user: undefined,
    host: "host",
    sshPort: undefined,
    servePort: DEFAULT_SSH_SERVE_PORT,
    destination: "host",
  });
  assert.equal(formatSshServeTarget(parseSshServeTarget("ssh://host")), "ssh://host?servePort=9419");
  const v6 = parseSshServeTarget("ssh://[::1]:2222?servePort=18000");
  assert.equal(v6.host, "::1");
  assert.equal(v6.sshPort, 2222);
  assert.equal(v6.servePort, 18000);
  assert.equal(formatSshServeTarget(v6), "ssh://[::1]:2222?servePort=18000");
  assert.equal(isSshServeTarget("ssh://host?servePort=9419"), true);
  assert.equal(isSshServeTarget("127.0.0.1:9419"), false);
  assert.equal(isSshServeTarget("tcp://127.0.0.1:9419"), false);
});

test("parseSshServeTarget rejects passwords, paths, fragments, unknown queries, and bad ports", () => {
  const secretUri = "ssh://user:s3cret-pass@host:22?servePort=9419";
  assert.throws(() => parseSshServeTarget(secretUri), (err) => {
    assert.equal(err.code, "bad_arg");
    assert.equal(err.message.includes("s3cret-pass"), false);
    assert.match(err.message, /password/i);
    return true;
  });
  assert.equal(redactSshUserinfo(secretUri).includes("s3cret-pass"), false);
  assert.equal(redactSshUserinfo(secretUri).includes(":s3cret-pass@"), false);
  assert.throws(() => parseSshServeTarget("ssh://host/var/run"), /path/);
  assert.throws(() => parseSshServeTarget("ssh://host#frag"), /fragment/);
  assert.throws(() => parseSshServeTarget("ssh://host?servePort=9419&foo=1"), /unsupported query/);
  assert.throws(() => parseSshServeTarget("ssh://host?servePort=0"), /servePort is invalid/);
  assert.throws(() => parseSshServeTarget("ssh://host:0"), /SSH port is invalid/);
  assert.throws(() => parseSshServeTarget("ssh://host?servePort=65536"), /servePort is invalid/);
  assert.throws(() => parseSshServeTarget("ssh://"), /valid URI|missing a host/);
});

test("parseCliArgv maps the ssh:// user-contract serve URI", () => {
  assert.deepEqual(
    parseCliArgv([
      "--serve",
      "ssh://Administrator@host:22?servePort=9419",
      "status",
      "--session",
      "crew",
    ]),
    {
      op: "status",
      serveAddress: "ssh://Administrator@host:22?servePort=9419",
      session: "crew",
    },
  );
});

test("buildSshTunnelArgv is foreground LocalForward with keepalives and host-key verify left on", () => {
  const { bin, args } = buildSshTunnelArgv(
    parseSshServeTarget("ssh://Administrator@host:22?servePort=9419"),
    18001,
    { ZSWARM_SSH_BIN: "/usr/bin/ssh", ZSWARM_SSH_OPTS: "-i /tmp/id" },
  );
  assert.equal(bin, "/usr/bin/ssh");
  assert.ok(args.includes("-N"));
  assert.ok(args.includes("-T"));
  assert.equal(args.at(-1), "Administrator@host");
  assert.ok(args.includes("-p"));
  assert.equal(args[args.indexOf("-p") + 1], "22");
  assert.equal(args[args.indexOf("-L") + 1], `${SSH_SERVE_REMOTE_HOST}:18001:${SSH_SERVE_REMOTE_HOST}:9419`);
  assert.ok(args.includes("ExitOnForwardFailure=yes"));
  assert.ok(args.includes(`ServerAliveInterval=${SSH_TUNNEL_KEEPALIVE_INTERVAL_S}`));
  assert.ok(args.includes(`ServerAliveCountMax=${SSH_TUNNEL_KEEPALIVE_COUNT}`));
  assert.ok(args.includes("ControlMaster=no"));
  assert.ok(args.includes("ControlPath=none"));
  assert.ok(args.includes("ControlPersist=no"));
  assert.ok(args.includes("ForkAfterAuthentication=no"));
  assert.equal(args.includes("-S"), true);
  assert.equal(args[args.indexOf("-S") + 1], "none");
  assert.ok(args.indexOf("ControlPath=none") < args.indexOf("-i"));
  assert.ok(args.indexOf("-S") > args.indexOf("-i"));
  assert.ok(args.includes("-i"));
  assert.equal(args.includes("-f"), false);
  assert.equal(args.some((a) => /StrictHostKeyChecking=no/i.test(a)), false);
  assert.equal(args.includes("zellij"), false);
});

test("assertSafeSshTunnelOpts rejects daemonize, combined flags, and whitespace -o forms", () => {
  assert.throws(() => assertSafeSshTunnelOpts(["-f"]), /daemonize/);
  assert.throws(() => assertSafeSshTunnelOpts(["-fn"]), /daemonize/);
  assert.throws(() => assertSafeSshTunnelOpts(["-o", "ControlMaster=yes"]), /ControlMaster/);
  assert.throws(() => assertSafeSshTunnelOpts(["-o", "ControlMaster auto"]), /ControlMaster/);
  assert.throws(() => assertSafeSshTunnelOpts(["-o", "ForkAfterAuthentication yes"]), /fork/);
  assert.throws(() => assertSafeSshTunnelOpts(["-oControlPersist=10m"]), /ControlPersist/);
  assert.throws(() => assertSafeSshTunnelOpts(["-L", "9419:127.0.0.1:9419"]), /extra forwards/);
  assert.throws(() => assertSafeSshTunnelOpts(["-o", "ExitOnForwardFailure no"]), /ExitOnForwardFailure/);
  assert.throws(() => assertSafeSshTunnelOpts(["-o", "BatchMode=no"]), /BatchMode/);
  assert.throws(() => assertSafeSshTunnelOpts(["evil-host"]), /destination or remote command/);
  assert.throws(() => assertSafeSshTunnelOpts(["-S", "/tmp/master.sock"]), /ControlPath|-S none/);
  assert.doesNotThrow(() => assertSafeSshTunnelOpts(["-o", "ControlMaster=no", "-i", "key"]));
  assert.doesNotThrow(() => assertSafeSshTunnelOpts(["-F", "/tmp/config", "-o", "ProxyJump=bastion"]));
});

test("serveTunnelCacheKey isolates identity and omits the serve token", () => {
  const target = parseSshServeTarget("ssh://Administrator@host:22?servePort=9419");
  const key = serveTunnelCacheKey(target, {
    ZSWARM_SSH_BIN: "ssh",
    ZSWARM_SSH_OPTS: "-i key",
    ZSWARM_SERVE_TOKEN: "s3cret-token",
  });
  assert.equal(key.includes("s3cret-token"), false);
  const otherPort = serveTunnelCacheKey(
    parseSshServeTarget("ssh://Administrator@host:22?servePort=18000"),
    { ZSWARM_SSH_BIN: "ssh", ZSWARM_SSH_OPTS: "-i key" },
  );
  assert.notEqual(key, otherPort);
  const otherHost = serveTunnelCacheKey(
    parseSshServeTarget("ssh://Administrator@other:22?servePort=9419"),
    { ZSWARM_SSH_BIN: "ssh", ZSWARM_SSH_OPTS: "-i key" },
  );
  assert.notEqual(key, otherHost);
  const sockA = serveTunnelCacheKey(target, { SSH_AUTH_SOCK: "/tmp/agent-a" });
  const sockB = serveTunnelCacheKey(target, { SSH_AUTH_SOCK: "/tmp/agent-b" });
  assert.notEqual(sockA, sockB);
  assert.equal(sockA.includes("/tmp/agent-a"), false);
  assert.equal(sockB.includes("/tmp/agent-b"), false);
  const omitted = serveTunnelCacheKey(parseSshServeTarget("ssh://Administrator@host?servePort=9419"));
  const explicit = serveTunnelCacheKey(parseSshServeTarget("ssh://Administrator@host:22?servePort=9419"));
  assert.notEqual(omitted, explicit);
  assert.equal(DEFAULT_SSH_PORT, 22);
});

test("stripControllerRouting drops serveAddress/local/ssh before forward", () => {
  assert.deepEqual(
    stripControllerRouting({
      op: "list",
      serveAddress: "ssh://host?servePort=9419",
      local: true,
      ssh: "old@host",
      session: "crew",
    }),
    { op: "list", session: "crew" },
  );
});

test("host:port and tcp:// stay compatible without spawning ssh", async (t) => {
  const fixture = sshFixture(t);
  let received;
  const server = await startServe("127.0.0.1:0", async (args) => {
    received = args;
    return { ok: true, data: { forwarded: args.op } };
  }, { token: "secret" });
  t.after(() => server.close());
  const manager = createServeTunnelManager({ persistIdle: false, spawnSsh: fixture.spawn });
  const result = await dispatchZswarm(
    { op: "list" },
    undefined,
    {
      env: { ZSWARM_SERVE: server.label, ZSWARM_SERVE_TOKEN: "secret" },
      serveTunnels: manager,
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(received.op, "list");
  assert.equal(fixture.launches.length, 0);
  const tcp = `tcp://${server.label}`;
  const again = await dispatchZswarm(
    { op: "list" },
    undefined,
    {
      env: { ZSWARM_SERVE: tcp, ZSWARM_SERVE_TOKEN: "secret" },
      serveTunnels: manager,
    },
  );
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(fixture.launches.length, 0);
});

test("ssh:// acquire probes hello before dispatching an application op", async (t) => {
  const fixture = sshFixture(t);
  const ops = [];
  const server = await startServe("127.0.0.1:0", async (args) => {
    ops.push(args.op);
    return { ok: true, data: { forwarded: args.op, session: "crew" } };
  }, { token: "secret" });
  t.after(() => server.close());
  const servePort = parseListenAddress(server.label).port;
  const uri = `ssh://Administrator@example.test?servePort=${servePort}`;
  const parentServe = process.env.ZSWARM_SERVE;
  process.env.ZSWARM_SERVE = "must-not-mutate";
  const env = {
    ZSWARM_SERVE: uri,
    ZSWARM_SERVE_TOKEN: "secret",
    ZSWARM_SSH: "should-not-run",
  };
  const manager = createServeTunnelManager({ persistIdle: false, spawnSsh: fixture.spawn });
  try {
    const result = await dispatchZswarm(
      parseCliArgv(["--serve", uri, "list", "--session", "crew"]),
      undefined,
      { env, serveTunnels: manager },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(ops, ["list"]);
    assert.equal(result.context.transport, "serve");
    assert.equal(describeServeTarget(uri), `ssh://Administrator@example.test?servePort=${servePort}`);
    assert.equal(result.context.host, describeServeTarget(uri));
    assert.equal(fixture.launches.length, 1);
    const argv = fixture.launches[0].args;
    assert.ok(argv.includes("-N"));
    assert.equal(argv.at(-1), "Administrator@example.test");
    assert.equal(argv[argv.indexOf("-L") + 1].endsWith(`:${SSH_SERVE_REMOTE_HOST}:${servePort}`), true);
    assert.equal(fixture.launches[0].env.ZSWARM_SERVE_TOKEN, undefined);
    assert.equal(process.env.ZSWARM_SERVE, "must-not-mutate");
    assert.equal(env.ZSWARM_SSH, "should-not-run");
    assert.equal(manager.ownedCount(), 0);
  } finally {
    await manager.closeAll();
    if (parentServe === undefined) delete process.env.ZSWARM_SERVE;
    else process.env.ZSWARM_SERVE = parentServe;
  }
});

test("wrong token fails hello and never dispatches the application op", async (t) => {
  const fixture = sshFixture(t);
  const ops = [];
  const server = await startServe("127.0.0.1:0", async (args) => {
    ops.push(args.op);
    return { ok: true, data: args };
  }, { token: "secret" });
  t.after(() => server.close());
  const servePort = parseListenAddress(server.label).port;
  const uri = `ssh://host?servePort=${servePort}`;
  const manager = createServeTunnelManager({ persistIdle: false, spawnSsh: fixture.spawn });
  t.after(() => manager.closeAll());
  const result = await dispatchZswarm(
    { op: "list" },
    undefined,
    {
      env: { ZSWARM_SERVE: uri, ZSWARM_SERVE_TOKEN: "wrong", ZSWARM_SSH: "fallback-host" },
      serveTunnels: manager,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "serve_unauthorized");
  assert.deepEqual(ops, []);
  assert.equal(manager.ownedCount(), 0);
});

test("TCP connect is not ready: listen-only forward never dispatches", async (t) => {
  const fixture = sshFixture(t, { SSH_FIXTURE_LISTEN_ONLY: "1" });
  const ops = [];
  const server = await startServe("127.0.0.1:0", async (args) => {
    ops.push(args.op);
    return { ok: true, data: args };
  }, { token: "secret" });
  t.after(() => server.close());
  const servePort = parseListenAddress(server.label).port;
  const uri = `ssh://host?servePort=${servePort}`;
  const manager = createServeTunnelManager({ persistIdle: false, spawnSsh: fixture.spawn });
  t.after(() => manager.closeAll());
  const acquired = await manager.acquire(uri, {
    env: { ZSWARM_SERVE: uri, ZSWARM_SERVE_TOKEN: "secret" },
    token: "secret",
    timeoutMs: 800,
  });
  assert.equal(acquired.ok, false, JSON.stringify(acquired));
  assert.ok(
    acquired.error.code === "timeout" ||
      acquired.error.code === "serve_protocol" ||
      acquired.error.code === "serve_hello_unsupported" ||
      acquired.error.code === "serve_unreachable",
    acquired.error.code,
  );
  assert.deepEqual(ops, []);
});

test("CLI persistIdle=false disposes; MCP persistIdle=true reuses a healthy tunnel", async (t) => {
  const fixture = sshFixture(t);
  const server = await startServe("127.0.0.1:0", async (args) => {
    return { ok: true, data: { forwarded: args.op } };
  }, { token: "secret" });
  t.after(() => server.close());
  const servePort = parseListenAddress(server.label).port;
  const uri = `ssh://host?servePort=${servePort}`;
  const env = { ZSWARM_SERVE: uri, ZSWARM_SERVE_TOKEN: "secret" };

  const cli = createServeTunnelManager({ persistIdle: false, spawnSsh: fixture.spawn });
  const first = await dispatchZswarm({ op: "list" }, undefined, { env, serveTunnels: cli });
  assert.equal(first.ok, true, JSON.stringify(first));
  await cli.closeAll();
  assert.equal(cli.ownedCount(), 0);
  const afterCli = fixture.launches.length;

  const mcp = createServeTunnelManager({ persistIdle: true, spawnSsh: fixture.spawn });
  t.after(() => mcp.closeAll());
  const a = await dispatchZswarm({ op: "list" }, undefined, { env, serveTunnels: mcp });
  const b = await dispatchZswarm({ op: "list" }, undefined, { env, serveTunnels: mcp });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(fixture.launches.length, afterCli + 1);
  assert.equal(mcp.ownedCount(), 1);
  await mcp.closeAll();
  assert.equal(mcp.ownedCount(), 0);
});

test("concurrent ssh:// calls share one owned tunnel", async (t) => {
  const fixture = sshFixture(t);
  const server = await startServe("127.0.0.1:0", async (args) => {
    return { ok: true, data: { forwarded: args.op } };
  }, { token: "secret" });
  t.after(() => server.close());
  const servePort = parseListenAddress(server.label).port;
  const uri = `ssh://host?servePort=${servePort}`;
  const manager = createServeTunnelManager({ persistIdle: true, spawnSsh: fixture.spawn });
  t.after(() => manager.closeAll());
  const env = { ZSWARM_SERVE: uri, ZSWARM_SERVE_TOKEN: "secret" };
  const [a, b] = await Promise.all([
    dispatchZswarm({ op: "list" }, undefined, { env, serveTunnels: manager }),
    dispatchZswarm({ op: "sessions" }, undefined, { env, serveTunnels: manager }),
  ]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(fixture.launches.length, 1);
  assert.equal(manager.ownedCount(), 1);
});

test("private loopback port retries instead of stealing a foreign listener", async (t) => {
  const occupied = await occupyPort();
  t.after(() => occupied.close());
  const fixture = sshFixture(t);
  const server = await startServe("127.0.0.1:0", async (args) => {
    return { ok: true, data: { forwarded: args.op } };
  }, { token: "secret" });
  t.after(() => server.close());
  const servePort = parseListenAddress(server.label).port;
  const uri = `ssh://host?servePort=${servePort}`;
  let n = 0;
  const manager = createServeTunnelManager({
    persistIdle: false,
    spawnSsh: fixture.spawn,
    allocatePort: async () => {
      n += 1;
      if (n === 1) return occupied.port;
      const next = await occupyPort();
      const port = next.port;
      await next.close();
      return port;
    },
  });
  t.after(() => manager.closeAll());
  const result = await dispatchZswarm(
    { op: "list" },
    undefined,
    { env: { ZSWARM_SERVE: uri, ZSWARM_SERVE_TOKEN: "secret" }, serveTunnels: manager },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(n >= 2, `expected a retry after the occupied port, got ${n}`);
  const used = fixture.launches.map((l) => l.args[l.args.indexOf("-L") + 1].split(":")[1]);
  assert.equal(used.includes(String(occupied.port)), false);
  assert.ok(used.length >= 1);
});

test("reconnects only before send; a lost reply is uncertain and is not retried", async (t) => {
  const failFirst = join(mkdtempSync(join(tmpdir(), "zswarm-ssh-fail-")), "once");
  t.after(() => rmSync(join(failFirst, ".."), { recursive: true, force: true }));
  const reconnect = sshFixture(t, { SSH_FIXTURE_FAIL_FIRST: failFirst });
  const server = await startServe("127.0.0.1:0", async (args) => {
    return { ok: true, data: { forwarded: args.op } };
  }, { token: "secret" });
  t.after(() => server.close());
  const servePort = parseListenAddress(server.label).port;
  const uri = `ssh://host?servePort=${servePort}`;
  const env = { ZSWARM_SERVE: uri, ZSWARM_SERVE_TOKEN: "secret" };
  const manager = createServeTunnelManager({ persistIdle: false, spawnSsh: reconnect.spawn });
  t.after(() => manager.closeAll());
  const recovered = await dispatchZswarm({ op: "list" }, undefined, { env, serveTunnels: manager });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.ok(reconnect.launches.length >= 2);

  const drop = sshFixture(t, { SSH_FIXTURE_DROP_AFTER_HELLO: "1" });
  const dropManager = createServeTunnelManager({ persistIdle: false, spawnSsh: drop.spawn });
  t.after(() => dropManager.closeAll());
  const lost = await forwardServe({
    target: uri,
    args: { op: "list" },
    timeoutMs: 1_500,
    token: "secret",
    env,
    manager: dropManager,
  });
  assert.equal(lost.ok, false, JSON.stringify(lost));
  assert.ok(
    lost.error.code === "serve_protocol" || lost.error.code === "timeout",
    lost.error.code,
  );
  assert.equal(lost.error.details?.delivery, "uncertain");
  assert.equal(drop.launches.length, 1);
});

test("ssh:// failure never falls back to direct ZSWARM_SSH", async (t) => {
  let sshSpawns = 0;
  const manager = createServeTunnelManager({
    persistIdle: false,
    spawnSsh: (_bin, _args, opts) => {
      sshSpawns += 1;
      return spawn(
        process.execPath,
        ["-e", "console.error('Permission denied (publickey)'); process.exit(255);"],
        opts,
      );
    },
  });
  t.after(() => manager.closeAll());
  const result = await dispatchZswarm(
    { op: "sessions" },
    undefined,
    {
      env: {
        ZSWARM_SERVE: "ssh://no-such-serve.example?servePort=9419",
        ZSWARM_SERVE_TOKEN: "secret",
        ZSWARM_SSH: "windows-host",
        ZSWARM_SSH_BIN: "/nonexistent/zellij-should-not-run",
      },
      serveTunnels: manager,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "serve_unreachable");
  assert.equal(sshSpawns >= 1, true);
  assert.notEqual(result.error.code, "zellij_missing");
  assert.notEqual(result.error.code, "zellij_wrong_bin");
  assert.match(result.error.message, /Permission denied|LocalForward/i);
});

test("--local/--ssh/--serve precedence is unchanged for ssh://", () => {
  const uri = "ssh://Administrator@host:22?servePort=9419";
  const env = { ZSWARM_SSH: "old@host", ZSWARM_SERVE: "127.0.0.1:1", ZSWARM_SERVE_TOKEN: "secret" };
  const served = resolveInvocationEnv({ serveAddress: uri }, env);
  assert.equal(served.ZSWARM_SERVE, uri);
  assert.equal(served.ZSWARM_SSH, undefined);
  const ssh = resolveInvocationEnv({ ssh: "win@host" }, env);
  assert.equal(ssh.ZSWARM_SSH, "win@host");
  assert.equal(ssh.ZSWARM_SERVE, undefined);
  const local = resolveInvocationEnv({ local: true }, env);
  assert.equal(local.ZSWARM_SERVE, undefined);
  assert.equal(local.ZSWARM_SSH, undefined);
  assert.throws(
    () => resolveInvocationEnv({ local: true, serveAddress: uri }, env),
    (err) => err.code === "usage",
  );
});

test("invalid ssh:// is a bad_arg and does not echo secrets", async () => {
  const result = await dispatchZswarm(
    { op: "list", serveAddress: "ssh://user:super-secret@host/path" },
    undefined,
    { env: { ZSWARM_SERVE_TOKEN: "secret" } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "bad_arg");
  assert.equal(JSON.stringify(result).includes("super-secret"), false);
});

function gate() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

function waitForFile(path, timeoutMs = 5_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (existsSync(path) && readFileSync(path, "utf8").trim()) {
        resolve(readFileSync(path, "utf8").trim());
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timed out waiting for ${path}`));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function waitExit(child, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(new Error("process did not exit"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function mcpFrame(message) {
  return `${JSON.stringify(message)}\n`;
}

test("omitted ssh:// port does not emit -p; explicit port does", () => {
  const omitted = buildSshTunnelArgv(parseSshServeTarget("ssh://review-alias?servePort=9419"), 18555);
  assert.equal(omitted.args.includes("-p"), false);
  assert.equal(omitted.args.at(-1), "review-alias");
  const explicit = buildSshTunnelArgv(parseSshServeTarget("ssh://review-alias:22?servePort=9419"), 18555);
  assert.ok(explicit.args.includes("-p"));
  assert.equal(explicit.args[explicit.args.indexOf("-p") + 1], "22");
});

test("ssh -G honors omitted port and private ControlPath/ForkAfterAuthentication", () => {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-ssh-g-"));
  const config = join(dir, "ssh_config");
  writeFileSync(
    config,
    [
      "Host review-alias",
      "  HostName 127.0.0.1",
      "  Port 2222",
      "  ControlMaster auto",
      "  ControlPersist 10m",
      "  ControlPath /tmp/zswarm-review-external-master.sock",
      "  ForkAfterAuthentication yes",
      "",
    ].join("\n"),
  );
  const { args } = buildSshTunnelArgv(parseSshServeTarget("ssh://review-alias?servePort=9419"), 18555);
  let effective;
  try {
    effective = execFileSync("ssh", ["-G", "-F", config, ...args], {
      encoding: "utf8",
      timeout: 8_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    if (err.code === "ENOENT") {
      assert.equal(args.includes("-p"), false);
      assert.ok(args.includes("ControlPath=none"));
      assert.ok(args.includes("ForkAfterAuthentication=no"));
      return;
    }
    throw err;
  }
  rmSync(dir, { recursive: true, force: true });
  const lines = new Map(
    effective
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf(" ");
        return [line.slice(0, i).toLowerCase(), line.slice(i + 1)];
      }),
  );
  assert.equal(lines.get("port"), "2222");
  assert.notEqual(lines.get("controlpath"), "/tmp/zswarm-review-external-master.sock");
  if (lines.has("controlpath")) {
    assert.equal(lines.get("controlpath"), "none");
  }
  assert.ok(lines.get("controlmaster") === "no" || lines.get("controlmaster") === "false");
  assert.equal(lines.get("forkafterauthentication"), "no");
  assert.ok(args.includes("ControlPath=none"));
  assert.equal(args[args.indexOf("-S") + 1], "none");
});

test("parseSshServeTarget rejects option-injection, NULs, and malformed escapes without echoing secrets", () => {
  assert.throws(() => parseSshServeTarget("ssh://-V@host"), /destination/);
  assert.throws(() => parseSshServeTarget("ssh://user%00@host"), /control characters/);
  assert.throws(() => parseSshServeTarget("ssh://ho%zzst"), /malformed escape/);
  const tokenUri = "ssh://host?token=review-secret";
  assert.throws(() => parseSshServeTarget(tokenUri), (err) => {
    assert.equal(err.code, "bad_arg");
    assert.equal(err.message.includes("review-secret"), false);
    assert.equal(err.message.includes("token="), false);
    return /unsupported query/.test(err.message);
  });
  assert.equal(describeServeTarget(tokenUri).includes("review-secret"), false);
  const malformed = "ssh://user:review/secret@host";
  assert.throws(() => parseSshServeTarget(malformed), (err) => {
    assert.equal(JSON.stringify(err.message).includes("review/secret"), false);
    return true;
  });
  assert.equal(describeServeTarget(malformed).includes("review/secret"), false);
  assert.equal(describeServeTarget(malformed).includes("review"), false);
  const v6 = parseSshServeTarget("ssh://[::1]?servePort=9419");
  assert.equal(v6.host, "::1");
  assert.equal(v6.sshPort, undefined);
});

test("rejected ssh:// dispatch result omits secret-bearing URI text", async () => {
  const result = await dispatchZswarm(
    { op: "list", serveAddress: "ssh://host?token=review-secret" },
    undefined,
    { env: { ZSWARM_SERVE_TOKEN: "secret" } },
  );
  const serialized = JSON.stringify(result);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "bad_arg");
  assert.equal(serialized.includes("review-secret"), false);
  assert.equal(serialized.includes("token=review"), false);
});

test("reuse revalidates credentials, returns hello metadata, and isolates a wrong token", async (t) => {
  const fixture = sshFixture(t);
  const ops = [];
  const server = await startServe(
    "127.0.0.1:0",
    async (args) => {
      ops.push(args.op);
      return { ok: true, data: { forwarded: args.op } };
    },
    { token: "good" },
  );
  t.after(() => server.close());
  const servePort = parseListenAddress(server.label).port;
  const uri = `ssh://host?servePort=${servePort}`;
  const manager = createServeTunnelManager({ persistIdle: true, spawnSsh: fixture.spawn });
  t.after(() => manager.closeAll());
  const good = await manager.acquire(uri, { token: "good", timeoutMs: 8_000 });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(typeof good.hello.protocol, "number");
  assert.ok(good.hello.serverId);
  assert.ok(good.hello.hostname);
  assert.ok(good.hello.platform);
  assert.ok(good.hello.version);
  assert.ok(Array.isArray(good.hello.capabilities));
  assert.equal(good.handle.hello.serverId, good.hello.serverId);
  const wrong = await manager.acquire(uri, { token: "wrong", timeoutMs: 3_000 });
  assert.equal(wrong.ok, false, JSON.stringify(wrong));
  assert.equal(wrong.error.code, "serve_unauthorized");
  assert.deepEqual(ops, []);
  assert.equal(manager.ownedCount(), 1);
  assert.equal(fixture.launches[0].child.exitCode, null);
  assert.equal(fixture.launches[0].env.ZSWARM_SERVE_TOKEN, undefined);
  await good.handle.release();
});

test("invalidate retires a transport without killing another live lease", async (t) => {
  const stopListen = join(mkdtempSync(join(tmpdir(), "zswarm-stop-listen-")), "stop");
  t.after(() => rmSync(join(stopListen, ".."), { recursive: true, force: true }));
  const fixture = sshFixture(t, { SSH_FIXTURE_STOP_LISTEN: stopListen });
  const server = await startServe(
    "127.0.0.1:0",
    async (args) => ({ ok: true, data: { forwarded: args.op } }),
    { token: "secret" },
  );
  t.after(() => server.close());
  const servePort = parseListenAddress(server.label).port;
  const uri = `ssh://host?servePort=${servePort}`;
  const env = { ZSWARM_SERVE: uri, ZSWARM_SERVE_TOKEN: "secret" };
  let probes = 0;
  const manager = createServeTunnelManager({
    persistIdle: true,
    spawnSsh: fixture.spawn,
    probe: async (...args) => {
      const result = await probeServe(...args);
      probes += 1;
      if (probes === 3 && result.ok) {
        writeFileSync(stopListen, "1");
        await waitForFile(`${stopListen}.done`, 2_000);
      }
      return result;
    },
  });
  t.after(() => manager.closeAll());
  const first = await manager.acquire(uri, { env, token: "secret", timeoutMs: 3_000 });
  const second = await manager.acquire(uri, { env, token: "secret", timeoutMs: 3_000 });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(manager.ownedCount() >= 1, true);
  const originalChild = fixture.launches[0].child;
  const forwarded = await forwardServe({
    target: uri,
    args: { op: "list" },
    timeoutMs: 2_000,
    token: "secret",
    env,
    manager,
  });
  assert.ok(fixture.launches.length >= 2, `expected a replacement child, got ${fixture.launches.length}`);
  assert.equal(originalChild.exitCode, null, JSON.stringify(forwarded));
  assert.equal(originalChild.signalCode, null);
  if (!forwarded.ok) {
    assert.ok(
      forwarded.error.code === "serve_unreachable" || forwarded.error.code === "timeout",
      forwarded.error.code,
    );
    assert.notEqual(forwarded.error.details?.delivery, "uncertain");
  }
  await first.handle.release();
  await second.handle.release();
});

test("closeAll reaps in-flight startups and rejects later adoption", async (t) => {
  const fixture = sshFixture(t);
  const server = await startServe(
    "127.0.0.1:0",
    async (args) => ({ ok: true, data: { forwarded: args.op } }),
    { token: "good" },
  );
  t.after(() => server.close());
  const servePort = parseListenAddress(server.label).port;
  const uri = `ssh://host?servePort=${servePort}`;
  const entered = gate();
  const finish = gate();
  const manager = createServeTunnelManager({
    persistIdle: true,
    spawnSsh: fixture.spawn,
    probe: async (...args) => {
      entered.resolve();
      await finish.promise;
      return probeServe(...args);
    },
  });
  t.after(() => manager.closeAll());
  const starting = manager.acquire(uri, { token: "good", timeoutMs: 5_000 });
  await entered.promise;
  assert.ok(manager.ownedCount() >= 1);
  await manager.closeAll();
  assert.equal(manager.ownedCount(), 0);
  finish.resolve();
  const resurrected = await starting;
  assert.equal(resurrected.ok, false, JSON.stringify(resurrected));
  assert.equal(resurrected.error.code, "cancelled");
  assert.equal(manager.ownedCount(), 0);
  const later = await manager.acquire(uri, { token: "good", timeoutMs: 1_000 });
  assert.equal(later.ok, false);
  assert.match(later.error.message, /closed/);
});

test("queued callers cancel and expire independently of a gated predecessor", async (t) => {
  const fixture = sshFixture(t);
  const ops = [];
  const server = await startServe(
    "127.0.0.1:0",
    async (args) => {
      ops.push(args.op);
      return { ok: true, data: { forwarded: args.op } };
    },
    { token: "good" },
  );
  t.after(() => server.close());
  const servePort = parseListenAddress(server.label).port;
  const uri = `ssh://host?servePort=${servePort}`;
  const entered = gate();
  const finish = gate();
  let nowMs = 1_000_000;
  const manager = createServeTunnelManager({
    persistIdle: true,
    spawnSsh: fixture.spawn,
    now: () => nowMs,
    probe: async (...args) => {
      entered.resolve();
      await finish.promise;
      return probeServe(...args);
    },
  });
  t.after(() => manager.closeAll());
  const first = manager.acquire(uri, { token: "good", timeoutMs: 30_000 });
  await entered.promise;
  const expired = manager.acquire(uri, { token: "good", timeoutMs: 5 });
  const ac = new AbortController();
  let cancelledSettled = false;
  const cancelled = manager
    .acquire(uri, { token: "good", timeoutMs: 30_000, signal: ac.signal })
    .then((result) => {
      cancelledSettled = true;
      return result;
    });
  ac.abort();
  const cancelledResult = await cancelled;
  assert.equal(cancelledSettled, true);
  assert.equal(cancelledResult.ok, false);
  assert.equal(cancelledResult.error.code, "cancelled");
  nowMs += 100;
  const expiredResult = await expired;
  assert.equal(expiredResult.ok, false, JSON.stringify(expiredResult));
  assert.equal(expiredResult.error.code, "timeout");
  finish.resolve();
  const firstResult = await first;
  assert.equal(firstResult.ok, true, JSON.stringify(firstResult));
  assert.deepEqual(ops, []);
  await firstResult.handle.release();
});

// Windows node --test runs files concurrently. This LISTEN_ONLY fixture holds a
// 15s CLI timeout and starves the CPU enough that pr1-fixes.status deadline
// assertions miss a 4s cap. MCP stdin-EOF still covers process+child reaping
// on Windows; Unix still exercises CLI SIGTERM/timeout shutdown.
test("CLI timeout during hello exits and reaps the ssh child", { skip: process.platform === "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-cli-life-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const fixtureFile = join(dir, "ssh-fixture.mjs");
  writeFileSync(fixtureFile, SSH_FORWARD_SOURCE);
  const pidfile = join(dir, "child.pid");
  const server = await startServe(
    "127.0.0.1:0",
    async () => ({ ok: true, data: { forwarded: true } }),
    { token: "secret" },
  );
  t.after(() => server.close());
  const servePort = parseListenAddress(server.label).port;
  const uri = `ssh://review-alias?servePort=${servePort}`;
  const cliJs = fileURLToPath(new URL("../../cli/dist/cli.js", import.meta.url));
  const child = spawn(process.execPath, [cliJs, "--serve", uri, "list", "--timeout-ms", "1"], {
    env: {
      ...process.env,
      ZSWARM_SERVE_TOKEN: "secret",
      ZSWARM_SSH_BIN: fixtureFile,
      SSH_FIXTURE_PIDFILE: pidfile,
      SSH_FIXTURE_LISTEN_ONLY: "1",
      ZSWARM_LOG: "0",
      ZSWARM_BUS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const pid = Number(await waitForFile(pidfile, 8_000));
  assert.ok(pidAlive(pid));
  const exited = await waitExit(child, 25_000);
  assert.notEqual(exited.code, 0);
  if (stdout.trim()) {
    const json = stdout.trim().match(/\{[\s\S]*\}\s*$/);
    assert.ok(json, stdout.slice(0, 200));
    const parsed = JSON.parse(json[0]);
    assert.equal(parsed.ok, false);
  }
  const deadline = Date.now() + 3_000;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(pidAlive(pid), false);
});

test("MCP stdin EOF during hello exits and reaps the ssh child", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-mcp-life-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const fixtureFile = join(dir, "ssh-fixture.mjs");
  writeFileSync(fixtureFile, SSH_FORWARD_SOURCE);
  const pidfile = join(dir, "child.pid");
  const gateFile = join(dir, "listen.gate");
  const server = await startServe(
    "127.0.0.1:0",
    async () => ({ ok: true, data: { forwarded: true } }),
    { token: "secret" },
  );
  t.after(() => server.close());
  const servePort = parseListenAddress(server.label).port;
  const uri = `ssh://review-alias?servePort=${servePort}`;
  const mcpJs = fileURLToPath(new URL("../../mcp/dist/mcp-server.js", import.meta.url));
  const child = spawn(process.execPath, [mcpJs], {
    env: {
      ...process.env,
      ZSWARM_SERVE: uri,
      ZSWARM_SERVE_TOKEN: "secret",
      ZSWARM_SSH_BIN: fixtureFile,
      SSH_FIXTURE_PIDFILE: pidfile,
      SSH_FIXTURE_GATE: gateFile,
      ZSWARM_LOG: "0",
      ZSWARM_BUS: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stdin.write(
    mcpFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "zswarm-test", version: "0.0.0" },
      },
    }),
  );
  child.stdin.write(mcpFrame({ jsonrpc: "2.0", method: "notifications/initialized" }));
  child.stdin.write(
    mcpFrame({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "zswarm", arguments: { op: "list" } },
    }),
  );
  const pid = Number(await waitForFile(pidfile, 8_000));
  assert.ok(pidAlive(pid));
  child.stdin.end();
  const exited = await waitExit(child, 12_000);
  assert.ok(exited.code === 0 || exited.code === null || exited.signal != null);
  assert.equal(stdout.includes("review-secret"), false);
  const deadline = Date.now() + 3_000;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(pidAlive(pid), false);
});

