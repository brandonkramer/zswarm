import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classify,
  createStateStore,
  createZellijClient,
  diffScreens,
  dispatchZswarm,
  lastLine,
  selectTargets,
} from "../dist/index.js";

let stateSeq = 0;
/** Store in a throwaway directory so tests never touch the real one. */
function tempState() {
  const dir = join(tmpdir(), `zswarm-test-${process.pid}-${stateSeq++}`);
  const store = createStateStore({ dir, env: {} });
  store.reset();
  return store;
}

const PANES = [
  {
    id: 1,
    is_plugin: false,
    is_focused: true,
    title: "builder",
    exited: false,
    is_floating: false,
    tab_id: 0,
    tab_name: "crew",
    pane_command: "claude.exe",
  },
  {
    id: 2,
    is_plugin: false,
    is_focused: false,
    title: "reviewer",
    exited: false,
    is_floating: false,
    tab_id: 0,
    tab_name: "crew",
    pane_command: "codex.exe",
  },
  {
    id: 3,
    is_plugin: false,
    is_focused: false,
    title: "dead",
    exited: true,
    is_floating: false,
    tab_id: 1,
    tab_name: "other",
    pane_command: "bash",
  },
  {
    id: 0,
    is_plugin: true,
    is_focused: false,
    title: "hub",
    exited: false,
    is_floating: false,
    tab_id: 0,
    tab_name: "crew",
  },
];

/** `screens` is consumed per dump call; the last entry repeats. */
function harness({ env = {}, screens = ["idle"], panes = PANES } = {}) {
  const calls = [];
  let dumps = 0;
  const client = createZellijClient({
    env,
    exec: async (args) => {
      calls.push(args);
      if (args.includes("list-sessions")) {
        return { code: 0, stdout: "demo\n", stderr: "" };
      }
      if (args.includes("list-panes")) {
        return { code: 0, stdout: JSON.stringify(panes), stderr: "" };
      }
      if (args.includes("dump-screen")) {
        const idx = Math.min(dumps++, screens.length - 1);
        return { code: 0, stdout: screens[idx], stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return {
    client,
    calls,
    pastes: () => calls.filter((a) => a.includes("paste")),
  };
}

function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test("selectTargets resolves lists, tabs, and all — minus what it must skip", () => {
  const { client } = harness();
  const panes = [
    { id: "terminal_1", numericId: 1, isPlugin: false, title: "builder", command: "claude.exe", tabName: "crew", focused: true, exited: false, floating: false },
    { id: "terminal_2", numericId: 2, isPlugin: false, title: "reviewer", command: "codex.exe", tabName: "crew", focused: false, exited: false, floating: false },
    { id: "terminal_3", numericId: 3, isPlugin: false, title: "dead", command: "bash", tabName: "other", focused: false, exited: true, floating: false },
    { id: "plugin_0", numericId: 0, isPlugin: true, title: "hub", tabName: "crew", focused: false, exited: false, floating: false },
  ];

  const byList = selectTargets(client, panes, { to: "1, reviewer" });
  assert.deepEqual(byList.targets.map((p) => p.id), ["terminal_1", "terminal_2"]);

  const byTab = selectTargets(client, panes, { tab: "crew" });
  assert.deepEqual(byTab.targets.map((p) => p.id), ["terminal_1", "terminal_2"]);
  assert.deepEqual(byTab.skipped, [{ id: "plugin_0", reason: "pane_is_plugin" }]);

  const all = selectTargets(client, panes, { all: true });
  assert.deepEqual(all.targets.map((p) => p.id), ["terminal_1", "terminal_2"]);
  assert.ok(all.skipped.some((s) => s.reason === "pane_exited"));

  const grouped = selectTargets(client, panes, { all: true, group: "codex" });
  assert.deepEqual(grouped.targets.map((p) => p.id), ["terminal_2"]);

  const unknown = selectTargets(client, panes, { to: "nope" });
  assert.deepEqual(unknown.targets, []);
  assert.deepEqual(unknown.skipped, [{ id: "nope", reason: "peer_not_found" }]);

  // Duplicates in the list collapse to one delivery.
  const dupes = selectTargets(client, panes, { to: "1,terminal_1,builder" });
  assert.equal(dupes.targets.length, 1);
});

test("broadcast delivers to every target and logs each one", async () => {
  const { client, pastes } = harness();
  const state = tempState();
  const res = await dispatchZswarm(
    { op: "broadcast", tab: "crew", body: "stand up", from: "lead" },
    client,
    { state, now: () => 5_000 },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.delivered, ["terminal_1", "terminal_2"]);
  assert.deepEqual(res.data.failed, []);
  assert.equal(pastes().length, 2);
  assert.ok(pastes()[0].some((a) => String(a).includes("[zswarm from=lead]")));

  const log = state.readLog();
  assert.equal(log.length, 2);
  assert.deepEqual(
    log.map((e) => [e.op, e.to, e.ok]),
    [
      ["broadcast", "terminal_1", true],
      ["broadcast", "terminal_2", true],
    ],
  );
  state.reset();
});

test("broadcast skips the caller's own pane and refuses an empty selection", async () => {
  const { client, pastes } = harness({ env: { ZELLIJ_PANE_ID: "1" } });
  const state = tempState();
  const res = await dispatchZswarm(
    { op: "broadcast", all: true, body: "ping" },
    client,
    { state },
  );
  assert.deepEqual(res.data.delivered, ["terminal_2"]);
  assert.ok(res.data.skipped.some((s) => s.reason === "self_target"));
  assert.equal(pastes().length, 1);

  const empty = await dispatchZswarm(
    { op: "broadcast", tab: "nowhere", body: "ping" },
    client,
    { state },
  );
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, "no_targets");
  state.reset();
});

test("broadcast reports a pane that failed without failing the whole call", async () => {
  const calls = [];
  const client = createZellijClient({
    env: {},
    exec: async (args) => {
      calls.push(args);
      if (args.includes("list-sessions")) return { code: 0, stdout: "demo\n", stderr: "" };
      if (args.includes("list-panes")) {
        return { code: 0, stdout: JSON.stringify(PANES), stderr: "" };
      }
      if (args.includes("paste") && args.includes("terminal_2")) {
        return { code: 1, stdout: "", stderr: "pane went away" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const state = tempState();
  const res = await dispatchZswarm(
    { op: "broadcast", tab: "crew", body: "ping" },
    client,
    { state },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.delivered, ["terminal_1"]);
  assert.equal(res.data.failed[0].to, "terminal_2");
  assert.equal(res.data.failed[0].error.code, "zellij_failed");
  assert.equal(state.readLog().filter((e) => !e.ok).length, 1);
  state.reset();
});

test("signal and await rendezvous across calls", async () => {
  const { client } = harness();
  const state = tempState();
  const clock = fakeClock();

  const posted = await dispatchZswarm(
    { op: "signal", channel: "build", payload: "green" },
    client,
    { state, ...clock },
  );
  assert.equal(posted.data.count, 1);

  const ready = await dispatchZswarm(
    { op: "await", channel: "build" },
    client,
    { state, ...clock },
  );
  assert.equal(ready.data.reason, "signalled");
  assert.equal(ready.data.waitedMs, 0);
  assert.equal(ready.data.last, "green");

  // A barrier of two is not satisfied by one post.
  const short = await dispatchZswarm(
    { op: "await", channel: "build", count: 2, pollMs: 100, timeoutMs: 1000 },
    client,
    { state, ...clock },
  );
  assert.equal(short.data.reason, "timeout");
  assert.equal(short.data.count, 1);

  await dispatchZswarm({ op: "signal", channel: "build" }, client, {
    state,
    ...clock,
  });
  const both = await dispatchZswarm(
    { op: "await", channel: "build", count: 2 },
    client,
    { state, ...clock },
  );
  assert.equal(both.data.reason, "signalled");
  assert.equal(both.data.count, 2);

  const listed = await dispatchZswarm({ op: "signals" }, client, { state });
  assert.deepEqual(listed.data.channels.map((c) => [c.channel, c.count]), [
    ["build", 2],
  ]);

  await dispatchZswarm({ op: "signal", channel: "build", clear: true }, client, {
    state,
    ...clock,
  });
  const cleared = await dispatchZswarm({ op: "signals" }, client, { state });
  assert.deepEqual(cleared.data.channels, []);

  const noChannel = await dispatchZswarm({ op: "await" }, client, { state });
  assert.equal(noChannel.error.code, "missing_channel");
  state.reset();
});

test("await unblocks once a concurrent post lands", async () => {
  const { client } = harness();
  const state = tempState();
  let t = 0;
  const clock = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      // A peer signals while we are sleeping.
      if (t >= 1000) state.postSignal("deploy", "done", t);
    },
  };
  const res = await dispatchZswarm(
    { op: "await", channel: "deploy", pollMs: 500, timeoutMs: 10_000 },
    client,
    { state, ...clock },
  );
  assert.equal(res.data.reason, "signalled");
  assert.equal(res.data.waitedMs, 1000);
  state.reset();
});

test("diffScreens returns only what is new", () => {
  assert.deepEqual(diffScreens(null, "a\nb"), { text: "a\nb", reset: true });
  assert.deepEqual(diffScreens("a\nb", "a\nb"), { text: "", reset: false });
  assert.deepEqual(diffScreens("a\nb", "a\nb\nc"), { text: "\nc", reset: false });
  // Scrolled: the old bottom is the new top.
  assert.deepEqual(diffScreens("a\nb\nc", "b\nc\nd"), { text: "d", reset: false });
  // Redrawn from scratch.
  assert.deepEqual(diffScreens("a\nb\nc", "x\ny"), { text: "x\ny", reset: true });
});

test("tail returns fresh output only, and reset rewinds it", async () => {
  const { client } = harness({
    screens: ["line one\nline two", "line one\nline two\nline three"],
  });
  const state = tempState();

  const first = await dispatchZswarm({ op: "tail", to: "1" }, client, { state });
  assert.equal(first.data.reset, true);
  assert.equal(first.data.text, "line one\nline two");

  const second = await dispatchZswarm({ op: "tail", to: "1" }, client, { state });
  assert.equal(second.data.reset, false);
  assert.equal(second.data.fresh, true);
  assert.equal(second.data.text, "\nline three");

  const third = await dispatchZswarm({ op: "tail", to: "1" }, client, { state });
  assert.equal(third.data.fresh, false);
  assert.equal(third.data.text, "");

  const rewound = await dispatchZswarm(
    { op: "tail", to: "1", reset: true },
    client,
    { state },
  );
  assert.equal(rewound.data.reset, true);
  assert.match(rewound.data.text, /line three/);
  state.reset();
});

test("tail keeps a separate cursor per pane", async () => {
  const { client } = harness({ screens: ["shared"] });
  const state = tempState();
  await dispatchZswarm({ op: "tail", to: "1" }, client, { state });
  const other = await dispatchZswarm({ op: "tail", to: "2" }, client, { state });
  assert.equal(other.data.reset, true, "pane 2 has its own cursor");
  state.reset();
});

test("classify separates busy, waiting, idle, and exited", () => {
  assert.equal(classify({ exited: true, before: "x", after: "x" }), "exited");
  assert.equal(classify({ exited: false, before: "a", after: "b" }), "busy");
  assert.equal(
    classify({ exited: false, before: "Overwrite? (y/n)", after: "Overwrite? (y/n)" }),
    "waiting",
  );
  assert.equal(
    classify({ exited: false, before: "D:\\repo>", after: "D:\\repo>" }),
    "idle",
  );
  assert.equal(lastLine("a\nb\n\n  \n"), "b");
});

test("status reports who is free", async () => {
  // terminal_1 changes between samples, terminal_2 does not.
  const screens = ["work 1", "still", "work 2", "still"];
  let i = 0;
  const client = createZellijClient({
    env: {},
    exec: async (args) => {
      if (args.includes("list-sessions")) return { code: 0, stdout: "demo\n", stderr: "" };
      if (args.includes("list-panes")) {
        return { code: 0, stdout: JSON.stringify(PANES), stderr: "" };
      }
      if (args.includes("dump-screen")) {
        return { code: 0, stdout: screens[i++] ?? "still", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const res = await dispatchZswarm({ op: "status" }, client, fakeClock());
  assert.equal(res.ok, true);
  const byId = Object.fromEntries(res.data.peers.map((p) => [p.id, p.state]));
  assert.equal(byId.terminal_1, "busy");
  assert.equal(byId.terminal_2, "idle");
  assert.equal(byId.terminal_3, "exited");
  assert.deepEqual(res.data.free, ["terminal_2"]);
});

test("log reads back deliveries and filters them", async () => {
  const { client } = harness();
  const state = tempState();
  await dispatchZswarm({ op: "send", to: "1", body: "one" }, client, {
    state,
    now: () => 100,
  });
  await dispatchZswarm({ op: "send", to: "2", body: "two" }, client, {
    state,
    now: () => 200,
  });
  await dispatchZswarm({ op: "keys", to: "1", keys: ["Esc"] }, client, {
    state,
    now: () => 300,
  });

  const all = await dispatchZswarm({ op: "log" }, client, { state });
  assert.equal(all.data.entries.length, 3);
  assert.deepEqual(all.data.entries.map((e) => e.op), ["send", "send", "keys"]);
  assert.equal(all.data.entries[0].bytes, 3);

  const one = await dispatchZswarm({ op: "log", to: "terminal_1" }, client, {
    state,
  });
  assert.equal(one.data.entries.length, 2);

  const recent = await dispatchZswarm({ op: "log", since: "200" }, client, {
    state,
  });
  assert.equal(recent.data.entries.length, 2);

  const limited = await dispatchZswarm({ op: "log", limit: 1 }, client, { state });
  assert.deepEqual(limited.data.entries.map((e) => e.op), ["keys"]);

  const failed = await dispatchZswarm({ op: "log", failed: true }, client, {
    state,
  });
  assert.equal(failed.data.entries.length, 0);
  state.reset();
});

test("ZSWARM_LOG=0 turns the log off without breaking sends", async () => {
  const { client, pastes } = harness();
  const dir = join(tmpdir(), `zswarm-test-off-${process.pid}`);
  const state = createStateStore({ dir, env: { ZSWARM_LOG: "0" } });
  const res = await dispatchZswarm({ op: "send", to: "1", body: "quiet" }, client, {
    state,
  });
  assert.equal(res.ok, true);
  assert.equal(pastes().length, 1);
  assert.deepEqual(state.readLog(), []);
  state.reset();
});
