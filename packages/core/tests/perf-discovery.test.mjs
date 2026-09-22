process.env.ZSWARM_BUS = "0";
process.env.ZSWARM_LOG = "0";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeFixture } from "../test-support/node-fixture.mjs";
import {
  createSshExec,
  ipcDiscoveryCacheKey,
  ipcDiscoveryCacheSize,
  ipcDiscoveryProbes,
  peekIpcDiscoveryCache,
  resetIpcDiscoveryCache,
  setIpcDiscoveryCacheLimit,
  setIpcDiscoveryTtlMs,
  sshIpcContextKey,
} from "../dist/exec.js";
import {
  unixDiscoverRemote,
  windowsDiscoverRemote,
} from "../dist/zellij/ipc.js";
import {
  ensureZellijCapabilities,
  ensureZellijIdentity,
  ensureZellijProbes,
  identityCacheKey,
  resetZellijIdentityCache,
} from "../dist/zellij/binary.js";

const WIN_SERVER = String.raw`C:\IpcTemp\zellij\contract_version_1\crew`;
const WIN_TMP = String.raw`C:\IpcTemp`;
const UNIX_DISCOVER = unixDiscoverRemote();
const WIN_DISCOVER = windowsDiscoverRemote();

const zellijOk = () => ({ code: 0, stdout: "zellij 0.45.1\n", stderr: "" });
const helpOk = () => ({
  code: 0,
  stdout: "list-sessions\n--no-formatting\n--help\n",
  stderr: "",
});

function windowsAutoTarget(ssh, extra = {}) {
  return {
    ssh,
    host: extra.host ?? "win@host",
    remoteBin: extra.remoteBin ?? "zellij.exe",
    options: extra.options ?? [],
    tmp: extra.tmp ?? "auto",
    mode: extra.mode ?? "ssh",
    remoteShell: extra.remoteShell,
  };
}

function discoverSource({ delayMs = 0, listing = `zellij.exe --server ${WIN_SERVER}` } = {}) {
  return `
const cmd = process.argv.at(-1);
const discover = cmd.includes("powershell.exe") || cmd === ${JSON.stringify(UNIX_DISCOVER)};
if (discover) {
  const wait = Number(process.env.DISCOVER_DELAY_MS || ${delayMs});
  if (wait) await new Promise((r) => setTimeout(r, wait));
  if (process.env.DISCOVER_FAIL === "1") {
    process.stderr.write("process discovery unavailable");
    process.exitCode = 1;
  } else {
    console.log(${JSON.stringify(listing)});
  }
} else {
  console.log("crew [Created 1h ago]");
}
`;
}

describe("perf discovery", { concurrency: 1 }, () => {
  test("known Windows paths skip the Unix ps fallback", () => {
    assert.deepEqual(
      ipcDiscoveryProbes(windowsAutoTarget("ssh")),
      [WIN_DISCOVER],
    );
    assert.deepEqual(
      ipcDiscoveryProbes(
        windowsAutoTarget("ssh", { remoteBin: "zellij", remoteShell: "cmd" }),
      ),
      [WIN_DISCOVER],
    );
    assert.deepEqual(
      ipcDiscoveryProbes(
        windowsAutoTarget("ssh", { remoteBin: "zellij", mode: "interactive" }),
      ),
      [WIN_DISCOVER],
    );
    assert.deepEqual(
      ipcDiscoveryProbes(
        windowsAutoTarget("ssh", { remoteBin: "zellij.exe", remoteShell: "sh" }),
      ),
      [UNIX_DISCOVER],
    );
    assert.deepEqual(
      ipcDiscoveryProbes({
        ssh: "ssh",
        host: "box",
        remoteBin: "zellij",
        options: [],
        tmp: "auto",
        mode: "ssh",
      }),
      [UNIX_DISCOVER, WIN_DISCOVER],
    );
  });

  test("IPC cache keys isolate host, ssh bin, options, shell, mode, tmp, user", () => {
    const base = windowsAutoTarget("ssh");
    const key = ipcDiscoveryCacheKey(base, { USER: "alice", HOME: "/a" });
    assert.notEqual(
      key,
      ipcDiscoveryCacheKey({ ...base, host: "other" }, { USER: "alice", HOME: "/a" }),
    );
    assert.notEqual(
      key,
      ipcDiscoveryCacheKey({ ...base, ssh: "/usr/bin/ssh" }, { USER: "alice", HOME: "/a" }),
    );
    assert.notEqual(
      key,
      ipcDiscoveryCacheKey({ ...base, options: ["-p", "22"] }, { USER: "alice", HOME: "/a" }),
    );
    assert.notEqual(
      key,
      ipcDiscoveryCacheKey({ ...base, remoteShell: "cmd" }, { USER: "alice", HOME: "/a" }),
    );
    assert.notEqual(
      key,
      ipcDiscoveryCacheKey({ ...base, mode: "interactive" }, { USER: "alice", HOME: "/a" }),
    );
    assert.notEqual(
      key,
      ipcDiscoveryCacheKey({ ...base, tmp: "C:\\\\Other" }, { USER: "alice", HOME: "/a" }),
    );
    assert.notEqual(
      key,
      ipcDiscoveryCacheKey(base, { USER: "bob", HOME: "/a" }),
    );
    assert.notEqual(
      key,
      ipcDiscoveryCacheKey(base, { USER: "alice", USERPROFILE: "C:\\\\Users\\\\alice" }),
    );
    assert.notEqual(
      sshIpcContextKey(base, { USER: "alice" }, { tmp: WIN_TMP, socketDir: String.raw`C:\IpcTemp\zellij` }),
      sshIpcContextKey(base, { USER: "alice" }),
    );
    assert.notEqual(
      sshIpcContextKey(base, { USER: "alice" }, { tmp: WIN_TMP, socketDir: "a" }),
      sshIpcContextKey(base, { USER: "alice" }, { tmp: WIN_TMP, socketDir: "b" }),
    );
    const routed = { USER: "alice", HOME: "/a", PATH: "/bin", SSH_AUTH_SOCK: "/tmp/s" };
    assert.notEqual(
      ipcDiscoveryCacheKey(base, routed),
      ipcDiscoveryCacheKey(base, { ...routed, SSH_AUTH_SOCK: "/tmp/other" }),
    );
    assert.notEqual(
      ipcDiscoveryCacheKey(base, routed),
      ipcDiscoveryCacheKey(base, { ...routed, PATH: "/usr/bin" }),
    );
    assert.notEqual(
      ipcDiscoveryCacheKey(base, routed),
      ipcDiscoveryCacheKey(base, { ...routed, USERDOMAIN: "CORP" }),
    );
    assert.notEqual(
      ipcDiscoveryCacheKey(base, routed),
      ipcDiscoveryCacheKey(base, { ...routed, XDG_CONFIG_HOME: "/cfg" }),
    );
  });

  test("Windows auto discovery is one probe and reuses a positive hit across execs", async (t) => {
    resetIpcDiscoveryCache();
    const fixture = nodeFixture(t, discoverSource());
    const target = windowsAutoTarget(fixture.binary);
    const env = { USER: "alice" };
    const first = createSshExec(target, env);
    const result = await first(["list-sessions"], { timeoutMs: 2000 });
    assert.equal(result.code, 0);
    assert.equal(first.ipcState.status, "resolved");
    assert.equal(first.ipcState.tmp, WIN_TMP);
    const discoverCalls = fixture.launches.filter((launch) =>
      launch.args.at(-1)?.includes("powershell.exe"),
    );
    assert.equal(discoverCalls.length, 1, "known Windows must not also run ps");
    const afterFirst = fixture.launches.length;

    const second = createSshExec(target, env);
    assert.equal(second.ipcState.status, "resolved", "warm cache seeds ipcState at construct");
    assert.equal(second.ipcState.tmp, WIN_TMP);
    assert.equal(second.ipcState.socketDir, String.raw`C:\IpcTemp\zellij`);
    assert.equal(
      sshIpcContextKey(target, env, second.ipcState),
      sshIpcContextKey(target, env, first.ipcState),
    );
    const reused = await second(["list-sessions"], { timeoutMs: 2000 });
    assert.equal(reused.code, 0);
    assert.equal(second.ipcState.status, "resolved");
    assert.equal(second.ipcState.tmp, WIN_TMP);
    assert.equal(fixture.launches.length, afterFirst + 1, "cache hit skips discovery");
    assert.deepEqual(peekIpcDiscoveryCache(ipcDiscoveryCacheKey(target, env)), {
      tmp: WIN_TMP,
      socketDir: String.raw`C:\IpcTemp\zellij`,
    });
  });

  test("failed auto IPC is not cached for the next exec", async (t) => {
    resetIpcDiscoveryCache();
    const fixture = nodeFixture(t, discoverSource());
    const target = windowsAutoTarget(fixture.binary, { host: "fail-host" });
    const failed = createSshExec(target, { USER: "alice", DISCOVER_FAIL: "1" });
    await failed(["list-sessions"], { timeoutMs: 2000 });
    assert.equal(failed.ipcState.status, "failed");
    assert.equal(peekIpcDiscoveryCache(ipcDiscoveryCacheKey(target, { USER: "alice" })), undefined);

    const retry = createSshExec(target, { USER: "alice" });
    await retry(["list-sessions"], { timeoutMs: 2000 });
    assert.equal(retry.ipcState.status, "resolved");
    assert.equal(failed.ipcState.status, "failed", "a sibling success must not hide this caller's failure");
    assert.equal(
      fixture.launches.filter((launch) => launch.args.at(-1)?.includes("powershell.exe")).length,
      2,
    );
  });

  test("cancelled auto IPC is not cached and does not poison the next caller", async (t) => {
    resetIpcDiscoveryCache();
    const fixture = nodeFixture(t, discoverSource({ delayMs: 5_000 }));
    const target = windowsAutoTarget(fixture.binary, { host: "cancel-host" });
    const env = { USER: "alice" };
    const ac = new AbortController();
    const first = createSshExec(target, env);
    const pending = first(["list-sessions"], { timeoutMs: 5000, signal: ac.signal });
    await delay(30);
    ac.abort();
    const cancelled = await pending;
    assert.equal(cancelled.code, -1);
    assert.equal(first.ipcState.status, "cancelled");
    assert.equal(peekIpcDiscoveryCache(ipcDiscoveryCacheKey(target, env)), undefined);

    const second = createSshExec(target, { USER: "alice", DISCOVER_DELAY_MS: "0" });
    await second(["list-sessions"], { timeoutMs: 2000 });
    assert.equal(second.ipcState.status, "resolved");
    assert.equal(first.ipcState.status, "cancelled", "a sibling success must not hide cancellation");
  });

  test("expired TTL forces a fresh probe; failed/expired hits stay out of the map", async (t) => {
    resetIpcDiscoveryCache();
    setIpcDiscoveryTtlMs(800);
    const fixture = nodeFixture(t, discoverSource());
    const target = windowsAutoTarget(fixture.binary, { host: "ttl-host" });
    const env = { USER: "alice" };
    const first = createSshExec(target, env);
    await first(["list-sessions"], { timeoutMs: 2000 });
    assert.equal(first.ipcState.status, "resolved");
    await delay(900);
    assert.equal(peekIpcDiscoveryCache(ipcDiscoveryCacheKey(target, env)), undefined);
    assert.equal(first.ipcState.status, "none", "TTL drops resolved dirs on a long-lived exec");
    assert.equal(first.ipcState.tmp, undefined);
    setIpcDiscoveryTtlMs(5_000);
    const second = createSshExec(target, env);
    assert.equal(second.ipcState.status, "none");
    await second(["list-sessions"], { timeoutMs: 2000 });
    assert.equal(second.ipcState.status, "resolved");
    assert.equal(
      fixture.launches.filter((launch) => launch.args.at(-1)?.includes("powershell.exe")).length,
      2,
    );
  });

  test("pre-cancelled and zero-budget discovery retain their own diagnostics", async (t) => {
    resetIpcDiscoveryCache();
    const fixture = nodeFixture(t, discoverSource());
    const target = windowsAutoTarget(fixture.binary, { host: "early-failure" });
    const cancelled = createSshExec(target, {});
    const expired = createSshExec(target, {});
    await cancelled.prepareIpc(2000, AbortSignal.abort());
    await expired.prepareIpc(0);
    assert.equal(fixture.launches.length, 0);
    await createSshExec(target, {}).prepareIpc(2000);
    assert.equal(cancelled.ipcState.status, "cancelled");
    assert.equal(expired.ipcState.status, "expired");
  });

  test("in-flight discovery is not shared across independent budgets", async (t) => {
    resetIpcDiscoveryCache();
    const fixture = nodeFixture(t, discoverSource({ delayMs: 400 }));
    const target = windowsAutoTarget(fixture.binary, { host: "budget-host" });
    const env = { USER: "alice" };
    const slow = createSshExec(target, env);
    const tight = createSshExec(target, env);
    const started = Date.now();
    const slowP = slow(["list-sessions"], { timeoutMs: 5000 });
    await delay(20);
    const tightResult = await tight(["list-sessions"], { timeoutMs: 80 });
    const tightElapsed = Date.now() - started;
    assert.ok(tightElapsed < 250, `tight caller waited ${tightElapsed}ms`);
    assert.equal(tightResult.code, -1);
    assert.ok(
      tight.ipcState.status === "expired" || tight.ipcState.status === "failed",
      tight.ipcState.status,
    );
    assert.equal(peekIpcDiscoveryCache(ipcDiscoveryCacheKey(target, env)), undefined);
    const slowResult = await slowP;
    assert.equal(slowResult.code, 0);
    assert.equal(slow.ipcState.status, "resolved");
  });

  test("identity and capability probes overlap under one remaining budget", async () => {
    resetZellijIdentityCache();
    let inflight = 0;
    let maxInflight = 0;
    const exec = async (args) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await delay(40);
      inflight -= 1;
      return args.includes("--version") ? zellijOk() : helpOk();
    };
    const result = await ensureZellijProbes(exec, "zellij", 1000, "parallel-key");
    assert.deepEqual(result, { identity: true, capabilities: true });
    assert.equal(maxInflight, 2);
    // Cached positives do not re-enter the transport.
    let later = 0;
    const cached = async () => {
      later += 1;
      return zellijOk();
    };
    await ensureZellijProbes(cached, "zellij", 1000, "parallel-key");
    assert.equal(later, 0);
  });

  test("parallel probes still throw on a zswarm binary and do not cache it", async () => {
    resetZellijIdentityCache();
    const exec = async () => ({
      code: 0,
      stdout: "usage: zswarm <op>\nunknown arg: --version\n",
      stderr: "",
    });
    await assert.rejects(
      () => ensureZellijProbes(exec, "zellij", 1000, "wrong-bin"),
      /resolved binary is zswarm/,
    );
    let calls = 0;
    const retry = async (args) => {
      calls += 1;
      return args.includes("--version") ? zellijOk() : helpOk();
    };
    const result = await ensureZellijProbes(retry, "zellij", 1000, "wrong-bin");
    assert.deepEqual(result, { identity: true, capabilities: true });
    assert.equal(calls, 2);
  });

  test("identity/capability in-flight work does not inherit another caller's budget", async () => {
    resetZellijIdentityCache();
    const exec = async (_args, opts) => {
      await delay(Math.min(200, opts.timeoutMs + 5));
      if (opts.signal?.aborted) {
        return { code: -1, stdout: "", stderr: "cancelled" };
      }
      if (opts.timeoutMs < 150) {
        return { code: -1, stdout: "", stderr: "timed out" };
      }
      return _args.includes("--version") ? zellijOk() : helpOk();
    };
    const slow = ensureZellijIdentity(exec, "zellij", 5000, "shared-identity");
    await delay(10);
    const start = Date.now();
    const tight = await ensureZellijIdentity(exec, "zellij", 40, "shared-identity");
    assert.equal(tight, false);
    assert.ok(Date.now() - start < 150);
    assert.equal(await slow, true);
  });

  test("cancelled identity probe is not cached", async () => {
    resetZellijIdentityCache();
    const ac = new AbortController();
    const exec = async (_args, opts) => {
      ac.abort();
      await delay(5);
      if (opts.signal?.aborted) {
        return { code: -1, stdout: "", stderr: "cancelled" };
      }
      return zellijOk();
    };
    assert.equal(
      await ensureZellijIdentity(exec, "zellij", 1000, "cancel-id", ac.signal),
      false,
    );
    const ok = async () => zellijOk();
    assert.equal(await ensureZellijIdentity(ok, "zellij", 1000, "cancel-id"), true);
  });

  test("capability transport failure is not cached as success", async () => {
    resetZellijIdentityCache();
    const once = async () => ({ code: -1, stdout: "", stderr: "timed out" });
    assert.equal(
      await ensureZellijCapabilities(once, "zellij", 50, "cap-fail"),
      false,
    );
    const ok = async () => helpOk();
    assert.equal(await ensureZellijCapabilities(ok, "zellij", 1000, "cap-fail"), true);
  });

  test("positive identity is not cached when abort lands after exec", async () => {
    resetZellijIdentityCache();
    const ac = new AbortController();
    const exec = async () => {
      ac.abort();
      return zellijOk();
    };
    assert.equal(
      await ensureZellijIdentity(exec, "zellij", 1000, "abort-after", ac.signal),
      false,
    );
    const ok = async () => zellijOk();
    assert.equal(await ensureZellijIdentity(ok, "zellij", 1000, "abort-after"), true);
  });

  test("parallel probes settle both sides before rethrowing wrong-bin", async () => {
    resetZellijIdentityCache();
    let capDone = false;
    const exec = async (args) => {
      if (args.includes("--version")) {
        await delay(15);
        return { code: 0, stdout: "usage: zswarm\nunknown arg: --version\n", stderr: "" };
      }
      await delay(40);
      capDone = true;
      return helpOk();
    };
    await assert.rejects(
      () => ensureZellijProbes(exec, "zellij", 1000, "settle-both"),
      /resolved binary is zswarm/,
    );
    assert.equal(capDone, true);
  });

  test("non-zero discovery with --server in stdout is not cached", async (t) => {
    resetIpcDiscoveryCache();
    const fixture = nodeFixture(
      t,
      `
const cmd = process.argv.at(-1);
if (cmd.includes("powershell.exe")) {
  console.log(${JSON.stringify(`zellij.exe --server ${WIN_SERVER}`)});
  process.exitCode = 1;
} else {
  console.log("crew");
}
`,
    );
    const target = windowsAutoTarget(fixture.binary, { host: "nonzero-host" });
    const env = { USER: "alice" };
    const exec = createSshExec(target, env);
    await exec(["list-sessions"], { timeoutMs: 2000 });
    assert.equal(exec.ipcState.status, "failed");
    assert.equal(peekIpcDiscoveryCache(ipcDiscoveryCacheKey(target, env)), undefined);
  });

  test("prepareIpc warms the cache so the next call skips discovery", async (t) => {
    resetIpcDiscoveryCache();
    const fixture = nodeFixture(t, discoverSource());
    const target = windowsAutoTarget(fixture.binary, { host: "prepare-host" });
    const env = { USER: "alice" };
    const exec = createSshExec(target, env);
    const dirs = await exec.prepareIpc(2000);
    assert.deepEqual(dirs, { tmp: WIN_TMP, socketDir: String.raw`C:\IpcTemp\zellij` });
    assert.equal(exec.ipcState.status, "resolved");
    dirs.tmp = 'poisoned';
    exec.ipcState.tmp = 'poisoned';
    assert.equal(exec.ipcState.tmp, WIN_TMP, 'returned discovery/state objects cannot mutate the cache');
    const afterPrepare = fixture.launches.length;
    await exec(["list-sessions"], { timeoutMs: 2000 });
    assert.equal(fixture.launches.length, afterPrepare + 1);
  });

  for (const late of ['success', 'failure', 'cancel']) {
    test(`pinned discovery keeps the first positive context after a late ${late}`, async (t) => {
      resetIpcDiscoveryCache();
      const fixture = nodeFixture(t, `
        import { existsSync, openSync, closeSync } from 'node:fs';
        const cmd = process.argv.at(-1);
        if (!cmd.includes('powershell.exe')) console.log('crew');
        else {
          let first = false;
          try { closeSync(openSync(process.env.READY, 'wx')); first = true; }
          catch (err) { if (err.code !== 'EEXIST') throw err; }
          if (first) {
            while (!existsSync(process.env.RELEASE)) await new Promise(r => setTimeout(r, 5));
            console.log('zellij.exe --server C:/late/zellij/contract_version_1/crew');
            if (process.env.LATE === 'failure') process.exitCode = 1;
          } else console.log('zellij.exe --server C:/pinned/zellij/contract_version_1/crew');
        }
      `);
      const env = { READY: join(fixture.dir, 'ready'), RELEASE: join(fixture.dir, 'release'), LATE: late };
      const target = windowsAutoTarget(fixture.binary);
      const exec = createSshExec(target, env, { pinIpc: true });
      const ac = new AbortController();
      const pending = exec.prepareIpc(5000, ac.signal);
      try {
        const until = Date.now() + 3000;
        while (!existsSync(env.READY) && Date.now() < until) await delay(5);
        assert.ok(existsSync(env.READY), 'first discovery did not start');
        const pinned = await exec.prepareIpc(2000);
        assert.match(pinned.tmp, /pinned/);
        if (late === 'cancel') ac.abort();
        writeFileSync(env.RELEASE, 'release');
        assert.deepEqual(await pending, pinned);
        assert.equal(exec.ipcState.status, 'resolved');
        assert.equal(exec.ipcState.tmp, pinned.tmp);
        assert.equal(peekIpcDiscoveryCache(ipcDiscoveryCacheKey(target, env)).tmp, pinned.tmp);
        await exec(['list-sessions'], { timeoutMs: 2000 });
        assert.match(fixture.launches.at(-1).args.at(-1), /pinned/);
      } finally {
        writeFileSync(env.RELEASE, 'release');
        await pending.catch(() => {});
      }
    });
  }

  test("IPC cache evicts oldest entries at the bound", async (t) => {
    resetIpcDiscoveryCache();
    setIpcDiscoveryCacheLimit(2);
    const fixture = nodeFixture(t, discoverSource());
    const env = { USER: "alice" };
    const hosts = ["evict-a", "evict-b", "evict-c"];
    for (const host of hosts) {
      const exec = createSshExec(windowsAutoTarget(fixture.binary, { host }), env);
      await exec(["list-sessions"], { timeoutMs: 2000 });
    }
    assert.equal(ipcDiscoveryCacheSize(), 2);
    assert.equal(
      peekIpcDiscoveryCache(
        ipcDiscoveryCacheKey(windowsAutoTarget(fixture.binary, { host: "evict-a" }), env),
      ),
      undefined,
    );
    assert.ok(
      peekIpcDiscoveryCache(
        ipcDiscoveryCacheKey(windowsAutoTarget(fixture.binary, { host: "evict-c" }), env),
      ),
    );
  });
});

test("routing cache keys cannot collide on delimiters in options or paths", () => {
  const base = windowsAutoTarget("ssh");
  assert.notEqual(
    ipcDiscoveryCacheKey({ ...base, options: ["a|b"], remoteBin: "zellij" }),
    ipcDiscoveryCacheKey({ ...base, options: ["a"], remoteBin: "b|zellij" }),
  );
  assert.notEqual(
    identityCacheKey("zellij", { ...base, options: ["a|b"], ssh: "c" }),
    identityCacheKey("zellij", { ...base, options: ["a"], ssh: "b|c" }),
  );
});
