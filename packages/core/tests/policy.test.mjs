import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadPolicy,
  isWriteOp,
  assertOpAllowed,
  assertPaneAllowed,
  ZellijError,
} from "../dist/index.js";

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
