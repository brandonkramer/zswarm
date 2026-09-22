process.env.ZSWARM_LOG = "0";
process.env.ZSWARM_BUS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildServeTaskScript,
  callServe,
  DEFAULT_SERVE_INSTALL_TIMEOUT_MS,
  dispatchZswarm,
  DOCTOR_SCOPE_FIELD,
  DOCTOR_SCOPE_HOST,
  encodePowerShellCommand,
  installServeLogon,
  looksLikeCliEntrypoint,
  looksLikeMcpEntrypoint,
  parseCliArgv,
  probeServe,
  resolveServeCliLaunch,
  sameWindowsAccount,
  SERVE_LAUNCH_ID_ENV,
  SERVE_NOT_READY_CODE,
  SERVE_PROTOCOL,
  SERVE_TASK_NAME,
  SERVE_TASK_OWNED_CODE,
  serveLogonCommand,
  serveTaskChildEnv,
  startServe,
  uninstallServeLogon,
} from "../dist/index.js";

function tempDir(t, prefix = "zswarm-serve-install-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function writeCli(dir, name = "cli.js") {
  const scriptPath = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(scriptPath, "#!/usr/bin/env node\n");
  return scriptPath;
}

function actionOf(script) {
  if (script.includes("New-ScheduledTaskPrincipal")) return "register";
  if (script.includes("Unregister-ScheduledTask")) return "unregister";
  if (script.includes("Start-ScheduledTask") && !script.includes("Stop-ScheduledTask")) return "start";
  if (script.includes("Stop-ScheduledTask")) return "stop";
  return "inspect";
}

function taskHarness(opts = {}) {
  const currentUser = opts.currentUser ?? "DESKTOP\\me";
  const calls = [];
  let task = opts.task ?? null;
  const runPowerShell = async (script) => {
    calls.push(actionOf(script));
    const action = actionOf(script);
    if (action === "inspect") {
      if (!task) {
        return { code: 0, stdout: JSON.stringify({ exists: false, currentUser }), stderr: "" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          exists: true,
          currentUser,
          taskName: SERVE_TASK_NAME,
          state: task.state,
          userId: task.userId,
          logonType: task.logonType,
          runLevel: task.runLevel,
          execute: task.execute,
          arguments: task.arguments,
        }),
        stderr: "",
      };
    }
    if (action === "register") {
      if (opts.registerCode) {
        return { code: opts.registerCode, stdout: "", stderr: opts.registerStderr ?? "register failed" };
      }
      const match = script.match(/FromBase64String\('([^']+)'\)/);
      const command = match ? Buffer.from(match[1], "base64").toString("utf8") : "";
      task = {
        userId: currentUser,
        state: "Ready",
        execute: "cmd.exe",
        arguments: `/c ${command}`,
        logonType: "Interactive",
        runLevel: "Limited",
      };
      return {
        code: 0,
        stdout: JSON.stringify({
          registered: true,
          userId: currentUser,
          logonType: "Interactive",
          runLevel: "Limited",
          taskName: SERVE_TASK_NAME,
        }),
        stderr: "",
      };
    }
    if (action === "start") {
      if (task) task.state = "Running";
      return { code: 0, stdout: JSON.stringify({ started: true, taskName: SERVE_TASK_NAME }), stderr: "" };
    }
    if (action === "stop") {
      if (task) task.state = "Ready";
      return { code: 0, stdout: JSON.stringify({ stopped: true, taskName: SERVE_TASK_NAME }), stderr: "" };
    }
    task = null;
    return { code: 0, stdout: JSON.stringify({ cleared: true, taskName: SERVE_TASK_NAME }), stderr: "" };
  };
  return {
    calls,
    currentUser,
    runPowerShell,
    get task() {
      return task;
    },
    setTask(next) {
      task = next;
    },
  };
}

function hostReport(opts = {}) {
  const session = opts.session ?? "crew";
  const none = opts.none === true;
  const live = none ? [] : opts.live ?? [session];
  const sessionMissing = opts.sessionMissing === true;
  const ipcFail = opts.ipcFail === true;
  const checks = [
    {
      id: "zellij_binary",
      scope: "host",
      state: "ok",
      code: "zellij_ok",
      elapsedMs: 1,
      detail: { zellij: "zellij.exe" },
      remedy: null,
    },
    {
      id: "zellij_ipc",
      scope: "host",
      state: ipcFail ? "fail" : "ok",
      code: ipcFail ? "ipc_failed" : "ipc_local",
      elapsedMs: 1,
      detail: { transport: "local" },
      remedy: ipcFail ? "Point ZSWARM_TMP at the desktop TEMP" : null,
    },
    {
      id: "zellij_sessions",
      scope: "host",
      state: none ? "warn" : "ok",
      code: none ? "sessions_none" : "sessions_visible",
      elapsedMs: 1,
      detail: { live },
      remedy: none ? "Start a live session" : null,
    },
    {
      id: "session",
      scope: "host",
      state: sessionMissing ? "fail" : none ? "warn" : "ok",
      code: sessionMissing ? "session_missing" : none ? "session_unresolved" : "session_present",
      elapsedMs: 1,
      detail: { session: sessionMissing ? session : none ? null : session, live },
      remedy: sessionMissing || none ? "Start the requested Zellij session" : null,
    },
    {
      id: "bus_artifact",
      scope: "host",
      state: "warn",
      code: "bus_artifact_missing",
      elapsedMs: 0,
      detail: {},
      remedy: "Missing wasm is degraded performance",
    },
    {
      id: "bus_marker",
      scope: "host",
      state: "warn",
      code: "bus_marker_missing",
      elapsedMs: 0,
      detail: { session },
      remedy: "run zswarm bus --install on the crew host",
    },
    {
      id: "bus_instance",
      scope: "host",
      state: "warn",
      code: "bus_instance_absent",
      elapsedMs: 0,
      detail: { readiness: "unknown" },
      remedy: "doctor will not launch one",
    },
  ];
  return {
    ok: true,
    data: {
      route: {
        transport: "local",
        endpoint: "host",
        session: sessionMissing || none ? null : session,
        sessionOrigin: sessionMissing ? "explicit" : none ? "unresolved" : "explicit",
      },
      checks,
    },
  };
}

function assertNoSecret(value, token) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert.equal(text.includes(token), false, "token leaked");
  assert.equal(text.includes(Buffer.from(token, "utf8").toString("base64")), false);
}

async function listenDoctor(t, opts = {}) {
  const token = opts.token ?? "secret";
  const launchId = opts.launchId ?? "launch-real";
  const report = opts.report ?? hostReport(opts);
  const { label, close } = await startServe(
    "127.0.0.1:0",
    async (args) => {
      if (args.op === "doctor" || args[DOCTOR_SCOPE_FIELD] === DOCTOR_SCOPE_HOST) {
        if (typeof report === "function") return report(args);
        return report;
      }
      return { ok: true, data: args };
    },
    { token, launchId },
  );
  t.after(() => close());
  return { label, token, launchId };
}

function baseInput(t, extra = {}) {
  const dir = extra.dir ?? tempDir(t);
  const scriptPath = extra.scriptPath ?? writeCli(dir);
  const execPath = extra.execPath ?? process.execPath;
  const launchId = extra.launchId ?? "launch-1";
  const token = extra.token ?? "s3cret-token";
  const harness = extra.harness ?? taskHarness(extra.harnessOpts);
  return {
    platform: "win32",
    listen: extra.listen ?? "127.0.0.1:9419",
    env: extra.env ?? { ZSWARM_SERVE_TOKEN: token, ZSWARM_BIN: "C:\\zellij\\zellij.exe" },
    token,
    session: extra.session,
    timeoutMs: extra.timeoutMs ?? 2_000,
    launchId,
    execPath,
    scriptPath,
    argv: extra.argv ?? [execPath, scriptPath],
    runPowerShell: extra.runPowerShell ?? harness.runPowerShell,
    probeServe: extra.probeServe,
    callServe: extra.callServe,
    now: extra.now,
    sleep: extra.sleep,
    signal: extra.signal,
    harness,
    scriptPath,
    execPath,
    token,
    launchId,
  };
}

test("CLI parse covers the Windows install contract", () => {
  assert.equal(DEFAULT_SERVE_INSTALL_TIMEOUT_MS, 30_000);
  assert.deepEqual(
    parseCliArgv(["serve", "--install", "--listen", "127.0.0.1:9419", "--session", "crew", "--timeout-ms", "30000"]),
    {
      op: "serve",
      install: true,
      listen: "127.0.0.1:9419",
      session: "crew",
      timeoutMs: 30000,
    },
  );
});

test("resolveServeCliLaunch rejects MCP argv and finds a sibling CLI", (t) => {
  const dir = tempDir(t);
  const mcp = writeCli(dir, "mcp-server.js");
  assert.equal(looksLikeMcpEntrypoint(mcp), true);
  assert.equal(looksLikeCliEntrypoint(mcp), false);
  assert.throws(
    () => resolveServeCliLaunch({ argv: [process.execPath, mcp], env: {} }),
    /MCP|CLI launcher/,
  );
  const sibling = writeCli(dir, "zswarm.mjs");
  const resolved = resolveServeCliLaunch({ argv: [process.execPath, mcp], env: {} });
  assert.equal(resolved.scriptPath, sibling);
  assert.equal(looksLikeCliEntrypoint(sibling), true);
});

test("resolveServeCliLaunch honors ZSWARM_SERVE_CLI and refuses MCP there too", (t) => {
  const dir = tempDir(t, "zswarm serve cli ");
  const nested = join(dir, "Program Files", "zswarm");
  const cli = writeCli(nested, "cli.js");
  const resolved = resolveServeCliLaunch({
    argv: [process.execPath, writeCli(dir, "mcp-server.js")],
    env: { ZSWARM_SERVE_CLI: cli },
  });
  assert.equal(resolved.scriptPath, cli);
  assert.throws(
    () =>
      resolveServeCliLaunch({
        env: { ZSWARM_SERVE_CLI: writeCli(dir, "zswarm-mcp.mjs") },
      }),
    /MCP/,
  );
});

test("serveTaskChildEnv keeps host Zellij/IPC and strips controller routing", () => {
  const child = serveTaskChildEnv({
    ZSWARM_BIN: "C:\\zellij.exe",
    ZSWARM_TMP: "C:\\Users\\me\\AppData\\Local\\Temp",
    ZSWARM_SESSION: "crew",
    ZSWARM_SERVE: "127.0.0.1:9419",
    ZSWARM_SSH: "user@host",
    ZSWARM_SSH_MODE: "interactive",
    PATH: "C:\\Windows",
  });
  assert.equal(child.ZSWARM_BIN, "C:\\zellij.exe");
  assert.equal(child.ZSWARM_TMP, "C:\\Users\\me\\AppData\\Local\\Temp");
  assert.equal(child.ZSWARM_SESSION, "crew");
  assert.equal(child.PATH, "C:\\Windows");
  assert.equal(child.ZSWARM_SERVE, undefined);
  assert.equal(child.ZSWARM_SSH, undefined);
  assert.equal(child.ZSWARM_SSH_MODE, undefined);
});

test("sameWindowsAccount matches DOMAIN\\user with an unqualified name", () => {
  assert.equal(sameWindowsAccount("DESKTOP\\me", "me"), true);
  assert.equal(sameWindowsAccount("DESKTOP\\me", "DESKTOP\\other"), false);
  assert.equal(sameWindowsAccount("NT AUTHORITY\\SYSTEM", "me"), false);
});

test("register script is Interactive/Limited, quotes via base64, and never SYSTEM", () => {
  const command = serveLogonCommand(
    String.raw`C:\Program Files\nodejs\node.exe`,
    String.raw`C:\Program Files\zswarm\cli.js`,
    "127.0.0.1:9419",
    "s3cret",
    { [SERVE_LAUNCH_ID_ENV]: "launch-1", ZSWARM_BIN: String.raw`C:\Program Files\zellij.exe` },
  );
  const script = buildServeTaskScript("register", { command });
  assert.match(script, /LogonType Interactive/);
  assert.match(script, /RunLevel Limited/);
  assert.match(script, /AtLogOn/);
  assert.match(script, /WindowsIdentity/);
  assert.doesNotMatch(script, /SYSTEM/);
  assert.doesNotMatch(script, /RunLevel Highest/);
  assert.match(script, /FromBase64String/);
  assert.equal(script.includes("s3cret"), false);
  const start = buildServeTaskScript("start");
  assert.match(start, /Start-ScheduledTask/);
  assert.doesNotMatch(start, /Register-ScheduledTask/);
});

test("verified install needs authenticated hello plus host evidence", async (t) => {
  const server = await listenDoctor(t, { session: "crew" });
  const input = baseInput(t, {
    listen: server.label,
    token: server.token,
    launchId: server.launchId,
    session: "crew",
    env: { ZSWARM_SERVE_TOKEN: server.token, ZSWARM_BIN: "C:\\zellij.exe" },
  });
  const result = await installServeLogon(input);
  assert.equal(result.installed, true);
  assert.equal(result.ready, true);
  assert.equal(result.running, true);
  assert.equal(result.task, SERVE_TASK_NAME);
  assert.equal(result.listen, server.label);
  assert.equal(result.session, "crew");
  assert.deepEqual(result.sessions, ["crew"]);
  assert.equal(result.server.launchId, server.launchId);
  assert.equal(result.server.protocol, SERVE_PROTOCOL);
  assert.equal(result.principal.logonType, "Interactive");
  assert.equal(result.warning, undefined);
  assert.equal(input.harness.calls.filter((a) => a === "register").length, 1);
  assert.equal(input.harness.calls.filter((a) => a === "start").length, 1);
  assert.ok(input.harness.task.arguments.includes(SERVE_LAUNCH_ID_ENV));
  assert.ok(input.harness.task.arguments.includes("ZSWARM_BIN"));
  assert.equal(input.harness.task.arguments.includes("ZSWARM_SSH"), false);
  assertNoSecret(result, server.token);
  assertNoSecret(input.harness.calls, server.token);
});

test("TCP connect or Start-ScheduledTask is not readiness", async (t) => {
  const input = baseInput(t, {
    timeoutMs: 250,
    probeServe: async () => ({
      ok: false,
      error: { code: "serve_unreachable", message: "not listening yet" },
    }),
    sleep: async () => {},
  });
  await assert.rejects(() => installServeLogon(input), (err) => {
    assert.equal(err.code, "timeout");
    assert.equal(err.details.installed, true);
    assert.equal(err.details.ready, false);
    assert.equal(err.details.running, false);
    assert.equal(err.details.phase, "hello");
    assert.equal(err.details.cause, "serve_unreachable");
    assert.equal(input.harness.calls.filter((a) => a === "register").length, 1);
    assert.equal(input.harness.calls.filter((a) => a === "start").length, 1);
    assertNoSecret(err, input.token);
    return true;
  });
});

test("wrong token is not ready and does not leak the secret", async (t) => {
  const server = await listenDoctor(t, { session: "crew" });
  const input = baseInput(t, {
    listen: server.label,
    token: "wrong-token",
    launchId: server.launchId,
    timeoutMs: 300,
    env: { ZSWARM_SERVE_TOKEN: "wrong-token" },
    sleep: async () => {},
  });
  await assert.rejects(() => installServeLogon(input), (err) => {
    assert.ok(err.code === "timeout" || err.code === SERVE_NOT_READY_CODE);
    assert.equal(err.details.installed, true);
    assert.equal(err.details.ready, false);
    assert.equal(err.details.cause, "serve_unauthorized");
    assertNoSecret(err, "wrong-token");
    assertNoSecret(err, server.token);
    return true;
  });
});

test("incompatible and malformed hello are not ready", async (t) => {
  const incompatible = baseInput(t, {
    timeoutMs: 200,
    probeServe: async () => ({
      ok: false,
      error: { code: "serve_incompatible", message: "protocol 2" },
    }),
    sleep: async () => {},
  });
  await assert.rejects(() => installServeLogon(incompatible), (err) => {
    assert.equal(err.details.cause, "serve_incompatible");
    assert.equal(err.details.installed, true);
    assert.equal(err.details.ready, false);
    return true;
  });
  const malformed = baseInput(t, {
    timeoutMs: 200,
    probeServe: async () => ({
      ok: false,
      error: { code: "serve_protocol", message: "invalid hello" },
    }),
    sleep: async () => {},
  });
  await assert.rejects(() => installServeLogon(malformed), (err) => {
    assert.equal(err.details.cause, "serve_protocol");
    assert.equal(err.details.ready, false);
    return true;
  });
});

test("missing requested session is serve_not_ready after our launch identity", async (t) => {
  const server = await listenDoctor(t, {
    session: "crew",
    sessionMissing: true,
    live: ["other"],
  });
  const input = baseInput(t, {
    listen: server.label,
    token: server.token,
    launchId: server.launchId,
    session: "crew",
    env: { ZSWARM_SERVE_TOKEN: server.token },
  });
  await assert.rejects(() => installServeLogon(input), (err) => {
    assert.equal(err.code, SERVE_NOT_READY_CODE);
    assert.equal(err.details.installed, true);
    assert.equal(err.details.ready, false);
    assert.equal(err.details.phase, "session");
    assert.equal(err.details.cause, "session_missing");
    assert.equal(input.harness.calls.filter((a) => a === "unregister").length, 0);
    return true;
  });
});

test("failed IPC is not a ready crew", async (t) => {
  const server = await listenDoctor(t, { session: "crew", ipcFail: true });
  const input = baseInput(t, {
    listen: server.label,
    token: server.token,
    launchId: server.launchId,
    session: "crew",
    env: { ZSWARM_SERVE_TOKEN: server.token },
  });
  await assert.rejects(() => installServeLogon(input), (err) => {
    assert.equal(err.code, SERVE_NOT_READY_CODE);
    assert.equal(err.details.cause, "ipc_failed");
    assert.equal(err.details.phase, "host");
    assert.equal(err.details.ready, false);
    return true;
  });
});

test("no live sessions is ready server with an explicit warning", async (t) => {
  const server = await listenDoctor(t, { none: true });
  const input = baseInput(t, {
    listen: server.label,
    token: server.token,
    launchId: server.launchId,
    env: { ZSWARM_SERVE_TOKEN: server.token },
  });
  const result = await installServeLogon(input);
  assert.equal(result.ready, true);
  assert.equal(result.running, true);
  assert.deepEqual(result.sessions, []);
  assert.match(result.warning, /not a ready crew/);
});

test("stale listener with a different launchId is not this installation", async (t) => {
  const server = await listenDoctor(t, { launchId: "old-launch", session: "crew" });
  const input = baseInput(t, {
    listen: server.label,
    token: server.token,
    launchId: "new-launch",
    timeoutMs: 300,
    env: { ZSWARM_SERVE_TOKEN: server.token },
    sleep: async () => {},
  });
  await assert.rejects(() => installServeLogon(input), (err) => {
    assert.ok(err.code === "timeout" || err.code === SERVE_NOT_READY_CODE);
    assert.equal(err.details.cause, "stale_listener");
    assert.equal(err.details.installed, true);
    assert.equal(err.details.ready, false);
    assert.match(err.details.remedy, /does not kill/);
    return true;
  });
});

test("late hello success is readiness after retries without repeating register/start", async (t) => {
  const server = await listenDoctor(t, { session: "crew" });
  let probes = 0;
  const input = baseInput(t, {
    listen: server.label,
    token: server.token,
    launchId: server.launchId,
    session: "crew",
    env: { ZSWARM_SERVE_TOKEN: server.token },
    probeServe: async (target, options) => {
      probes += 1;
      if (probes < 3) {
        return { ok: false, error: { code: "serve_unreachable", message: "starting" } };
      }
      return probeServe(target, options);
    },
  });
  const result = await installServeLogon(input);
  assert.equal(result.ready, true);
  assert.ok(probes >= 3);
  assert.equal(input.harness.calls.filter((a) => a === "register").length, 1);
  assert.equal(input.harness.calls.filter((a) => a === "start").length, 1);
});

test("cancellation after registration keeps installed:true and does not rollback", async (t) => {
  const ac = new AbortController();
  const harness = taskHarness();
  const input = baseInput(t, {
    harness,
    signal: ac.signal,
    timeoutMs: 2_000,
    probeServe: async () => {
      ac.abort();
      return { ok: false, error: { code: "cancelled", message: "operation cancelled" } };
    },
  });
  await assert.rejects(() => installServeLogon(input), (err) => {
    assert.equal(err.code, "cancelled");
    assert.equal(err.details.installed, true);
    assert.equal(err.details.ready, false);
    assert.equal(harness.calls.includes("unregister"), false);
    return true;
  });
});

test("already-running matching task is not restarted", async (t) => {
  const server = await listenDoctor(t, { session: "crew" });
  const dir = tempDir(t);
  const scriptPath = writeCli(dir);
  const launchId = server.launchId;
  const token = server.token;
  const command = serveLogonCommand(process.execPath, scriptPath, server.label, token, {
    ZSWARM_BIN: "C:\\zellij.exe",
    [SERVE_LAUNCH_ID_ENV]: launchId,
  });
  const harness = taskHarness({
    task: {
      userId: "DESKTOP\\me",
      state: "Running",
      execute: "cmd.exe",
      arguments: `/c ${command}`,
      logonType: "Interactive",
      runLevel: "Limited",
    },
  });
  const result = await installServeLogon({
    platform: "win32",
    listen: server.label,
    env: { ZSWARM_SERVE_TOKEN: token, ZSWARM_BIN: "C:\\zellij.exe" },
    token,
    session: "crew",
    launchId,
    execPath: process.execPath,
    scriptPath,
    timeoutMs: 2_000,
    runPowerShell: harness.runPowerShell,
  });
  assert.equal(result.ready, true);
  assert.equal(harness.calls.filter((a) => a === "register").length, 0);
  assert.equal(harness.calls.filter((a) => a === "start").length, 0);
  assert.equal(harness.calls.filter((a) => a === "stop").length, 0);
});

test("changed token/listen restarts only the owned zswarm task", async (t) => {
  const server = await listenDoctor(t, { session: "crew" });
  const dir = tempDir(t);
  const scriptPath = writeCli(dir);
  const harness = taskHarness({
    task: {
      userId: "DESKTOP\\me",
      state: "Running",
      execute: "cmd.exe",
      arguments: `/c ${serveLogonCommand(process.execPath, scriptPath, "127.0.0.1:9419", "old-token")}`,
      logonType: "Interactive",
      runLevel: "Limited",
    },
  });
  const result = await installServeLogon({
    platform: "win32",
    listen: server.label,
    env: { ZSWARM_SERVE_TOKEN: server.token },
    token: server.token,
    session: "crew",
    launchId: server.launchId,
    execPath: process.execPath,
    scriptPath,
    timeoutMs: 2_000,
    runPowerShell: harness.runPowerShell,
  });
  assert.equal(result.ready, true);
  assert.deepEqual(
    harness.calls.filter((a) => a !== "inspect"),
    ["stop", "register", "start"],
  );
  assert.match(harness.task.arguments, new RegExp(server.label.replace(".", "\\.")));
  assert.equal(harness.task.arguments.includes("old-token"), false);
});

test("a task owned by another account is not overwritten", async (t) => {
  const harness = taskHarness({
    currentUser: "DESKTOP\\me",
    task: {
      userId: "NT AUTHORITY\\SYSTEM",
      state: "Running",
      execute: "cmd.exe",
      arguments: "/c leftover",
      logonType: "Interactive",
      runLevel: "Highest",
    },
  });
  const input = baseInput(t, { harness });
  await assert.rejects(() => installServeLogon(input), (err) => {
    assert.equal(err.code, SERVE_TASK_OWNED_CODE);
    assert.equal(err.details.installed, false);
    assert.equal(harness.calls.includes("register"), false);
    assert.equal(harness.calls.includes("stop"), false);
    return true;
  });
});

test("MCP argv fails before any task mutation", async (t) => {
  const dir = tempDir(t);
  const mcp = writeCli(dir, "mcp-server.js");
  const harness = taskHarness();
  await assert.rejects(
    () =>
      installServeLogon({
        platform: "win32",
        env: { ZSWARM_SERVE_TOKEN: "secret" },
        argv: [process.execPath, mcp],
        runPowerShell: harness.runPowerShell,
      }),
    /CLI launcher|MCP/,
  );
  assert.deepEqual(harness.calls, []);
});

test("explicit deps.env token is used instead of ambient process.env", async (t) => {
  process.env.ZSWARM_SERVE_TOKEN = "ambient-should-not-win";
  t.after(() => {
    delete process.env.ZSWARM_SERVE_TOKEN;
  });
  const server = await listenDoctor(t, { token: "embedded-token", session: "crew" });
  const input = baseInput(t, {
    listen: server.label,
    token: undefined,
    launchId: server.launchId,
    session: "crew",
    env: { ZSWARM_SERVE_TOKEN: "embedded-token" },
  });
  delete input.token;
  const result = await installServeLogon(input);
  assert.equal(result.ready, true);
  assert.ok(input.harness.task.arguments.includes("embedded-token"));
  assert.equal(input.harness.task.arguments.includes("ambient-should-not-win"), false);
  assertNoSecret(result, "embedded-token");
});

test("--session is a readiness target and is not baked into the task env", async (t) => {
  const server = await listenDoctor(t, { session: "crew" });
  const input = baseInput(t, {
    listen: server.label,
    token: server.token,
    launchId: server.launchId,
    session: "crew",
    env: { ZSWARM_SERVE_TOKEN: server.token, ZSWARM_BIN: "C:\\zellij.exe" },
  });
  const result = await installServeLogon(input);
  assert.equal(result.session, "crew");
  assert.equal(input.harness.task.arguments.includes("ZSWARM_SESSION=crew"), false);
});

test("dispatch propagates serve_not_ready details and redacts the token", async (t) => {
  const server = await listenDoctor(t, { session: "crew", sessionMissing: true, live: [] });
  const dir = tempDir(t);
  const scriptPath = writeCli(dir);
  const harness = taskHarness();
  const result = await dispatchZswarm(
    { op: "serve", install: true, listen: server.label, session: "crew", timeoutMs: 2_000 },
    undefined,
    {
      env: { ZSWARM_SERVE_TOKEN: server.token },
      serveInstall: {
        platform: "win32",
        launchId: server.launchId,
        execPath: process.execPath,
        scriptPath,
        runPowerShell: harness.runPowerShell,
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, SERVE_NOT_READY_CODE);
  assert.equal(result.error.details.installed, true);
  assert.equal(result.error.details.ready, false);
  assert.equal(result.error.details.running, false);
  assert.equal(result.error.details.cause, "session_missing");
  assertNoSecret(result, server.token);
});

test("serve --clear stops and removes an owned running task", async (t) => {
  const harness = taskHarness({
    task: {
      userId: "DESKTOP\\me",
      state: "Running",
      execute: "cmd.exe",
      arguments: "/c zswarm",
      logonType: "Interactive",
      runLevel: "Limited",
    },
  });
  const cleared = await uninstallServeLogon({
    platform: "win32",
    runPowerShell: harness.runPowerShell,
  });
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.stopped, true);
  assert.ok(harness.calls.includes("unregister"));
  assert.equal(harness.task, null);
});

test("serve --clear does not remove another account's task", async (t) => {
  const harness = taskHarness({
    currentUser: "DESKTOP\\me",
    task: {
      userId: "OTHER\\admin",
      state: "Running",
      execute: "cmd.exe",
      arguments: "/c zswarm",
      logonType: "Interactive",
      runLevel: "Limited",
    },
  });
  await assert.rejects(
    () => uninstallServeLogon({ platform: "win32", runPowerShell: harness.runPowerShell }),
    (err) => {
      assert.equal(err.code, SERVE_TASK_OWNED_CODE);
      assert.equal(harness.calls.includes("unregister"), false);
      return true;
    },
  );
});

test("register scripts parse on Windows PowerShell", {
  skip: process.platform !== "win32",
}, (t) => {
  const dir = tempDir(t);
  const command = serveLogonCommand(
    String.raw`C:\Program Files\nodejs\node.exe`,
    String.raw`C:\Program Files\zswarm\cli.js`,
    "127.0.0.1:9419",
    "s3cret",
    { [SERVE_LAUNCH_ID_ENV]: "launch-1" },
  );
  for (const action of ["inspect", "register", "start", "stop", "unregister"]) {
    const script = buildServeTaskScript(action, { command });
    const file = join(dir, `${action}.ps1`);
    writeFileSync(file, script);
    const encoded = encodePowerShellCommand(
      `$e=$null; $n=$null; [void][System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(file)}, [ref]$n, [ref]$e); if ($e) { $e | ForEach-Object { $_.ToString() }; exit 1 }`,
    );
    const spawned = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    assert.equal(spawned.status, 0, `${action} parse failed: ${spawned.stdout}\n${spawned.stderr}`);
  }
});
