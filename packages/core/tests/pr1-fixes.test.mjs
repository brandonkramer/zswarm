import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { nodeFixture } from "../test-support/node-fixture.mjs";
import {
  createStateStore,
  createZellijClient,
  dispatchZswarm,
  resetBusCache,
} from "../dist/index.js";
import {
  defaultExec,
  ensureZellijProbes,
  identityCacheKey,
} from "../dist/zellij/binary.js";
import { routingEnvironment } from "../dist/zellij/cache.js";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const timedOut = { code: -1, stdout: "", stderr: "timed out" };
const rows = (count) => Array.from({ length: count }, (_, index) => ({
  id: index + 1, title: `peer-${index + 1}`, is_plugin: false, exited: false,
}));
const busReply = (ready) => JSON.stringify({
  ok: true, source: "plugin", ready, paneUpdates: ready ? 1 : 0, tabUpdates: 1,
  tabs: ["work"],
  panes: ready ? rows(2).map((p) => ({
    id: `terminal_${p.id}`, title: p.title, exited: false,
    focused: false, command: null, tab: 0,
  })) : [],
});

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-pr1-fixes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Real child processes exercise identity, capability, and command timeouts. */
function binaryFixture(t, body) {
  const { dir, binary, launches } = nodeFixture(t, `
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const args = process.argv.slice(2);
const op = args.includes("--version") ? "identity"
  : args.includes("--help") ? "capabilities"
  : args.includes("pipe") ? "pipe"
  : args.includes("list-panes") ? "panes"
  : args.includes("list-sessions") ? "sessions" : "dump";
const log = new URL("./calls.jsonl", import.meta.url);
const previous = readFileSync(log, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
const seen = previous.filter((call) => call.op === op).length;
appendFileSync(log, JSON.stringify({ op, at: Date.now() }) + "\\n");
${body}
`);
  const log = join(dir, "calls.jsonl");
  writeFileSync(log, "");
  return {
    dir,
    launches,
    env: { ZSWARM_BIN: binary, ZSWARM_BUS: "0", ZSWARM_LOG: "0" },
    calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
  };
}

const standardReplies = `
if (op === "identity") console.log("zellij 0.45.1");
else if (op === "capabilities") console.log("list-sessions --no-formatting");
else if (op === "panes") console.log(${JSON.stringify(JSON.stringify(rows(2)))});
else console.log("crew");
`;

// Leave room for cold Node startup on loaded CI runners. The final stage stalls
// well past the budget; launch-time assertions below detect fresh child budgets.
// Windows process kill after execFile timeout routinely exceeds 1s of wall
// clock. Launch-budget capture vs Date.now() can also skew remaining by tens of
// ms on loaded Ubuntu when node --test files run concurrently (observed 2944ms
// timeout with 2892ms remaining, 2ms over a 50ms Unix slack). Windows CI also
// observed 5149ms wall clock for a 3000ms status budget (149ms over a 2000ms
// kill slack) on capabilities-without-sampling. A separate session-listing flake
// saw identity+capabilities cold-start consume the whole budget so list-sessions
// never started under concurrent load — those scenarios pre-warm probes outside
// the status budget so the hung stage is what shares the deadline. Status budget
// stays 3000ms (must not exceed the 5s ensureZellijProbes cap, or probe hangs
// soft-fail and later stages succeed). Product defaults unchanged. Unix launch
// slack is 200ms; Windows launch slack is 1000ms. Elapsed slack: Unix 1000ms,
// Windows 3000ms. Test-only.
const statusTimeoutMs = 3000;
const elapsedSlackMs = process.platform === "win32" ? 3000 : 1000;
const launchSlackMs = process.platform === "win32" ? 1000 : 200;
for (const scenario of [
  { name: "identity", delays: { identity: 10_000 }, session: "crew", sampleMs: 50, calls: ["identity", "capabilities"] },
  { name: "capabilities with sampling", delays: { identity: 100, capabilities: 10_000 }, session: "crew", sampleMs: 50, calls: ["identity", "capabilities"] },
  { name: "capabilities without sampling", delays: { identity: 100, capabilities: 10_000 }, session: "crew", sampleMs: 0, calls: ["identity", "capabilities"] },
  { name: "session listing", delays: { identity: 100, capabilities: 100, sessions: 10_000 }, sampleMs: 50, calls: ["identity", "capabilities", "sessions"], prewarmProbes: true },
  { name: "pane listing", delays: { identity: 100, capabilities: 100, panes: 10_000 }, session: "crew", sampleMs: 50, calls: ["identity", "capabilities", "panes"], prewarmProbes: true },
]) {
  test(`status shares its deadline through real ${scenario.name}`, async (t) => {
    const fixture = binaryFixture(t, `
await delay((${JSON.stringify(scenario.delays)})[op] ?? 0);
${standardReplies}
`);
    // Warm identity/capability caches outside the status budget so Windows CI
    // load cannot spend the whole deadline on cold Node --version/--help and
    // skip the intentional hung stage (list-sessions / list-panes).
    if (scenario.prewarmProbes) {
      const zellijPath = fixture.env.ZSWARM_BIN;
      const probeKey = JSON.stringify([
        identityCacheKey(zellijPath),
        routingEnvironment(fixture.env),
      ]);
      await ensureZellijProbes(
        defaultExec(zellijPath, fixture.env),
        zellijPath,
        15_000,
        probeKey,
      );
    }
    const statusLaunchesFrom = fixture.launches.length;
    const start = Date.now();
    const result = await dispatchZswarm({
      op: "status", session: scenario.session, sampleMs: scenario.sampleMs, timeoutMs: statusTimeoutMs,
    }, undefined, { env: fixture.env });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < statusTimeoutMs + elapsedSlackMs, `elapsed ${elapsed}ms`);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "zellij_failed", JSON.stringify(result));
    assert.match(result.error.message, /timed out/);
    const observed = fixture.calls().map((c) => c.op);
    assert.deepEqual(observed.slice(0, 2).sort(), ["capabilities", "identity"], JSON.stringify(observed));
    assert.deepEqual(observed.slice(2), scenario.calls.slice(2), JSON.stringify({ observed, error: result.error }));
    for (const call of fixture.launches.slice(statusLaunchesFrom)) {
      const remaining = statusTimeoutMs - (call.at - start);
      assert.ok(remaining > 0, "child started after the deadline");
      assert.ok(call.timeoutMs > 0 && call.timeoutMs <= remaining + launchSlackMs,
        `${call.args.join(" ")} got ${call.timeoutMs}ms with ${remaining}ms remaining`);
    }
  });
}

test("status bounds an enabled slow bus snapshot and skips polling after expiry", async (t) => {
  resetBusCache();
  t.after(resetBusCache);
  const fixture = binaryFixture(t, `
if (op === "pipe") {
  await delay(10_000);
  console.log(${JSON.stringify(busReply(true))});
} else { ${standardReplies} }
`);
  // Stay below the bus's 2500ms per-call cap so the pipe exhausts status itself.
  const timeoutMs = 2000;
  const start = Date.now();
  const result = await dispatchZswarm({
    op: "status", session: "crew", sampleMs: 50, timeoutMs,
  }, undefined, {
    env: { ...fixture.env, ZSWARM_BUS: "1", ZSWARM_BUS_PLUGIN: fixture.env.ZSWARM_BIN },
    state: createStateStore({ dir: join(fixture.dir, "state"), env: {} }),
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < timeoutMs + 1000, `elapsed ${elapsed}ms`);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "zellij_failed");
  assert.deepEqual(fixture.calls().map((c) => c.op), ["pipe"]);
});

// Advance the dispatch clock explicitly to cover every cold-bus boundary,
// including expiration between a nudge's list and rename operations.
for (const expiresAt of [null, 0, 1, 2, 3, 4, "sleep"]) {
  test(`cold bus shares the status budget (expires at ${expiresAt ?? "none"})`, async (t) => {
    resetBusCache();
    t.after(resetBusCache);
    const dir = tempDir(t);
    let now = 0;
    const calls = [];
    const sleeps = [];
    const steps = [
      { op: "pipe", time: 100, reply: busReply(false) },
      { op: "pipe", time: 100, reply: busReply(false) },
      { op: "list-panes", time: 200, reply: JSON.stringify(rows(2)) },
      { op: "rename-pane", time: 200, reply: "" },
      { op: "pipe", time: 100, reply: busReply(true) },
    ];
    const client = createZellijClient({ env: {}, exec: async (args, opts) => {
      const index = calls.length;
      const step = steps[index];
      assert.ok(step, `unexpected command: ${args.join(" ")}`);
      assert.ok(args.includes(step.op), args.join(" "));
      assert.ok(now < 1000, "command started after expiry");
      assert.ok(opts.timeoutMs > 0 && opts.timeoutMs <= 1000 - now,
        `${step.op} received ${opts.timeoutMs}ms with ${1000 - now}ms remaining`);
      calls.push(step.op);
      if (expiresAt === index) {
        now = 1000;
        return timedOut;
      }
      now += expiresAt === "sleep" ? 950 : step.time;
      return ok(step.reply);
    } });
    const result = await dispatchZswarm({
      op: "status", session: "crew", sampleMs: 0, timeoutMs: 1000,
    }, client, {
      env: { ZSWARM_BUS: "1", ZSWARM_BUS_PLUGIN: fileURLToPath(import.meta.url) },
      state: createStateStore({ dir, env: {} }),
      now: () => now,
      sleep: async (ms) => {
        assert.ok(ms > 0 && ms <= 1000 - now);
        sleeps.push(ms);
        now += ms;
      },
    });
    assert.equal(result.ok, expiresAt === null, JSON.stringify(result));
    const expectedCount = expiresAt === null ? 5 : expiresAt === "sleep" ? 1 : expiresAt + 1;
    assert.deepEqual(calls, steps.slice(0, expectedCount).map((s) => s.op));
    if (expiresAt === "sleep") assert.deepEqual(sleeps, [50]);
    if (expiresAt === null) assert.equal(result.data.source, "plugin");
    else assert.equal(result.error.code, "zellij_failed");
  });
}

for (const sinceLast of [false, true]) {
  test(`dispatch bounds bus ${sinceLast ? "changed" : "screen"} reads after snapshot`, async (t) => {
    resetBusCache();
    t.after(resetBusCache);
    let now = 0;
    const calls = [];
    const client = createZellijClient({ env: {}, exec: async (args, opts) => {
      assert.ok(now < 1000);
      assert.ok(opts.timeoutMs <= 1000 - now);
      calls.push(args.at(-1));
      if (calls.length === 1) {
        now = 400;
        return ok(busReply(true));
      }
      now = 1000;
      return timedOut;
    } });
    const result = await dispatchZswarm({
      op: "status", session: "crew", sampleMs: 50, timeoutMs: 1000, sinceLast,
    }, client, {
      env: { ZSWARM_BUS: "1", ZSWARM_BUS_PLUGIN: fileURLToPath(import.meta.url) },
      state: createStateStore({ dir: tempDir(t), env: {} }),
      now: () => now,
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.partial, true);
    assert.ok(result.data.peers.every((p) => p.state === "unknown"));
    assert.deepEqual(result.data.free, []);
    assert.equal(calls.length, 2);
    assert.match(calls[1], sinceLast ? /changed/ : /scrollback/);
  });
}

for (const probe of ["identity", "capabilities"]) {
  for (const valid of [false, true]) {
    test(`same client retries timed-out ${probe} and ${valid ? "caches verification" : "rejects invalid output"}`, async (t) => {
      const fixture = binaryFixture(t, `
if (op === ${JSON.stringify(probe)}) {
  if (seen === 0) await delay(5000);
  if (!${valid}) { console.log("unrelated executable"); process.exit(0); }
}
${standardReplies}
`);
      const client = createZellijClient({ env: fixture.env });
      await assert.rejects(client.listSessions(2000), /timed out/);
      if (valid) {
        assert.equal((await client.listSessions(5000))[0].name, "crew");
        assert.equal((await client.listSessions(5000))[0].name, "crew");
      } else {
        await assert.rejects(client.listSessions(5000), {
          code: probe === "identity" ? "zellij_wrong_bin" : "zellij_incompatible",
        });
      }
      assert.equal(fixture.calls().filter((c) => c.op === probe).length, 2);
      assert.equal(fixture.calls().filter((c) => c.op === "sessions").length, valid ? 1 : 0);
    });
  }
}

test("concurrent clients do not inherit an in-flight identity probe's deadline", async (t) => {
  const fixture = binaryFixture(t, `
if (op === "identity") await delay(1500);
${standardReplies}
`);
  const first = createZellijClient({ env: fixture.env }).listSessions(5000);
  // Observe failure immediately, including while waiting for the child to log.
  void first.catch(() => {});
  try {
    const readyDeadline = Date.now() + 3000;
    while (fixture.calls().length === 0) {
      assert.ok(Date.now() < readyDeadline, "identity fixture did not start");
      await delay(10);
    }
    const start = Date.now();
    await assert.rejects(createZellijClient({ env: fixture.env }).listSessions(150), /timed out/);
    assert.ok(Date.now() - start < 1000);
  } finally {
    assert.equal((await first)[0].name, "crew");
  }
});

for (const sampleMs of [80, 700]) {
  test(`queued panes preserve their own ${sampleMs}ms observation interval`, async () => {
    const samples = new Map();
    const client = createZellijClient({ env: {}, exec: async (args) => {
      if (args.includes("list-panes")) return ok(JSON.stringify(rows(6)));
      const id = args.find((a) => /^terminal_\d+$/.test(a));
      const times = samples.get(id) ?? [];
      times.push(Date.now());
      samples.set(id, times);
      return ok(Date.now() - times[0] >= 40 ? "working 2" : "working 1");
    } });
    const result = await dispatchZswarm({
      op: "status", session: "crew", timeoutMs: 1000, sampleMs,
    }, client, { env: { ZSWARM_BUS: "0" } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.free, []);
    for (const peer of result.data.peers) {
      const times = samples.get(peer.id);
      const expectedUnknown = sampleMs === 700 && Number(peer.id.split("_")[1]) > 3;
      assert.equal(peer.state, expectedUnknown ? "unknown" : "busy", peer.id);
      assert.equal(times.length, expectedUnknown ? 1 : 2, peer.id);
      if (!expectedUnknown) assert.ok(times[1] - times[0] >= sampleMs - 10, peer.id);
    }
    if (sampleMs === 700) assert.equal(result.data.partial, true);
  });
}

test("a slow first read cannot replace the interval between screen observations", async () => {
  const calls = [];
  let firstReturnedAt;
  const client = createZellijClient({ env: {}, exec: async (args) => {
    if (args.includes("list-panes")) return ok(JSON.stringify(rows(1)));
    calls.push(Date.now());
    if (calls.length === 1) {
      await delay(120);
      firstReturnedAt = Date.now();
      return ok("before");
    }
    return ok(Date.now() - firstReturnedAt >= 40 ? "after" : "before");
  } });
  const result = await dispatchZswarm({
    op: "status", session: "crew", timeoutMs: 1000, sampleMs: 80,
  }, client, { env: { ZSWARM_BUS: "0" } });
  assert.equal(result.ok, true);
  assert.equal(result.data.peers[0].state, "busy");
  assert.ok(calls[1] - firstReturnedAt >= 70);
});

test("conflicting routing flags return a structured dispatch usage error", async () => {
  const result = await dispatchZswarm({ op: "sessions", local: true, ssh: "host" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "usage");
  assert.match(result.error.message, /--local.*--ssh/);
});

test("CLI prints structured usage JSON for conflicting routing flags", async () => {
  // The root test command builds all packages, including CLI helper modules.
  for (const flags of [["sessions", "--local", "--ssh", "host"], ["--local", "sessions", "--ssh", "host"]]) {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../../cli/dist/cli.js", import.meta.url)), ...flags,
    ], { cwd: new URL("../../cli", import.meta.url), encoding: "utf8", timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "usage");
  }
});
