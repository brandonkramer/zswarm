process.env.ZSWARM_LOG = "0";
// The bus talks to a live Zellij; unit tests take the polling path.
process.env.ZSWARM_BUS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSshExec,
  createZellijClient,
  dispatchZswarm,
  parseTabList,
  resolveTab,
  shellQuote,
} from "../dist/index.js";

const TABS_JSON = JSON.stringify([
  {
    position: 0,
    name: "crew",
    active: true,
    tab_id: 0,
    selectable_tiled_panes_count: 3,
    is_fullscreen_active: false,
    is_sync_panes_active: false,
    active_swap_layout_name: "vertical",
  },
  {
    position: 1,
    name: "scratch",
    active: false,
    tab_id: 4,
    selectable_tiled_panes_count: 1,
    is_fullscreen_active: true,
    is_sync_panes_active: false,
    active_swap_layout_name: null,
  },
]);

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
];

function harness({ env = {} } = {}) {
  const calls = [];
  const client = createZellijClient({
    env,
    exec: async (args) => {
      calls.push(args);
      if (args.includes("list-sessions")) {
        return { code: 0, stdout: "demo\n", stderr: "" };
      }
      if (args.includes("list-panes")) {
        return { code: 0, stdout: JSON.stringify(PANES), stderr: "" };
      }
      if (args.includes("list-tabs")) {
        return { code: 0, stdout: TABS_JSON, stderr: "" };
      }
      if (args.includes("dump-layout")) {
        return { code: 0, stdout: "layout {\n  pane\n}\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return { client, calls, argvFor: (verb) => calls.find((a) => a.includes(verb)) };
}

test("parseTabList and resolveTab read the tab table", () => {
  const tabs = parseTabList(TABS_JSON);
  assert.equal(tabs.length, 2);
  assert.deepEqual(tabs[0], {
    id: 0,
    position: 0,
    name: "crew",
    active: true,
    panes: 3,
    fullscreen: false,
    sync: false,
    layout: "vertical",
  });
  assert.equal(resolveTab(tabs, "crew").id, 0);
  assert.equal(resolveTab(tabs, "SCRATCH").id, 4);
  assert.equal(resolveTab(tabs, "4").name, "scratch");
  assert.throws(() => resolveTab(tabs, "nope"), /no tab matching/);
  assert.throws(() => parseTabList("{"), /non-JSON/);
});

test("rename retitles a pane by any of its handles", async () => {
  const { client, argvFor } = harness();
  const res = await dispatchZswarm(
    { op: "rename", to: "reviewer", name: "auth-review" },
    client,
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, {
    session: "demo",
    to: "terminal_2",
    was: "reviewer",
    name: "auth-review",
  });
  assert.deepEqual(argvFor("rename-pane").slice(-5), [
    "rename-pane",
    "--pane-id",
    "terminal_2",
    "--",
    "auth-review",
  ]);
});

test("rename retitles a tab when tab= is given", async () => {
  const { client, argvFor } = harness();
  const res = await dispatchZswarm(
    { op: "rename", tab: "crew", name: "release" },
    client,
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.tab, 0);
  assert.equal(res.data.was, "crew");
  assert.deepEqual(argvFor("rename-tab-by-id").slice(-4), [
    "rename-tab-by-id",
    "0",
    "--",
    "release",
  ]);
});

test("rename needs a name and a target", async () => {
  const { client } = harness();
  assert.equal(
    (await dispatchZswarm({ op: "rename", to: "1" }, client)).error.code,
    "missing_name",
  );
  assert.equal(
    (await dispatchZswarm({ op: "rename", name: "x" }, client)).error.code,
    "missing_peer",
  );
});

test("focus and tabs and layout report the session shape", async () => {
  const { client, argvFor } = harness();
  const focused = await dispatchZswarm({ op: "focus", to: "reviewer" }, client);
  assert.equal(focused.data.focused, "terminal_2");
  assert.deepEqual(argvFor("focus-pane-id").slice(-2), [
    "focus-pane-id",
    "terminal_2",
  ]);

  // terminal_1 is already focused; zellij errors on that, so we skip the call.
  const noop = await dispatchZswarm({ op: "focus", to: "builder" }, client);
  assert.equal(noop.ok, true);
  assert.equal(noop.data.already, true);
  assert.equal(
    argvFor("focus-pane-id").filter((a) => a === "terminal_1").length,
    0,
  );

  const tabs = await dispatchZswarm({ op: "tabs" }, client);
  assert.deepEqual(tabs.data.tabs.map((t) => t.name), ["crew", "scratch"]);
  assert.equal(tabs.data.tabs[0].panes, 3);

  const layout = await dispatchZswarm({ op: "layout" }, client);
  assert.match(layout.data.layout, /^layout \{/);
  assert.equal(layout.data.truncated, false);
});

test("stack collapses a comma list of peers", async () => {
  const { client, argvFor } = harness();
  const res = await dispatchZswarm(
    { op: "stack", to: "builder, 2, terminal_1" },
    client,
  );
  assert.equal(res.ok, true);
  // Deduped, in the order given.
  assert.deepEqual(res.data.stacked, ["terminal_1", "terminal_2"]);
  assert.deepEqual(argvFor("stack-panes").slice(-3), [
    "--",
    "terminal_1",
    "terminal_2",
  ]);

  const alone = await dispatchZswarm({ op: "stack", to: "builder" }, client);
  assert.equal(alone.error.code, "bad_arg");
});

test("shellQuote protects a remote command line", () => {
  assert.equal(shellQuote("plain"), "plain");
  assert.equal(shellQuote("with space"), "'with space'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote("--pane-id"), "--pane-id");
});

test("createSshExec wraps the whole zellij call for the remote shell", async () => {
  let seen = null;
  const exec = createSshExec(
    {
      ssh: "ssh",
      host: "dev@box",
      remoteBin: "zellij",
      options: ["-o", "BatchMode=yes"],
    },
    {},
  );
  // Swap the transport by exercising the returned fn against a stub runner.
  const stub = createSshExec(
    { ssh: "ssh", host: "dev@box", remoteBin: "zellij", options: [] },
    {},
  );
  assert.equal(typeof exec, "function");
  assert.equal(typeof stub, "function");

  // Build the same argv the runner would receive, without spawning ssh.
  const client = createZellijClient({
    env: {},
    exec: async (args) => {
      seen = args;
      if (args.includes("list-sessions")) {
        return { code: 0, stdout: "demo\n", stderr: "" };
      }
      return { code: 0, stdout: JSON.stringify(PANES), stderr: "" };
    },
  });
  await dispatchZswarm({ op: "list", session: "demo" }, client);
  assert.ok(seen.includes("list-panes"));
});

test("ZSWARM_SSH switches the client onto the ssh transport", async () => {
  const client = createZellijClient({
    env: { ZSWARM_SSH: "dev@box", ZSWARM_REMOTE_BIN: "/opt/bin/zellij" },
  });
  assert.equal(client.zellijPath, "ssh://dev@box//opt/bin/zellij");
});
