process.env.ZSWARM_LOG = "0";
process.env.ZSWARM_BUS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callServe,
  createZellijClient,
  DEFAULT_SERVE_LISTEN,
  dispatchZswarm,
  installServeLogon,
  parseCliArgv,
  parseListenAddress,
  serveCallTimeout,
  serveChildEnv,
  serveLogonCommand,
  SERVE_TASK_NAME,
  startServe,
  uninstallServeLogon,
} from "../dist/index.js";

test("parseListenAddress accepts host:port, port-only, and tcp URLs", () => {
  assert.deepEqual(parseListenAddress(undefined), {
    host: "127.0.0.1",
    port: 9419,
    label: DEFAULT_SERVE_LISTEN,
  });
  assert.deepEqual(parseListenAddress("9419"), {
    host: "127.0.0.1",
    port: 9419,
    label: "127.0.0.1:9419",
  });
  assert.deepEqual(parseListenAddress("tcp://127.0.0.1:9419"), {
    host: "127.0.0.1",
    port: 9419,
    label: "127.0.0.1:9419",
  });
  assert.equal(parseListenAddress("127.0.0.1:0").port, 0);
  assert.throws(() => parseListenAddress("nope"), /host:port/);
});

test("serveLogonCommand is node + script + serve --listen", () => {
  assert.equal(
    serveLogonCommand(
      String.raw`C:\Program Files\nodejs\node.exe`,
      String.raw`C:\zswarm\cli.js`,
      "127.0.0.1:9419",
    ),
    `"C:\\Program Files\\nodejs\\node.exe" "C:\\zswarm\\cli.js" serve --listen 127.0.0.1:9419`,
  );
  assert.equal(SERVE_TASK_NAME, "zswarm-serve");
});

test("serveChildEnv drops ZSWARM_SERVE and ZSWARM_SSH so the worker stays local", () => {
  const child = serveChildEnv({
    ZSWARM_SERVE: "127.0.0.1:9419",
    ZSWARM_SSH: "user@host",
    PATH: "/bin",
  });
  assert.equal(child.ZSWARM_SERVE, undefined);
  assert.equal(child.ZSWARM_SSH, undefined);
  assert.equal(child.PATH, "/bin");
});

test("serveCallTimeout follows the op timeout plus slack", () => {
  assert.equal(serveCallTimeout({}), 65_000);
  assert.equal(serveCallTimeout({ timeoutMs: 1_000 }), 15_000);
  assert.equal(serveCallTimeout({ timeoutMs: 120_000 }), 125_000);
});

test("installServeLogon / --clear are Windows-only", async () => {
  await assert.rejects(
    () => installServeLogon({ platform: "darwin" }),
    /Windows logon task/,
  );
  await assert.rejects(
    () => uninstallServeLogon({ platform: "linux" }),
    /Windows-only/,
  );
});

test("parseCliArgv maps serve --listen", () => {
  assert.deepEqual(parseCliArgv(["serve", "--listen", "127.0.0.1:9419"]), {
    op: "serve",
    listen: "127.0.0.1:9419",
  });
  assert.deepEqual(parseCliArgv(["serve", "--install"]), {
    op: "serve",
    install: true,
  });
});

test("dispatch serve --listen is CLI-only", async () => {
  const result = await dispatchZswarm({ op: "serve", listen: "127.0.0.1:9419" });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /CLI-only/);
});

test("dispatch serve --clear on Unix fails without touching Zellij", {
  skip: process.platform === "win32",
}, async () => {
  const result = await dispatchZswarm({ op: "serve", clear: true });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /Windows-only/);
});

test("startServe + callServe round-trip JSONL", async () => {
  const { label, close } = await startServe("127.0.0.1:0", async (args) => ({
    ok: true,
    data: args,
  }));
  try {
    const result = await callServe(label, { op: "ping", to: "reviewer" }, 2_000);
    assert.deepEqual(result, { ok: true, data: { op: "ping", to: "reviewer" } });
  } finally {
    await close();
  }
});

test("ZSWARM_SERVE forwards dispatch when no client is injected", async () => {
  const { label, close } = await startServe("127.0.0.1:0", async (args) => ({
    ok: true,
    data: { forwarded: args.op },
  }));
  try {
    const result = await dispatchZswarm(
      { op: "list" },
      undefined,
      { env: { ZSWARM_SERVE: label } },
    );
    assert.deepEqual(result, { ok: true, data: { forwarded: "list" } });
  } finally {
    await close();
  }
});

test("an injected client is not skipped for ZSWARM_SERVE", async () => {
  const client = createZellijClient({
    exec: async (args) => {
      if (args.includes("list-sessions")) {
        return { code: 0, stdout: "demo\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: args.join(" ") };
    },
  });
  const result = await dispatchZswarm(
    { op: "sessions" },
    client,
    { env: { ZSWARM_SERVE: "127.0.0.1:1" } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.sessions[0], "demo");
});
