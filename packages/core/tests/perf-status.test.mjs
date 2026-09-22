import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createZellijClient, createStateStore, dispatchZswarm, resetBusCache,
  ListingCache, startServe, parseCliArgv, resolveInvocationEnv,
} from "../dist/index.js";
import { parseChangedReply } from "../dist/zellij/bus.js";
import { nodeFixture } from "../test-support/node-fixture.mjs";

const ok = (value = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const pane = { id: 1, title: "codex", pane_command: "codex", pane_cwd: "/crew", tab_name: "crew", tab_id: 7, exited: false };
const snapshot = (revision = 1) => ({
  ok: true, ready: true, paneUpdates: revision, tabUpdates: 1, tabs: ["crew"], tabIds: [7],
  panes: [{ id: "terminal_1", title: "codex", tab: 0, focused: false, exited: false, command: "codex" }],
});
function setup(t, options = {}) {
  resetBusCache(); t.after(resetBusCache);
  const dir = mkdtempSync(join(tmpdir(), "zswarm-perf-status-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = createStateStore({ dir, env: {} });
  const env = { ZSWARM_BUS: "1", ZSWARM_LOG: "0", ZSWARM_BUS_PLUGIN: fileURLToPath(import.meta.url) };
  let now = 0, seen = false, screen = "working", revision = 1;
  const calls = [], sleeps = [];
  const exec = async (args, opts) => {
    const action = args.includes("action") ? args[args.indexOf("action") + 1]
      : args.includes("pipe") ? "pipe" : args[0];
    const payload = action === "pipe" ? args.at(-1) : "";
    calls.push({ action, payload, timeoutMs: opts.timeoutMs, at: now });
    if (options.exec) {
      const custom = await options.exec(args, opts, payload);
      if (custom !== undefined) return custom;
    }
    if (action === "list-panes") return ok([pane]);
    if (action === "dump-screen") return ok(screen);
    if (action === "pipe") {
      if (payload === "status") return ok(snapshot(revision));
      const request = JSON.parse(payload);
      if (request.op === "changed") {
        if (options.missing) return ok({ ok: true, ready: true, panes: [], missing: ["terminal_1"] });
        if (options.noChanges) return ok("");
        const first = !seen; seen = true;
        return ok({ ok: true, ready: true, panes: [{ id: "terminal_1", first, changed: options.changed === true, viewport: [screen] }], missing: [] });
      }
      if (request.op === "scrollback") return ok({ ok: true, ready: true, panes: [{ id: "terminal_1", viewport: [screen], above: [], below: [] }], missing: [] });
    }
    return ok("crew\n");
  };
  const client = createZellijClient({ env: {}, exec, cache: new ListingCache(), now: () => now });
  return {
    calls, sleeps, client, env, state, setScreen: (value) => { screen = value; }, bump: () => revision++,
    run: (args = {}) => dispatchZswarm({ op: "status", session: "crew", ...args }, client, {
      env, state, now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; },
    }),
  };
}

test("ordinary bus status uses one changed observation, no dumps or sample sleep", async (t) => {
  const h = setup(t);
  const first = await h.run();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.data.observation, "bus-changes");
  assert.equal(first.data.peers[0].state, "unknown");
  assert.equal(first.data.peers[0].first, true);
  assert.deepEqual(first.data.free, []);
  const next = await h.run();
  assert.equal(next.data.peers[0].state, "idle");
  assert.deepEqual(h.calls.map((c) => c.action), ["pipe", "pipe", "pipe", "pipe"]);
  assert.deepEqual(h.sleeps, []);
});

test("a first bus prompt remains waiting, while changed screens are busy", async (t) => {
  const h = setup(t, { changed: true });
  h.setScreen("Would you like to run the following command?");
  assert.equal((await h.run()).data.peers[0].state, "waiting");
  h.setScreen("working on the task");
  assert.equal((await h.run()).data.peers[0].state, "busy");
});

test("missing bus observations stay unknown without a dump storm", async (t) => {
  const h = setup(t, { missing: true });
  const result = await h.run();
  assert.equal(result.data.peers[0].state, "unknown");
  assert.deepEqual(result.data.free, []);
  assert.deepEqual(h.calls.map((c) => c.action), ["pipe", "pipe"]);
});

test("explicit sampling retains two observations; old changed protocol falls back", async (t) => {
  const h = setup(t, { noChanges: true });
  const result = await h.run({ sampleMs: 70 });
  assert.equal(result.data.observation, "samples");
  assert.deepEqual(h.sleeps, [70]);
  assert.equal(h.calls.filter((c) => c.action === "dump-screen").length, 2);
  h.calls.length = 0; h.sleeps.length = 0;
  const fallback = await h.run();
  assert.equal(fallback.data.observation, "samples");
  assert.equal(h.calls.filter((c) => c.action === "dump-screen").length, 2);
  assert.equal(parseChangedReply(JSON.stringify(snapshot())).panes.length, 0);
});

test("bus manifest events invalidate completed direct pane listings", async (t) => {
  const h = setup(t);
  await h.client.listPanes("crew");
  await h.run({ sampleMs: 0 });
  await h.client.listPanes("crew");
  await h.client.listPanes("crew");
  assert.equal(h.calls.filter((c) => c.action === "list-panes").length, 2);
  h.bump();
  await h.run({ sampleMs: 0 });
  await h.client.listPanes("crew");
  assert.equal(h.calls.filter((c) => c.action === "list-panes").length, 3);
});

test("one failed bus scope does not disable another session", async (t) => {
  const h = setup(t, { exec: async (args) => args.includes("broken") && args.includes("pipe") ? ok("") : undefined });
  const broken = await h.run({ session: "broken", sampleMs: 0 });
  assert.equal(broken.data.source, "zellij");
  const healthy = await h.run({ sampleMs: 0 });
  assert.equal(healthy.data.source, "plugin");
});

test("bus failure backoff expires so a recovered plugin is used again", async (t) => {
  let failed = true, now = 1000;
  t.mock.method(Date, "now", () => now);
  const h = setup(t, { exec: async (args) => failed && args.includes("pipe") ? ok("") : undefined });
  assert.equal((await h.run({ sampleMs: 0 })).data.source, "zellij");
  failed = false;
  assert.equal((await h.run({ sampleMs: 0 })).data.source, "zellij");
  now += 5001;
  assert.equal((await h.run({ sampleMs: 0 })).data.source, "plugin");
});

test("verbose status overlaps independent metadata and bus discovery under one deadline", async (t) => {
  let release; const bothStarted = new Promise((resolve) => { release = resolve; });
  const starts = [];
  const h = setup(t, { exec: async (args, opts, payload) => {
    if (args.includes("list-panes") || payload === "status") {
      starts.push(args.includes("list-panes") ? "metadata" : "bus");
      if (starts.length === 2) release();
      await bothStarted;
      assert.ok(opts.timeoutMs > 0 && opts.timeoutMs <= 1000);
    }
  } });
  const result = await h.run({ verbose: true, timeoutMs: 1000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(starts.sort(), ["bus", "metadata"]);
  assert.equal(result.data.peers[0].cwd, "/crew");
  assert.equal(result.data.observation, "bus-changes");
  assert.equal(h.calls.some((c) => c.action === "dump-screen"), false);
});

test("--serve overrides inherited SSH and is consumed before forwarding", async (t) => {
  let received;
  const server = await startServe("127.0.0.1:0", async (request) => {
    received = request;
    return { ok: true, data: { session: "crew", source: "plugin" } };
  }, { token: "perf-token" });
  t.after(() => server.close());
  const env = { ZSWARM_SSH: "old-windows", ZSWARM_SERVE: "invalid:1", ZSWARM_SERVE_TOKEN: "perf-token" };
  const args = parseCliArgv(["--serve", server.label, "status", "--session", "crew", "--fresh"]);
  const result = await dispatchZswarm(args, undefined, { env });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.context.origin.transport, "--serve");
  assert.equal(received.serveAddress, undefined);
  assert.equal(received.fresh, true);
  assert.equal(env.ZSWARM_SSH, "old-windows");
  for (const flags of [{ local: true }, { ssh: "host" }]) {
    assert.throws(() => resolveInvocationEnv({ ...flags, serveAddress: server.label }, env), (err) => err.code === "usage");
  }
});

test("direct Windows SSH status exposes bus limitation and serve/tunnel guidance", async (t) => {
  const fixture = nodeFixture(t, [
    "const args = process.argv.slice(2).join(' ');",
    "if (args.includes('--version')) console.log('zellij 0.45.1');",
    "else if (args.includes('--help')) console.log('list-sessions --no-formatting');",
    "else if (args.includes('list-panes')) console.log('[]');",
  ].join("\n"));
  const result = await dispatchZswarm({ op: "status", session: "crew", sampleMs: 0 }, undefined, {
    env: { ZSWARM_SSH: "windows-host", ZSWARM_SSH_BIN: fixture.binary, ZSWARM_BUS: "1", ZSWARM_LOG: "0" },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.polling.busAvailable, false);
  assert.match(result.data.polling.reason, /remote/);
  assert.match(result.data.polling.recommendation, /serve.*SSH tunnel/);
});

test("dispatch --fresh bypasses warm listings across real clients", async (t) => {
  const fixture = nodeFixture(t, [
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) console.log('zellij 0.45.1');",
    "else if (args.includes('--help')) console.log('list-sessions --no-formatting');",
    `else if (args.includes('list-panes')) console.log(${JSON.stringify(JSON.stringify([pane]))});`,
  ].join("\n"));
  const env = { ZSWARM_BIN: fixture.binary, ZSWARM_BUS: "0", ZSWARM_LOG: "0", ZSWARM_CACHE_TTL_MS: "5000" };
  const list = (extra = {}) => dispatchZswarm({ op: "list", session: "crew", ...extra }, undefined, { env });
  assert.equal((await list()).ok, true);
  const warm = fixture.launches.length;
  assert.equal((await list()).ok, true);
  assert.equal(fixture.launches.length, warm);
  assert.equal((await list({ fresh: true })).ok, true);
  assert.equal(fixture.launches.length, warm + 1);
});
