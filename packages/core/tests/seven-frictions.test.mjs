import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createZellijClient, dispatchZswarm, busToPanes, parseBusReply,
  startServe, resolveInvocationEnv,
} from "../dist/index.js";
import { peerStatus, waitingPrompt } from "../dist/ops/status.js";
import { invocationContext } from "../dist/ops/routing.js";
import { resolveHarness } from "../dist/harness.js";
import { nodeFixture } from "../test-support/node-fixture.mjs";

const row = (id, extra = {}) => ({
  id, title: "peer-" + id, is_plugin: false, exited: false,
  is_focused: false, tab_id: 7, tab_name: "crew", pane_command: "bash", ...extra,
});
const old = row(1);
const fresh = row(9, { title: "reviewer" });

function harness(options = {}) {
  let now = 0, created = false, reads = 0, alias = null;
  const calls = [];
  const clock = { now: () => now, sleep: async (ms) => { now += ms; options.onSleep?.(); } };
  const env = { ZSWARM_BUS: "0", ZSWARM_LOG: "0" };
  const state = { readBus() { return null; }, appendLog() {}, readSignals() { return {}; } };
  const client = createZellijClient({
    env, signal: options.signal,
    exec: async (args, opts) => {
      const op = args.includes("action") ? args[args.indexOf("action") + 1] : args[0];
      calls.push({ op, args, timeoutMs: opts.timeoutMs, at: now });
      let stdout = "";
      if (op === "list-sessions") stdout = "crew\n";
      if (op === "new-pane" || op === "new-tab") {
        created = true;
        now += options.createDelay ?? 0;
        stdout = op === "new-pane" ? options.paneId ?? "terminal_9\n" : options.tabId ?? "7\n";
      }
      if (op === "list-tabs") stdout = JSON.stringify([{ position: 0, tab_id: 7, name: "crew" }]);
      if (op === "rename-pane") alias = args.at(-1);
      if (op === "list-panes") {
        const current = options.readPanes
          ? options.readPanes({ created, reads: reads++, alias, now })
          : created ? options.after ?? [old, { ...fresh, ...(alias ? { title: alias } : {}) }]
            : options.before ?? [old];
        now += options.listDelay ?? 0;
        stdout = JSON.stringify(current);
      }
      if (op === "dump-screen") {
        if (options.dumpFails) return { code: 1, stdout: "", stderr: "screen unavailable" };
        stdout = options.screen ?? "ready";
      }
      return { code: 0, stdout, stderr: "" };
    },
  });
  return {
    client, calls, clock, env,
    run: (args) => dispatchZswarm({ session: "crew", ...args }, client, { env, state, ...clock, signal: options.signal }),
  };
}

test("spawn retains creation ID and settles delayed visibility without recreating", async () => {
  const h = harness({ readPanes: ({ created, reads }) => created && reads >= 3 ? [old, fresh] : [old] });
  const result = await h.run({ op: "spawn", name: "reviewer" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.paneId, "terminal_9");
  assert.equal(result.data.observation.status, "observed");
  assert.equal(result.data.observed, true);
  assert.equal(result.data.ready, "unknown");
  assert.equal(h.calls.filter((c) => c.op === "new-pane").length, 1);
  const dumped = await h.run({ op: "dump", to: "reviewer" });
  assert.equal(dumped.ok, true);
});

test("missing created ID never falls back to an unrelated concurrent pane", async () => {
  const h = harness({ after: [old, row(27)] });
  const result = await h.run({ op: "spawn", observeMs: 200 });
  assert.equal(result.data.paneId, "terminal_9");
  assert.equal(result.data.observed, false);
  assert.equal(result.data.exited, null);
  assert.equal(result.data.observation.status, "timeout");
  assert.equal(h.calls.filter((c) => c.op === "new-pane").length, 1);
});

test("new-tab correlation never crosses the returned tab ID", async () => {
  const h = harness({ tabId: "99\n", after: [old, row(27, { tab_id: 8 })] });
  const result = await h.run({ op: "spawn", newTab: true, name: "wanted", observeMs: 200 });
  assert.equal(result.data.tabId, 99);
  assert.equal(result.data.paneId, null);
  assert.equal(result.data.observed, false);
  assert.equal(h.calls.some((c) => c.op === "rename-pane"), false);
});

test("multiple new-tab candidates remain ambiguous", async () => {
  const h = harness({ tabId: "99\n", after: [old, row(27, { tab_id: 99 }), row(28, { tab_id: 99 })] });
  const result = await h.run({ op: "spawn", newTab: true });
  assert.equal(result.data.paneId, null);
  assert.equal(result.data.observation.status, "ambiguous");
});

test("missing new-pane stdout does not guess from a global pane diff", async () => {
  const h = harness({ paneId: "", after: [old, fresh] });
  const result = await h.run({ op: "spawn" });
  assert.equal(result.data.paneId, null);
  assert.equal(result.data.observation.status, "unresolved");
});

test("creation IDs must occupy complete output lines, not diagnostic text", async () => {
  const pane = await harness({ paneId: "warning: terminal_27 was removed\nterminal_9\n" }).run({ op: "spawn" });
  assert.equal(pane.data.paneId, "terminal_9");
  const tab = await harness({ tabId: "warning: waited 1 second\n99\n", after: [row(9, { tab_id: 99 })] })
    .run({ op: "spawn", newTab: true });
  assert.equal(tab.data.tabId, 99);
  assert.equal(tab.data.paneId, "terminal_9");
  for (const tabId of ["warning: tab 7 pending\n", "7\n99\n"]) {
    const unresolved = await harness({ tabId }).run({ op: "spawn", newTab: true });
    assert.equal(unresolved.data.tabId, null);
    assert.equal(unresolved.data.paneId, null);
    assert.equal(unresolved.data.observation.status, "unresolved");
  }
});

test("new-tab does not select a lone pane from a partial multi-pane layout", async () => {
  const h = harness({
    readPanes: ({ created, reads }) => !created ? [old]
      : reads === 1 ? [row(20)] : [row(20), row(21)],
  });
  const result = await h.run({ op: "spawn", newTab: true });
  assert.equal(result.data.paneId, null);
  assert.equal(result.data.observation.status, "ambiguous");
});

test("new-tab names its terminal alias and observes it before returning", async () => {
  const h = harness({
    before: [row(1, { tab_id: 0 })],
    readPanes: ({ created, alias }) => created ? [row(9, { title: alias ?? "bash" })] : [row(1, { tab_id: 0 })],
  });
  const result = await h.run({ op: "spawn", newTab: true, name: "reviewer" });
  assert.equal(result.data.paneId, "terminal_9");
  assert.deepEqual(result.data.alias, { name: "reviewer", observed: true });
  assert.equal(h.calls.filter((c) => c.op === "rename-pane").length, 1);
  assert.equal((await h.run({ op: "dump", to: "reviewer" })).ok, true);
});

test("held exited pane is observed but neither live nor ready", async () => {
  const h = harness({ after: [old, { ...fresh, exited: true }] });
  const result = await h.run({ op: "spawn" });
  assert.equal(result.data.created, true);
  assert.equal(result.data.observed, true);
  assert.equal(result.data.exited, true);
  assert.equal(result.data.live, false);
  assert.equal(result.data.ready, false);
});

test("spawn addresses a tab explicitly with and without focused clients", async () => {
  for (const focused of [false, true]) {
    const h = harness({ before: [old, row(2, { tab_id: 8, is_focused: focused })] });
    await h.run({ op: "spawn" });
    const args = h.calls.find((c) => c.op === "new-pane").args;
    assert.equal(args[args.indexOf("--tab-id") + 1], focused ? "8" : "7");
  }
});

test("spawn setup and creation consume one deadline; expired observation does not start", async () => {
  const h = harness({ listDelay: 60, createDelay: 40 });
  const result = await h.run({ op: "spawn", timeoutMs: 100 });
  assert.equal(result.data.created, true);
  assert.equal(result.data.observed, false);
  assert.equal(h.calls.filter((c) => c.op === "list-panes").length, 1);
  const created = h.calls.find((c) => c.op === "new-pane");
  assert.ok(created.timeoutMs <= 40);
});

test("cancelled spawn settling stops without another creation", async () => {
  const abort = new AbortController();
  const h = harness({ signal: abort.signal, after: [old], onSleep: () => abort.abort() });
  const result = await h.run({ op: "spawn" });
  assert.equal(result.error.code, "cancelled");
  assert.equal(result.error.details.paneId, "terminal_9");
  assert.equal(result.error.details.created, true);
  assert.equal(h.calls.filter((c) => c.op === "new-pane").length, 1);
});

test("typed ID and alias lookup settle while preserving ambiguity errors", async () => {
  for (const to of ["terminal_9", "reviewer"]) {
    const h = harness({ readPanes: ({ reads }) => reads >= 2 ? [fresh] : [] });
    assert.equal((await h.run({ op: "dump", to })).ok, true);
  }
  const ambiguous = harness({ before: [fresh, { ...fresh, id: 10 }] });
  assert.equal((await ambiguous.run({ op: "dump", to: "reviewer" })).error.code, "peer_ambiguous");
  assert.equal(ambiguous.calls.filter((c) => c.op === "list-panes").length, 1);
});

test("zero observe budget disables lookup retries", async () => {
  const h = harness({ before: [] });
  const result = await h.run({ op: "dump", to: "terminal_9", observeMs: 0 });
  assert.equal(result.error.code, "peer_not_found");
  assert.equal(h.calls.filter((c) => c.op === "list-panes").length, 1);
});

test("an absent typed ID cannot resolve to another pane with an ID-shaped title", async () => {
  const h = harness({ before: [row(27, { title: "terminal_9" })] });
  const result = await h.run({ op: "keys", to: "terminal_9", keys: ["Enter"], observeMs: 0 });
  assert.equal(result.error.code, "peer_not_found");
  assert.equal(h.calls.some((c) => c.op === "send-keys"), false);
});

for (const input of [{ keys: ["Enter"] }, { chars: "y", enter: true }]) {
  test("keys expectation mismatch prevents every write: " + JSON.stringify(input), async () => {
    const h = harness({ before: [fresh], screen: "shell prompt" });
    const result = await h.run({ op: "keys", to: "terminal_9", expect: "Approve this operation", ...input });
    assert.equal(result.error.code, "expect_missing");
    assert.equal(h.calls.filter((c) => ["send-keys", "write-chars"].includes(c.op)).length, 0);
  });
  test("keys checks current screen then performs authorized input once: " + JSON.stringify(input), async () => {
    const h = harness({ before: [fresh], screen: "APPROVE THIS OPERATION" });
    const result = await h.run({ op: "keys", to: "terminal_9", expect: "approve this operation", ...input });
    assert.equal(result.ok, true, JSON.stringify(result));
    const actions = h.calls.map((c) => c.op);
    assert.ok(actions.indexOf("dump-screen") < actions.indexOf(input.chars ? "write-chars" : "send-keys"));
    assert.equal(actions.filter((op) => op === "send-keys").length, 1);
  });
}

test("keys still refuses exited panes even with matching expectations", async () => {
  const h = harness({ before: [{ ...fresh, exited: true }], screen: "approved" });
  assert.equal((await h.run({ op: "keys", to: "9", expect: "approved", keys: ["Enter"] })).error.code, "pane_exited");
  assert.equal(h.calls.some((c) => c.op === "send-keys"), false);
});

test("an expectation read failure prevents both keys and characters", async () => {
  for (const input of [{ keys: ["Enter"] }, { chars: "y", enter: true }]) {
    const h = harness({ before: [fresh], dumpFails: true });
    const result = await h.run({ op: "keys", to: "terminal_9", expect: "Approve", ...input });
    assert.equal(result.error.code, "zellij_failed");
    assert.equal(h.calls.some((c) => ["send-keys", "write-chars"].includes(c.op)), false);
  }
});

test("ordinary status carries tab name/ID and summarizes the whole session", async () => {
  const h = harness({ before: [old, row(9, { tab_id: 30, tab_name: "other", exited: true })] });
  for (const sampleMs of [0, 50]) {
    const result = await h.run({ op: "status", sampleMs });
    assert.deepEqual(result.data.peers.map((p) => [p.tab, p.tabId]), [["crew", 7], ["other", 30]]);
    assert.equal(result.data.tabs.length, 2);
    assert.equal(result.data.tabs.find((t) => t.id === 30).states.exited, 1);
  }
});

test("bus status maps tab positions to stable IDs; old bus IDs stay unknown", async () => {
  const payload = {
    ok: true, ready: true, paneUpdates: 1, tabUpdates: 1,
    tabs: ["crew", "other"], tabIds: [7, 30],
    panes: [{ id: "terminal_9", title: "reviewer", tab: 1, exited: false, focused: false, command: null }],
  };
  const panes = busToPanes(parseBusReply(JSON.stringify(payload)));
  const h = harness();
  const result = await peerStatus(h.client, { sampleMs: 0 }, h.clock, { session: "crew", panes, source: "plugin" });
  assert.equal(result.data.peers[0].tabId, 30);
  assert.equal(result.data.peers[0].tab, "other");
  delete payload.tabIds;
  assert.equal(busToPanes(parseBusReply(JSON.stringify(payload)))[0].tabId, null);
});

test("approval menu is waiting with evidence and cannot enter free", async () => {
  const screen = "Approve this operation\n› 1. Allow once\n2. Cancel\nEnter to select · Esc to cancel";
  const h = harness({ before: [row(9, { pane_command: "codex" })], screen });
  const result = await h.run({ op: "status", sampleMs: 50 });
  assert.equal(result.data.peers[0].state, "waiting");
  assert.equal(result.data.peers[0].waiting.reason, "approval_menu");
  assert.match(result.data.peers[0].waiting.evidence, /Allow once/);
  assert.deepEqual(result.data.free, []);
});

test("named Codex/Cursor questions are detected; prose/chrome alone are not", () => {
  for (const [command, text] of [["codex", "Would you like to run the following command?"], ["cursor-agent", "Run this command?"]]) {
    const profile = resolveHarness({ command });
    assert.equal(waitingPrompt(text + "\nEsc to cancel", profile)?.reason, "prompt");
    assert.equal(waitingPrompt("Documentation says: " + text + "\nworking...", profile), null);
    assert.equal(waitingPrompt("Allow once\nenter confirm", profile), null);
  }
});

test("missing bus observations report unknown rather than free", async () => {
  const h = harness();
  const pane = { id: "terminal_9", title: "reviewer", numericId: 9, isPlugin: false, focused: false, exited: false, floating: false };
  const result = await peerStatus(h.client, { sinceLast: true }, h.clock, {
    session: "crew", panes: [pane], source: "plugin", readChanged: async () => new Map(),
  });
  assert.equal(result.data.peers[0].state, "unknown");
  assert.deepEqual(result.data.free, []);
});

test("routing context accompanies ordinary successes and lookup failures", async () => {
  const h = harness();
  const success = await h.run({ op: "list" });
  const failure = await h.run({ op: "dump", to: "missing", observeMs: 0 });
  for (const result of [success, failure]) {
    assert.equal(result.context.transport, "local");
    assert.equal(result.context.session, "crew");
    assert.equal(result.context.origin.session, "arg");
    assert.ok(result.context.host);
  }
});

test("local routing metadata explains override without changing later invocations", () => {
  const base = { ZSWARM_SSH: "windows", ZSWARM_SESSION: "remote", ZSWARM_TMP: "auto" };
  const local = resolveInvocationEnv({ local: true, session: "local" }, base);
  const result = invocationContext({ local: true, session: "local" }, local);
  assert.equal(result.transport, "local");
  assert.deepEqual(result.origin, { transport: "--local", session: "arg" });
  assert.equal(invocationContext({}, base).host, "windows");
  assert.equal(base.ZSWARM_TMP, "auto");
});

test("serve does not misreport the caller's inherited session as its destination", () => {
  const env = { ZSWARM_SERVE: "127.0.0.1:4242", ZSWARM_SESSION: "caller-local-crew" };
  assert.equal(invocationContext({}, env).session, null);
  assert.equal(invocationContext({}, env).origin.session, "unresolved");
  assert.equal(invocationContext({ session: "requested-remote-crew" }, env).session, "requested-remote-crew");
});

test("SSH ordinary response exposes actual destination and origin", async (t) => {
  const fixture = nodeFixture(t, [
    "const a = process.argv.slice(2).join(' ');",
    "if (a.includes('--version')) console.log('zellij 0.45.1');",
    "else if (a.includes('--help')) console.log('list-sessions --no-formatting');",
    "else if (a.includes('list-panes')) console.log('[]');",
  ].join("\n"));
  const result = await dispatchZswarm({ op: "list", session: "remote-crew" }, undefined, {
    env: { ZSWARM_SSH: "windows-host", ZSWARM_SSH_BIN: fixture.binary, ZSWARM_BUS: "0", ZSWARM_LOG: "0" },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.context.transport, "ssh");
  assert.equal(result.context.host, "windows-host");
  assert.equal(result.context.origin.transport, "ZSWARM_SSH");
  assert.equal(result.context.session, "remote-crew");
});

test("serve context keeps endpoint routing and actual server session", async (t) => {
  const h = harness();
  const server = await startServe("127.0.0.1:0", (args) => h.run({ ...args, session: "server-crew" }), { token: "fixture-token" });
  t.after(() => server.close());
  const result = await dispatchZswarm({ op: "list" }, undefined, {
    env: { ZSWARM_SERVE: server.label, ZSWARM_SERVE_TOKEN: "fixture-token", ZSWARM_SSH: "ignored" },
  });
  assert.equal(result.context.transport, "serve");
  assert.equal(result.context.host, server.label);
  assert.equal(result.context.session, "server-crew");
  assert.equal(result.context.server.transport, "local");
  assert.equal(JSON.stringify(result).includes("fixture-token"), false);
});

// Representative pinned menus: fixtures preserve layout and footer placement.
for (const [file, command] of [["codex-approval", "codex"], ["cursor-approval", "cursor-agent"], ["dumb-term", "bash"]]) {
  test("prompt fixture stays out of free: " + file, async () => {
    const screen = readFileSync(new URL("./fixtures/prompts/" + file + ".txt", import.meta.url), "utf8");
    const h = harness({ before: [row(9, { pane_command: command })], screen });
    const result = await h.run({ op: "status", sampleMs: 50 });
    assert.equal(result.data.peers[0].state, "waiting");
    assert.ok(result.data.peers[0].waiting.evidence);
    assert.deepEqual(result.data.free, []);
  });
}
