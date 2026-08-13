process.env.ZSWARM_LOG = "0";
process.env.ZSWARM_BUS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyIpcTmpEnv,
  buildSshRemoteCommand,
  cmdQuote,
  concreteTmp,
  inferRemoteShell,
  parseZellijServerPaths,
  pickIpcTmp,
  resolveSshTarget,
  sanitizeZellijEnv,
  socketDirFromServerPath,
  tmpFromServerPath,
  windowsDiscoverRemote,
  windowsInteractiveRemote,
  wrapWithTmpEnv,
} from "../dist/index.js";

const IPC = String.raw`C:\IpcTemp`;
const SERVER = String.raw`C:\IpcTemp\zellij\contract_version_1\crew`;

function decodeEncodedCommand(command) {
  const marker = "-EncodedCommand ";
  const at = command.indexOf(marker);
  assert.ok(at >= 0, "expected powershell -EncodedCommand");
  return Buffer.from(command.slice(at + marker.length), "base64").toString(
    "utf16le",
  );
}

test("tmpFromServerPath takes the parent of the zellij contract dir", () => {
  assert.equal(tmpFromServerPath(SERVER), IPC);
  assert.equal(socketDirFromServerPath(SERVER), String.raw`C:\IpcTemp\zellij`);
  assert.equal(
    tmpFromServerPath("/tmp/zellij/contract_version_1/crew"),
    "/tmp",
  );
  assert.equal(
    tmpFromServerPath("/tmp/zellij-501/contract_version_1/crew"),
    "/tmp",
  );
  assert.equal(
    socketDirFromServerPath("/tmp/zellij-501/contract_version_1/crew"),
    "/tmp/zellij-501",
  );
  assert.equal(tmpFromServerPath("zellij --server nowhere"), null);
});

test("parseZellijServerPaths reads --server off process listings", () => {
  const listing = [
    `zellij.exe --server ${SERVER}`,
    `zellij.exe --server ${String.raw`C:\IpcTemp\zellij\contract_version_1\other`}`,
    "unrelated",
    "zellij.exe --server=/var/tmp/zellij/contract_version_1/unix",
  ].join("\n");
  assert.deepEqual(parseZellijServerPaths(listing), [
    SERVER,
    String.raw`C:\IpcTemp\zellij\contract_version_1\other`,
    "/var/tmp/zellij/contract_version_1/unix",
  ]);
});

test("pickIpcTmp majority-votes so a stray SSH server loses", () => {
  assert.equal(
    pickIpcTmp([
      SERVER,
      String.raw`C:\IpcTemp\zellij\contract_version_1\other`,
      String.raw`C:\OtherTemp\zellij\contract_version_1\ssh`,
    ]),
    IPC,
  );
});

test("wrapWithTmpEnv sets TEMP/TMP and ZELLIJ_SOCKET_DIR for cmd", () => {
  assert.equal(
    wrapWithTmpEnv("zellij.exe list-sessions", IPC, "cmd"),
    `set "TEMP=${IPC}" && set "TMP=${IPC}" && set "ZELLIJ_SOCKET_DIR=${IPC}\\zellij" && zellij.exe list-sessions`,
  );
  assert.equal(
    wrapWithTmpEnv("zellij list-sessions", "/tmp/ipc", "sh"),
    "TMPDIR='/tmp/ipc' TEMP='/tmp/ipc' TMP='/tmp/ipc' zellij list-sessions",
  );
  assert.equal(
    wrapWithTmpEnv("zellij list-sessions", "/tmp", "sh", "/tmp/zellij-501"),
    "TMPDIR='/tmp' TEMP='/tmp' TMP='/tmp' ZELLIJ_SOCKET_DIR='/tmp/zellij-501' zellij list-sessions",
  );
});

test("cmdQuote doubles inner quotes", () => {
  assert.equal(cmdQuote("plain"), "plain");
  assert.equal(cmdQuote("has space"), '"has space"');
  assert.equal(cmdQuote('say "hi"'), '"say ""hi"""');
});

test("inferRemoteShell prefers explicit, then .exe / Windows tmp / interactive", () => {
  assert.equal(inferRemoteShell({ explicit: "sh", remoteBin: "zellij.exe" }), "sh");
  assert.equal(inferRemoteShell({ remoteBin: "zellij.exe" }), "cmd");
  assert.equal(inferRemoteShell({ tmp: IPC }), "cmd");
  assert.equal(inferRemoteShell({ mode: "interactive" }), "cmd");
  assert.equal(inferRemoteShell({ remoteBin: "zellij" }), "sh");
});

test("concreteTmp ignores auto so local TEMP is never the string auto", () => {
  assert.equal(concreteTmp("auto"), undefined);
  assert.equal(concreteTmp(" AUTO "), undefined);
  assert.equal(concreteTmp(IPC), IPC);
  assert.equal(applyIpcTmpEnv({ ZSWARM_TMP: "auto" }).TEMP, undefined);
  const applied = applyIpcTmpEnv({ ZSWARM_TMP: IPC });
  assert.equal(applied.TEMP, IPC);
  assert.equal(applied.TMPDIR, IPC);
  assert.equal(applied.ZELLIJ_SOCKET_DIR, String.raw`C:\IpcTemp\zellij`);
});

test("sanitizeZellijEnv copies a concrete ZSWARM_TMP onto TEMP/TMP/TMPDIR", () => {
  const cleaned = sanitizeZellijEnv({ ZSWARM_TMP: IPC, PATH: "x" });
  assert.equal(cleaned.TEMP, IPC);
  assert.equal(cleaned.TMP, IPC);
  assert.equal(cleaned.TMPDIR, IPC);
  assert.equal(cleaned.ZELLIJ_SOCKET_DIR, String.raw`C:\IpcTemp\zellij`);
  const auto = sanitizeZellijEnv({ ZSWARM_TMP: "auto", PATH: "x" });
  assert.equal(auto.TEMP, undefined);
});

test("buildSshRemoteCommand prefixes cmd.exe /c and TEMP on Windows", () => {
  const remote = buildSshRemoteCommand(
    {
      ssh: "ssh",
      host: "user@host",
      remoteBin: "zellij.exe",
      options: [],
    },
    ["list-sessions"],
    IPC,
    15_000,
  );
  assert.equal(
    remote,
    `cmd.exe /c "set ""TEMP=${IPC}"" && set ""TMP=${IPC}"" && set ""ZELLIJ_SOCKET_DIR=${IPC}\\zellij"" && zellij.exe list-sessions"`,
  );
});

test("buildSshRemoteCommand prefixes TMPDIR on Unix ssh", () => {
  const remote = buildSshRemoteCommand(
    {
      ssh: "ssh",
      host: "user@host",
      remoteBin: "zellij",
      options: [],
    },
    ["--session", "crew", "list-sessions"],
    "/tmp/ipc",
    15_000,
  );
  assert.equal(
    remote,
    "TMPDIR='/tmp/ipc' TEMP='/tmp/ipc' TMP='/tmp/ipc' zellij --session crew list-sessions",
  );
});

test("windowsInteractiveRemote is a scheduled task in the desktop session", () => {
  const inner = "zellij.exe list-panes";
  const wrapped = windowsInteractiveRemote(inner, 5_000);
  const script = decodeEncodedCommand(wrapped);
  assert.match(script, /schtasks\.exe \/Create/);
  assert.match(script, /\/IT/);
  assert.match(script, /Start-ScheduledTask/);
  assert.doesNotMatch(script, /schtasks\.exe \/Run/);
  assert.ok(script.includes(Buffer.from(inner, "utf8").toString("base64")));
});

test("interactive SSH mode wraps the zellij line in that scheduled task", () => {
  const remote = buildSshRemoteCommand(
    {
      ssh: "ssh",
      host: "user@host",
      remoteBin: "zellij.exe",
      options: [],
      mode: "interactive",
    },
    ["list-panes"],
    undefined,
    5_000,
  );
  const script = decodeEncodedCommand(remote);
  assert.match(script, /schtasks\.exe \/Create/);
  assert.match(script, /\/IT/);
  assert.match(script, /Start-ScheduledTask/);
  assert.ok(
    script.includes(Buffer.from("zellij.exe list-panes", "utf8").toString("base64")),
  );
});

test("windowsDiscoverRemote asks CIM for zellij.exe command lines", () => {
  const script = decodeEncodedCommand(windowsDiscoverRemote());
  assert.match(script, /Win32_Process/);
  assert.match(script, /zellij\.exe/);
  assert.match(script, /CommandLine/);
});

test("resolveSshTarget reads TMP, MODE, and REMOTE_SHELL", () => {
  const target = resolveSshTarget({
    ZSWARM_SSH: "user@host",
    ZSWARM_TMP: "auto",
    ZSWARM_SSH_MODE: "interactive",
    ZSWARM_REMOTE_SHELL: "cmd",
    ZSWARM_REMOTE_BIN: "zellij.exe",
  });
  assert.equal(target.host, "user@host");
  assert.equal(target.tmp, "auto");
  assert.equal(target.mode, "interactive");
  assert.equal(target.remoteShell, "cmd");
  assert.equal(target.remoteBin, "zellij.exe");
  assert.equal(
    resolveSshTarget({
      ZSWARM_SSH: "user@host",
      ZSWARM_SSH_MODE: "interactive",
    }).tmp,
    "auto",
  );
  assert.equal(resolveSshTarget({}), null);
});
