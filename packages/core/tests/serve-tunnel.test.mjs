process.env.ZSWARM_LOG = "0";
process.env.ZSWARM_BUS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { existsSync, writeFileSync } from "node:fs";

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
let proxied = 0;
const server = createServer((client) => {
  proxied += 1;
  if (listenOnly) return;
  if (dropAfterHello && proxied > 1) {
    client.once("data", () => client.destroy());
    return;
  }
  const upstream = connect({ host: remoteHost, port: remotePort });
  const fail = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", fail);
  upstream.on("error", fail);
  client.pipe(upstream);
  upstream.pipe(client);
});
server.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
server.listen(localPort, localHost);
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
      launches.push({ bin, args, env: opts?.env });
      return spawn(process.execPath, [file, ...args], {
        ...opts,
        env: { ...process.env, ...env, ...(opts?.env ?? {}) },
      });
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
    sshPort: DEFAULT_SSH_PORT,
    servePort: DEFAULT_SSH_SERVE_PORT,
    destination: "host",
  });
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
  assert.match(redactSshUserinfo(secretUri), /:\*\*\*@/);
  assert.throws(() => parseSshServeTarget("ssh://host/var/run"), /path/);
  assert.throws(() => parseSshServeTarget("ssh://host#frag"), /fragment/);
  assert.throws(() => parseSshServeTarget("ssh://host?servePort=9419&foo=1"), /unknown query \(foo\)/);
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
  assert.ok(args.includes("ControlPersist=no"));
  assert.ok(args.includes("-i"));
  assert.equal(args.includes("-f"), false);
  assert.equal(args.some((a) => /StrictHostKeyChecking=no/i.test(a)), false);
  assert.equal(args.includes("zellij"), false);
});

test("assertSafeSshTunnelOpts rejects daemonize and extra forwards", () => {
  assert.throws(() => assertSafeSshTunnelOpts(["-f"]), /daemonize/);
  assert.throws(() => assertSafeSshTunnelOpts(["-o", "ControlMaster=yes"]), /ControlMaster/);
  assert.throws(() => assertSafeSshTunnelOpts(["-oControlPersist=10m"]), /ControlPersist/);
  assert.throws(() => assertSafeSshTunnelOpts(["-L", "9419:127.0.0.1:9419"]), /extra forwards/);
  assert.doesNotThrow(() => assertSafeSshTunnelOpts(["-o", "ControlMaster=no", "-i", "key"]));
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
    assert.equal(describeServeTarget(uri), `ssh://Administrator@example.test:22?servePort=${servePort}`);
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
