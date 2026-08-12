import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLaunchPluginArgs,
  buildPipeArgs,
  busPluginUrl,
  busSnapshot,
  busToPanes,
  createStateStore,
  createZellijClient,
  dispatchZswarm,
  nextConfigKey,
  parseBusReply,
  planBus,
  resetBusCache,
  resolveBusPlugin,
} from "../dist/index.js";

let seq = 0;
function tempState() {
  const dir = join(tmpdir(), `zswarm-bus-test-${process.pid}-${seq++}`);
  const store = createStateStore({ dir, env: {} });
  store.reset();
  return store;
}

const REPLY = JSON.stringify({
  ok: true,
  source: "plugin",
  ready: true,
  paneUpdates: 12,
  tabUpdates: 3,
  tabs: ["work", "review"],
  panes: [
    {
      id: "terminal_2",
      title: "builder",
      exited: false,
      focused: true,
      command: null,
      tab: 0,
    },
    {
      id: "terminal_5",
      title: "reviewer",
      exited: true,
      focused: false,
      command: null,
      tab: 1,
    },
    {
      id: "plugin_1",
      title: "tab-bar",
      exited: false,
      focused: false,
      command: null,
      tab: 0,
    },
  ],
});

/** A client whose pipe answers only for the listed config keys. */
function busClient(options = {}) {
  const {
    answering = ["zswarm-bus"],
    reply = REPLY,
    coldFirst = false,
    stayColdUntilRename = false,
    panesJson = "[]",
    scrollback = null,
  } = options;
  const calls = [];
  let asked = 0;
  let renamed = 0;
  const client = createZellijClient({
    env: {},
    exec: async (args) => {
      calls.push(args);
      if (args.includes("list-sessions")) {
        return { code: 0, stdout: "demo\n", stderr: "" };
      }
      if (args.includes("list-panes")) {
        return { code: 0, stdout: panesJson, stderr: "" };
      }
      if (args.includes("rename-pane")) {
        renamed += 1;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args.includes("pipe")) {
        const payload = args[args.length - 1];
        if (typeof payload === "string" && payload.includes('"scrollback"')) {
          if (!scrollback) return { code: 0, stdout: "", stderr: "" };
          const asked = JSON.parse(payload).panes;
          const panes = asked
            .filter((id) => scrollback[id])
            .map((id) => ({
              id,
              viewport: scrollback[id],
              above: [],
              below: [],
            }));
          return {
            code: 0,
            stdout: `${JSON.stringify({ ok: true, ready: true, panes, missing: [] })}\n`,
            stderr: "",
          };
        }
        const key = args[args.indexOf("--plugin-configuration") + 1];
        if (!answering.includes(key.replace("instance=", ""))) {
          // A stale instance swallows the message and says nothing.
          return { code: 0, stdout: "", stderr: "" };
        }
        asked += 1;
        if (stayColdUntilRename && renamed === 0) {
          return {
            code: 0,
            stdout: `${reply.replace('"ready":true', '"ready":false')}\n`,
            stderr: "",
          };
        }
        if (coldFirst && asked === 1) {
          return {
            code: 0,
            stdout: `${reply.replace('"ready":true', '"ready":false')}\n`,
            stderr: "",
          };
        }
        return { code: 0, stdout: `${reply}\n`, stderr: "" };
      }
      return { code: 0, stdout: "screen", stderr: "" };
    },
  });
  return { client, calls, pipes: () => calls.filter((a) => a.includes("pipe")) };
}

function installed(store, configKey = "zswarm-bus") {
  store.writeBus({ plugin: "/tmp/zswarm-bus.wasm", configKey, installedAt: 1 });
  return store;
}

const clock = { now: () => 1, sleep: async () => {} };

test("bus pipe args carry an instance key and an end-of-options marker", () => {
  assert.deepEqual(
    buildPipeArgs({
      session: "demo",
      url: "file:/x/zswarm-bus.wasm",
      configKey: "zswarm-bus",
      payload: "status",
    }),
    [
      "--session",
      "demo",
      "pipe",
      "--plugin",
      "file:/x/zswarm-bus.wasm",
      "--plugin-configuration",
      "instance=zswarm-bus",
      "--name",
      "zswarm",
      "--",
      "status",
    ],
  );
  assert.deepEqual(
    buildLaunchPluginArgs({
      session: "demo",
      url: "file:/x/zswarm-bus.wasm",
      configKey: "zswarm-bus",
      floating: true,
      skipCache: true,
    }),
    [
      "--session",
      "demo",
      "action",
      "launch-or-focus-plugin",
      "--configuration",
      "instance=zswarm-bus",
      "--floating",
      "--skip-plugin-cache",
      "file:/x/zswarm-bus.wasm",
    ],
  );
});

test("plugin urls use forward slashes and keys rotate", () => {
  assert.match(busPluginUrl("/tmp/zswarm-bus.wasm"), /^file:.*\/zswarm-bus\.wasm$/);
  assert.ok(!busPluginUrl("/tmp/zswarm-bus.wasm").includes("\\"));
  assert.equal(nextConfigKey("zswarm-bus"), "zswarm-bus-2");
  assert.equal(nextConfigKey("zswarm-bus-2"), "zswarm-bus-3");
  assert.equal(nextConfigKey("zswarm-bus-9"), "zswarm-bus-10");
});

test("parseBusReply picks the answer out of zellij's own chatter", () => {
  const noisy = [
    "Action CliPipe did not complete within 1s timeout",
    REPLY,
    "",
  ].join("\n");
  const snapshot = parseBusReply(noisy);
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.panes.length, 3);
  assert.equal(parseBusReply("no json here"), null);
  assert.equal(parseBusReply('{"ok":false}'), null);
  assert.equal(parseBusReply("{oops"), null);
});

test("busToPanes names tabs and marks plugin panes", () => {
  const panes = busToPanes(parseBusReply(REPLY));
  assert.deepEqual(
    panes.map((p) => [p.id, p.tabName, p.isPlugin, p.exited]),
    [
      ["terminal_2", "work", false, false],
      ["terminal_5", "review", false, true],
      ["plugin_1", "work", true, false],
    ],
  );
  // The manifest carries neither, so both read as unknown.
  assert.equal(panes[0].cwd, null);
  assert.equal(panes[0].command, null);
});

test("resolveBusPlugin honours an explicit path and rejects a missing one", () => {
  assert.equal(resolveBusPlugin({ ZSWARM_BUS_PLUGIN: "/nope/missing.wasm" }), null);
  const self = fileURLToPath(import.meta.url);
  assert.equal(resolveBusPlugin({ ZSWARM_BUS_PLUGIN: `"${self}"` }), self);
});

test("the bus stays off until it is installed", () => {
  resetBusCache();
  const { client } = busClient();
  const store = tempState();
  const off = planBus(client, store, { ZSWARM_BUS_PLUGIN: "/nope.wasm" });
  assert.equal(off.enabled, false);
  assert.match(off.reason, /no plugin wasm/);

  const on = planBus(client, installed(store), {});
  assert.equal(on.enabled, true);
  assert.equal(on.reason, "installed");

  const denied = planBus(client, store, { ZSWARM_BUS: "0" });
  assert.equal(denied.enabled, false);
  assert.equal(denied.reason, "ZSWARM_BUS=0");
});

test("a remote session never asks a local plugin", () => {
  resetBusCache();
  const store = installed(tempState());
  const remote = createZellijClient({
    env: { ZSWARM_SSH: "user@host" },
  });
  const plan = planBus(remote, store, {});
  assert.equal(plan.enabled, false);
  assert.match(plan.reason, /remote session/);
});

test("busSnapshot rotates past an instance that answers nothing", async () => {
  resetBusCache();
  const store = installed(tempState());
  const { client, pipes } = busClient({ answering: ["zswarm-bus-3"] });
  const result = await busSnapshot(client, store, "demo", clock, {});
  assert.equal(result.configKey, "zswarm-bus-3");
  assert.equal(result.snapshot.panes.length, 3);
  assert.equal(pipes().length, 3);
  // The winning key is remembered, so the next process starts there.
  assert.equal(store.readBus().configKey, "zswarm-bus-3");
});

test("busSnapshot asks a cold instance twice before believing it", async () => {
  resetBusCache();
  const store = installed(tempState());
  const { client, pipes } = busClient({ coldFirst: true });
  const result = await busSnapshot(client, store, "demo", clock, {});
  assert.equal(result.snapshot.ready, true);
  assert.equal(pipes().length, 2);
});

test("a quiet session nudges the bus once; a ready one never does", async () => {
  const panesJson = JSON.stringify([
    {
      id: 2,
      is_plugin: false,
      is_focused: true,
      title: "builder",
      exited: false,
      is_floating: false,
      tab_name: "work",
    },
  ]);

  resetBusCache();
  const cold = busClient({ stayColdUntilRename: true, panesJson });
  const coldResult = await busSnapshot(
    cold.client,
    installed(tempState()),
    "demo",
    clock,
    {},
  );
  assert.equal(coldResult.snapshot.ready, true);
  const renames = cold.calls.filter((a) => a.includes("rename-pane"));
  assert.equal(renames.length, 1);
  assert.equal(renames[0].at(-1), "builder");
  assert.equal(cold.pipes().length, 3);

  resetBusCache();
  const warm = busClient({ panesJson });
  const warmResult = await busSnapshot(
    warm.client,
    installed(tempState()),
    "demo",
    clock,
    {},
  );
  assert.equal(warmResult.snapshot.ready, true);
  assert.equal(warm.calls.filter((a) => a.includes("rename-pane")).length, 0);
  assert.equal(warm.pipes().length, 1);
});

test("a bus that never answers costs one round, then falls back", async () => {
  resetBusCache();
  const store = installed(tempState());
  const { client, pipes } = busClient({ answering: [] });
  assert.equal(await busSnapshot(client, store, "demo", clock, {}), null);
  assert.equal(pipes().length, 3);
  // Disabled for the rest of the process: a second call costs nothing.
  assert.equal(await busSnapshot(client, store, "demo", clock, {}), null);
  assert.equal(pipes().length, 3);
  resetBusCache();
});

test("list reads the bus and reports where the answer came from", async () => {
  resetBusCache();
  const store = installed(tempState());
  const { client } = busClient();
  const listed = await dispatchZswarm({ op: "list" }, client, {
    state: store,
    env: {},
  });
  assert.equal(listed.ok, true);
  assert.equal(listed.data.source, "plugin");
  assert.deepEqual(
    listed.data.panes.map((p) => p.id),
    ["terminal_2", "terminal_5"],
  );
  // Absent, not null: the plugin does not know the command.
  assert.deepEqual(Object.keys(listed.data.panes[0]).sort(), ["id", "tab", "title"]);
});

test("verbose list skips the bus, which has no cwd to give", async () => {
  resetBusCache();
  const store = installed(tempState());
  const panesJson = JSON.stringify([
    {
      id: 2,
      is_plugin: false,
      is_focused: true,
      title: "builder",
      exited: false,
      is_floating: false,
      tab_name: "work",
      pane_cwd: "/repo",
      pane_command: "claude",
    },
  ]);
  const { client, pipes } = busClient({ panesJson });
  const listed = await dispatchZswarm({ op: "list", verbose: true }, client, {
    state: store,
    env: {},
  });
  assert.equal(listed.data.source, "zellij");
  assert.equal(listed.data.panes[0].cwd, "/repo");
  assert.equal(pipes().length, 0);
});

test("verbose status skips the bus, which has no command to give", async () => {
  resetBusCache();
  const store = installed(tempState());
  const panesJson = JSON.stringify([
    {
      id: 2,
      is_plugin: false,
      is_focused: true,
      title: "builder",
      exited: false,
      is_floating: false,
      tab_name: "work",
      pane_cwd: "/repo",
      pane_command: "claude",
    },
  ]);
  const { client, pipes } = busClient({ panesJson });
  const status = await dispatchZswarm(
    { op: "status", sampleMs: 0, verbose: true },
    client,
    { state: store, env: {} },
  );
  assert.equal(status.data.source, "zellij");
  assert.equal(pipes().length, 0);
});

test("status with sampleMs=0 answers from the bus without dumping screens", async () => {
  resetBusCache();
  const store = installed(tempState());
  const { client, calls } = busClient();
  const status = await dispatchZswarm({ op: "status", sampleMs: 0 }, client, {
    state: store,
    env: {},
  });
  assert.equal(status.ok, true);
  assert.equal(status.data.source, "plugin");
  assert.equal(status.data.sampled, false);
  assert.deepEqual(
    status.data.peers.map((p) => [p.id, p.state]),
    [
      ["terminal_2", "running"],
      ["terminal_5", "exited"],
    ],
  );
  // No `free`: busy and idle are indistinguishable without sampling.
  assert.equal(status.data.free, undefined);
  assert.equal(calls.some((a) => a.includes("dump-screen")), false);
});

test("sampled status batches its screen reads through one pipe", async () => {
  resetBusCache();
  const store = installed(tempState());
  const screens = { terminal_2: ["hello"], terminal_5: ["world"] };
  const { client, calls } = busClient({
    scrollback: screens,
    reply: REPLY.replace('"exited":true', '"exited":false'),
  });
  const status = await dispatchZswarm({ op: "status", sampleMs: 50 }, client, {
    state: store,
    env: {},
    sleep: async () => {},
  });
  assert.equal(status.ok, true);
  assert.equal(status.data.source, "plugin");
  // Two samples, two pipes — not two dumps per pane.
  assert.equal(calls.filter((a) => a.includes("dump-screen")).length, 0);
  const scrollbacks = calls.filter((a) =>
    a.some((arg) => typeof arg === "string" && arg.includes('"scrollback"')),
  );
  assert.equal(scrollbacks.length, 2);
});

test("a partial scrollback reply falls back rather than reporting quiet panes", async () => {
  resetBusCache();
  const store = installed(tempState());
  const { client, calls } = busClient({
    // Only one of the two live panes comes back.
    scrollback: { terminal_2: ["hello"] },
    reply: REPLY.replace('"exited":true', '"exited":false'),
  });
  const status = await dispatchZswarm({ op: "status", sampleMs: 50 }, client, {
    state: store,
    env: {},
    sleep: async () => {},
  });
  assert.equal(status.ok, true);
  // Missing screens would read as "unchanged", so status polls both samples.
  assert.equal(calls.filter((a) => a.includes("dump-screen")).length, 4);
});

test("a single-pane read never goes through the bus", async () => {
  resetBusCache();
  const store = installed(tempState());
  const { client, calls } = busClient({ scrollback: { terminal_2: ["hi"] } });
  await dispatchZswarm({ op: "status", to: "builder", sampleMs: 50 }, client, {
    state: store,
    env: {},
    sleep: async () => {},
  });
  // One pane costs more over a pipe than it does as a process.
  assert.equal(
    calls.filter((a) =>
      a.some((arg) => typeof arg === "string" && arg.includes('"scrollback"')),
    ).length,
    0,
  );
});

test("bus reports itself and can be forgotten", async () => {
  resetBusCache();
  const store = installed(tempState());
  const { client } = busClient();
  const report = await dispatchZswarm({ op: "bus" }, client, {
    state: store,
    env: {},
  });
  assert.equal(report.ok, true);
  assert.equal(report.data.enabled, true);
  assert.equal(report.data.ready, true);
  assert.equal(report.data.panes, 3);

  const cleared = await dispatchZswarm({ op: "bus", clear: true }, client, {
    state: store,
    env: {},
  });
  assert.equal(cleared.data.installed, false);
  assert.equal(store.readBus(), null);
});

test("installing the bus is refused by a read-only policy", async () => {
  resetBusCache();
  const store = tempState();
  const { client } = busClient();
  const denied = await dispatchZswarm({ op: "bus", install: true }, client, {
    state: store,
    env: {},
    policy: {
      readOnly: true,
      allowPanes: null,
      denyPanes: [],
      allowSpawn: true,
      allowClose: true,
      allowWorktreeRemove: true,
    },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "policy_denied");
});
