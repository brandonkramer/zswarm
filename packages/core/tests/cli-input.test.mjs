import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { startServe, parseCliArgv, mcpInputSchema, createZellijClient } from "../dist/index.js";
import { readBodyFile } from "../../cli/dist/input.js";
import { routingNotice } from "../../cli/dist/output.js";

const cli = fileURLToPath(new URL("../../cli/dist/cli.js", import.meta.url));
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "zswarm-seven-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}
function runCli(args, extraEnv = {}, input = "") {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ZSWARM|ZELLIJ)_/.test(key)));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...env, ...extraEnv }, stdio: "pipe" });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", (err) => { if (err.code !== "EPIPE") reject(err); });
    child.stdin.end(input);
  });
}

test("body-file is CLI input and absent from MCP's protocol schema", () => {
  assert.equal(Object.hasOwn(mcpInputSchema().properties, "bodyFile"), false);
  assert.deepEqual(parseCliArgv(["--body-file", "-", "send", "9"]), { op: "send", bodyFile: "-", to: "9" });
});

test("body-file rejects competing sources, duplicates, and other operations", () => {
  for (const args of [
    ["send", "9", "--body", "", "--body-file", "missing"],
    ["send", "9", "--text", "hello", "--body-file", "missing"],
    ["send", "9", "hello", "--body-file", "missing"],
    ["send", "9", "--body-file", "a", "--body-file", "b"],
    ["send", "9", "--body", "one", "--text", "two"],
    ["dump", "9", "--body-file", "missing"],
  ]) assert.throws(() => parseCliArgv(args), (e) => e.code === "usage");
});

test("UTF-8 bodies preserve whitespace and split multibyte stdin", async (t) => {
  const text = "\n  hello 🐕\r\n$(literal) \"quote\" " + String.fromCharCode(96) + "\n\n";
  const path = join(temp(t), "handoff with spaces.md");
  writeFileSync(path, text);
  const fromFile = await readBodyFile({ op: "send", bodyFile: path });
  assert.equal(fromFile.body, text);
  assert.equal(Object.hasOwn(fromFile, "bodyFile"), false);
  const bytes = Buffer.from(text);
  const fromStdin = await readBodyFile({ op: "send", bodyFile: "-" }, Readable.from([...bytes].map((b) => Buffer.from([b]))));
  assert.equal(fromStdin.body, text);
  const client = createZellijClient({ env: {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
  assert.equal(client.formatPeerMessage("lead", text), "[zswarm from=lead]\n" + text);
});

test("CLI file and stdin bodies are read locally before serve forwarding", async (t) => {
  const text = "\ncrew handoff 🐕\n\n";
  const path = join(temp(t), "local handoff.md");
  writeFileSync(path, text);
  const requests = [];
  const server = await startServe("127.0.0.1:0", async (request) => {
    requests.push(request);
    return { ok: true, data: { body: request.body, session: "remote-crew" } };
  }, { token: "test-token" });
  t.after(() => server.close());
  const env = { ZSWARM_SERVE: server.label, ZSWARM_SERVE_TOKEN: "test-token", ZSWARM_SSH: "unused-host" };
  for (const [bodyFile, input] of [[path, ""], ["-", text]]) {
    const result = await runCli(["send", "9", "--body-file", bodyFile], env, input);
    assert.equal(result.code, 0, result.stderr);
    const reply = JSON.parse(result.stdout);
    assert.equal(reply.data.body, text);
    assert.equal(reply.context.transport, "serve");
    assert.equal(result.stderr, "");
  }
  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => !Object.hasOwn(r, "bodyFile")));
});

test("unreadable files and stdin failures stop before dispatch", async (t) => {
  const missing = join(temp(t), "absent.md");
  const result = await runCli(["send", "9", "--body-file", missing], { ZSWARM_SSH: "-V" });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "body_file_read");
  async function* failed() { throw new Error("stdin failed"); }
  await assert.rejects(readBodyFile({ op: "send", bodyFile: "-" }, failed()), (e) => e.code === "body_file_read");
});

test("body conflicts fail before file reading or remote contact", async () => {
  const result = await runCli(["send", "9", "--body", "hello", "--body-file", "absent"], { ZSWARM_SSH: "-V" });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /cannot be combined/);
  assert.equal(result.stdout, "");
});

test("routing notice is interactive-only and escapes host/session labels", () => {
  const result = {
    ok: true, data: {}, context: {
      transport: "ssh", host: "windows\nhost", session: "crew\u001b",
      origin: { transport: "ZSWARM_SSH", session: "arg" },
    },
  };
  assert.equal(routingNotice(result, false), "");
  const notice = routingNotice(result, true);
  assert.match(notice, /ssh "windows\\nhost"/);
  assert.match(notice, /ZSWARM_SSH/);
  assert.equal(notice.split("\n").length, 2);
  assert.equal(notice.includes("\u001b"), false);
});
