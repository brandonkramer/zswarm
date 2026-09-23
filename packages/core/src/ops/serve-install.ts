import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ZellijError } from "../errors.js";
import { encodePowerShellCommand } from "../zellij/ipc.js";
import {
  coverHostReport,
  hostDoctorRequest,
  isRequiredFailure,
  mergeHostReply,
  type DoctorCheck,
  type DoctorReport,
} from "./doctor.js";
import {
  callServe,
  isLoopbackHost,
  parseListenAddress,
  probeServe,
  redactServeSecret,
  SERVE_CORE_VERSION,
  SERVE_HELLO_TIMEOUT_MS,
  SERVE_LAUNCH_ID_ENV,
  SERVE_PROTOCOL,
  SERVE_TASK_NAME,
  serveLogonCommand,
  type CallServeOptions,
  type ProbeServeOptions,
  type ServeHelloData,
} from "./serve.js";
import {
  authorizeServeListen,
  SERVE_BIND_REMEDY,
  SERVE_TAILSCALE_BIN_ENV,
  type NetworkInterfacesFn,
  type TailscaleStatusRunner,
} from "./serve-bind.js";
import type { OpsResult, ServeInstallDeps, ServePowerShellResult } from "./types.js";
import { throwIfAborted } from "./util.js";

/** Overall install/readiness deadline when `timeoutMs` is omitted. */
export const DEFAULT_SERVE_INSTALL_TIMEOUT_MS = 30_000;
export const SERVE_NOT_READY_CODE = "serve_not_ready";
export const SERVE_TASK_OWNED_CODE = "serve_task_owned";
export const SERVE_TASK_VERSION_ENV = "ZSWARM_CORE_VERSION";

const HOST_ENV_KEYS = [
  "ZSWARM_BIN",
  "ZSWARM_PATH",
  "ZSWARM_TMP",
  "ZSWARM_STATE_DIR",
  "ZSWARM_BUS",
  "ZSWARM_BUS_PLUGIN",
  "ZSWARM_CACHE_TTL_MS",
  "ZSWARM_SESSION",
  "ZELLIJ_SOCKET_DIR",
  "ZELLIJ_TMP_DIR",
  "ZELLIJ_CONFIG_DIR",
  "TEMP",
  "TMP",
  "PATH",
  "ZSWARM_READONLY",
  "ZSWARM_ALLOW_PANES",
  "ZSWARM_DENY_PANES",
  "ZSWARM_ALLOW_SPAWN",
  "ZSWARM_ALLOW_CLOSE",
  "ZSWARM_ALLOW_WORKTREE_REMOVE",
  /** Optional Tailscale CLI path; re-checked on every task startup, never a token. */
  SERVE_TAILSCALE_BIN_ENV,
] as const;

const CONTROLLER_ENV_KEYS = [
  "ZSWARM_SERVE",
  "ZSWARM_SSH",
  "ZSWARM_SSH_OPTS",
  "ZSWARM_SSH_MODE",
  "ZSWARM_SSH_BIN",
  "ZSWARM_REMOTE_BIN",
  "ZSWARM_REMOTE_SHELL",
] as const;

const WELL_KNOWN_SIDS = new Set(["S-1-5-18", "S-1-5-19", "S-1-5-20"]);

const PS_PREAMBLE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "function Get-ZswarmIdentity {",
  "  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
  "  if (-not $id -or -not $id.User -or [string]::IsNullOrWhiteSpace($id.User.Value)) {",
  "    throw 'cannot resolve the current Windows SID for the Interactive logon task'",
  "  }",
  "  $name = [string]$id.Name",
  "  if ([string]::IsNullOrWhiteSpace($name)) {",
  "    throw 'cannot resolve the current Windows account name for the Interactive logon task'",
  "  }",
  "  return @{ name = $name; sid = [string]$id.User.Value }",
  "}",
  "function Resolve-ZswarmSid($account) {",
  "  if ($null -eq $account) { return $null }",
  "  $text = [string]$account",
  "  if ([string]::IsNullOrWhiteSpace($text)) { return $null }",
  "  if ($text -match '^S-\\d-') { return $text }",
  "  try {",
  "    $nt = New-Object System.Security.Principal.NTAccount($text)",
  "    $sid = $nt.Translate([System.Security.Principal.SecurityIdentifier])",
  "    if (-not $sid -or [string]::IsNullOrWhiteSpace($sid.Value)) { return $null }",
  "    return [string]$sid.Value",
  "  } catch {",
  "    return $null",
  "  }",
  "}",
  "function Assert-ZswarmCurrentOwner($task) {",
  "  $identity = Get-ZswarmIdentity",
  "  $existingSid = Resolve-ZswarmSid ([string]$task.Principal.UserId)",
  "  if ([string]::IsNullOrWhiteSpace($existingSid) -or $existingSid -ne $identity.sid) {",
  "    throw 'zswarm-serve is owned by a different or unverified Windows account'",
  "  }",
  "  return $identity",
  "}",
  "function Write-ZswarmJson($obj) {",
  "  $json = $obj | ConvertTo-Json -Compress -Depth 6",
  "  [Console]::Out.Write($json)",
  "}",
  `function Get-ZswarmTask { Get-ScheduledTask -TaskName '${SERVE_TASK_NAME}' -ErrorAction Stop }`,
  "function Test-ZswarmMissing($err) {",
  "  return $err.CategoryInfo.Category -eq 'ObjectNotFound' -or ([string]$err.FullyQualifiedErrorId -match 'ObjectNotFound')",
  "}",
].join("\n");

export type ServeTaskAction = "inspect" | "register" | "start" | "stop" | "unregister";

export type ServePowerShellExec = (
  script: string,
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<ServePowerShellResult>;

export type ServeCliLaunch = {
  execPath: string;
  scriptPath: string;
};

export type ServeInstallInput = ServeInstallDeps & {
  listen?: string;
  token?: string;
  env?: NodeJS.ProcessEnv;
  session?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test seams for Tailscale listen verification (before task mutation). */
  tailscaleStatus?: TailscaleStatusRunner;
  networkInterfaces?: NetworkInterfacesFn;
};

export type ServeInstallSuccess = {
  installed: true;
  ready: true;
  running: true;
  task: string;
  listen: string;
  command: string;
  principal: { userId: string; logonType: string; runLevel: string; userSid?: string };
  server: ServeHelloData;
  session: string | null;
  sessions: string[];
  warning?: string;
  inspection: { checks: DoctorCheck[] };
};

const REMEDY = {
  notReady:
    "Registration/start was accepted, but authenticated hello and host inspection did not prove this installation is ready. Retry serve --install or inspect with zswarm doctor; serve --clear removes the owned task. Install does not kill unrelated processes.",
  stale:
    "A listener answered on this port but did not present this installation's launch identity. Install does not kill arbitrary node processes or port owners. Stop the owned zswarm-serve task (serve --clear) or free the port, then retry.",
  session:
    "Start the requested Zellij session on the desktop account that owns the crew, then retry serve --install --session <name> or zswarm doctor --session <name>.",
  ipc:
    "The installed server could not see the desktop Zellij IPC. Confirm the logon task runs as the already-logged-in desktop account (Interactive/Limited) and that ZSWARM_TMP points at that TEMP.",
  cli:
    "Cannot resolve a zswarm CLI launcher for the logon task. process.argv[1] in MCP is the MCP entrypoint, not the CLI. Set ZSWARM_SERVE_CLI to the CLI script (cli.js / zswarm.mjs), or run `zswarm serve --install` from the CLI.",
  owner:
    "An existing zswarm-serve task belongs to a different or unverified Windows account. Install does not overwrite another user's task. Run --install as the desktop account that owns the crew, or --clear from that account.",
  interactive:
    "This task requires an already logged-in interactive desktop session (LogonType Interactive, RunLevel Limited). It is not a headless boot/SYSTEM service.",
  token:
    "Set the same ZSWARM_SERVE_TOKEN on the server and this caller. The token is stored in the task action (readable by this user and administrators), not encrypted; reinstall to rotate.",
  bind: SERVE_BIND_REMEDY.literal,
  uncertain:
    "Inspect the zswarm-serve task. The last mutation was interrupted before a confirmed reply; the task may or may not exist. Install/clear does not claim rollback.",
} as const;

export function looksLikeMcpEntrypoint(scriptPath: string): boolean {
  const base = basename(scriptPath).toLowerCase();
  return (
    base === "mcp-server.js" ||
    base === "mcp-server.mjs" ||
    base === "mcp-server.cjs" ||
    base === "zswarm-mcp" ||
    base === "zswarm-mcp.js" ||
    base === "zswarm-mcp.mjs" ||
    base === "zswarm-mcp.cjs" ||
    base === "zswarm-mcp.cmd"
  );
}

export function looksLikeCliEntrypoint(scriptPath: string): boolean {
  const base = basename(scriptPath).toLowerCase();
  if (base.endsWith(".cmd") || base.endsWith(".bat")) return false;
  return (
    base === "cli.js" ||
    base === "cli.mjs" ||
    base === "cli.cjs" ||
    base === "zswarm" ||
    base === "zswarm.js" ||
    base === "zswarm.mjs" ||
    base === "zswarm.cjs"
  );
}

function fileExists(path: string): boolean {
  try {
    return Boolean(path) && existsSync(path);
  } catch {
    return false;
  }
}

function resolveFromRequire(fromFile: string, spec: string): string | undefined {
  try {
    const href = isAbsolute(fromFile) ? pathToFileURL(fromFile).href : fromFile;
    return createRequire(href).resolve(spec);
  } catch {
    return undefined;
  }
}

function firstExisting(paths: Array<string | undefined>): string | undefined {
  for (const path of paths) {
    if (path && looksLikeCliEntrypoint(path) && fileExists(path)) return path;
  }
  return undefined;
}

/**
 * Resolve node + CLI script for the logon task. MCP argv[1] is never installed.
 */
export function resolveServeCliLaunch(input: {
  execPath?: string;
  scriptPath?: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}): ServeCliLaunch {
  const execPath = input.execPath ?? process.execPath;
  if (!execPath) {
    throw new ZellijError("usage", "cannot resolve node executable for the logon task");
  }
  const argv = input.argv ?? process.argv;
  const envCli = input.env?.ZSWARM_SERVE_CLI?.trim();
  const explicit = input.scriptPath?.trim();
  if (explicit) {
    if (looksLikeMcpEntrypoint(explicit)) {
      throw new ZellijError(
        "usage",
        `${REMEDY.cli} (${explicit} looks like zswarm-mcp)`,
      );
    }
    if (!looksLikeCliEntrypoint(explicit) || !fileExists(explicit)) {
      throw new ZellijError(
        "usage",
        `cannot use ${explicit} as the zswarm CLI launcher for serve --install`,
      );
    }
    return { execPath, scriptPath: explicit };
  }
  if (envCli) {
    if (looksLikeMcpEntrypoint(envCli)) {
      throw new ZellijError("usage", `${REMEDY.cli} (ZSWARM_SERVE_CLI points at MCP)`);
    }
    if (!looksLikeCliEntrypoint(envCli) || !fileExists(envCli)) {
      throw new ZellijError(
        "usage",
        `ZSWARM_SERVE_CLI is not a usable zswarm CLI script (${envCli})`,
      );
    }
    return { execPath, scriptPath: envCli };
  }
  const argvScript = typeof argv[1] === "string" ? argv[1] : "";
  if (argvScript && looksLikeMcpEntrypoint(argvScript)) {
    const sibling = firstExisting([
      join(dirname(argvScript), "zswarm.mjs"),
      join(dirname(argvScript), "zswarm.js"),
      join(dirname(argvScript), "zswarm"),
      join(dirname(argvScript), "..", "..", "cli", "dist", "cli.js"),
      join(dirname(argvScript), "..", "..", "cli", "dist", "cli.mjs"),
      resolveFromRequire(argvScript, "@zswarm/cli"),
    ]);
    if (sibling) return { execPath, scriptPath: sibling };
    throw new ZellijError("usage", REMEDY.cli);
  }
  if (argvScript && looksLikeCliEntrypoint(argvScript) && fileExists(argvScript)) {
    return { execPath, scriptPath: argvScript };
  }
  throw new ZellijError(
    "usage",
    "cannot resolve a zswarm CLI launcher for the logon task; set ZSWARM_SERVE_CLI or run serve --install from the CLI",
  );
}

/** Host Zellij/IPC + configured server policy; controller routing is stripped. */
export function serveTaskChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of HOST_ENV_KEYS) {
    const raw = key === "PATH" ? env.PATH ?? env.Path : env[key];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value) out[key] = value;
  }
  for (const key of CONTROLLER_ENV_KEYS) delete out[key];
  return out;
}

/** Child env persisted in the task, including package version and optional launch id. */
export function serveTaskLaunchEnv(
  env: NodeJS.ProcessEnv,
  launchId?: string,
): Record<string, string> {
  const out: Record<string, string> = {
    ...serveTaskChildEnv(env),
    [SERVE_TASK_VERSION_ENV]: SERVE_CORE_VERSION,
  };
  const id = launchId?.trim();
  if (id) out[SERVE_LAUNCH_ID_ENV] = id;
  return out;
}

export function isWindowsSid(value: string): boolean {
  return /^S-\d-\d+(-\d+)+$/i.test(value.trim());
}

/** Verified SID equality. Account-name / UPN resemblance is not identity. */
export function sameWindowsSid(a: string, b: string): boolean {
  const na = a.trim().toUpperCase();
  const nb = b.trim().toUpperCase();
  if (!na || !nb || !isWindowsSid(na) || !isWindowsSid(nb)) return false;
  return na === nb;
}

/** @deprecated Use sameWindowsSid; names are not verified identity. */
export function sameWindowsAccount(a: string, b: string): boolean {
  return sameWindowsSid(a, b);
}

function privilegedAccount(userId: string): boolean {
  return /(?:^|\\)(system|local service|network service)$/i.test(userId.trim()) ||
    /^nt authority\\/i.test(userId.trim());
}

function privilegedSid(sid: string): boolean {
  return WELL_KNOWN_SIDS.has(sid.trim().toUpperCase());
}

export function buildServeTaskScript(
  action: ServeTaskAction,
  params: { command?: string } = {},
): string {
  if (action === "inspect") {
    return [
      PS_PREAMBLE,
      "try {",
      "  $task = Get-ZswarmTask",
      "} catch {",
      "  if (Test-ZswarmMissing $_) {",
      "    $identity = Get-ZswarmIdentity",
      "    Write-ZswarmJson @{ exists = $false; currentUser = $identity.name; currentSid = $identity.sid }",
      "    exit 0",
      "  }",
      "  throw",
      "}",
      "$identity = Get-ZswarmIdentity",
      "$action = @($task.Actions)[0]",
      "$principal = $task.Principal",
      "Write-ZswarmJson @{",
      "  exists = $true",
      "  currentUser = $identity.name",
      "  currentSid = $identity.sid",
      "  taskName = [string]$task.TaskName",
      "  state = [string]$task.State",
      "  userId = [string]$principal.UserId",
      "  userSid = (Resolve-ZswarmSid ([string]$principal.UserId))",
      "  logonType = [string]$principal.LogonType",
      "  runLevel = [string]$principal.RunLevel",
      "  execute = [string]$action.Execute",
      "  arguments = [string]$action.Arguments",
      "}",
    ].join("\n");
  }
  if (action === "register") {
    const command = params.command ?? "";
    const commandB64 = Buffer.from(command, "utf8").toString("base64");
    return [
      PS_PREAMBLE,
      `$cmd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${commandB64}'))`,
      "try {",
      "  $existing = Get-ZswarmTask",
      "  $identity = Assert-ZswarmCurrentOwner $existing",
      "} catch {",
      "  if (-not (Test-ZswarmMissing $_)) { throw }",
      "  $identity = Get-ZswarmIdentity",
      "}",
      "$userId = $identity.name",
      "$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c ' + $cmd)",
      "$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited",
      "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId",
      `Register-ScheduledTask -TaskName '${SERVE_TASK_NAME}' -Action $action -Principal $principal -Trigger $trigger -Force | Out-Null`,
      "Write-ZswarmJson @{ registered = $true; userId = $userId; userSid = $identity.sid; logonType = 'Interactive'; runLevel = 'Limited'; taskName = '" +
        SERVE_TASK_NAME +
        "' }",
    ].join("\n");
  }
  if (action === "start") {
    return [
      PS_PREAMBLE,
      "try {",
      "  $task = Get-ZswarmTask",
      "  [void](Assert-ZswarmCurrentOwner $task)",
      "} catch {",
      "  throw",
      "}",
      `Start-ScheduledTask -TaskName '${SERVE_TASK_NAME}'`,
      "Write-ZswarmJson @{ started = $true; taskName = '" + SERVE_TASK_NAME + "' }",
    ].join("\n");
  }
  if (action === "stop") {
    return [
      PS_PREAMBLE,
      "try {",
      "  $task = Get-ZswarmTask",
      "  [void](Assert-ZswarmCurrentOwner $task)",
      `  Stop-ScheduledTask -TaskName '${SERVE_TASK_NAME}'`,
      "} catch {",
      "  if (-not (Test-ZswarmMissing $_)) { throw }",
      "}",
      "Write-ZswarmJson @{ stopped = $true; taskName = '" + SERVE_TASK_NAME + "' }",
    ].join("\n");
  }
  return [
    PS_PREAMBLE,
    "$identity = Get-ZswarmIdentity",
    "$stopped = $false",
    "$stopFailed = $false",
    "$stopError = $null",
    "try {",
    "  $task = Get-ZswarmTask",
    "} catch {",
    "  if (Test-ZswarmMissing $_) {",
    "    Write-ZswarmJson @{ cleared = $true; missing = $true; stopped = $false; taskName = '" +
      SERVE_TASK_NAME +
      "' }",
    "    exit 0",
    "  }",
    "  throw",
    "}",
    "[void](Assert-ZswarmCurrentOwner $task)",
    "try {",
    `  Stop-ScheduledTask -TaskName '${SERVE_TASK_NAME}'`,
    "  $stopped = $true",
    "} catch {",
    "  if (Test-ZswarmMissing $_) {",
    "    Write-ZswarmJson @{ cleared = $true; missing = $true; stopped = $false; taskName = '" +
      SERVE_TASK_NAME +
      "' }",
    "    exit 0",
    "  }",
    "  $stopFailed = $true",
    "  $stopError = [string]$_.Exception.Message",
    "}",
    "try {",
    `  Unregister-ScheduledTask -TaskName '${SERVE_TASK_NAME}' -Confirm:$false`,
    "} catch {",
    "  if (Test-ZswarmMissing $_) {",
    "    Write-ZswarmJson @{ cleared = $true; missing = $true; stopped = $stopped; stopFailed = $stopFailed; stopError = $stopError; taskName = '" +
      SERVE_TASK_NAME +
      "' }",
    "    exit 0",
    "  }",
    "  throw",
    "}",
    "Write-ZswarmJson @{ cleared = $true; stopped = $stopped; stopFailed = $stopFailed; stopError = $stopError; taskName = '" +
      SERVE_TASK_NAME +
      "' }",
  ].join("\n");
}

function runPowerShellDefault(
  script: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<ServePowerShellResult> {
  const timeout = Math.floor(options.timeoutMs);
  if (timeout <= 0) {
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "no remaining budget",
      timedOut: true,
    });
  }
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShellCommand(script),
      ],
      {
        windowsHide: true,
        timeout,
        signal: options.signal,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const err = error as NodeJS.ErrnoException & { killed?: boolean } | null;
        const aborted =
          Boolean(options.signal?.aborted) ||
          err?.name === "AbortError" ||
          err?.code === "ABORT_ERR";
        const timedOut = Boolean(err?.killed) && !aborted;
        const code =
          aborted || timedOut
            ? 1
            : error && typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : error
                ? 1
                : 0;
        resolve({
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          ...(aborted ? { aborted: true } : {}),
          ...(timedOut ? { timedOut: true } : {}),
        });
      },
    );
  });
}

function parseTaskJson(stdout: string, secrets: string[]): Record<string, unknown> {
  const text = stdout.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw new ZellijError(
      "zellij_failed",
      `serve task helper returned no JSON (${scrubDiagnosticText(text || "no output", secrets).slice(0, 200)})`,
    );
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ZellijError(
      "zellij_failed",
      "serve task helper returned invalid JSON",
    );
  }
}

function serveInstallToken(input: { token?: string; env?: NodeJS.ProcessEnv }): string {
  const raw =
    input.token ??
    (input.env ? input.env.ZSWARM_SERVE_TOKEN : process.env.ZSWARM_SERVE_TOKEN);
  const secret = raw?.trim() ?? "";
  if (!secret) {
    throw new ZellijError(
      "serve_auth",
      "zswarm serve requires ZSWARM_SERVE_TOKEN; another local OS user can connect to 127.0.0.1",
    );
  }
  return secret;
}

function tokenFromCommand(command: string): string[] {
  const found: string[] = [];
  const matches = command.matchAll(/ZSWARM_SERVE_TOKEN=([^"&\r\n]+)/g);
  for (const match of matches) {
    const value = match[1]?.trim();
    if (value) found.push(value);
  }
  return found;
}

function scrubDiagnosticText(text: string, secrets: string[]): string {
  let out = text
    .replace(/set\s+"ZSWARM_SERVE_TOKEN=[^"]*"/gi, 'set "ZSWARM_SERVE_TOKEN=***"')
    .replace(/ZSWARM_SERVE_TOKEN=([^"&\r\n]*)/gi, "ZSWARM_SERVE_TOKEN=***");
  for (const secret of secrets) {
    if (!secret) continue;
    out = redactServeSecret(out, secret);
    const utf8 = Buffer.from(secret, "utf8").toString("base64");
    if (utf8.length >= 4) out = out.split(utf8).join("***");
    const utf16 = Buffer.from(secret, "utf16le").toString("base64");
    if (utf16.length >= 4) out = out.split(utf16).join("***");
  }
  out = out.replace(/FromBase64String\('([^']*)'\)/g, "FromBase64String('***')");
  out = out.replace(/-EncodedCommand\s+[A-Za-z0-9+/]+=*/g, "-EncodedCommand ***");
  out = out.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "***");
  return out;
}

function scrubSecrets<T>(value: T, secrets: string[]): T {
  if (typeof value === "string") return scrubDiagnosticText(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, secrets)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubSecrets(nested, secrets);
    }
    return out as T;
  }
  return value;
}

function taskRunning(state: string | undefined): boolean {
  return (state ?? "").toLowerCase() === "running";
}

function commandFromArguments(raw: string | undefined): string {
  const text = raw?.trim() ?? "";
  if (text.toLowerCase().startsWith("/c ")) return text.slice(3).trim();
  return text;
}

export function serveCommandFingerprint(command: string): string {
  return command
    .replace(/set "ZSWARM_SERVE_LAUNCH_ID=[^"]*"&& /g, "")
    .replace(/&& set "ZSWARM_SERVE_LAUNCH_ID=[^"]*"/g, "");
}

function launchIdFromCommand(command: string): string {
  const match = command.match(/set "ZSWARM_SERVE_LAUNCH_ID=([^"]*)"/);
  return match?.[1]?.trim() ?? "";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function liveSessionsFrom(checks: DoctorCheck[]): string[] {
  const row = checks.find((item) => item.id === "zellij_sessions");
  const live = row?.detail?.live;
  if (!Array.isArray(live)) return [];
  return live.filter((name): name is string => typeof name === "string" && name.length > 0);
}

function checkById(checks: DoctorCheck[], id: string): DoctorCheck | undefined {
  return checks.find((item) => item.id === id);
}

function hostReportFromMerged(
  merged: { session?: string | null; sessionOrigin?: string },
  checks: DoctorCheck[],
  explicitSession: string | null,
): DoctorReport {
  return {
    route: {
      transport: "local",
      endpoint: "host",
      session: merged.session ?? explicitSession,
      sessionOrigin:
        merged.sessionOrigin ?? (explicitSession ? "explicit" : "unresolved"),
    },
    checks,
  };
}

function evaluateHostReadiness(
  report: DoctorReport,
  explicitSession: string | null,
): {
  ready: boolean;
  phase?: string;
  cause?: string;
  remedy?: string;
  warning?: string;
  session: string | null;
  sessions: string[];
} {
  const checks = report.checks;
  const sessions = liveSessionsFrom(checks);
  const sessionRow = checkById(checks, "session");
  const sessionName =
    typeof sessionRow?.detail.session === "string" ? sessionRow.detail.session : explicitSession;
  const failed = checks.filter((item) => isRequiredFailure(report, item));
  if (failed.length > 0) {
    const row = failed[0]!;
    return {
      ready: false,
      phase: row.id === "session" ? "session" : "host",
      cause: row.code,
      remedy: row.remedy ?? (row.id === "zellij_ipc" ? REMEDY.ipc : row.id === "session" ? REMEDY.session : REMEDY.notReady),
      session: sessionName,
      sessions,
    };
  }
  if (explicitSession) {
    return { ready: true, session: explicitSession, sessions };
  }
  const listed = checkById(checks, "zellij_sessions");
  const empty = sessions.length === 0 || listed?.code === "sessions_none";
  if (empty) {
    return {
      ready: true,
      session: null,
      sessions,
      warning:
        "Serve is authenticated and can list sessions, but no live Zellij session is visible. This is a healthy server, not a ready crew. Pass --session once the desktop crew is running.",
    };
  }
  return { ready: true, session: sessionName, sessions };
}

function notReadyError(
  message: string,
  details: Record<string, unknown>,
  secrets: string[],
  code = SERVE_NOT_READY_CODE,
): ZellijError {
  return new ZellijError(code, scrubDiagnosticText(message, secrets), scrubSecrets(details, secrets));
}

async function runTask(
  action: ServeTaskAction,
  input: {
    run: ServePowerShellExec;
    timeoutMs: number;
    signal?: AbortSignal;
    secrets: string[];
    command?: string;
  },
): Promise<Record<string, unknown>> {
  const script = buildServeTaskScript(action, { command: input.command });
  const result = await input.run(script, {
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (result.code === 0) {
    try {
      return parseTaskJson(result.stdout, input.secrets);
    } catch (err) {
      if (result.aborted || input.signal?.aborted) {
        throw new ZellijError("cancelled", "operation cancelled");
      }
      if (result.timedOut) {
        throw new ZellijError("timeout", `serve task ${action} timed out`);
      }
      throw err;
    }
  }
  if (result.aborted || input.signal?.aborted) {
    throw new ZellijError("cancelled", "operation cancelled");
  }
  if (result.timedOut) {
    throw new ZellijError("timeout", `serve task ${action} timed out`);
  }
  throw new ZellijError(
    "zellij_failed",
    `serve --${action === "unregister" ? "clear" : "install"} ${action} failed`,
    scrubSecrets(
      {
        phase: action,
        cause: "helper_failed",
        exitCode: result.code,
        stderr: scrubDiagnosticText((result.stderr || result.stdout).trim(), input.secrets).slice(0, 400),
      },
      input.secrets,
    ),
  );
}

function remainingOf(deadline: number, now: () => number): number {
  return Math.max(0, deadline - now());
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ZellijError("cancelled", "operation cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new ZellijError("cancelled", "operation cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Register/update the current-user Interactive logon task and wait until the
 * requested server instance is authenticated and the host crew is visible.
 */
export async function installServeLogon(
  input: ServeInstallInput = {},
): Promise<ServeInstallSuccess> {
  if ((input.platform ?? process.platform) !== "win32") {
    throw new ZellijError(
      "usage",
      "serve --install registers a Windows logon task; on Unix start `zswarm serve --listen` in the session that owns Zellij",
    );
  }
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs ?? DEFAULT_SERVE_INSTALL_TIMEOUT_MS));
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => defaultSleep(ms, input.signal));
  const deadline = now() + timeoutMs;
  const remaining = () => remainingOf(deadline, now);
  const env = input.env ?? process.env;
  const { host, label } = parseListenAddress(input.listen);
  const token = serveInstallToken(input);
  const secrets = [token];
  throwIfAborted(input.signal);
  if (remaining() <= 0) {
    throw notReadyError("serve --install timed out before task mutation", {
      installed: false,
      ready: false,
      running: false,
      phase: "inspect",
      cause: "timeout",
      listen: label,
      task: SERVE_TASK_NAME,
    }, secrets, "timeout");
  }

  // Non-loopback: verify Tailscale + OS ownership before any task mutation.
  // Installer-time proof is not a permanent permit; every task startup revalidates via startServe.
  if (!isLoopbackHost(host)) {
    await authorizeServeListen(host, {
      env,
      signal: input.signal,
      deadline,
      now,
      tailscaleStatus: input.tailscaleStatus,
      networkInterfaces: input.networkInterfaces,
    });
  }
  throwIfAborted(input.signal);
  if (remaining() <= 0) {
    throw notReadyError("serve --install timed out before task mutation", {
      installed: false,
      ready: false,
      running: false,
      phase: "verify",
      cause: "timeout",
      listen: label,
      task: SERVE_TASK_NAME,
    }, secrets, "timeout");
  }

  const launch = resolveServeCliLaunch({
    execPath: input.execPath,
    scriptPath: input.scriptPath,
    argv: input.argv,
    env,
  });
  const run = input.runPowerShell ?? runPowerShellDefault;
  const probe = input.probeServe ?? probeServe;
  const call = input.callServe ??
    ((target: string, args: Record<string, unknown>, options: CallServeOptions) =>
      callServe(target, args, options));
  const explicitSession = input.session?.trim() || null;
  const requestedLaunchId = input.launchId?.trim() || "";

  const partial = (extra: Record<string, unknown>): Record<string, unknown> => {
    const details = scrubSecrets(
      {
        installed: false,
        ready: false,
        running: false,
        task: SERVE_TASK_NAME,
        listen: label,
        ...extra,
      },
      secrets,
    ) as Record<string, unknown>;
    if (details.mutation === "uncertain") delete details.installed;
    return details;
  };

  const assertRunnable = (phase: string, extra: Record<string, unknown> = {}): number => {
    if (input.signal?.aborted) {
      throw notReadyError("serve --install cancelled", {
        ...partial({ ...extra, phase, cause: "cancelled" }),
      }, secrets, "cancelled");
    }
    const left = remaining();
    if (left <= 0) {
      throw notReadyError(`serve --install timed out during ${phase}`, {
        ...partial({ ...extra, phase, cause: "timeout" }),
      }, secrets, "timeout");
    }
    return Math.min(20_000, left);
  };

  const rethrowKnown = (err: unknown, extra: Record<string, unknown>): never => {
    if (err instanceof ZellijError && (err.code === "cancelled" || err.code === "timeout")) {
      throw notReadyError(err.message, {
        ...partial(extra),
        ...(err.details ?? {}),
        cause: err.code,
        phase: typeof extra.phase === "string" ? extra.phase : err.code,
      }, secrets, err.code);
    }
    throw err;
  };

  const inspectBudget = assertRunnable("inspect");
  const inspected = await runTask("inspect", {
    run,
    timeoutMs: inspectBudget,
    signal: input.signal,
    secrets,
  });
  const exists = inspected.exists === true;
  const existingCommand = commandFromArguments(asString(inspected.arguments));
  secrets.push(...tokenFromCommand(existingCommand));
  const ownership = (() => {
    const currentUser = asString(inspected.currentUser);
    const currentSid = asString(inspected.currentSid);
    const userId = asString(inspected.userId);
    const userSid = asString(inspected.userSid);
    if (!isWindowsSid(currentSid)) {
      throw notReadyError(
        "cannot verify the current Windows account SID for the Interactive logon task",
        {
          ...partial({
            phase: "inspect",
            cause: SERVE_TASK_OWNED_CODE,
            remedy: REMEDY.owner,
            currentUser,
          }),
        },
        secrets,
        SERVE_TASK_OWNED_CODE,
      );
    }
    if (!exists) {
      return { currentUser, currentSid, userId, userSid };
    }
    const verified = isWindowsSid(userSid) && sameWindowsSid(currentSid, userSid);
    if (!verified || privilegedSid(userSid) || privilegedAccount(userId)) {
      throw notReadyError(
        `serve --install will not overwrite ${SERVE_TASK_NAME} owned by ${userId || "an unverified account"}`,
        {
          ...partial({
            phase: "inspect",
            cause: SERVE_TASK_OWNED_CODE,
            remedy: REMEDY.owner,
            principal: { userId, userSid },
            currentUser,
            currentSid,
          }),
        },
        secrets,
        SERVE_TASK_OWNED_CODE,
      );
    }
    return { currentUser, currentSid, userId, userSid };
  })();

  const execute = asString(inspected.execute);
  const alreadyRunning = exists && taskRunning(asString(inspected.state));
  const existingLaunchId = launchIdFromCommand(existingCommand);
  const desiredBase = serveLogonCommand(
    launch.execPath,
    launch.scriptPath,
    label,
    token,
    serveTaskLaunchEnv(env),
  );
  const configMatches =
    exists &&
    execute.toLowerCase() === "cmd.exe" &&
    serveCommandFingerprint(existingCommand) === desiredBase &&
    asString(inspected.logonType).toLowerCase() === "interactive" &&
    asString(inspected.runLevel).toLowerCase() === "limited";
  const reuseExistingLaunch =
    configMatches &&
    Boolean(existingLaunchId) &&
    (!requestedLaunchId || requestedLaunchId === existingLaunchId);
  const launchId = reuseExistingLaunch
    ? existingLaunchId
    : (requestedLaunchId || randomUUID());
  const childEnv = serveTaskLaunchEnv(env, launchId);
  const command = serveLogonCommand(launch.execPath, launch.scriptPath, label, token, childEnv);
  const redactedCommand = redactServeSecret(command, token);
  const needsUpdate = !reuseExistingLaunch;
  let installed = exists && reuseExistingLaunch;
  let principal = {
    userId: ownership.userId || ownership.currentUser,
    userSid: ownership.userSid || ownership.currentSid,
    logonType: asString(inspected.logonType) || "Interactive",
    runLevel: asString(inspected.runLevel) || "Limited",
  };

  const mutate = async (
    action: ServeTaskAction,
    extra: Record<string, unknown>,
    commandArg?: string,
  ): Promise<Record<string, unknown>> => {
    const budget = assertRunnable(action, extra);
    try {
      return await runTask(action, {
        run,
        timeoutMs: budget,
        signal: input.signal,
        secrets,
        command: commandArg,
      });
    } catch (err) {
      return rethrowKnown(err, extra);
    }
  };

  if (needsUpdate) {
    assertRunnable("register", { installed: false });
    if (alreadyRunning) {
      await mutate("stop", { phase: "stop", installed: false });
    }
    let registered: Record<string, unknown> | undefined;
    try {
      registered = await mutate(
        "register",
        {
          phase: "register",
          mutation: "uncertain",
          observed: { existed: exists },
          remedy: REMEDY.uncertain,
        },
        command,
      );
      installed = true;
      principal = {
        userId: asString(registered.userId) || principal.userId,
        userSid: asString(registered.userSid) || principal.userSid,
        logonType: asString(registered.logonType) || "Interactive",
        runLevel: asString(registered.runLevel) || "Limited",
      };
    } catch (err) {
      if (err instanceof ZellijError && (err.code === "cancelled" || err.code === "timeout")) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw notReadyError(message, {
        ...partial({
          phase: "register",
          cause: "register_failed",
          stopped: alreadyRunning,
          command: redactedCommand,
          remedy:
            "Task mutation was interrupted; inspect the zswarm-serve task. Install does not claim rollback.",
        }),
      }, secrets, err instanceof ZellijError ? err.code : "zellij_failed");
    }
    assertRunnable("start", { installed: true, principal, command: redactedCommand });
    try {
      await mutate("start", { phase: "start", installed: true, principal, command: redactedCommand });
    } catch (err) {
      if (err instanceof ZellijError && (err.code === "cancelled" || err.code === "timeout")) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw notReadyError(message, {
        ...partial({
          installed: true,
          phase: "start",
          cause: "start_failed",
          principal,
          command: redactedCommand,
          remedy: REMEDY.notReady,
        }),
      }, secrets, err instanceof ZellijError ? err.code : "zellij_failed");
    }
  } else if (!alreadyRunning) {
    assertRunnable("start", { installed: true, principal, command: redactedCommand });
    await mutate("start", { phase: "start", installed: true, principal, command: redactedCommand });
    installed = true;
  }

  let lastCause = "serve_unreachable";
  let lastPhase = "hello";
  let lastRemedy: string = REMEDY.notReady;
  let lastServer: ServeHelloData | undefined;
  let lastInspection: DoctorCheck[] | undefined;
  let lastSessions: string[] = [];
  let probes = 0;
  const known = () =>
    partial({
      installed: true,
      principal,
      command: redactedCommand,
      phase: lastPhase,
      cause: lastCause,
      remedy: lastRemedy,
      ...(lastServer ? { server: lastServer } : {}),
      ...(lastInspection ? { inspection: { checks: lastInspection } } : {}),
      sessions: lastSessions,
      session: explicitSession,
    });
  const waitRetry = async (): Promise<void> => {
    try {
      await sleep(Math.min(100, remaining()));
    } catch (err) {
      if (err instanceof ZellijError && (err.code === "cancelled" || err.code === "timeout")) {
        throw notReadyError(err.message, known(), secrets, err.code);
      }
      throw err;
    }
  };

  while (remaining() > 0 && probes < 64) {
    assertRunnable("hello", known());
    probes += 1;
    const helloBudget = Math.max(1, Math.min(SERVE_HELLO_TIMEOUT_MS, remaining()));
    const hello = await probe(label, {
      token,
      timeoutMs: helloBudget,
      signal: input.signal,
    } satisfies ProbeServeOptions);
    if (!hello.ok) {
      if (hello.error.code === "cancelled") {
        throw notReadyError("serve --install cancelled during hello", known(), secrets, "cancelled");
      }
      lastPhase = "hello";
      lastCause = hello.error.code;
      lastRemedy =
        hello.error.code === "serve_unauthorized"
          ? REMEDY.token
          : hello.error.code === "serve_unreachable" || hello.error.code === "timeout"
            ? REMEDY.notReady
            : hello.error.message;
      if (remaining() <= 0) break;
      await waitRetry();
      continue;
    }
    const server = hello.data as ServeHelloData;
    lastServer = {
      protocol: server.protocol,
      serverId: server.serverId,
      hostname: server.hostname,
      platform: server.platform,
      version: server.version,
      capabilities: [...server.capabilities],
      ...(server.launchId ? { launchId: server.launchId } : {}),
    };
    if (server.protocol !== SERVE_PROTOCOL) {
      lastPhase = "hello";
      lastCause = "serve_incompatible";
      lastRemedy = `This serve protocol is not supported by this client (got ${server.protocol}).`;
      await waitRetry();
      continue;
    }
    if (server.launchId !== launchId) {
      lastPhase = "hello";
      lastCause = "stale_listener";
      lastRemedy = REMEDY.stale;
      if (remaining() <= 0) break;
      await waitRetry();
      continue;
    }
    assertRunnable("host", known());
    const hostResult = await call(label, hostDoctorRequest(remaining(), explicitSession), {
      timeoutMs: Math.max(1, remaining()),
      token,
      signal: input.signal,
    });
    const absorbHostRows = (result: OpsResult): ReturnType<typeof mergeHostReply> => {
      const merged = mergeHostReply(result);
      if (merged.checks.length) {
        lastInspection = coverHostReport(merged.checks, explicitSession);
        lastSessions = liveSessionsFrom(lastInspection);
      }
      return merged;
    };
    if (!hostResult.ok && hostResult.error.code === "cancelled") {
      absorbHostRows(hostResult);
      throw notReadyError("serve --install cancelled during host inspection", known(), secrets, "cancelled");
    }
    if (!hostResult.ok && hostResult.error.code === "timeout") {
      lastPhase = "host";
      lastCause = "timeout";
      lastRemedy = REMEDY.notReady;
      absorbHostRows(hostResult);
      if (remaining() <= 0) break;
      await waitRetry();
      continue;
    }
    if (!hostResult.ok) {
      const merged = absorbHostRows(hostResult);
      const checks = lastInspection ?? coverHostReport(merged.checks, explicitSession);
      const report = hostReportFromMerged(merged, checks, explicitSession);
      const verdict = evaluateHostReadiness(report, explicitSession);
      lastInspection = checks;
      lastPhase = verdict.phase ?? "host";
      lastCause = verdict.cause ?? hostResult.error.code;
      lastRemedy = verdict.remedy ?? hostResult.error.message;
      throw notReadyError(
        hostResult.error.message,
        {
          ...known(),
          envelope: { code: hostResult.error.code, message: hostResult.error.message },
          inspection: { checks },
        },
        secrets,
        hostResult.error.code || SERVE_NOT_READY_CODE,
      );
    }
    const merged = absorbHostRows(hostResult);
    if (merged.unsupported) {
      lastPhase = "host";
      lastCause = "doctor_unsupported";
      lastRemedy =
        "This serve peer does not implement doctor host inspection. Upgrade zswarm serve on the crew host, then retry.";
      await waitRetry();
      continue;
    }
    if (merged.invalid) {
      lastPhase = "host";
      lastCause = "host_report_invalid";
      lastRemedy =
        "Authenticated hello succeeded, but the host doctor reply was missing or malformed. Upgrade zswarm serve and retry.";
      if (remaining() <= 0) break;
      await waitRetry();
      continue;
    }
    const checks = coverHostReport(merged.checks, explicitSession);
    lastInspection = checks;
    lastSessions = liveSessionsFrom(checks);
    const verdict = evaluateHostReadiness(
      hostReportFromMerged(merged, checks, explicitSession),
      explicitSession,
    );
    if (verdict.ready) {
      assertRunnable("ready", {
        installed: true,
        principal,
        server: lastServer,
        inspection: { checks },
      });
      const data: ServeInstallSuccess = {
        installed: true,
        ready: true,
        running: true,
        task: SERVE_TASK_NAME,
        listen: label,
        command: redactedCommand,
        principal,
        server: lastServer,
        session: verdict.session,
        sessions: verdict.sessions,
        inspection: { checks },
      };
      if (verdict.warning) data.warning = verdict.warning;
      return scrubSecrets(data, secrets);
    }
    lastPhase = verdict.phase ?? "host";
    lastCause = verdict.cause ?? SERVE_NOT_READY_CODE;
    lastRemedy = verdict.remedy ?? REMEDY.notReady;
    const conclusive =
      lastCause === "session_missing" ||
      lastCause === "ipc_failed" ||
      lastCause === "zellij_missing" ||
      lastCause === "zellij_wrong_bin" ||
      lastCause === "zellij_incompatible";
    if (conclusive) {
      throw notReadyError(
        `serve --install registered ${SERVE_TASK_NAME} but it is not ready (${lastCause})`,
        known(),
        secrets,
      );
    }
    if (remaining() <= 0) break;
    await waitRetry();
  }

  if (input.signal?.aborted) {
    throw notReadyError("serve --install cancelled", known(), secrets, "cancelled");
  }
  const code = lastCause === "cancelled" ? "cancelled" : remaining() <= 0 || lastCause === "timeout" ? "timeout" : SERVE_NOT_READY_CODE;
  throw notReadyError(
    code === "timeout"
      ? "serve --install timed out waiting for authenticated readiness"
      : `serve --install registered ${SERVE_TASK_NAME} but it is not ready (${lastCause})`,
    known(),
    secrets,
    code === SERVE_NOT_READY_CODE ? SERVE_NOT_READY_CODE : code,
  );
}

export async function uninstallServeLogon(
  input: ServeInstallInput = {},
): Promise<{ task: string; cleared: true; stopped?: boolean; missing?: boolean; stopFailed?: boolean }> {
  if ((input.platform ?? process.platform) !== "win32") {
    throw new ZellijError("usage", "serve --clear is Windows-only");
  }
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs ?? DEFAULT_SERVE_INSTALL_TIMEOUT_MS));
  const now = input.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const remaining = () => remainingOf(deadline, now);
  const token = input.token?.trim() || input.env?.ZSWARM_SERVE_TOKEN?.trim() || "none";
  const secrets = token === "none" ? [] : [token];
  const run = input.runPowerShell ?? runPowerShellDefault;

  const assertClear = (phase: string, extra: Record<string, unknown> = {}): number => {
    if (input.signal?.aborted) {
      throw notReadyError("serve --clear cancelled", {
        installed: extra.installed ?? false,
        ready: false,
        task: SERVE_TASK_NAME,
        phase,
        cause: "cancelled",
        ...extra,
      }, secrets, "cancelled");
    }
    const left = remaining();
    if (left <= 0) {
      throw notReadyError("serve --clear timed out", {
        installed: extra.installed ?? false,
        ready: false,
        task: SERVE_TASK_NAME,
        phase,
        cause: "timeout",
        ...extra,
      }, secrets, "timeout");
    }
    return Math.min(20_000, left);
  };

  const inspectBudget = assertClear("inspect");
  const inspected = await runTask("inspect", {
    run,
    timeoutMs: inspectBudget,
    signal: input.signal,
    secrets,
  });
  secrets.push(...tokenFromCommand(commandFromArguments(asString(inspected.arguments))));
  assertClear("unregister", { installed: inspected.exists === true });
  if (inspected.exists === true) {
    const currentSid = asString(inspected.currentSid);
    const userSid = asString(inspected.userSid);
    const currentUser = asString(inspected.currentUser);
    const existingUser = asString(inspected.userId);
    const verified = isWindowsSid(currentSid) && isWindowsSid(userSid) && sameWindowsSid(currentSid, userSid);
    if (!verified || privilegedSid(userSid) || privilegedAccount(existingUser)) {
      throw notReadyError(
        `serve --clear will not remove ${SERVE_TASK_NAME} owned by ${existingUser || "an unverified account"}`,
        {
          installed: true,
          ready: false,
          task: SERVE_TASK_NAME,
          phase: "inspect",
          cause: SERVE_TASK_OWNED_CODE,
          remedy: REMEDY.owner,
          principal: { userId: existingUser, userSid },
          currentUser,
          currentSid,
        },
        secrets,
        SERVE_TASK_OWNED_CODE,
      );
    }
  }
  const unregisterBudget = assertClear("unregister", { installed: inspected.exists === true });
  let cleared: Record<string, unknown>;
  try {
    cleared = await runTask("unregister", {
      run,
      timeoutMs: unregisterBudget,
      signal: input.signal,
      secrets,
    });
  } catch (err) {
    if (err instanceof ZellijError && (err.code === "cancelled" || err.code === "timeout")) {
      throw notReadyError(err.message, {
        ready: false,
        task: SERVE_TASK_NAME,
        phase: "unregister",
        cause: err.code,
        mutation: "uncertain",
        observed: { existed: inspected.exists === true },
        remedy: REMEDY.uncertain,
      }, secrets, err.code);
    }
    throw err;
  }
  const confirmed = {
    cleared: true as const,
    stopped: cleared.stopped === true,
    ...(cleared.missing === true ? { missing: true } : {}),
    ...(cleared.stopFailed === true ? { stopFailed: true } : {}),
  };
  assertClear("unregister", confirmed);
  return {
    task: SERVE_TASK_NAME,
    ...confirmed,
  };
}
