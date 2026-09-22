process.env.ZSWARM_LOG = "0";
process.env.ZSWARM_BUS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import {
  callServe,
  createZellijClient,
  DEFAULT_SERVE_LISTEN,
  dispatchZswarm,
  installServeLogon,
  parseCliArgv,
  parseListenAddress,
  probeServe,
  SERVE_CALL_TIMEOUT_CAP_MS,
  SERVE_CAPTURE_BUDGET_BYTES,
  SERVE_CAPABILITY_HELLO,
  SERVE_CAPABILITY_DOCTOR,
  SERVE_CONTROL_FIELD,
  SERVE_HELLO_CONTROL,
  SERVE_MAX_HELLO_BYTES,
  SERVE_MAX_REPLY_BYTES,
  SERVE_PROTOCOL,
  serveCallTimeout,
  serveChildEnv,
  serveLogonCommand,
  serveMaxReplyBytes,
  redactServeSecret,
  SERVE_TASK_NAME,
  startServe,
  uninstallServeLogon,
} from "../dist/index.js";

const CORE_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

function listenRaw(onSocket) {
  return new Promise((resolve, reject) => {
    const server = createServer(onSocket);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        label: `127.0.0.1:${port}`,
        close: () =>
          new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

function listenLegacy(handler) {
  return listenRaw((socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const parsed = JSON.parse(buf.slice(0, nl));
      const result = handler(parsed);
      socket.write(`${JSON.stringify(result)}\n`);
    });
  });
}

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
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { forwarded: "list" });
    assert.equal(result.context.transport, "serve");
    assert.equal(result.context.host, label);
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
  assert.deepEqual(result.data.sessions[0], {
    name: "demo",
    exited: false,
    current: false,
  });
  assert.equal(result.data.filter, "live");
  assert.equal(result.data.transport.kind, "local");
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

test("authenticated hello returns protocol identity and never dispatches", async () => {
  let dispatched = 0;
  const { label, close } = await startServe(
    "127.0.0.1:0",
    async () => {
      dispatched += 1;
      throw new Error("zellij must not run for hello");
    },
    { token: "secret" },
  );
  try {
    const preferred = await callServe(
      label,
      { [SERVE_CONTROL_FIELD]: SERVE_HELLO_CONTROL },
      2_000,
      "secret",
    );
    assert.equal(preferred.ok, true);
    assert.equal(preferred.data.protocol, SERVE_PROTOCOL);
    assert.match(preferred.data.serverId, /^[0-9a-f-]{36}$/i);
    assert.equal(preferred.data.hostname, hostname() || "unknown");
    assert.equal(preferred.data.platform, process.platform);
    assert.equal(preferred.data.version, CORE_VERSION);
    assert.deepEqual(preferred.data.capabilities, [SERVE_CAPABILITY_HELLO, SERVE_CAPABILITY_DOCTOR]);
    const compatible = await callServe(label, { op: "hello" }, 2_000, "secret");
    assert.equal(compatible.ok, true);
    assert.equal(compatible.data.serverId, preferred.data.serverId);
    assert.equal(dispatched, 0);
  } finally {
    await close();
  }
});

test("probeServe validates hello and stays distinct across startServe instances", async () => {
  const first = await startServe("127.0.0.1:0", async () => ({ ok: true, data: {} }), {
    token: "secret",
  });
  const second = await startServe("127.0.0.1:0", async () => ({ ok: true, data: {} }), {
    token: "secret",
  });
  try {
    const a = await probeServe(first.label, { token: "secret", timeoutMs: 2_000 });
    const b = await probeServe(second.label, { token: "secret", timeoutMs: 2_000 });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.data.protocol, 1);
    assert.notEqual(a.data.serverId, b.data.serverId);
    assert.equal(a.data.version, CORE_VERSION);
  } finally {
    await first.close();
    await second.close();
  }
});

test("ambiguous control+op and unknown controls are protocol errors without dispatch", async () => {
  let dispatched = 0;
  const { label, close } = await startServe(
    "127.0.0.1:0",
    async (args) => {
      dispatched += 1;
      return { ok: true, data: args };
    },
    { token: "secret" },
  );
  try {
    const ambiguous = await callServe(
      label,
      { [SERVE_CONTROL_FIELD]: SERVE_HELLO_CONTROL, op: "list" },
      2_000,
      "secret",
    );
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.error.code, "serve_protocol");
    assert.match(ambiguous.error.message, /serveControl and op/);
    const unknown = await callServe(
      label,
      { [SERVE_CONTROL_FIELD]: "drain" },
      2_000,
      "secret",
    );
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "serve_protocol");
    assert.match(unknown.error.message, /unknown serve control/);
    assert.equal(dispatched, 0);
    const allowed = await callServe(label, { op: "list" }, 2_000, "secret");
    assert.deepEqual(allowed, { ok: true, data: { op: "list" } });
    assert.equal(dispatched, 1);
  } finally {
    await close();
  }
});

test("wrong token is serve_unauthorized with no hello metadata", async () => {
  const { label, close } = await startServe(
    "127.0.0.1:0",
    async () => ({ ok: true, data: { leaked: true } }),
    { token: "secret" },
  );
  try {
    const missing = await probeServe(label, { timeoutMs: 2_000 });
    const wrong = await probeServe(label, { token: "nope", timeoutMs: 2_000 });
    for (const result of [missing, wrong]) {
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "serve_unauthorized");
      assert.equal(result.error.details, undefined);
      assert.equal(Object.hasOwn(result, "data"), false);
      assert.equal(JSON.stringify(result).includes("protocol"), false);
      assert.equal(JSON.stringify(result).includes("serverId"), false);
    }
  } finally {
    await close();
  }
});

test("dispatch serve hello never reaches Zellij; ordinary ops still forward", async () => {
  let dispatched = 0;
  const { label, close } = await startServe(
    "127.0.0.1:0",
    async (args) => {
      dispatched += 1;
      return { ok: true, data: { forwarded: args.op } };
    },
    { token: "secret" },
  );
  try {
    const hello = await dispatchZswarm(
      { op: "hello" },
      undefined,
      { env: { ZSWARM_SERVE: label, ZSWARM_SERVE_TOKEN: "secret" } },
    );
    assert.equal(hello.ok, true);
    assert.equal(hello.data.protocol, SERVE_PROTOCOL);
    assert.equal(hello.context.transport, "serve");
    assert.equal(dispatched, 0);
    const listed = await dispatchZswarm(
      { op: "list" },
      undefined,
      { env: { ZSWARM_SERVE: label, ZSWARM_SERVE_TOKEN: "secret" } },
    );
    assert.deepEqual(listed.data, { forwarded: "list" });
    assert.equal(dispatched, 1);
  } finally {
    await close();
  }
});

test("legacy serve still runs ordinary commands; probeServe is not healthy", async () => {
  const { label, close } = await listenLegacy((req) => {
    const { serveToken, ...rest } = req;
    if (serveToken !== "secret") {
      return { ok: false, error: { code: "serve_unauthorized", message: "nope" } };
    }
    return { ok: true, data: rest };
  });
  try {
    const listed = await callServe(label, { op: "list" }, 2_000, "secret");
    assert.deepEqual(listed, { ok: true, data: { op: "list" } });
    const probe = await probeServe(label, { token: "secret", timeoutMs: 2_000 });
    assert.equal(probe.ok, false);
    assert.equal(probe.error.code, "serve_hello_unsupported");
    assert.equal(probe.error.details.phase, "hello");
    assert.equal(probe.error.details.delivery, "replied");
    assert.equal(probe.error.details.endpoint, label);
    assert.match(probe.error.details.remedy, /Ordinary commands still work/);
  } finally {
    await close();
  }
});

test("incompatible hello protocol is an explicit probe failure", async () => {
  const { label, close } = await listenLegacy(() => ({
    ok: true,
    data: {
      protocol: 2,
      serverId: "other",
      hostname: "host",
      platform: "linux",
      version: "0.0.0",
      capabilities: ["hello"],
    },
  }));
  try {
    const probe = await probeServe(label, { token: "secret", timeoutMs: 2_000 });
    assert.equal(probe.ok, false);
    assert.equal(probe.error.code, "serve_incompatible");
    assert.equal(probe.error.details.phase, "hello");
    assert.equal(probe.error.details.delivery, "replied");
  } finally {
    await close();
  }
});

test("malformed protocol-1 hello is serve_protocol, not healthy", async () => {
  const { label, close } = await listenLegacy(() => ({
    ok: true,
    data: { protocol: 1, serverId: "", hostname: "h", platform: "linux", version: "1", capabilities: ["hello"] },
  }));
  try {
    const probe = await probeServe(label, { token: "secret", timeoutMs: 2_000 });
    assert.equal(probe.ok, false);
    assert.equal(probe.error.code, "serve_protocol");
    assert.equal(probe.error.details.delivery, "replied");
  } finally {
    await close();
  }
});

test("EOF before a complete reply settles promptly with uncertain delivery", async () => {
  const { label, close } = await listenRaw((socket) => {
    socket.on("data", () => socket.end());
  });
  try {
    const started = Date.now();
    const result = await callServe(label, { op: "ping" }, 10_000, "secret");
    assert.ok(Date.now() - started < 2_000, "EOF must not wait for the call timeout");
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "serve_protocol");
    assert.equal(result.error.details.phase, "request");
    assert.equal(result.error.details.delivery, "uncertain");
    assert.equal(result.error.details.endpoint, label);
    assert.match(result.error.details.remedy, /uncertain/);
  } finally {
    await close();
  }
});

test("truncated JSONL settles without echoing the payload", async () => {
  const marker = "UNIQUE_TRUNCATED_PAYLOAD";
  const { label, close } = await listenRaw((socket) => {
    socket.on("data", () => {
      socket.write(`{"ok":true,"data":{"${marker}":`);
      socket.end();
    });
  });
  try {
    const started = Date.now();
    const result = await callServe(label, { op: "ping" }, 10_000, "secret");
    assert.ok(Date.now() - started < 2_000);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "serve_protocol");
    assert.equal(result.error.details.delivery, "uncertain");
    assert.equal(result.error.message.includes(marker), false);
    assert.equal(JSON.stringify(result).includes(marker), false);
  } finally {
    await close();
  }
});

test("oversized replies are bounded and do not echo the body", async () => {
  const { label, close } = await listenRaw((socket) => {
    socket.on("data", () => {
      socket.write("x".repeat(64));
    });
  });
  try {
    const result = await callServe(label, { op: "ping" }, {
      timeoutMs: 2_000,
      token: "secret",
      maxReplyBytes: 32,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "serve_protocol");
    assert.match(result.error.message, /exceeded/);
    assert.equal(result.error.message.includes("xxxx"), false);
    assert.equal(SERVE_CAPTURE_BUDGET_BYTES, 8 * 1024 * 1024);
    assert.equal(SERVE_MAX_REPLY_BYTES, SERVE_CAPTURE_BUDGET_BYTES * 2 + 256 * 1024);
    assert.equal(SERVE_MAX_HELLO_BYTES, 16 * 1024);
    assert.equal(serveMaxReplyBytes({}), SERVE_MAX_REPLY_BYTES);
    assert.equal(serveMaxReplyBytes({ ZSWARM_SERVE_MAX_REPLY_BYTES: "80" }), 80);
    assert.equal(serveMaxReplyBytes({ ZSWARM_SERVE_MAX_REPLY_BYTES: "nope" }), SERVE_MAX_REPLY_BYTES);
  } finally {
    await close();
  }
});

test("reply cap counts UTF-8 frame bytes including the newline", async () => {
  const frame = `${JSON.stringify({ ok: true, data: "é".repeat(40) })}\n`;
  assert.equal(frame.length, 62);
  assert.equal(Buffer.byteLength(frame, "utf8"), 102);
  const marker = "é".repeat(40);
  const { label, close } = await listenRaw((socket) => {
    socket.on("data", () => socket.end(frame));
  });
  try {
    const denied = await callServe(label, { op: "ping" }, {
      timeoutMs: 2_000,
      token: "secret",
      maxReplyBytes: 80,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "serve_protocol");
    assert.match(denied.error.message, /exceeded 80 bytes/);
    assert.equal(denied.error.message.includes(marker), false);
    assert.equal(JSON.stringify(denied).includes(marker), false);
  } finally {
    await close();
  }
});

test("multibyte replies under the UTF-8 cap succeed even when split across chunks", async () => {
  const frame = Buffer.from(`${JSON.stringify({ ok: true, data: "é".repeat(10) })}\n`, "utf8");
  assert.ok(frame.length < 80);
  const splitAt = frame.indexOf(Buffer.from("é", "utf8")) + 1;
  assert.equal(frame[splitAt - 1], 0xc3);
  const { label, close } = await listenRaw((socket) => {
    socket.on("data", () => {
      socket.write(frame.subarray(0, splitAt));
      socket.write(frame.subarray(splitAt));
    });
  });
  try {
    const result = await callServe(label, { op: "ping" }, {
      timeoutMs: 2_000,
      token: "secret",
      maxReplyBytes: 80,
    });
    assert.deepEqual(result, { ok: true, data: "é".repeat(10) });
  } finally {
    await close();
  }
});

test("dump-sized serve replies succeed through dispatch without an SDK override", async () => {
  const text = "x".repeat(Math.ceil(1.2 * 1024 * 1024));
  const { label, close } = await startServe(
    "127.0.0.1:0",
    async (args) => {
      assert.equal(args.op, "dump");
      return {
        ok: true,
        data: {
          session: "crew",
          to: "1",
          text,
          truncated: false,
          chars: text.length,
          max: 0,
        },
      };
    },
    { token: "secret" },
  );
  try {
    const result = await dispatchZswarm(
      { op: "dump", to: "1", max: 0 },
      undefined,
      { env: { ZSWARM_SERVE: label, ZSWARM_SERVE_TOKEN: "secret" } },
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    assert.equal(result.data.text.length, text.length);
    assert.equal(result.data.max, 0);
    assert.ok(Buffer.byteLength(JSON.stringify(result.data.text), "utf8") > 1024 * 1024);
  } finally {
    await close();
  }
});

test("success envelopes require a data field; null data is valid", async () => {
  const replies = [
    { body: `${JSON.stringify({ ok: true })}\n`, valid: false },
    { body: `${JSON.stringify({ ok: true, error: { code: "failed", message: "nope" } })}\n`, valid: false },
    { body: `${JSON.stringify({ ok: true, data: null })}\n`, valid: true },
    { body: `${JSON.stringify({ ok: true, data: { text: "ok" } })}\n`, valid: true },
  ];
  for (const { body, valid } of replies) {
    const { label, close } = await listenRaw((socket) => {
      socket.on("data", () => socket.end(body));
    });
    try {
      const result = await callServe(label, { op: "dump" }, 2_000, "secret");
      if (valid) {
        assert.equal(result.ok, true, body);
        assert.equal(Object.hasOwn(result, "data"), true);
      } else {
        assert.equal(result.ok, false, body);
        assert.equal(result.error.code, "serve_protocol");
        assert.equal(result.error.details.phase, "request");
        assert.equal(result.error.details.delivery, "replied");
        assert.equal(JSON.stringify(result).includes(body.trim()), false);
      }
    } finally {
      await close();
    }
  }
});

test("unreachable connect is not a dead-tunnel label for later auth errors", async () => {
  const missing = await callServe("127.0.0.1:1", { op: "ping" }, 2_000, "secret");
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "serve_unreachable");
  assert.equal(missing.error.details.phase, "connect");
  assert.equal(missing.error.details.delivery, "not_sent");
  assert.match(missing.error.details.remedy, /does not fall back to SSH/);

  const { label, close } = await startServe(
    "127.0.0.1:0",
    async () => ({ ok: true, data: { ran: true } }),
    { token: "secret" },
  );
  try {
    const denied = await callServe(label, { op: "ping" }, 2_000, "wrong");
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "serve_unauthorized");
    assert.equal(denied.error.details, undefined);
    assert.equal(JSON.stringify(denied).includes("dead"), false);
    assert.equal(JSON.stringify(denied).includes("unreachable"), false);
  } finally {
    await close();
  }
});

test("connect timeout is bounded inside a long overall deadline", async () => {
  const started = Date.now();
  const result = await callServe("192.0.2.1:1", { op: "wait" }, {
    timeoutMs: 60_000,
    token: "secret",
    connectTimeoutMs: 250,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `connect bound should not consume the wait budget (${elapsed}ms)`);
  assert.equal(result.ok, false);
  assert.ok(result.error.code === "timeout" || result.error.code === "serve_unreachable");
  assert.equal(result.error.details.phase, "connect");
  assert.equal(result.error.details.delivery, "not_sent");
});

test("AbortSignal cancels an in-flight serve call and cleans up", async () => {
  const abort = new AbortController();
  let entered = false;
  const { label, close } = await startServe(
    "127.0.0.1:0",
    async () => {
      entered = true;
      return new Promise(() => {});
    },
    { token: "secret" },
  );
  try {
    const pending = callServe(label, { op: "ping" }, 30_000, "secret", abort.signal);
    const waitStart = Date.now();
    while (!entered && Date.now() - waitStart < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(entered, true);
    abort.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "cancelled");
    assert.equal(result.error.details.phase, "request");
    assert.equal(result.error.details.delivery, "uncertain");
  } finally {
    await close();
  }
});
