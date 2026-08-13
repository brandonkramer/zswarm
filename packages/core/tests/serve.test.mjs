process.env.ZSWARM_LOG = "0";
process.env.ZSWARM_BUS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import {
  callServe,
  createZellijClient,
  DEFAULT_SERVE_LISTEN,
  dispatchZswarm,
  installServeLogon,
  parseCliArgv,
  parseListenAddress,
  SERVE_CALL_TIMEOUT_CAP_MS,
  serveCallTimeout,
  serveChildEnv,
  serveLogonCommand,
  redactServeSecret,
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
  assert.deepEqual(parseListenAddress("[::1]:9419"), {
    host: "::1",
    port: 9419,
    label: "[::1]:9419",
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

test("serveLogonCommand persists ZSWARM_SERVE_TOKEN in the logon command", () => {
  assert.equal(
    serveLogonCommand(
      String.raw`C:\Program Files\nodejs\node.exe`,
      String.raw`C:\zswarm\cli.js`,
      "127.0.0.1:9419",
      "s3cret",
    ),
    `set "ZSWARM_SERVE_TOKEN=s3cret"&& "C:\\Program Files\\nodejs\\node.exe" "C:\\zswarm\\cli.js" serve --listen 127.0.0.1:9419`,
  );
  assert.throws(
    () =>
      serveLogonCommand(
        String.raw`C:\node.exe`,
        String.raw`C:\zswarm\cli.js`,
        "127.0.0.1:9419",
        'bad"token',
      ),
    /quotes/,
  );
});

test("redactServeSecret strips the token from install output", () => {
  const command = serveLogonCommand(
    String.raw`C:\node.exe`,
    String.raw`C:\zswarm\cli.js`,
    "127.0.0.1:9419",
    "s3cret",
  );
  assert.ok(command.includes("s3cret"));
  const redacted = redactServeSecret(command, "s3cret");
  assert.equal(redacted.includes("s3cret"), false);
  assert.ok(redacted.includes("ZSWARM_SERVE_TOKEN=***"));
});

test("serveChildEnv drops ZSWARM_SERVE and ZSWARM_SSH so the worker stays local", () => {
  const child = serveChildEnv({
    ZSWARM_SERVE: "127.0.0.1:9419",
    ZSWARM_SSH: "user@host",
    ZSWARM_SERVE_TOKEN: "secret",
    PATH: "/bin",
  });
  assert.equal(child.ZSWARM_SERVE, undefined);
  assert.equal(child.ZSWARM_SSH, undefined);
  assert.equal(child.ZSWARM_SERVE_TOKEN, "secret");
  assert.equal(child.PATH, "/bin");
});

test("serveCallTimeout follows the op timeout plus slack", () => {
  assert.equal(serveCallTimeout({}), 65_000);
  assert.equal(serveCallTimeout({ timeoutMs: 1_000 }), 15_000);
  assert.equal(serveCallTimeout({ timeoutMs: 120_000 }), 125_000);
  assert.equal(serveCallTimeout({ timeoutMs: 900_000 }), 905_000);
  assert.equal(
    serveCallTimeout({ timeoutMs: 20 * 60_000 }),
    SERVE_CALL_TIMEOUT_CAP_MS,
  );
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
  await assert.rejects(
    () => installServeLogon({ platform: "win32", env: {} }),
    /ZSWARM_SERVE_TOKEN/,
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
  const { label, close } = await startServe(
    "127.0.0.1:0",
    async (args) => ({
      ok: true,
      data: args,
    }),
    { token: "secret" },
  );
  try {
    const result = await callServe(label, { op: "ping", to: "reviewer" }, 2_000, "secret");
    assert.deepEqual(result, { ok: true, data: { op: "ping", to: "reviewer" } });
  } finally {
    await close();
  }
});

test("ZSWARM_SERVE forwards dispatch when no client is injected", async () => {
  const { label, close } = await startServe(
    "127.0.0.1:0",
    async (args) => ({
      ok: true,
      data: { forwarded: args.op },
    }),
    { token: "secret" },
  );
  try {
    const result = await dispatchZswarm(
      { op: "list" },
      undefined,
      { env: { ZSWARM_SERVE: label, ZSWARM_SERVE_TOKEN: "secret" } },
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

test("startServe requires ZSWARM_SERVE_TOKEN on loopback", async () => {
  await assert.rejects(
    () => startServe("127.0.0.1:0", async () => ({ ok: true, data: {} })),
    /ZSWARM_SERVE_TOKEN/,
  );
});

test("startServe refuses a non-loopback bind even with a token", async () => {
  await assert.rejects(
    () =>
      startServe("0.0.0.0:0", async () => ({ ok: true, data: {} }), {
        token: "secret",
      }),
    /loopback/,
  );
  await assert.rejects(
    () =>
      installServeLogon({
        platform: "win32",
        listen: "0.0.0.0:9419",
      }),
    /loopback/,
  );
});

test("startServe requires a matching token when one is configured", async () => {
  const { label, close } = await startServe(
    "127.0.0.1:0",
    async (args) => ({ ok: true, data: args }),
    { token: "secret" },
  );
  try {
    const denied = await callServe(label, { op: "ping" }, 2_000);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "serve_unauthorized");
    const allowed = await callServe(label, { op: "ping" }, 2_000, "secret");
    assert.deepEqual(allowed, { ok: true, data: { op: "ping" } });
  } finally {
    await close();
  }
});

test("startServe drops an oversized request", async () => {
  const { label, close } = await startServe(
    "127.0.0.1:0",
    async () => ({ ok: true, data: {} }),
    { token: "secret", maxRequestBytes: 32 },
  );
  try {
    const result = await callServe(label, { op: "x".repeat(64) }, 2_000, "secret");
    assert.equal(result.ok, false);
    assert.match(result.error.message, /exceeded/);
  } finally {
    await close();
  }
});

test("startServe drops an idle socket that never sends a request", async () => {
  const { label, close } = await startServe(
    "127.0.0.1:0",
    async () => ({ ok: true, data: {} }),
    { token: "secret", idleTimeoutMs: 40 },
  );
  try {
    const { host, port } = parseListenAddress(label);
    await new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      const fail = setTimeout(() => reject(new Error("idle socket was not closed")), 1_000);
      socket.on("error", () => {});
      socket.on("close", () => {
        clearTimeout(fail);
        resolve(undefined);
      });
    });
  } finally {
    await close();
  }
});

test("startServe caps concurrent connections", async () => {
  const { label, close } = await startServe(
    "127.0.0.1:0",
    async () => ({ ok: true, data: {} }),
    { token: "secret", maxConnections: 1, idleTimeoutMs: 5_000 },
  );
  try {
    const { host, port } = parseListenAddress(label);
    const first = connect({ host, port });
    await new Promise((resolve, reject) => {
      first.once("connect", resolve);
      first.once("error", reject);
    });
    const second = connect({ host, port });
    await new Promise((resolve, reject) => {
      const fail = setTimeout(() => reject(new Error("extra connection was not dropped")), 1_000);
      second.on("error", () => {});
      second.on("close", () => {
        clearTimeout(fail);
        resolve(undefined);
      });
    });
    first.destroy();
  } finally {
    await close();
  }
});

test("startServe handles a socket error before auth", async () => {
  const { label, close } = await startServe(
    "127.0.0.1:0",
    async (args) => ({ ok: true, data: args }),
    { token: "secret" },
  );
  try {
    const { host, port } = parseListenAddress(label);
    const socket = connect({ host, port });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.destroy();
    const result = await callServe(label, { op: "ping" }, 2_000, "secret");
    assert.deepEqual(result, { ok: true, data: { op: "ping" } });
  } finally {
    await close();
  }
});
