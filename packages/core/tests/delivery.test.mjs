import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateStore, createZellijClient } from "../dist/index.js";
import { deliverTo } from "../dist/ops/delivery.js";

let stateSeq = 0;
function tempState() {
  const dir = join(tmpdir(), `zswarm-delivery-${process.pid}-${stateSeq++}`);
  const store = createStateStore({ dir, env: {} });
  store.reset();
  return store;
}

const PANE = {
  id: "terminal_1",
  numericId: 1,
  isPlugin: false,
  title: "builder",
  command: "claude.exe",
  tabName: "crew",
  focused: true,
  exited: false,
  floating: false,
};

/** Fake clock: sleep advances `now`. */
function fakeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

/**
 * Scripted Zellij exec. `screens` is consumed per dump-screen call;
 * set `dumpFailAt` (0-based) to make that dump exit non-zero.
 */
function harness({ screens = ["idle prompt"], dumpFailAt = -1 } = {}) {
  const calls = [];
  let dumps = 0;
  const client = createZellijClient({
    env: {},
    exec: async (args) => {
      calls.push(args);
      if (args.includes("dump-screen")) {
        const idx = dumps++;
        if (idx === dumpFailAt) {
          return { code: 1, stdout: "", stderr: "dump failed" };
        }
        const pick = Math.min(idx, screens.length - 1);
        return { code: 0, stdout: screens[pick], stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const enterSends = () =>
    calls.filter((a) => a.includes("send-keys") && a.includes("Enter"));
  return { client, calls, enterSends };
}

async function runDeliver(args, harnessOpts, body = "please review the auth patch") {
  const { client, calls, enterSends } = harness(harnessOpts);
  const state = tempState();
  const clock = fakeClock();
  const result = await deliverTo(client, state, args, {
    session: "demo",
    pane: PANE,
    body,
    op: "send",
    at: clock.now(),
    clock,
  });
  return { result, calls, enterSends, state, clock };
}

test("auto: clean submit — no extra Enter, submitted true", async () => {
  const { result, enterSends, state } = await runDeliver(
    { from: "codex" },
    { screens: ["ready>\n  (listening)"] },
  );
  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
  // injectPane already sends one Enter; auto must not send another
  assert.equal(enterSends().length, 1);
  const log = state.readLog();
  assert.equal(log.length, 1);
  assert.match(log[0].detail, /submitted=true/);
});

test("auto: queued text rescued by extra Enter", async () => {
  const body = "please review the auth patch";
  const queued = `composer\n[Pasted text #1 +2 lines]\n${body}`;
  const clear = "thinking…\nworking on it";
  const { result, enterSends } = await runDeliver(
    { from: "codex" },
    { screens: [queued, clear] },
    body,
  );
  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
  assert.equal(enterSends().length, 2);
});

test("auto: still queued after retry → submitted false", async () => {
  const body = "please review the auth patch";
  const queued = `idle\n> ${body.slice(0, 40)}\n[Pasted text #1 +1 lines]`;
  const { result, enterSends } = await runDeliver(
    {},
    { screens: [queued, queued] },
    body,
  );
  assert.equal(result.ok, true);
  assert.equal(result.submitted, false);
  assert.equal(enterSends().length, 2);
});

test("submit none: no verify dump, submitted unverified", async () => {
  const { result, enterSends, calls } = await runDeliver(
    { submit: "none" },
    { screens: ["[Pasted text #1 +9 lines]"] },
  );
  assert.equal(result.ok, true);
  assert.equal(result.submitted, "unverified");
  assert.equal(enterSends().length, 1);
  assert.equal(calls.filter((a) => a.includes("dump-screen")).length, 0);
});

test("auto: dump failure falls back to unverified", async () => {
  const { result, enterSends } = await runDeliver(
    {},
    { screens: ["unused"], dumpFailAt: 0 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.submitted, "unverified");
  // inject Enter only — rescue Enter not attempted when first dump fails
  assert.equal(enterSends().length, 1);
});
