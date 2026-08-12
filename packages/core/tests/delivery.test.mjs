import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStateStore, createZellijClient } from "../dist/index.js";
import {
  classifySubmit,
  composerHolds,
  deliverTo,
  resolveSubmitMode,
} from "../dist/ops/delivery.js";

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

const CODEX_PANE = {
  ...PANE,
  title: "agent-codex",
  command: "codex",
};

const BODY = "please review the auth patch";
const BEFORE = "idle\n>";
const QUEUED = `idle\n>\n[Pasted text #1 +2 lines]\n${BODY}`;
const SUBMITTED = `${QUEUED}\nI'll start by reading auth.ts`;
/** Body left the composer; it sits in history, last lines are new output. */
const CLEARED = `idle\n[zswarm from=swarm]\n${BODY}\nthinking…\nworking on auth.ts\nstill going`;

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

async function runDeliver(args, harnessOpts, body = BODY, pane = PANE) {
  const { client, calls, enterSends } = harness(harnessOpts);
  const state = tempState();
  const clock = fakeClock();
  const result = await deliverTo(client, state, args, {
    session: "demo",
    pane,
    body,
    op: "send",
    at: clock.now(),
    clock,
  });
  return { result, calls, enterSends, state, clock };
}

test("classifySubmit: new output below the paste is submitted", () => {
  assert.equal(classifySubmit(BEFORE, SUBMITTED, BODY), true);
});

test("classifySubmit: composer holding the paste is queued", () => {
  assert.equal(classifySubmit(BEFORE, QUEUED, BODY), false);
});

test("classifySubmit: unchanged screen without a last-line marker is unverified", () => {
  assert.equal(classifySubmit(BEFORE, BEFORE, BODY), "unverified");
});

test("classifySubmit: [Pasted text] in scrollback does not decide", () => {
  const after = `idle\n[Pasted text #1 +9 lines]\noutput line`;
  const before = `idle\noutput line`;
  assert.equal(classifySubmit(before, after, BODY), "unverified");
});

test("classifySubmit: pasted text leaving the input region is submitted", () => {
  assert.equal(classifySubmit(BEFORE, CLEARED, BODY), true);
  assert.equal(composerHolds(QUEUED, BODY), true);
  assert.equal(composerHolds(CLEARED, BODY), false);
});

test("auto: real submission — new output below paste, no extra Enter", async () => {
  const { result, enterSends, state } = await runDeliver(
    { from: "codex" },
    { screens: [BEFORE, SUBMITTED] },
  );
  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
  assert.equal(enterSends().length, 1);
  const log = state.readLog();
  assert.equal(log.length, 1);
  assert.match(log[0].detail, /submitted=true/);
});

test("auto: queued composer rescued by extra Enter", async () => {
  const { result, enterSends } = await runDeliver(
    { from: "codex" },
    { screens: [BEFORE, QUEUED, SUBMITTED] },
  );
  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
  assert.equal(enterSends().length, 2);
});

test("auto: still queued after retry → submitted false", async () => {
  const { result, enterSends } = await runDeliver(
    {},
    { screens: [BEFORE, QUEUED, QUEUED] },
  );
  assert.equal(result.ok, true);
  assert.equal(result.submitted, false);
  assert.equal(enterSends().length, 2);
});

test("auto: ambiguous screen → unverified", async () => {
  const { result, enterSends } = await runDeliver(
    {},
    { screens: [BEFORE, BEFORE, BEFORE] },
  );
  assert.equal(result.ok, true);
  assert.equal(result.submitted, "unverified");
  assert.equal(enterSends().length, 1);
});

test("auto: leftover [Pasted text] marker does not force a retry", async () => {
  const before = "idle\noutput line";
  const after = "idle\n[Pasted text #1 +9 lines]\noutput line";
  const { result, enterSends } = await runDeliver(
    {},
    { screens: [before, after, after] },
  );
  assert.equal(result.ok, true);
  assert.equal(result.submitted, "unverified");
  assert.equal(enterSends().length, 1);
});

test("auto: delayed composer-clear after a longer pause reads true", async () => {
  const { result, enterSends } = await runDeliver(
    {},
    { screens: [BEFORE, BEFORE, CLEARED] },
  );
  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
  assert.equal(enterSends().length, 1);
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
  assert.equal(enterSends().length, 1);
});

test("explicit submit= overrides the harness profile", () => {
  assert.equal(resolveSubmitMode({ submit: "none" }, CODEX_PANE), "none");
  assert.equal(resolveSubmitMode({ submit: "auto" }, CODEX_PANE), "auto");
  assert.equal(
    resolveSubmitMode({ submit: "double-enter" }, PANE),
    "double-enter",
  );
});

test("codex-shaped pane defaults to double-enter", async () => {
  assert.equal(resolveSubmitMode({}, CODEX_PANE), "double-enter");
  const { result, enterSends, calls } = await runDeliver(
    {},
    { screens: [BEFORE, QUEUED] },
    BODY,
    CODEX_PANE,
  );
  assert.equal(result.ok, true);
  assert.equal(result.submitted, "unverified");
  assert.equal(enterSends().length, 2);
  assert.equal(calls.filter((a) => a.includes("dump-screen")).length, 0);
});
