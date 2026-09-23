process.env.ZSWARM_LOG = "0";
process.env.ZSWARM_BUS = "0";

import { describe, test } from "node:test";
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
  loadPolicy,
  looksLikeCliEntrypoint,
  looksLikeMcpEntrypoint,
  parseCliArgv,
  probeServe,
  resolveServeCliLaunch,
  sameWindowsAccount,
  sameWindowsSid,
  SERVE_CORE_VERSION,
  SERVE_LAUNCH_ID_ENV,
  SERVE_NOT_READY_CODE,
  SERVE_PROTOCOL,
  SERVE_TASK_NAME,
  SERVE_TASK_OWNED_CODE,
  serveCommandFingerprint,
  serveLogonCommand,
  serveTaskChildEnv,
  serveTaskLaunchEnv,
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

function sidForAccount(userId, currentUser, currentSid, otherSid) {
  if (!userId) return "";
  if (userId === currentUser) return currentSid;
  if (/(?:^|\\)(system|local service|network service)$/i.test(userId) || /^nt authority\\/i.test(userId)) {
    return "S-1-5-18";
  }
  return otherSid;
}

function taskHarness(opts = {}) {
  const currentUser = opts.currentUser ?? "DESKTOP\\me";
  const currentSid = opts.currentSid ?? "S-1-5-21-1-2-3-1001";
  const otherSid = opts.otherSid ?? "S-1-5-21-9-9-9-9999";
  const calls = [];
  let task = opts.task ?? null;
  let lastCommand64 = "";
  const runPowerShell = async (script) => {
    const action = actionOf(script);
    calls.push(action);
    let result;
    if (action === "inspect") {
      if (!task) {
        result = {
          code: 0,
          stdout: JSON.stringify({ exists: false, currentUser, currentSid }),
          stderr: "",
        };
      } else {
        result = {
          code: 0,
          stdout: JSON.stringify({
            exists: true,
            currentUser,
            currentSid,
            taskName: SERVE_TASK_NAME,
            state: task.state,
            userId: task.userId,
            userSid: task.userSid ?? sidForAccount(task.userId, currentUser, currentSid, otherSid),
            logonType: task.logonType,
            runLevel: task.runLevel,
            execute: task.execute,
            arguments: task.arguments,
          }),
          stderr: "",
        };
      }
    } else if (action === "register") {
      const match = script.match(/FromBase64String\('([^']+)'\)/);
      lastCommand64 = match?.[1] ?? "";
      if (opts.registerCode) {
        result = {
          code: opts.registerCode,
          stdout: "",
          stderr: opts.registerStderr ?? (opts.failWithScript ? script : "register failed"),
        };
      } else {
        const command = lastCommand64 ? Buffer.from(lastCommand64, "base64").toString("utf8") : "";
        task = {
          userId: currentUser,
          userSid: currentSid,
          state: "Ready",
          execute: "cmd.exe",
          arguments: `/c ${command}`,
          logonType: "Interactive",
          runLevel: "Limited",
        };
        result = {
          code: 0,
          stdout: JSON.stringify({
            registered: true,
            userId: currentUser,
            userSid: currentSid,
            logonType: "Interactive",
            runLevel: "Limited",
            taskName: SERVE_TASK_NAME,
          }),
          stderr: "",
        };
      }
    } else if (action === "start") {
      if (task) task.state = "Running";
      result = { code: 0, stdout: JSON.stringify({ started: true, taskName: SERVE_TASK_NAME }), stderr: "" };
    } else if (action === "stop") {
      if (task) task.state = "Ready";
      result = { code: 0, stdout: JSON.stringify({ stopped: true, taskName: SERVE_TASK_NAME }), stderr: "" };
    } else {
      const wasRunning = Boolean(task) && String(task.state).toLowerCase() === "running";
      task = null;
      result = {
        code: 0,
        stdout: JSON.stringify({
          cleared: true,
          stopped: opts.clearStopped ?? wasRunning,
          taskName: SERVE_TASK_NAME,
        }),
        stderr: "",
      };
    }
    if (opts.afterTask) await opts.afterTask(action);
    return result;
  };
  return {
    calls,
    currentUser,
    currentSid,
    runPowerShell,
    get lastCommand64() {
      return lastCommand64;
    },
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

function launchIdFromTask(task) {
  return task?.arguments?.match(/ZSWARM_SERVE_LAUNCH_ID=([^"\r\n]+)/)?.[1];
}

function followTaskServe(harness, session = "crew") {
  return {
    probeServe: async () => ({
      ok: true,
      data: {
        protocol: SERVE_PROTOCOL,
        serverId: "fixture-server",
        hostname: "desktop",
        platform: "win32",
        version: SERVE_CORE_VERSION,
        capabilities: ["hello"],
        launchId: launchIdFromTask(harness.task),
      },
    }),
    callServe: async () => hostReport({ session }),
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

describe("Windows serve --install readiness", { concurrency: 1 }, () => {
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

test("serveTaskChildEnv keeps host Zellij/IPC, policy, and strips controller routing", () => {
  const child = serveTaskChildEnv({
    ZSWARM_BIN: "C:\\zellij.exe",
    ZSWARM_TMP: "C:\\Users\\me\\AppData\\Local\\Temp",
    ZSWARM_SESSION: "crew",
    ZSWARM_SERVE: "127.0.0.1:9419",
    ZSWARM_SSH: "user@host",
    ZSWARM_SSH_MODE: "interactive",
    ZSWARM_ALLOW_CLOSE: "0",
    ZSWARM_ALLOW_SPAWN: "0",
    PATH: "C:\\Windows",
  });
  assert.equal(child.ZSWARM_BIN, "C:\\zellij.exe");
  assert.equal(child.ZSWARM_TMP, "C:\\Users\\me\\AppData\\Local\\Temp");
  assert.equal(child.ZSWARM_SESSION, "crew");
  assert.equal(child.PATH, "C:\\Windows");
  assert.equal(child.ZSWARM_ALLOW_CLOSE, "0");
  assert.equal(child.ZSWARM_SERVE, undefined);
  assert.equal(child.ZSWARM_SSH, undefined);
  assert.equal(child.ZSWARM_SSH_MODE, undefined);
});

test("sameWindowsSid requires verified SIDs and rejects name/UPN resemblance", () => {
  assert.equal(sameWindowsSid("S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-1001"), true);
  assert.equal(sameWindowsSid("S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-9999"), false);
  assert.equal(sameWindowsAccount("DESKTOP\\me", "me"), false);
  assert.equal(sameWindowsAccount("CORP\\sam", "sam@foreign.example"), false);
  assert.equal(sameWindowsSid("", "S-1-5-21-1-2-3-1001"), false);
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
  assert.match(script, /Translate/);
  assert.match(script, /SecurityIdentifier/);
  assert.match(script, /User\.Value/);
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
    assert.ok(err.code === "timeout" || err.code === SERVE_NOT_READY_CODE);
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
  const command = serveLogonCommand(
    process.execPath,
    scriptPath,
    server.label,
    token,
    serveTaskLaunchEnv({ ZSWARM_BIN: "C:\\zellij.exe" }, launchId),
  );
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

test("final host success after deadline or cancel cannot become ready", async (t) => {
  for (const variant of ["deadline", "cancel"]) {
    const ac = new AbortController();
    let now = 1000;
    const harness = taskHarness();
    const followed = followTaskServe(harness);
    const input = baseInput(t, {
      harness,
      session: "crew",
      timeoutMs: 100,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      signal: ac.signal,
      probeServe: followed.probeServe,
      callServe: async () => {
        if (variant === "deadline") now += 200;
        else ac.abort();
        return hostReport({ session: "crew" });
      },
    });
    await assert.rejects(() => installServeLogon(input), (err) => {
      assert.equal(err.code, variant === "deadline" ? "timeout" : "cancelled");
      assert.equal(err.details.installed, true);
      assert.equal(err.details.ready, false);
      assert.ok(err.details.server);
      assert.ok(err.details.inspection?.checks?.length);
      return true;
    });
  }
});

test("negative host envelopes with completed rows cannot become ready", async (t) => {
  for (const code of ["serve_unauthorized", "doctor_failed"]) {
    const harness = taskHarness();
    const followed = followTaskServe(harness);
    const input = baseInput(t, {
      harness,
      session: "crew",
      probeServe: followed.probeServe,
      callServe: async () => ({
        ok: false,
        error: { code, message: "host rejected inspection", details: hostReport({ session: "crew" }).data },
      }),
    });
    await assert.rejects(() => installServeLogon(input), (err) => {
      assert.equal(err.code, code);
      assert.equal(err.details.installed, true);
      assert.equal(err.details.ready, false);
      assert.notEqual(err.details.running, true);
      assert.ok(err.details.inspection?.checks?.length);
      return true;
    });
  }
});

test("failed inherited host session cannot become ready without an explicit install session", async (t) => {
  const report = hostReport({ session: "missing-default", sessionMissing: true, live: [] });
  report.data.route.sessionOrigin = "inherited";
  const harness = taskHarness();
  const followed = followTaskServe(harness);
  const input = baseInput(t, {
    harness,
    session: null,
    probeServe: followed.probeServe,
    callServe: async () => ({
      ok: false,
      error: { code: "doctor_failed", message: "session:session_missing", details: report.data },
    }),
  });
  await assert.rejects(() => installServeLogon(input), (err) => {
    assert.equal(err.code, "doctor_failed");
    assert.equal(err.details.installed, true);
    assert.notEqual(err.details.ready, true);
    return true;
  });
});

test("confirmed registration is retained when cancellation follows its reply", async (t) => {
  const ac = new AbortController();
  const harness = taskHarness({
    afterTask: async (action) => {
      if (action === "register") ac.abort();
    },
  });
  const input = baseInput(t, {
    harness,
    signal: ac.signal,
    timeoutMs: 2_000,
  });
  await assert.rejects(() => installServeLogon(input), (err) => {
    assert.equal(err.code, "cancelled");
    assert.equal(err.details.installed, true);
    assert.equal(harness.calls.includes("unregister"), false);
    return true;
  });
});

test("deadline consumed stopping old task cannot launch registration afterward", async (t) => {
  let now = 1000;
  const harness = taskHarness({
    task: {
      userId: "DESKTOP\\me",
      state: "Running",
      execute: "cmd.exe",
      arguments: "/c old",
      logonType: "Interactive",
      runLevel: "Limited",
    },
    afterTask: async (action) => {
      if (action === "stop") now += 200;
    },
  });
  await installServeLogon({
    ...baseInput(t, { harness, timeoutMs: 100, now: () => now, sleep: async () => {} }),
  }).catch(() => {});
  assert.equal(harness.calls.includes("register"), false, JSON.stringify(harness.calls));
});

test("clear cancellation after inspection cannot launch unregister", async (t) => {
  const ac = new AbortController();
  const harness = taskHarness({
    task: {
      userId: "DESKTOP\\me",
      state: "Running",
      execute: "cmd.exe",
      arguments: "/c zswarm",
      logonType: "Interactive",
      runLevel: "Limited",
    },
    afterTask: async (action) => {
      if (action === "inspect") ac.abort();
    },
  });
  await uninstallServeLogon({
    platform: "win32",
    timeoutMs: 100,
    now: () => 1000,
    signal: ac.signal,
    runPowerShell: harness.runPowerShell,
  }).catch(() => {});
  assert.equal(harness.calls.includes("unregister"), false, JSON.stringify(harness.calls));
});

test("same config without injected launchId reuses the running task", async (t) => {
  const harness = taskHarness();
  const dir = tempDir(t);
  const scriptPath = writeCli(dir);
  const shared = {
    platform: "win32",
    listen: "127.0.0.1:9419",
    env: { ZSWARM_SERVE_TOKEN: "s3cret-token", ZSWARM_BIN: "C:\\zellij.exe" },
    token: "s3cret-token",
    session: "crew",
    execPath: process.execPath,
    scriptPath,
    timeoutMs: 2_000,
    runPowerShell: harness.runPowerShell,
    ...followTaskServe(harness),
  };
  const first = await installServeLogon(shared);
  assert.equal(first.ready, true);
  const launchId = first.server.launchId;
  assert.ok(launchId);
  const before = harness.calls.length;
  const second = await installServeLogon(shared);
  assert.equal(second.ready, true);
  assert.equal(second.server.launchId, launchId);
  assert.deepEqual(harness.calls.slice(before).filter((action) => action !== "inspect"), []);
  assert.equal(serveCommandFingerprint(harness.task.arguments).includes(SERVE_CORE_VERSION), true);
});

test("policy or version change restarts only the owned task", async (t) => {
  const dir = tempDir(t);
  const scriptPath = writeCli(dir);
  const firstEnv = { ZSWARM_SERVE_TOKEN: "s3cret-token", ZSWARM_BIN: "C:\\zellij.exe", ZSWARM_ALLOW_CLOSE: "0" };
  const harness = taskHarness();
  const first = await installServeLogon({
    platform: "win32",
    listen: "127.0.0.1:9419",
    env: firstEnv,
    token: "s3cret-token",
    session: "crew",
    execPath: process.execPath,
    scriptPath,
    timeoutMs: 2_000,
    runPowerShell: harness.runPowerShell,
    ...followTaskServe(harness),
  });
  assert.ok(harness.task.arguments.includes("ZSWARM_ALLOW_CLOSE=0"));
  const before = harness.calls.length;
  const second = await installServeLogon({
    platform: "win32",
    listen: "127.0.0.1:9419",
    env: { ...firstEnv, ZSWARM_ALLOW_CLOSE: "1" },
    token: "s3cret-token",
    session: "crew",
    execPath: process.execPath,
    scriptPath,
    timeoutMs: 2_000,
    runPowerShell: harness.runPowerShell,
    ...followTaskServe(harness),
  });
  assert.equal(second.ready, true);
  assert.notEqual(second.server.launchId, first.server.launchId);
  assert.deepEqual(
    harness.calls.slice(before).filter((action) => action !== "inspect"),
    ["stop", "register", "start"],
  );
  assert.ok(harness.task.arguments.includes("ZSWARM_ALLOW_CLOSE=1"));
});

test("install and clear fail closed for foreign UPN, empty owner, and missing SID", async (t) => {
  for (const op of ["install", "clear"]) {
    const harness = taskHarness({
      currentUser: "CORP\\sam",
      currentSid: "S-1-5-21-1-2-3-1001",
      otherSid: "S-1-5-21-8-8-8-8888",
      task: {
        userId: "sam@foreign.example",
        state: "Running",
        execute: "cmd.exe",
        arguments: "/c old",
        logonType: "Interactive",
        runLevel: "Limited",
      },
    });
    await assert.rejects(
      op === "install"
        ? installServeLogon(baseInput(t, { harness }))
        : uninstallServeLogon({ platform: "win32", runPowerShell: harness.runPowerShell }),
      (err) => err.code === SERVE_TASK_OWNED_CODE,
    );
    assert.deepEqual(harness.calls, ["inspect"]);
  }
  const empty = taskHarness({
    task: { userId: "", state: "Running", execute: "cmd.exe", arguments: "/c old" },
  });
  await assert.rejects(() => installServeLogon(baseInput(t, { harness: empty })));
  assert.deepEqual(empty.calls, ["inspect"]);
});

test("task environment preserves configured server policy and the child context denies close", async (t) => {
  const restricted = {
    ZSWARM_READONLY: "1",
    ZSWARM_ALLOW_PANES: "crew-*",
    ZSWARM_DENY_PANES: "private",
    ZSWARM_ALLOW_SPAWN: "0",
    ZSWARM_ALLOW_CLOSE: "0",
    ZSWARM_ALLOW_WORKTREE_REMOVE: "0",
  };
  const child = serveTaskChildEnv(restricted);
  assert.deepEqual(loadPolicy(child), loadPolicy(restricted));
  const denied = await dispatchZswarm(
    { op: "close", pane: "1" },
    undefined,
    { env: child, policy: loadPolicy(child) },
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "policy_denied");

  const harness = taskHarness();
  const followed = followTaskServe(harness);
  const installEnv = {
    ZSWARM_SERVE_TOKEN: "s3cret-token",
    ZSWARM_ALLOW_CLOSE: "0",
    ZSWARM_ALLOW_SPAWN: "0",
    ZSWARM_ALLOW_PANES: "crew-*",
    ZSWARM_DENY_PANES: "private",
    ZSWARM_ALLOW_WORKTREE_REMOVE: "0",
  };
  const input = baseInput(t, {
    harness,
    token: "s3cret-token",
    session: "crew",
    env: installEnv,
    probeServe: followed.probeServe,
    callServe: followed.callServe,
  });
  delete input.launchId;
  const result = await installServeLogon(input);
  assert.equal(result.ready, true);
  assert.ok(input.harness.task.arguments.includes("ZSWARM_ALLOW_CLOSE=0"));
  assert.ok(input.harness.task.arguments.includes("ZSWARM_ALLOW_SPAWN=0"));
  assert.ok(input.harness.task.arguments.includes("ZSWARM_ALLOW_PANES=crew-*"));
});

test("PowerShell error cannot expose the encoded secret-bearing task command", async (t) => {
  const token = "review-token-ONLY";
  const harness = taskHarness({ registerCode: 1, failWithScript: true });
  const input = baseInput(t, {
    harness,
    token,
    env: { ZSWARM_SERVE_TOKEN: token },
    timeoutMs: 500,
  });
  await assert.rejects(() => installServeLogon(input), (err) => {
    assert.ok(harness.lastCommand64);
    const dumped = `${err.message}${JSON.stringify(err.details ?? {})}`;
    assert.equal(dumped.includes(token), false);
    assert.equal(dumped.includes(harness.lastCommand64), false);
    assert.match(err.message, /register failed/);
    return true;
  });
});

test("clear does not certify stop from task existence alone", async (t) => {
  const harness = taskHarness({
    clearStopped: false,
    task: {
      userId: "DESKTOP\\me",
      state: "Running",
      execute: "cmd.exe",
      arguments: "/c zswarm",
      logonType: "Interactive",
      runLevel: "Limited",
    },
  });
  const result = await uninstallServeLogon({
    platform: "win32",
    runPowerShell: harness.runPowerShell,
  });
  assert.notEqual(result.stopped, true, JSON.stringify(result));
  assert.equal(result.cleared, true);
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
});
