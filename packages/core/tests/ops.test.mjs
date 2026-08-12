import { test } from "node:test";
import assert from "node:assert/strict";
// These tests exercise write ops; keep them out of the real delivery log.
process.env.ZSWARM_LOG = "0";

import {
  createZellijClient,
  dispatchZswarm,
  OP_NAMES,
  normalizeKey,
  normalizeKeys,
  normalizeScreen,
  resolveSelfPaneId,
  tokenizeCommand,
  DEFAULT_WAIT_MAX_CHARS,
} from "../dist/index.js";

const PANES = [
  {
    id: 1,
    is_plugin: false,
    is_focused: true,
    title: "builder",
    exited: false,
    is_floating: false,
    tab_id: 0,
    tab_name: "T",
    pane_command: "claude.exe",
  },
  {
    id: 2,
    is_plugin: false,
    is_focused: false,
    title: "dead",
    exited: true,
    is_floating: false,
    tab_id: 0,
    tab_name: "T",
    pane_command: "codex.exe",
  },
  {
    id: 0,
    is_plugin: true,
    is_focused: false,
    title: "hub",
    exited: false,
    is_floating: false,
    tab_id: 0,
    tab_name: "T",
  },
];

/** Client whose exec records argv and answers with `screens` per dump call. */
function harness({ env = {}, screens = ["idle"], panes = PANES, stdout } = {}) {
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
      if (stdout) return { code: 0, stdout: stdout(args), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return { client, calls, argvFor: (verb) => calls.find((a) => a.includes(verb)) };
}

/** Clock that only advances when the code under test sleeps. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test("normalizeKey accepts the common spellings", () => {
  assert.equal(normalizeKey("ctrl+c"), "Ctrl c");
  assert.equal(normalizeKey("Ctrl-C"), "Ctrl c");
  assert.equal(normalizeKey("^C"), "Ctrl c");
  assert.equal(normalizeKey("escape"), "Esc");
  assert.equal(normalizeKey("enter"), "Enter");
  assert.equal(normalizeKey("f1"), "F1");
  assert.equal(normalizeKey("pgdn"), "PageDown");
  assert.equal(normalizeKey("alt shift b"), "Alt Shift b");
  assert.equal(normalizeKey("y"), "y");
  assert.throws(() => normalizeKey("please stop"), /unknown/i);
  assert.throws(() => normalizeKey("hyper+c"), /unknown modifier/i);
});

test("normalizeKeys splits arrays and comma lists only", () => {
  assert.deepEqual(normalizeKeys(["Ctrl c", "esc"]), ["Ctrl c", "Esc"]);
  assert.deepEqual(normalizeKeys("Ctrl c"), ["Ctrl c"]);
  assert.deepEqual(normalizeKeys("esc,enter"), ["Esc", "Enter"]);
  assert.throws(() => normalizeKeys(""), /no keys|empty/i);
});

test("tokenizeCommand honours quotes", () => {
  assert.deepEqual(tokenizeCommand("claude --model opus"), [
    "claude",
    "--model",
    "opus",
  ]);
  assert.deepEqual(tokenizeCommand('sh -c "echo hi there"'), [
    "sh",
    "-c",
    "echo hi there",
  ]);
  assert.deepEqual(tokenizeCommand(["a", "b c"]), ["a", "b c"]);
  assert.deepEqual(tokenizeCommand(undefined), []);
  assert.throws(() => tokenizeCommand('sh -c "oops'), /unbalanced/i);
});

test("resolveSelfPaneId reads both env spellings", () => {
  assert.equal(resolveSelfPaneId({ ZELLIJ_PANE_ID: "3" }), "terminal_3");
  assert.equal(
    resolveSelfPaneId({ ZSWARM_SELF_PANE: "terminal_7", ZELLIJ_PANE_ID: "3" }),
    "terminal_7",
  );
  assert.equal(resolveSelfPaneId({ ZSWARM_SELF_PANE: "none" }), null);
  assert.equal(resolveSelfPaneId({}), null);
});

test("normalizeScreen ignores trailing padding", () => {
  assert.equal(normalizeScreen("a  \nb\n\n\n"), "a\nb");
  assert.equal(normalizeScreen("a\r\nb"), "a\nb");
});

test("send refuses its own pane unless allowSelf", async () => {
  const { client, calls } = harness({ env: { ZELLIJ_PANE_ID: "1" } });
  const blocked = await dispatchZswarm(
    { op: "send", to: "terminal_1", body: "hi" },
    client,
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "self_target");
  assert.equal(calls.some((a) => a.includes("paste")), false);

  const forced = await dispatchZswarm(
    { op: "send", to: "terminal_1", body: "hi", allowSelf: true },
    client,
  );
  assert.equal(forced.ok, true);
  assert.equal(calls.some((a) => a.includes("paste")), true);
});

test("send refuses exited and plugin panes", async () => {
  const { client } = harness();
  const dead = await dispatchZswarm(
    { op: "send", to: "terminal_2", body: "hi" },
    client,
  );
  assert.equal(dead.error.code, "pane_exited");

  const forced = await dispatchZswarm(
    { op: "send", to: "terminal_2", body: "hi", force: true },
    client,
  );
  assert.equal(forced.ok, true);

  const plugin = await dispatchZswarm(
    { op: "send", to: "plugin_0", body: "hi" },
    client,
  );
  assert.equal(plugin.error.code, "pane_is_plugin");
});

test("keys sends normalized specs, chars uses write-chars", async () => {
  const { client, calls, argvFor } = harness();
  const keyed = await dispatchZswarm(
    { op: "keys", to: "1", keys: ["ctrl+c", "esc"] },
    client,
  );
  assert.equal(keyed.ok, true);
  assert.deepEqual(keyed.data.keys, ["Ctrl c", "Esc"]);
  assert.deepEqual(argvFor("send-keys").slice(-4), [
    "--pane-id",
    "terminal_1",
    "Ctrl c",
    "Esc",
  ]);

  const typed = await dispatchZswarm(
    { op: "keys", to: "1", chars: "y", enter: true },
    client,
  );
  assert.equal(typed.ok, true);
  assert.equal(typed.data.delivery, "zellij_write_chars");
  assert.ok(argvFor("write-chars").includes("y"));
  assert.ok(calls.some((a) => a.includes("send-keys") && a.includes("Enter")));

  const bad = await dispatchZswarm(
    { op: "keys", to: "1", keys: ["make it stop"] },
    client,
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "bad_key");
});

test("dash-leading text is typed, not parsed as a zellij flag", async () => {
  const { client, argvFor } = harness();
  const typed = await dispatchZswarm(
    { op: "keys", to: "1", chars: "-y" },
    client,
  );
  assert.equal(typed.ok, true);
  assert.deepEqual(argvFor("write-chars").slice(-3), [
    "terminal_1",
    "--",
    "-y",
  ]);

  const sent = await dispatchZswarm(
    { op: "send", to: "1", raw: true, body: "--help me" },
    client,
  );
  assert.equal(sent.ok, true);
  assert.deepEqual(argvFor("paste").slice(-3), [
    "terminal_1",
    "--",
    "--help me",
  ]);
});

test("close refuses plugin panes like the other write ops", async () => {
  const { client, calls } = harness();
  // `0` is only a plugin pane here, and `list` never shows it.
  const res = await dispatchZswarm({ op: "close", to: "0" }, client);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "pane_is_plugin");
  assert.equal(calls.some((a) => a.includes("close-pane")), false);
});

test("interrupt defaults to Esc and escalates with hard", async () => {
  const soft = harness();
  const esc = await dispatchZswarm({ op: "interrupt", to: "1" }, soft.client);
  assert.deepEqual(esc.data.keys, ["Esc"]);

  const hard = harness();
  const ctrlC = await dispatchZswarm(
    { op: "interrupt", to: "1", hard: true },
    hard.client,
  );
  assert.deepEqual(ctrlC.data.keys, ["Ctrl c"]);
});

test("wait resolves on a quiet screen", async () => {
  const { client } = harness({ screens: ["same"] });
  const res = await dispatchZswarm(
    { op: "wait", to: "1", idleMs: 2000, pollMs: 600, timeoutMs: 30000 },
    client,
    fakeClock(),
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.reason, "idle");
  assert.equal(res.data.elapsedMs, 2400);
  assert.equal(res.data.changes, 0);
  assert.equal(res.data.text, "same");
});

test("wait resolves on a match before going idle", async () => {
  const { client } = harness({ screens: ["working", "working", "BUILD DONE"] });
  const res = await dispatchZswarm(
    { op: "wait", to: "1", match: "DONE", idleMs: 600, pollMs: 600 },
    client,
    fakeClock(),
  );
  assert.equal(res.data.reason, "match");
  assert.equal(res.data.elapsedMs, 1200);
});

test("wait for=match ignores a quiet screen and times out", async () => {
  const { client } = harness({ screens: ["quiet"] });
  const res = await dispatchZswarm(
    {
      op: "wait",
      to: "1",
      for: "match",
      match: "never",
      pollMs: 600,
      timeoutMs: 1800,
    },
    client,
    fakeClock(),
  );
  assert.equal(res.data.reason, "timeout");
  assert.equal(res.data.elapsedMs, 1800);
});

test("wait rejects for=match without a match string", async () => {
  const { client } = harness();
  const res = await dispatchZswarm(
    { op: "wait", to: "1", for: "match" },
    client,
    fakeClock(),
  );
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "missing_match");
});

test("wait caps its tail tighter than dump", async () => {
  const big = "z".repeat(DEFAULT_WAIT_MAX_CHARS + 100);
  const { client } = harness({ screens: [big] });
  const res = await dispatchZswarm(
    { op: "wait", to: "1", idleMs: 200, pollMs: 100 },
    client,
    fakeClock(),
  );
  assert.equal(res.data.text.length, DEFAULT_WAIT_MAX_CHARS);
  assert.equal(res.data.truncated, true);
  assert.equal(res.data.chars, big.length);
});

test("spawn passes cwd/name/command and reads the new pane id", async () => {
  const { client, argvFor } = harness({
    stdout: (args) => (args.includes("new-pane") ? "terminal_9\n" : ""),
    panes: [
      ...PANES,
      {
        id: 9,
        is_plugin: false,
        is_focused: true,
        title: "reviewer",
        exited: false,
        is_floating: false,
        tab_id: 0,
        tab_name: "T",
        pane_command: "claude.exe",
      },
    ],
  });
  const res = await dispatchZswarm(
    {
      op: "spawn",
      command: "claude --model opus",
      cwd: "/repo",
      name: "reviewer",
      direction: "right",
    },
    client,
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.paneId, "terminal_9");
  assert.equal(res.data.resolvedBy, "stdout");
  assert.equal(res.data.live, true);
  const argv = argvFor("new-pane");
  assert.deepEqual(argv.slice(argv.indexOf("new-pane") + 1), [
    "--cwd",
    "/repo",
    "--name",
    "reviewer",
    "--direction",
    "right",
    "--",
    "claude",
    "--model",
    "opus",
  ]);
});

test("spawn tab falls back to diffing the pane list", async () => {
  let created = false;
  const fresh = {
    id: 4,
    is_plugin: false,
    is_focused: true,
    title: "crew",
    exited: false,
    is_floating: false,
    tab_id: 2,
    tab_name: "crew",
    pane_command: "bash",
  };
  const client = createZellijClient({
    env: {},
    exec: async (args) => {
      if (args.includes("list-sessions")) {
        return { code: 0, stdout: "demo\n", stderr: "" };
      }
      if (args.includes("list-panes")) {
        const panes = created ? [...PANES, fresh] : PANES;
        return { code: 0, stdout: JSON.stringify(panes), stderr: "" };
      }
      if (args.includes("new-tab")) {
        created = true;
        return { code: 0, stdout: "2\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const res = await dispatchZswarm({ op: "spawn", tab: true, name: "crew" }, client);
  assert.equal(res.ok, true);
  assert.equal(res.data.tabId, 2);
  assert.equal(res.data.paneId, "terminal_4");
  assert.equal(res.data.resolvedBy, "diff");
});

test("spawn rejects a bad direction", async () => {
  const { client } = harness();
  const res = await dispatchZswarm(
    { op: "spawn", direction: "sideways" },
    client,
  );
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "bad_arg");
});

test("close targets a pane and still guards self", async () => {
  const { client, argvFor } = harness();
  const res = await dispatchZswarm({ op: "close", to: "2" }, client);
  assert.equal(res.ok, true);
  assert.equal(res.data.closed, "terminal_2");
  assert.deepEqual(argvFor("close-pane").slice(-2), ["--pane-id", "terminal_2"]);

  const own = harness({ env: { ZELLIJ_PANE_ID: "1" } });
  const blocked = await dispatchZswarm({ op: "close", to: "1" }, own.client);
  assert.equal(blocked.error.code, "self_target");
});

test("unknown op lists the current surface", async () => {
  const { client } = harness();
  const res = await dispatchZswarm({ op: "nope" }, client);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "usage");
  for (const op of OP_NAMES) assert.ok(res.error.message.includes(op), op);
});
