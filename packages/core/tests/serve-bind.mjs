// Proposal 7: verified Tailscale listen bind. Injected CLI/OS/listen seams only.
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorizeServeListen,
  canonicalizeListenIp,
  expandIPv6,
  installServeLogon,
  SERVE_BIND_STATUS_MAX_BYTES,
  SERVE_TAILSCALE_BIN_ENV,
  serveTaskLaunchEnv,
  startServe,
  uninstallServeLogon,
} from "../dist/index.js";

const SELF_V4 = "100.64.1.2";
const SELF_V6 = "fd7a:115c:a1e0::1";
const PEER_V4 = "100.64.9.9";
const OTHER_CGNAT = "100.64.50.50";

function statusJson(overrides = {}) {
  const selfIps = overrides.selfIps ?? [SELF_V4, SELF_V6];
  const rootIps = overrides.rootIps ?? selfIps;
  const body = {
    BackendState: overrides.BackendState ?? "Running",
    TailscaleIPs: rootIps,
    Self: {
      HostName: "crew-host",
      DNSName: "crew-host.tailnet.ts.net.",
      Online: true,
      TailscaleIPs: selfIps,
      ...(overrides.Self ?? {}),
    },
    ...(overrides.Peer ? { Peer: overrides.Peer } : {}),
    ...overrides.extra,
  };
  if (overrides.dropSelf) delete body.Self;
  if (overrides.dropRoot) delete body.TailscaleIPs;
  return JSON.stringify(body);
}

function ownedIfaces(addresses = [SELF_V4, SELF_V6]) {
  return () => ({
    tailscale0: addresses.map((address) => ({
      address,
      netmask: address.includes(":") ? "ffff:ffff:ffff:ffff::" : "255.255.255.255",
      family: address.includes(":") ? "IPv6" : "IPv4",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: address.includes(":") ? `${address}/128` : `${address}/32`,
    })),
    lo: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
  });
}

function okStatus(overrides = {}) {
  return async () => ({ code: 0, stdout: statusJson(overrides), stderr: "" });
}

function recordingServer(record) {
  return () => {
    const server = new EventEmitter();
    server.listen = (port, host, cb) => {
      record.push({ port, host });
      queueMicrotask(() => {
        if (typeof cb === "function") cb();
        server.emit("listening");
      });
      return server;
    };
    server.address = () => ({
      address: record.at(-1)?.host ?? "127.0.0.1",
      port: record.at(-1)?.port || 9419,
      family: "IPv4",
    });
    server.close = (cb) => {
      queueMicrotask(() => cb?.());
      return server;
    };
    return server;
  };
}

function failingServer(code) {
  return () => {
    const server = new EventEmitter();
    server.listen = () => {
      queueMicrotask(() => {
        const err = new Error(`listen ${code}`);
        err.code = code;
        server.emit("error", err);
      });
      return server;
    };
    server.address = () => null;
    server.close = (cb) => {
      cb?.();
      return server;
    };
    return server;
  };
}

export function registerServeBindTests(test = nodeTest) {
  test("canonicalizeListenIp rejects wildcards, hostnames, and mapped IPv6", () => {
    assert.equal(canonicalizeListenIp("0.0.0.0"), null);
    assert.equal(canonicalizeListenIp("::"), null);
    assert.equal(canonicalizeListenIp("*"), null);
    assert.equal(canonicalizeListenIp("crew-host"), null);
    assert.equal(canonicalizeListenIp("crew-host.tailnet.ts.net"), null);
    assert.equal(canonicalizeListenIp("::ffff:100.64.1.2"), null);
    assert.equal(canonicalizeListenIp("0:0:0:0:0:ffff:100.64.1.2"), null);
    assert.equal(canonicalizeListenIp("0:0:0:0:0:0:0:0"), null);
    assert.equal(canonicalizeListenIp("0::ffff:6440:102"), null);
    assert.equal(canonicalizeListenIp("::ffff:6440:102"), null);
    assert.deepEqual(canonicalizeListenIp(SELF_V4), { family: 4, canonical: SELF_V4 });
    assert.equal(canonicalizeListenIp(SELF_V6)?.canonical, expandIPv6(SELF_V6));
    assert.equal(
      canonicalizeListenIp("FD7A:115C:A1E0:0:0:0:0:1")?.canonical,
      expandIPv6(SELF_V6),
    );
  });

  test("default loopback authorize skips Tailscale CLI", async () => {
    let called = 0;
    const auth = await authorizeServeListen("127.0.0.1", {
      tailscaleStatus: async () => {
        called += 1;
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    assert.equal(auth.mode, "loopback");
    assert.equal(called, 0);
  });

  test("startServe default loopback does not invoke Tailscale status", async () => {
    let called = 0;
    const { label, close } = await startServe(
      "127.0.0.1:0",
      async () => ({ ok: true, data: {} }),
      {
        token: "secret",
        tailscaleStatus: async () => {
          called += 1;
          return { code: 0, stdout: "{}", stderr: "" };
        },
      },
    );
    try {
      assert.match(label, /^127\.0\.0\.1:/);
      assert.equal(called, 0);
    } finally {
      await close();
    }
  });

  test("missing token is checked before Tailscale dispatch", async () => {
    let called = 0;
    await assert.rejects(
      () =>
        startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
          tailscaleStatus: async () => {
            called += 1;
            return { code: 0, stdout: statusJson(), stderr: "" };
          },
          networkInterfaces: ownedIfaces(),
        }),
      /ZSWARM_SERVE_TOKEN/,
    );
    assert.equal(called, 0);
  });

  test("binds exact verified Tailscale IPv4 after status + OS evidence", async () => {
    const record = [];
    const { label, close } = await startServe(
      `${SELF_V4}:9419`,
      async () => ({ ok: true, data: {} }),
      {
        token: "secret",
        tailscaleStatus: okStatus(),
        networkInterfaces: ownedIfaces(),
        createServer: recordingServer(record),
      },
    );
    try {
      assert.equal(label, `${SELF_V4}:9419`);
      assert.deepEqual(record, [{ port: 9419, host: SELF_V4 }]);
    } finally {
      await close();
    }
  });

  test("accepts equivalent IPv6 listen forms for the same self address", async () => {
    const expanded = "fd7a:115c:a1e0:0:0:0:0:1";
    for (const host of [SELF_V6, expanded, expanded.toUpperCase()]) {
      const record = [];
      const { label, close } = await startServe(
        `[${host}]:9419`,
        async () => ({ ok: true, data: {} }),
        {
          token: "secret",
          tailscaleStatus: okStatus({ selfIps: [SELF_V4, SELF_V6] }),
          networkInterfaces: ownedIfaces([SELF_V4, SELF_V6]),
          createServer: recordingServer(record),
        },
      );
      try {
        assert.equal(record[0]?.host, host);
        assert.match(label, /^\[.+\]:9419$/);
      } finally {
        await close();
      }
    }
  });

  test("rejects arbitrary 100.x without self evidence", async () => {
    await assert.rejects(
      () =>
        startServe(`${OTHER_CGNAT}:9419`, async () => ({ ok: true, data: {} }), {
          token: "secret",
          tailscaleStatus: okStatus(),
          networkInterfaces: ownedIfaces([OTHER_CGNAT, SELF_V4]),
          createServer: recordingServer([]),
        }),
      /not a verified local Tailscale self address/,
    );
  });

  test("rejects another node's Tailscale IP even when present under Peer", async () => {
    await assert.rejects(
      () =>
        startServe(`${PEER_V4}:9419`, async () => ({ ok: true, data: {} }), {
          token: "secret",
          tailscaleStatus: okStatus({
            Peer: {
              k: {
                HostName: "peer",
                TailscaleIPs: [PEER_V4],
                Online: true,
              },
            },
          }),
          networkInterfaces: ownedIfaces([SELF_V4, PEER_V4]),
          createServer: recordingServer([]),
        }),
      /not a verified local Tailscale self address/,
    );
  });

  test("rejects OS-local CGNAT when Tailscale self evidence does not match", async () => {
    await assert.rejects(
      () =>
        startServe(`${OTHER_CGNAT}:9419`, async () => ({ ok: true, data: {} }), {
          token: "secret",
          tailscaleStatus: okStatus({ selfIps: [SELF_V4], rootIps: [SELF_V4] }),
          networkInterfaces: ownedIfaces([OTHER_CGNAT]),
          createServer: recordingServer([]),
        }),
      /not a verified local Tailscale self address/,
    );
  });

  test("rejects daemon-claimed address absent from OS interfaces", async () => {
    await assert.rejects(
      () =>
        startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
          token: "secret",
          tailscaleStatus: okStatus(),
          networkInterfaces: () => ({
            eth0: [
              {
                address: "192.168.1.10",
                netmask: "255.255.255.0",
                family: "IPv4",
                mac: "00:00:00:00:00:00",
                internal: false,
                cidr: "192.168.1.10/24",
              },
            ],
          }),
          createServer: recordingServer([]),
        }),
      /not assigned on a local OS interface/,
    );
  });

  test("rejects wildcard, LAN, public, hostname, and mapped-IPv6 inputs", async () => {
    const cases = [
      "0.0.0.0:9419",
      "[::]:9419",
      "192.168.1.10:9419",
      "8.8.8.8:9419",
      "crew-host:9419",
      "[::ffff:100.64.1.2]:9419",
    ];
    for (const listen of cases) {
      await assert.rejects(
        () =>
          startServe(listen, async () => ({ ok: true, data: {} }), {
            token: "secret",
            tailscaleStatus: okStatus(),
            networkInterfaces: ownedIfaces(),
            createServer: recordingServer([]),
          }),
        /serve_auth|literal|refuses|Tailscale|host/i,
      );
    }
  });

  test("missing Tailscale CLI fails closed before listen", async () => {
    const record = [];
    await assert.rejects(
      () =>
        startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
          token: "secret",
          tailscaleStatus: async () => ({ code: 127, stdout: "", stderr: "ENOENT" }),
          networkInterfaces: ownedIfaces(),
          createServer: recordingServer(record),
        }),
      /Tailscale CLI is missing/,
    );
    assert.equal(record.length, 0);
  });

  test("stopped or inaccessible daemon fails closed", async () => {
    for (const backend of ["Stopped", "NeedsLogin", "Starting", ""]) {
      await assert.rejects(
        () =>
          startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
            token: "secret",
            tailscaleStatus: okStatus({ BackendState: backend || "Stopped" }),
            networkInterfaces: ownedIfaces(),
            createServer: recordingServer([]),
          }),
        /BackendState Running/,
      );
    }
    await assert.rejects(
      () =>
        startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
          token: "secret",
          tailscaleStatus: async () => ({
            code: 1,
            stdout: "",
            stderr: "failed to connect to local tailscaled",
          }),
          networkInterfaces: ownedIfaces(),
          createServer: recordingServer([]),
        }),
      /Tailscale daemon/,
    );
  });

  test("malformed, truncated, and oversize status JSON fail closed", async () => {
    await assert.rejects(
      () =>
        startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
          token: "secret",
          tailscaleStatus: async () => ({ code: 0, stdout: "{not-json", stderr: "" }),
          networkInterfaces: ownedIfaces(),
          createServer: recordingServer([]),
        }),
      /malformed/,
    );
    await assert.rejects(
      () =>
        startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
          token: "secret",
          tailscaleStatus: async () => ({
            code: 0,
            stdout: '{"BackendState":"Running"',
            stderr: "",
          }),
          networkInterfaces: ownedIfaces(),
          createServer: recordingServer([]),
        }),
      /malformed/,
    );
    const oversize = `${"x".repeat(SERVE_BIND_STATUS_MAX_BYTES)}`;
    await assert.rejects(
      () =>
        startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
          token: "secret",
          tailscaleStatus: async () => ({ code: 0, stdout: oversize, stderr: "" }),
          networkInterfaces: ownedIfaces(),
          createServer: recordingServer([]),
        }),
      /size cap|malformed/,
    );
  });

  test("Self vs root TailscaleIPs conflict fails closed", async () => {
    await assert.rejects(
      () =>
        startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
          token: "secret",
          tailscaleStatus: okStatus({
            selfIps: [SELF_V4],
            rootIps: [OTHER_CGNAT],
          }),
          networkInterfaces: ownedIfaces(),
          createServer: recordingServer([]),
        }),
      /conflict/,
    );
  });

  test("cancellation before listen skips createServer", async () => {
    const record = [];
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () =>
        startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
          token: "secret",
          signal: ac.signal,
          tailscaleStatus: okStatus(),
          networkInterfaces: ownedIfaces(),
          createServer: recordingServer(record),
        }),
      /cancel/i,
    );
    assert.equal(record.length, 0);
  });

  test("EADDRNOTAVAIL and EADDRINUSE surface without fallback listen", async () => {
    for (const code of ["EADDRNOTAVAIL", "EADDRINUSE"]) {
      await assert.rejects(
        () =>
          startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
            token: "secret",
            tailscaleStatus: okStatus(),
            networkInterfaces: ownedIfaces(),
            createServer: failingServer(code),
          }),
        (err) => {
          assert.equal(err.code, "serve_auth");
          assert.match(err.message, new RegExp(code));
          assert.match(err.message, /no fallback/);
          assert.equal(err.details?.phase, "bind");
          return true;
        },
      );
    }
  });

  test("restart revalidates Tailscale evidence on every startServe", async () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return { code: 0, stdout: statusJson(), stderr: "" };
    };
    for (let i = 0; i < 2; i++) {
      const record = [];
      const { close } = await startServe(
        `${SELF_V4}:9419`,
        async () => ({ ok: true, data: {} }),
        {
          token: "secret",
          tailscaleStatus: runner,
          networkInterfaces: ownedIfaces(),
          createServer: recordingServer(record),
        },
      );
      await close();
    }
    assert.equal(calls, 2);
  });

  test("Windows install verifies Tailscale bind before task mutation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zswarm-bind-install-"));
    const scriptPath = join(dir, "cli.js");
    writeFileSync(scriptPath, "// fixture\n");
    let statusCalls = 0;
    let psCalls = [];
    await assert.rejects(
      () =>
        installServeLogon({
          platform: "win32",
          listen: `${OTHER_CGNAT}:9419`,
          token: "secret",
          env: { ZSWARM_SERVE_TOKEN: "secret" },
          execPath: process.execPath,
          scriptPath,
          timeoutMs: 100,
          now: () => 1000,
          sleep: async () => {},
          tailscaleStatus: async () => {
            statusCalls += 1;
            return { code: 0, stdout: statusJson(), stderr: "" };
          },
          networkInterfaces: ownedIfaces([OTHER_CGNAT]),
          runPowerShell: async (script) => {
            psCalls.push(script);
            return { code: 0, stdout: "{}", stderr: "" };
          },
        }),
      /not a verified local Tailscale self address/,
    );
    assert.equal(statusCalls, 1);
    assert.equal(psCalls.length, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("Windows install with verified Tailscale listen reaches readiness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zswarm-bind-ready-"));
    const scriptPath = join(dir, "cli.js");
    writeFileSync(scriptPath, "// fixture\n");
    let now = 1000;
    let task = null;
    const token = "secret";
    const result = await installServeLogon({
      platform: "win32",
      listen: `${SELF_V4}:9419`,
      token,
      env: {
        ZSWARM_SERVE_TOKEN: token,
        [SERVE_TAILSCALE_BIN_ENV]: "C:\\Tools\\tailscale.exe",
      },
      execPath: process.execPath,
      scriptPath,
      session: "crew",
      timeoutMs: 200,
      launchId: "launch-ts",
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      tailscaleStatus: okStatus(),
      networkInterfaces: ownedIfaces(),
      runPowerShell: async (script) => {
        if (script.includes("New-ScheduledTaskPrincipal")) {
          const encoded = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
          const command = Buffer.from(encoded ?? "", "base64").toString("utf8");
          assert.match(command, new RegExp(`serve --listen ${SELF_V4}:9419`));
          assert.match(command, /ZSWARM_TAILSCALE_BIN=C:\\Tools\\tailscale\.exe/);
          task = {
            userId: "CORP\\sam",
            state: "Ready",
            execute: "cmd.exe",
            arguments: `/c ${command}`,
            logonType: "Interactive",
            runLevel: "Limited",
          };
          return {
            code: 0,
            stdout: JSON.stringify({
              registered: true,
              userId: "CORP\\sam",
              userSid: "S-1-5-21-1-2-3-1001",
              logonType: "Interactive",
              runLevel: "Limited",
            }),
            stderr: "",
          };
        }
        if (script.includes("Start-ScheduledTask") && !script.includes("Stop-ScheduledTask")) {
          if (task) task.state = "Running";
          return { code: 0, stdout: JSON.stringify({ started: true }), stderr: "" };
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            exists: Boolean(task),
            currentUser: "CORP\\sam",
            currentSid: "S-1-5-21-1-2-3-1001",
            userSid: task ? "S-1-5-21-1-2-3-1001" : "",
            ...(task ?? {}),
          }),
          stderr: "",
        };
      },
      probeServe: async () => ({
        ok: true,
        data: {
          protocol: 1,
          serverId: "s",
          hostname: "desktop",
          platform: "win32",
          version: "0.1.7",
          capabilities: ["hello"],
          launchId: "launch-ts",
        },
      }),
      callServe: async () => ({
        ok: true,
        data: {
          route: {
            transport: "local",
            endpoint: "desktop",
            session: "crew",
            sessionOrigin: "explicit",
          },
          checks: ["zellij_binary", "zellij_ipc", "zellij_sessions", "session"].map((id) => ({
            id,
            scope: "host",
            state: "ok",
            code: id === "session" ? "session_present" : `${id}_ok`,
            elapsedMs: 1,
            detail: id === "session" ? { session: "crew" } : {},
            remedy: null,
          })),
        },
      }),
    });
    assert.equal(result.installed, true);
    assert.equal(result.ready, true);
    assert.equal(result.listen, `${SELF_V4}:9419`);
    rmSync(dir, { recursive: true, force: true });
  });

  test("Windows clear works while Tailscale evidence is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zswarm-bind-clear-"));
    const scriptPath = join(dir, "cli.js");
    writeFileSync(scriptPath, "// fixture\n");
    let task = {
      userId: "CORP\\sam",
      state: "Running",
      execute: "cmd.exe",
      arguments: `/c set "ZSWARM_SERVE_TOKEN=secret"&& "${process.execPath}" "${scriptPath}" serve --listen ${SELF_V4}:9419`,
      logonType: "Interactive",
      runLevel: "Limited",
    };
    const cleared = await uninstallServeLogon({
      platform: "win32",
      token: "secret",
      env: { ZSWARM_SERVE_TOKEN: "secret" },
      timeoutMs: 100,
      now: () => 1000,
      tailscaleStatus: async () => {
        throw new Error("tailscale should not run during clear");
      },
      runPowerShell: async (script) => {
        if (script.includes("Unregister-ScheduledTask")) {
          task = null;
          return { code: 0, stdout: JSON.stringify({ cleared: true, stopped: true }), stderr: "" };
        }
        if (script.includes("Stop-ScheduledTask")) {
          if (task) task.state = "Ready";
          return { code: 0, stdout: JSON.stringify({ stopped: true }), stderr: "" };
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            exists: Boolean(task),
            currentUser: "CORP\\sam",
            currentSid: "S-1-5-21-1-2-3-1001",
            userSid: task ? "S-1-5-21-1-2-3-1001" : "",
            ...(task ?? {}),
          }),
          stderr: "",
        };
      },
    });
    assert.equal(cleared.cleared, true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("serveTaskLaunchEnv persists ZSWARM_TAILSCALE_BIN without touching the token argv shape", () => {
    const env = serveTaskLaunchEnv({
      ZSWARM_SERVE_TOKEN: "should-not-copy",
      [SERVE_TAILSCALE_BIN_ENV]: "C:\\Tailscale\\tailscale.exe",
      PATH: "C:\\Windows\\System32",
    }, "launch-1");
    assert.equal(env[SERVE_TAILSCALE_BIN_ENV], "C:\\Tailscale\\tailscale.exe");
    assert.equal(env.ZSWARM_SERVE_TOKEN, undefined);
    assert.equal(env.ZSWARM_SERVE_LAUNCH_ID, "launch-1");
  });

  test("install deadline during verify prevents PowerShell mutation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zswarm-bind-deadline-"));
    const scriptPath = join(dir, "cli.js");
    writeFileSync(scriptPath, "// fixture\n");
    let now = 1000;
    let ps = 0;
    await assert.rejects(
      () =>
        installServeLogon({
          platform: "win32",
          listen: `${SELF_V4}:9419`,
          token: "secret",
          env: { ZSWARM_SERVE_TOKEN: "secret" },
          execPath: process.execPath,
          scriptPath,
          timeoutMs: 5,
          now: () => now,
          sleep: async () => {},
          tailscaleStatus: async () => {
            now += 50;
            return { code: 0, stdout: statusJson(), stderr: "" };
          },
          networkInterfaces: ownedIfaces(),
          runPowerShell: async () => {
            ps += 1;
            return { code: 0, stdout: "{}", stderr: "" };
          },
        }),
      /timed out|timeout/i,
    );
    assert.equal(ps, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("startup budget expiry after status or OS inspection prevents listener creation", async () => {
    for (const stage of ["status", "interfaces"]) {
      let now = 1000;
      const record = [];
      await assert.rejects(
        () =>
          startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
            token: "secret",
            timeoutMs: 10,
            now: () => now,
            tailscaleStatus: async () => {
              if (stage === "status") now += 11;
              return { code: 0, stdout: statusJson(), stderr: "" };
            },
            networkInterfaces: () => {
              if (stage === "interfaces") now += 11;
              return ownedIfaces()();
            },
            createServer: recordingServer(record),
          }),
        /timeout|timed out/i,
      );
      assert.equal(record.length, 0, stage);
    }
  });

  test("abort between authorization and listen prevents createServer", async () => {
    const ac = new AbortController();
    const record = [];
    await assert.rejects(
      () =>
        startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
          token: "secret",
          signal: ac.signal,
          timeoutMs: 100,
          now: () => 1000,
          tailscaleStatus: okStatus(),
          networkInterfaces: () => {
            queueMicrotask(() => ac.abort());
            return ownedIfaces()();
          },
          createServer: recordingServer(record),
        }),
      /cancel|abort/i,
    );
    assert.equal(record.length, 0);
  });

  test("cancel or deadline before listen callback closes the startup listener", async () => {
    for (const cause of ["cancel", "deadline"]) {
      const ac = new AbortController();
      let now = 1000;
      let closes = 0;
      await assert.rejects(
        () =>
          startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
            token: "secret",
            signal: ac.signal,
            timeoutMs: 10,
            now: () => now,
            tailscaleStatus: okStatus(),
            networkInterfaces: ownedIfaces(),
            createServer: () => {
              const server = new EventEmitter();
              server.listen = (_port, _host, cb) => {
                queueMicrotask(() => {
                  if (cause === "cancel") ac.abort();
                  else now += 11;
                  cb();
                  server.emit("listening");
                });
                return server;
              };
              server.address = () => ({ address: SELF_V4, port: 9419, family: "IPv4" });
              server.close = (cb) => {
                closes += 1;
                queueMicrotask(() => cb?.());
                return server;
              };
              return server;
            },
          }),
        /cancel|abort|timeout|timed out/i,
      );
      assert.ok(closes >= 1, cause);
    }
  });

  test("present invalid root/self TailscaleIP shapes refuse before listen", async () => {
    const bodies = [
      { ...JSON.parse(statusJson()), TailscaleIPs: [] },
      { ...JSON.parse(statusJson()), TailscaleIPs: "unexpected-shape" },
      { ...JSON.parse(statusJson()), TailscaleIPs: ["not-an-ip"] },
      { ...JSON.parse(statusJson()), Self: { TailscaleIPs: [SELF_V4, 42] } },
    ];
    for (const body of bodies) {
      const record = [];
      await assert.rejects(
        () =>
          startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
            token: "secret",
            tailscaleStatus: async () => ({ code: 0, stdout: JSON.stringify(body), stderr: "" }),
            networkInterfaces: ownedIfaces(),
            createServer: recordingServer(record),
          }),
        /serve_auth|Tailscale|malformed|conflict|valid/i,
      );
      assert.equal(record.length, 0);
    }
  });

  test("absent root TailscaleIPs still binds when Self is valid", async () => {
    const record = [];
    const body = JSON.parse(statusJson());
    delete body.TailscaleIPs;
    const { close } = await startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
      token: "secret",
      tailscaleStatus: async () => ({ code: 0, stdout: JSON.stringify(body), stderr: "" }),
      networkInterfaces: ownedIfaces(),
      createServer: recordingServer(record),
    });
    try {
      assert.deepEqual(record, [{ port: 9419, host: SELF_V4 }]);
    } finally {
      await close();
    }
  });

  test("healthy server survives past the startup budget", async () => {
    let now = 1000;
    const { label, close } = await startServe(
      "127.0.0.1:0",
      async () => ({ ok: true, data: { alive: true } }),
      { token: "secret", timeoutMs: 20, now: () => now },
    );
    try {
      now += 50_000;
      const { callServe } = await import("../dist/index.js");
      const reply = await callServe(label, { op: "ping" }, 2_000, "secret");
      assert.deepEqual(reply, { ok: true, data: { alive: true } });
    } finally {
      await close();
    }
  });

  test("abort settles pending listen without waiting for the callback", async () => {
    const ac = new AbortController();
    let complete;
    let closes = 0;
    let observed;
    const started = new Promise((resolve) => {
      void startServe("127.0.0.1:9419", async () => ({ ok: true, data: {} }), {
        token: "secret",
        signal: ac.signal,
        timeoutMs: 10_000,
        createServer: () => {
          const server = new EventEmitter();
          server.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 9419 });
          server.listen = (_port, _host, callback) => {
            complete = () => {
              callback();
              server.emit("listening");
            };
            resolve();
            return server;
          };
          server.close = (cb) => {
            closes += 1;
            queueMicrotask(() => cb?.());
            return server;
          };
          return server;
        },
      }).then(
        (value) => {
          observed = { ok: true, value };
        },
        (error) => {
          observed = { ok: false, error };
        },
      );
    });
    await started;
    ac.abort();
    await new Promise((r) => setImmediate(r));
    const beforeCallback = observed;
    const closedBeforeCallback = closes;
    complete();
    await new Promise((r) => setImmediate(r));
    assert.ok(beforeCallback, "startup remained pending after abort until listen callback");
    assert.equal(beforeCallback.ok, false);
    assert.match(beforeCallback.error.message, /cancel|abort/i);
    assert.ok(closedBeforeCallback > 0, "abort must close the owned listener promptly");
  });

  test("expiry settles pending listen without waiting for the callback", async () => {
    let now = 0;
    let complete;
    let closes = 0;
    let observed;
    const started = new Promise((resolve) => {
      void startServe("127.0.0.1:9419", async () => ({ ok: true, data: {} }), {
        token: "secret",
        now: () => now,
        timeoutMs: 50,
        createServer: () => {
          const server = new EventEmitter();
          server.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 9419 });
          server.listen = (_port, _host, callback) => {
            complete = () => {
              callback();
              server.emit("listening");
            };
            resolve();
            return server;
          };
          server.close = (cb) => {
            closes += 1;
            queueMicrotask(() => cb?.());
            return server;
          };
          return server;
        },
      }).then(
        (value) => {
          observed = { ok: true, value };
        },
        (error) => {
          observed = { ok: false, error };
        },
      );
    });
    await started;
    now = 51;
    await new Promise((r) => setTimeout(r, 75));
    const beforeCallback = observed;
    const closedBeforeCallback = closes;
    complete();
    await new Promise((r) => setImmediate(r));
    assert.ok(beforeCallback, "startup remained pending past expiry until listen callback");
    assert.equal(beforeCallback.ok, false);
    assert.match(beforeCallback.error.message, /timeout|timed out/i);
    assert.ok(closedBeforeCallback > 0, "expiry must close the owned listener promptly");
  });

  test("healthy server survives real wall-clock passage beyond the startup timer", async () => {
    const { label, close } = await startServe(
      "127.0.0.1:0",
      async () => ({ ok: true, data: { alive: true } }),
      { token: "secret", timeoutMs: 40 },
    );
    try {
      await new Promise((r) => setTimeout(r, 80));
      const { callServe } = await import("../dist/index.js");
      const reply = await callServe(label, { op: "ping" }, 2_000, "secret");
      assert.deepEqual(reply, { ok: true, data: { alive: true } });
    } finally {
      await close();
    }
  });

  test("verification receives only the remaining overall startup budget", async () => {
    let reads = 0;
    let granted;
    const handle = await startServe(`${SELF_V4}:9419`, async () => ({ ok: true, data: {} }), {
      token: "secret",
      timeoutMs: 100,
      // Time passes between creating the outer startup deadline and entering
      // the nested verifier; both operations use the same clock.
      now: () => (++reads === 1 ? 1000 : 1090),
      tailscaleStatus: async (input) => {
        granted = input.timeoutMs;
        return {
          code: 0,
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { TailscaleIPs: [SELF_V4] },
            TailscaleIPs: [SELF_V4],
          }),
          stderr: "",
        };
      },
      networkInterfaces: ownedIfaces(),
      createServer: recordingServer([]),
    });
    await handle.close();
    assert.ok(granted > 0 && granted <= 10, `CLI received ${granted}ms with only 10ms remaining in startup`);
  });

  test("synchronous listen failure clears startup watchers and closes owned resources", async () => {
    const ac = new AbortController();
    let closes = 0;
    let observed;
    try {
      await startServe("127.0.0.1:9419", async () => ({ ok: true, data: {} }), {
        token: "secret",
        signal: ac.signal,
        timeoutMs: 10_000,
        createServer: () => {
          const server = new EventEmitter();
          server.listen = () => {
            throw new Error("sync-listen failure");
          };
          server.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 9419 });
          server.close = (cb) => {
            closes += 1;
            queueMicrotask(() => cb?.());
            return server;
          };
          return server;
        },
      });
    } catch (error) {
      observed = error;
    }
    const { getEventListeners } = await import("node:events");
    const listenersAtFailure = getEventListeners(ac.signal, "abort").length;
    const closesAtFailure = closes;
    ac.abort();
    assert.match(observed?.message ?? "", /sync-listen failure/);
    assert.equal(listenersAtFailure, 0, "abort watcher survived an already-rejected startup");
    assert.ok(closesAtFailure >= 1, "owned listener was not closed on synchronous failure");
  });
}

function isStandaloneServeBindEntry() {
  const self = fileURLToPath(import.meta.url).replaceAll("\\", "/");
  return process.argv.some(
    (arg) =>
      arg.replaceAll("\\", "/").endsWith("tests/serve-bind.mjs") ||
      arg.replaceAll("\\", "/") === self,
  );
}

if (isStandaloneServeBindEntry()) registerServeBindTests();
