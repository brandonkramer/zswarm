process.env.ZSWARM_BUS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStateStore,
  createZellijClient,
  parseScrollbackReply,
  scrollbackPayload,
  scrollbackToScreen,
  ZellijError,
} from "../dist/index.js";

let seq = 0;
function tempState() {
  const dir = join(tmpdir(), `zswarm-scrollback-test-${process.pid}-${seq++}`);
  const store = createStateStore({ dir, env: {} });
  store.reset();
  return store;
}

const SCROLLBACK = JSON.stringify({
  ok: true,
  source: "plugin",
  ready: true,
  panes: [
    {
      id: "terminal_4",
      viewport: ["line 1", "line 2"],
      above: [],
      below: [],
    },
  ],
  missing: [],
});

/** A client whose pipe answers only for the listed config keys. */
function busClient(options = {}) {
  const {
    answering = ["zswarm-bus"],
    reply = SCROLLBACK,
    coldFirst = false,
    panesJson = "[]",
  } = options;
  const calls = [];
  const execOptions = [];
  let asked = 0;
  const client = createZellijClient({
    env: {},
    exec: async (args, opts) => {
      calls.push(args);
      execOptions.push(opts);
      if (args.includes("list-sessions")) {
        return { code: 0, stdout: "demo\n", stderr: "" };
      }
      if (args.includes("list-panes")) {
        return { code: 0, stdout: panesJson, stderr: "" };
      }
      if (args.includes("pipe")) {
        const key = args[args.indexOf("--plugin-configuration") + 1];
        if (!answering.includes(key.replace("instance=", ""))) {
          // A stale instance swallows the message and says nothing.
          return { code: 0, stdout: "", stderr: "" };
        }
        asked += 1;
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
  return {
    client,
    calls,
    execOptions,
    pipes: () => calls.filter((a) => a.includes("pipe")),
  };
}

function installed(store, configKey = "zswarm-bus") {
  store.writeBus({ plugin: "/tmp/zswarm-bus.wasm", configKey, installedAt: 1 });
  return store;
}

const clock = { now: () => 1, sleep: async () => {} };

test("scrollbackPayload emits the contract JSON and rejects an empty pane list", () => {
  assert.equal(
    scrollbackPayload({ panes: ["terminal_4", "terminal_13"] }),
    JSON.stringify({
      op: "scrollback",
      panes: ["terminal_4", "terminal_13"],
      full: false,
    }),
  );
  assert.equal(
    scrollbackPayload({ panes: ["terminal_4"], full: true }),
    JSON.stringify({
      op: "scrollback",
      panes: ["terminal_4"],
      full: true,
    }),
  );
  assert.throws(
    () => scrollbackPayload({ panes: [] }),
    (err) => err instanceof ZellijError && err.code === "bad_arg",
  );
});

test("parseScrollbackReply skips zellij chatter and finds the answer", () => {
  // This line is printed on successful pipes too; treating it as failure
  // would drop every real reply.
  const noisy = [
    "Action CliPipe did not complete within 1s timeout",
    SCROLLBACK,
    "",
  ].join("\n");
  const reply = parseScrollbackReply(noisy);
  assert.equal(reply.ready, true);
  assert.equal(reply.panes.length, 1);
  assert.equal(reply.panes[0].id, "terminal_4");
  assert.deepEqual(reply.missing, []);
});

test("parseScrollbackReply returns null for non-JSON, ok:false, and a malformed brace", () => {
  assert.equal(parseScrollbackReply("no json here"), null);
  assert.equal(parseScrollbackReply('{"ok":false,"panes":[]}'), null);
  assert.equal(parseScrollbackReply("{oops"), null);
});

test("scrollbackToScreen joins above, viewport, then below with newlines", () => {
  assert.equal(
    scrollbackToScreen({
      id: "terminal_4",
      above: ["old"],
      viewport: ["now"],
      below: ["later"],
    }),
    "old\nnow\nlater",
  );
  assert.equal(
    scrollbackToScreen({
      id: "terminal_4",
      above: [],
      viewport: ["only"],
      below: [],
    }),
    "only",
  );
});

test("a reply with missing ids reports them without failing the call", async () => {
  const reply = JSON.stringify({
    ok: true,
    source: "plugin",
    ready: true,
    panes: [
      {
        id: "terminal_4",
        viewport: ["hi"],
        above: [],
        below: [],
      },
    ],
    missing: ["terminal_99"],
  });
  installed(tempState());
  const { client } = busClient({ reply });
  const result = await client.scrollbackPlugin({
    session: "demo",
    url: "file:/x/zswarm-bus.wasm",
    configKey: "zswarm-bus",
    panes: ["terminal_4", "terminal_99"],
  });
  assert.equal(result.code, 0);
  const parsed = parseScrollbackReply(result.stdout);
  assert.equal(parsed.panes.length, 1);
  assert.deepEqual(parsed.missing, ["terminal_99"]);
});

test("a cold reply is distinguishable from an empty session", () => {
  const cold = parseScrollbackReply(
    JSON.stringify({
      ok: true,
      source: "plugin",
      ready: false,
      panes: [],
      missing: [],
    }),
  );
  const empty = parseScrollbackReply(
    JSON.stringify({
      ok: true,
      source: "plugin",
      ready: true,
      panes: [],
      missing: [],
    }),
  );
  assert.equal(cold.ready, false);
  assert.equal(empty.ready, true);
  assert.equal(cold.panes.length, 0);
  assert.equal(empty.panes.length, 0);
});

test("scrollbackPlugin passes an until predicate that fires on the JSON line", async () => {
  installed(tempState());
  const { client, execOptions, calls } = busClient();
  await client.scrollbackPlugin({
    session: "demo",
    url: "file:/x/zswarm-bus.wasm",
    configKey: "zswarm-bus",
    panes: ["terminal_4"],
  });
  const pipeIdx = calls.findIndex((a) => a.includes("pipe"));
  assert.ok(pipeIdx >= 0);
  const until = execOptions[pipeIdx].until;
  assert.equal(typeof until, "function");
  // Chatter alone must not look like an answer — otherwise we stop before
  // the JSON arrives, or treat a hung pipe as success.
  assert.equal(
    until("Action CliPipe did not complete within 1s timeout\n"),
    false,
  );
  assert.equal(
    until(`Action CliPipe did not complete within 1s timeout\n${SCROLLBACK}\n`),
    true,
  );
});
