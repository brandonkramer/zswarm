process.env.ZSWARM_BUS = "0";
process.env.ZSWARM_LOG = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createSshExec,
  createZellijClient,
  dispatchZswarm,
  peerStatus,
  resetZellijIdentityCache,
  resolveInvocationEnv,
} from "../dist/index.js";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const paneRows = [1, 2].map((id) => ({
  id,
  is_plugin: false,
  title: `peer-${id}`,
  exited: false,
}));

test("status overall deadline covers setup (no 15s child timeouts)", async () => {
  const calls = [];
  const client = createZellijClient({
    env: {},
    exec: async (args, opts) => {
      const op = args.includes("list-sessions")
        ? "list-sessions"
        : args.includes("list-panes")
          ? "list-panes"
          : "dump-screen";
      calls.push({ op, timeoutMs: opts.timeoutMs });
      if (op === "list-sessions") {
        await delay(80);
        return ok("crew [Created 1h ago]\n");
      }
      if (op === "list-panes") {
        await delay(80);
        return ok(JSON.stringify(paneRows));
      }
      return ok("steady");
    },
  });
  const start = Date.now();
  const result = await dispatchZswarm(
    { op: "status", timeoutMs: 1000, sampleMs: 50 },
    client,
    { env: {} },
  );
  const elapsed = Date.now() - start;
  assert.equal(result.ok, true);
  assert.ok(elapsed < 1500, `elapsed ${elapsed}ms`);
  // Setup calls must receive the remaining overall budget, not a fresh 15s.
  for (const c of calls.filter((x) => x.op !== "dump-screen")) {
    assert.ok(
      c.timeoutMs <= 1000,
      `${c.op} got timeoutMs=${c.timeoutMs}`,
    );
  }
  // Session is resolved once in dispatch, not again inside peerStatus.
  assert.equal(calls.filter((c) => c.op === "list-sessions").length, 1);
});

test("status bus readScreens respects remaining budget", async () => {
  const client = createZellijClient({
    env: {},
    exec: async () => ok(),
  });
  const pane = {
    id: "terminal_1",
    numericId: 1,
    title: "peer-1",
    isPlugin: false,
    focused: false,
    floating: false,
    exited: false,
  };
  const start = Date.now();
  const result = await peerStatus(
    client,
    { timeoutMs: 1000, sampleMs: 50 },
    { now: Date.now, sleep: delay },
    {
      session: "crew",
      panes: [pane],
      source: "plugin",
      readScreens: async (_ids, timeoutMs) => {
        assert.ok(timeoutMs <= 1000);
        await delay(Math.min(200, timeoutMs));
        return new Map([["terminal_1", "steady"]]);
      },
    },
    { deadlineAt: Date.now() + 1000 },
  );
  assert.equal(result.ok, true);
  assert.ok(Date.now() - start < 1500);
});

test("status cancellation during second sample is not a successful partial", async () => {
  const aborter = new AbortController();
  let dumps = 0;
  const client = createZellijClient({
    env: {},
    signal: aborter.signal,
    exec: async (args) => {
      if (args.includes("list-panes")) {
        return ok(JSON.stringify(paneRows.slice(0, 1)));
      }
      if (args.includes("list-sessions")) return ok("crew\n");
      if (++dumps === 2) {
        aborter.abort();
        return { code: -1, stdout: "", stderr: "zellij cancelled" };
      }
      return ok("steady");
    },
  });
  const result = await dispatchZswarm(
    { op: "status", session: "crew", timeoutMs: 5000, sampleMs: 50 },
    client,
    { env: {}, signal: aborter.signal },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "cancelled");
});

test("IPC discovery shares one remaining budget across probes", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "zswarm-ipc-budget-"));
  const fixture = join(fixtureDir, "ssh-fixture.mjs");
  const log = join(fixtureDir, "calls.jsonl");
  writeFileSync(log, "");
  writeFileSync(
    fixture,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const cmd = process.argv.at(-1);
appendFileSync(process.env.PR1_CALL_LOG, JSON.stringify({at:Date.now(),cmd}) + '\\n');
await new Promise((resolve) => setTimeout(resolve, 10_000));
`,
    { mode: 0o700 },
  );
  const sshExec = createSshExec(
    {
      ssh: fixture,
      host: "test-host",
      remoteBin: "zellij",
      options: [],
      tmp: "auto",
      mode: "ssh",
    },
    { ...process.env, PR1_CALL_LOG: log },
  );
  const start = Date.now();
  const result = await sshExec(["list-sessions", "--no-formatting"], {
    timeoutMs: 300,
  });
  const elapsed = Date.now() - start;
  const raw = readFileSync(log, "utf8").trim();
  const calls = raw
    ? raw.split("\n").map((line) => JSON.parse(line))
    : [];
  assert.ok(elapsed < 900, `elapsed ${elapsed}ms with ${calls.length} calls`);
  assert.equal(result.code, -1);
  // First probe may consume the whole budget; a second must not restart fresh.
  assert.ok(calls.length <= 2, `expected ≤2 probes, got ${calls.length}`);
  assert.ok(
    sshExec.ipcState.status === "expired" ||
      sshExec.ipcState.status === "failed",
    sshExec.ipcState.status,
  );
});

test("failed auto IPC discovery refuses empty live sessions", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "zswarm-ipc-fail-"));
  const fixture = join(fixtureDir, "ssh-fixture.mjs");
  writeFileSync(
    fixture,
    `#!${process.execPath}
const cmd = process.argv.at(-1);
if (cmd === 'ps ax -o args=' || cmd.startsWith('powershell.exe')) {
  process.stderr.write('process discovery unavailable');
  process.exitCode = 1;
} else if (cmd.includes('--version') || cmd.includes('--help')) {
  console.log('zellij 0.45.1');
  console.log('list-sessions');
  console.log('--no-formatting');
} else {
  console.log('desktop-crew [Created 1h ago] (EXITED - attach to resurrect)');
}
`,
    { mode: 0o700 },
  );
  const result = await dispatchZswarm(
    { op: "sessions" },
    undefined,
    {
      env: {
        ZSWARM_SSH: "test-host",
        ZSWARM_SSH_BIN: fixture,
        ZSWARM_REMOTE_BIN: "C:\\Tools\\zellij.exe",
        ZSWARM_TMP: "auto",
        ZSWARM_BUS: "0",
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ipc_unreachable");
  assert.match(result.error.message, /ZSWARM_TMP=auto/);
});

test("option-shaped ZSWARM_SSH is rejected before contacting ssh", async () => {
  const result = await dispatchZswarm(
    { op: "sessions" },
    undefined,
    { env: { ZSWARM_SSH: "-V", ZSWARM_SSH_BIN: "/usr/bin/ssh", ZSWARM_BUS: "0" } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "bad_ssh");
});

test("non-Zellij --version is rejected and not cached as success", async () => {
  resetZellijIdentityCache();
  const result = await dispatchZswarm(
    { op: "sessions" },
    undefined,
    { env: { ZSWARM_BIN: "/bin/echo", ZSWARM_BUS: "0", PATH: "" } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "zellij_wrong_bin");
});

test("resolveInvocationEnv --local clears SSH and serve", () => {
  const env = resolveInvocationEnv(
    { local: true },
    {
      ZSWARM_SSH: "user@host",
      ZSWARM_SERVE: "127.0.0.1:9419",
      ZSWARM_SERVE_TOKEN: "secret",
      ZSWARM_TMP: "auto",
      ZSWARM_BIN: "/usr/bin/zellij",
    },
  );
  assert.equal(env.ZSWARM_SSH, undefined);
  assert.equal(env.ZSWARM_SERVE, undefined);
  assert.equal(env.ZSWARM_TMP, undefined);
  assert.equal(env.ZSWARM_BIN, "/usr/bin/zellij");
});

test("resolveInvocationEnv --ssh sets destination and clears serve", () => {
  const env = resolveInvocationEnv(
    { ssh: "win@100.1.2.3" },
    { ZSWARM_SERVE: "127.0.0.1:9419", ZSWARM_SSH: "old@host" },
  );
  assert.equal(env.ZSWARM_SSH, "win@100.1.2.3");
  assert.equal(env.ZSWARM_SERVE, undefined);
});

test("dispatch --local overrides sticky SSH for sessions", async () => {
  const client = createZellijClient({
    env: {},
    exec: async (args) => {
      if (args.includes("list-sessions")) return ok("local-crew\n");
      return ok();
    },
  });
  // Injected client ignores env routing, but resolveInvocationEnv still runs;
  // assert the flag parses and does not error when combined with an injected client.
  const result = await dispatchZswarm(
    { op: "sessions", local: true },
    client,
    { env: { ZSWARM_SSH: "user@host", ZSWARM_BUS: "0" } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.sessions[0].name, "local-crew");
});

test("status verbose keeps command/cwd/tab on exited peers", async () => {
  const client = createZellijClient({
    env: {},
    exec: async (args) => {
      if (args.includes("list-sessions")) return ok("demo\n");
      if (args.includes("list-panes")) {
        return ok(
          JSON.stringify([
            {
              id: 1,
              is_plugin: false,
              title: "dead",
              exited: true,
              pane_command: "bash",
              pane_cwd: "/tmp",
              tab_name: "T",
            },
          ]),
        );
      }
      return ok("x");
    },
  });
  const result = await dispatchZswarm(
    { op: "status", sampleMs: 50, verbose: true, timeoutMs: 5000 },
    client,
    { env: {} },
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.peers[0].state, "exited");
  assert.equal(result.data.peers[0].command, "bash");
  assert.equal(result.data.peers[0].cwd, "/tmp");
  assert.equal(result.data.peers[0].tab, "T");
});

test("stalled pane does not prevent a healthy peer from dual-sampling", async () => {
  const counts = {};
  const client = createZellijClient({
    env: {},
    exec: async (args, opts) => {
      if (args.includes("list-sessions")) return ok("crew\n");
      if (args.includes("list-panes")) return ok(JSON.stringify(paneRows));
      const id = args.includes("terminal_2") ? "terminal_2" : "terminal_1";
      counts[id] = (counts[id] ?? 0) + 1;
      if (id === "terminal_2") {
        await delay(opts.timeoutMs);
        return { code: -1, stdout: "", stderr: "timed out" };
      }
      return ok(counts[id] === 1 ? "before" : "after");
    },
  });
  const result = await dispatchZswarm(
    { op: "status", session: "crew", timeoutMs: 800, sampleMs: 50 },
    client,
    { env: {} },
  );
  assert.equal(result.ok, true);
  const byId = Object.fromEntries(
    result.data.peers.map((p) => [p.id, p.state]),
  );
  // Healthy pane got both samples and classified busy; stalled is unknown.
  assert.equal(byId.terminal_1, "busy");
  assert.equal(byId.terminal_2, "unknown");
  assert.ok(counts.terminal_1 >= 2);
});
