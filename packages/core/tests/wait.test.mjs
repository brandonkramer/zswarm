process.env.ZSWARM_LOG = "0";
process.env.ZSWARM_BUS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createZellijClient,
  DEFAULT_WAIT_MAX_CHARS,
} from "../dist/index.js";
import { waitForPane } from "../dist/ops/wait.js";

process.env.ZSWARM_STATE_DIR = join(
  tmpdir(),
  `zswarm-wait-test-${process.pid}`,
);

const PANE = {
  id: "terminal_1",
  numericId: 1,
  isPlugin: false,
  title: "builder",
  command: "claude.exe",
  cwd: null,
  tabName: "T",
  tabId: 0,
  focused: true,
  exited: false,
  floating: false,
};

const PANE_JSON = [
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
];

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

function dumpClient(screens = ["idle"]) {
  const calls = [];
  let dumps = 0;
  const client = createZellijClient({
    env: {},
    exec: async (args) => {
      calls.push(args);
      if (args.includes("list-sessions")) {
        return { code: 0, stdout: "demo\n", stderr: "" };
      }
      if (args.includes("list-panes")) {
        return { code: 0, stdout: JSON.stringify(PANE_JSON), stderr: "" };
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
    dumpCount: () => calls.filter((a) => a.includes("dump-screen")).length,
  };
}

function busReply(reason, screen = "BUILD DONE") {
  return { reason, pane: "terminal_1", screen };
}

async function wait(client, args, clock, waitViaBus) {
  return waitForPane(
    client,
    { session: "demo", pane: PANE },
    args,
    clock,
    waitViaBus,
  );
}

test("wait via bus returns match without dumping", async () => {
  const { client, dumpCount } = dumpClient(["should not dump"]);
  const res = await wait(
    client,
    { match: "DONE" },
    fakeClock(),
    async () => busReply("match", "working\nBUILD DONE"),
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.reason, "match");
  assert.equal(res.data.to, "terminal_1");
  assert.equal(res.data.text, "working\nBUILD DONE");
  assert.equal(res.data.polls, 1);
  assert.equal(dumpCount(), 0);
});

test("wait via bus returns idle without dumping", async () => {
  const { client, dumpCount } = dumpClient(["should not dump"]);
  const res = await wait(
    client,
    { idleMs: 2000 },
    fakeClock(),
    async () => busReply("idle", "same"),
  );
  assert.equal(res.data.reason, "idle");
  assert.equal(res.data.text, "same");
  assert.equal(res.data.polls, 1);
  assert.equal(dumpCount(), 0);
});

test("wait via bus returns timeout without dumping", async () => {
  const { client, dumpCount } = dumpClient(["should not dump"]);
  const res = await wait(
    client,
    { for: "match", match: "never", timeoutMs: 1800 },
    fakeClock(),
    async () => busReply("timeout", "quiet"),
  );
  assert.equal(res.data.reason, "timeout");
  assert.equal(res.data.text, "quiet");
  assert.equal(dumpCount(), 0);
});

test("wait via bus null falls back to polling", async () => {
  const { client, dumpCount } = dumpClient(["same"]);
  const res = await wait(
    client,
    { idleMs: 2000, pollMs: 600, timeoutMs: 30000 },
    fakeClock(),
    async () => null,
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.reason, "idle");
  assert.equal(res.data.elapsedMs, 2400);
  assert.equal(res.data.changes, 0);
  assert.equal(res.data.text, "same");
  assert.ok(dumpCount() > 0);
});

test("wait fallback idle is byte-identical to today", async () => {
  const { client } = dumpClient(["same"]);
  const res = await wait(
    client,
    { idleMs: 2000, pollMs: 600, timeoutMs: 30000 },
    fakeClock(),
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.reason, "idle");
  assert.equal(res.data.elapsedMs, 2400);
  assert.equal(res.data.changes, 0);
  assert.equal(res.data.text, "same");
});

test("wait fallback match is byte-identical to today", async () => {
  const { client } = dumpClient(["working", "working", "BUILD DONE"]);
  const res = await wait(
    client,
    { match: "DONE", idleMs: 600, pollMs: 600 },
    fakeClock(),
  );
  assert.equal(res.data.reason, "match");
  assert.equal(res.data.elapsedMs, 1200);
});

test("wait fallback timeout is byte-identical to today", async () => {
  const { client } = dumpClient(["quiet"]);
  const res = await wait(
    client,
    { for: "match", match: "never", pollMs: 600, timeoutMs: 1800 },
    fakeClock(),
  );
  assert.equal(res.data.reason, "timeout");
  assert.equal(res.data.elapsedMs, 1800);
});

test("wait fallback still caps its tail", async () => {
  const big = "z".repeat(DEFAULT_WAIT_MAX_CHARS + 100);
  const { client } = dumpClient([big]);
  const res = await wait(
    client,
    { idleMs: 200, pollMs: 100 },
    fakeClock(),
  );
  assert.equal(res.data.text.length, DEFAULT_WAIT_MAX_CHARS);
  assert.equal(res.data.truncated, true);
  assert.equal(res.data.chars, big.length);
});
