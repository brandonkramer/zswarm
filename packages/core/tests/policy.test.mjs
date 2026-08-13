process.env.ZSWARM_LOG = "0";
process.env.ZSWARM_BUS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPolicy,
  isWriteOp,
  assertOpAllowed,
  assertPaneAllowed,
  createStateStore,
  createZellijClient,
  dispatchZswarm,
  ZellijError,
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

function paneClient() {
  const calls = [];
  const client = createZellijClient({
    env: {},
    exec: async (args) => {
      calls.push(args);
      if (args.includes("list-sessions")) {
        return { code: 0, stdout: "demo\n", stderr: "" };
      }
      if (args.includes("list-panes")) {
        return { code: 0, stdout: JSON.stringify(PANES), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return { client, calls };
}

let stateSeq = 0;
function tempState() {
  const dir = join(tmpdir(), `zswarm-policy-${process.pid}-${stateSeq++}`);
  const store = createStateStore({ dir, env: {} });
  store.reset();
  return store;
}

const emptyEnv = {};

test("loadPolicy defaults to fully permissive", () => {
  const p = loadPolicy(emptyEnv);
  assert.equal(p.readOnly, false);
  assert.equal(p.allowPanes, null);
  assert.deepEqual(p.denyPanes, []);
  assert.equal(p.allowSpawn, true);
  assert.equal(p.allowClose, true);
  assert.equal(p.allowWorktreeRemove, true);
});

test("isWriteOp covers the write set; list/dump/status are reads", () => {
  for (const op of [
    "send",
    "broadcast",
    "keys",
    "interrupt",
    "spawn",
    "close",
    "unworktree",
    "checkpoint",
    "signal",
    "rename",
    "focus",
    "stack",
    "serve",
  ]) {
    assert.equal(isWriteOp(op), true, op);
  }
  for (const op of ["list", "dump", "status", "wait", "tail", "log", "signals"]) {
    assert.equal(isWriteOp(op), false, op);
  }
});

test("ZSWARM_READONLY blocks writes but allows list/dump/status", () => {
  const p = loadPolicy({ ZSWARM_READONLY: "1" });
  assert.equal(p.readOnly, true);
  assert.throws(
    () => assertOpAllowed(p, "send"),
    (err) =>
      err instanceof ZellijError &&
      err.code === "policy_denied" &&
      /ZSWARM_READONLY/.test(err.message),
  );
  assert.throws(() => assertOpAllowed(p, "keys"), /ZSWARM_READONLY/);
  assert.throws(() => assertOpAllowed(p, "spawn"), /ZSWARM_READONLY/);
  assert.throws(() => assertOpAllowed(p, "checkpoint"), /ZSWARM_READONLY/);
  assert.throws(() => assertOpAllowed(p, "signal"), /ZSWARM_READONLY/);
  assert.throws(() => assertOpAllowed(p, "serve"), /ZSWARM_READONLY/);
  assert.doesNotThrow(() => assertOpAllowed(p, "list"));
  assert.doesNotThrow(() => assertOpAllowed(p, "dump"));
  assert.doesNotThrow(() => assertOpAllowed(p, "status"));
});

test("allowlist matches pane id and title substring (case-insensitive)", () => {
  const p = loadPolicy({ ZSWARM_ALLOW_PANES: "terminal_3,builder" });
  assert.deepEqual(p.allowPanes, ["terminal_3", "builder"]);
  assert.doesNotThrow(() =>
    assertPaneAllowed(p, { id: "terminal_3", title: "other" }, "send"),
  );
  assert.doesNotThrow(() =>
    assertPaneAllowed(p, { id: "terminal_9", title: "My Builder Pane" }, "send"),
  );
  assert.throws(
    () => assertPaneAllowed(p, { id: "terminal_2", title: "reviewer" }, "send"),
    (err) =>
      err instanceof ZellijError &&
      err.code === "policy_denied" &&
      /ZSWARM_ALLOW_PANES/.test(err.message),
  );
});

test("denylist wins over allowlist", () => {
  const p = loadPolicy({
    ZSWARM_ALLOW_PANES: "terminal_3,builder",
    ZSWARM_DENY_PANES: "builder",
  });
  assert.throws(
    () =>
      assertPaneAllowed(
        p,
        { id: "terminal_9", title: "builder agent" },
        "send",
      ),
    (err) =>
      err instanceof ZellijError &&
      err.code === "policy_denied" &&
      /ZSWARM_DENY_PANES/.test(err.message),
  );
  // id still allowed when not denied
  assert.doesNotThrow(() =>
    assertPaneAllowed(p, { id: "terminal_3", title: "ok" }, "send"),
  );
});

test("ZSWARM_ALLOW_SPAWN=0 disables spawn only", () => {
  const p = loadPolicy({ ZSWARM_ALLOW_SPAWN: "0" });
  assert.equal(p.allowSpawn, false);
  assert.throws(
    () => assertOpAllowed(p, "spawn"),
    (err) =>
      err instanceof ZellijError &&
      err.code === "policy_denied" &&
      /ZSWARM_ALLOW_SPAWN/.test(err.message),
  );
  assert.doesNotThrow(() => assertOpAllowed(p, "send"));
  assert.doesNotThrow(() => assertOpAllowed(p, "close"));
});

test("ZSWARM_ALLOW_CLOSE=false disables close only", () => {
  const p = loadPolicy({ ZSWARM_ALLOW_CLOSE: "false" });
  assert.equal(p.allowClose, false);
  assert.throws(() => assertOpAllowed(p, "close"), /ZSWARM_ALLOW_CLOSE/);
  assert.doesNotThrow(() => assertOpAllowed(p, "spawn"));
});

test("ZSWARM_ALLOW_WORKTREE_REMOVE=no disables unworktree only", () => {
  const p = loadPolicy({ ZSWARM_ALLOW_WORKTREE_REMOVE: "no" });
  assert.equal(p.allowWorktreeRemove, false);
  assert.throws(
    () => assertOpAllowed(p, "unworktree"),
    /ZSWARM_ALLOW_WORKTREE_REMOVE/,
  );
  assert.doesNotThrow(() => assertOpAllowed(p, "close"));
});

test("empty allow/deny lists stay permissive; only 0/false/no disable switches", () => {
  const p = loadPolicy({
    ZSWARM_ALLOW_PANES: "",
    ZSWARM_DENY_PANES: "  ",
    ZSWARM_ALLOW_SPAWN: "",
    ZSWARM_ALLOW_CLOSE: "1",
    ZSWARM_ALLOW_WORKTREE_REMOVE: "yes",
  });
  assert.equal(p.allowPanes, null);
  assert.deepEqual(p.denyPanes, []);
  assert.equal(p.allowSpawn, true);
  assert.equal(p.allowClose, true);
  assert.equal(p.allowWorktreeRemove, true);
});

test("rename, focus, and stack honor ZSWARM_DENY_PANES / ZSWARM_ALLOW_PANES", async () => {
  const { client, calls } = paneClient();
  const deny = { env: { ZSWARM_DENY_PANES: "reviewer" } };
  const renamed = await dispatchZswarm(
    { op: "rename", to: "reviewer", name: "auth-review" },
    client,
    deny,
  );
  assert.equal(renamed.ok, false);
  assert.equal(renamed.error.code, "policy_denied");
  assert.match(renamed.error.message, /ZSWARM_DENY_PANES/);
  assert.equal(calls.some((a) => a.includes("rename-pane")), false);

  const focused = await dispatchZswarm({ op: "focus", to: "reviewer" }, client, deny);
  assert.equal(focused.ok, false);
  assert.equal(focused.error.code, "policy_denied");
  assert.equal(calls.some((a) => a.includes("focus-pane-id")), false);

  const stacked = await dispatchZswarm(
    { op: "stack", to: "builder,reviewer" },
    client,
    deny,
  );
  assert.equal(stacked.ok, false);
  assert.equal(stacked.error.code, "policy_denied");
  assert.equal(calls.some((a) => a.includes("stack-panes")), false);

  const allowed = await dispatchZswarm(
    { op: "rename", to: "builder", name: "ok" },
    client,
    deny,
  );
  assert.equal(allowed.ok, true);
  assert.equal(allowed.data.to, "terminal_1");

  const allowlist = await dispatchZswarm(
    { op: "focus", to: "reviewer" },
    client,
    { env: { ZSWARM_ALLOW_PANES: "builder" } },
  );
  assert.equal(allowlist.ok, false);
  assert.equal(allowlist.error.code, "policy_denied");
  assert.match(allowlist.error.message, /ZSWARM_ALLOW_PANES/);
});

test("ZSWARM_SSH refuses client-local signal/signals/await", async () => {
  const ssh = { env: { ZSWARM_SSH: "user@host" } };
  for (const op of ["signal", "signals", "await"]) {
    const args =
      op === "signals"
        ? { op }
        : { op, channel: "build" };
    const res = await dispatchZswarm(args, undefined, ssh);
    assert.equal(res.ok, false, op);
    assert.equal(res.error.code, "ssh_git_unsupported", op);
    assert.match(res.error.message, /client-local barrier/);
  }

  const viaServe = await dispatchZswarm(
    { op: "signal", channel: "build" },
    paneClient().client,
    {
      env: { ZSWARM_SSH: "user@host", ZSWARM_SERVE: "127.0.0.1:9419" },
      state: tempState(),
    },
  );
  assert.equal(viaServe.ok, true);
  assert.equal(viaServe.data.channel, "build");
});
