/**
 * Zellij keeps its session sockets under TEMP (Windows) / TMPDIR (Unix).
 * An SSH login on Windows is a different session from the interactive desktop,
 * so the CLI looks in the wrong directory unless we point it at the live one.
 * Windows pane attach still uses named pipes in that desktop session — TEMP
 * is enough to list sessions; `interactive` or `serve` is what can write.
 */

/** `…/zellij/contract_version_N/…` or Unix `…/zellij-<uid>/contract_version_N/…`. */
const ZELLIJ_DIR =
  /[\\/](zellij(?:-\d+)?)[\\/]contract_version_[^\\/]+[\\/]/i;
const SERVER_FLAG =
  /(?:^|\s)--server(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/;

/** Drive letter plus rest, or a UNC / posix path. */
export function looksLikeWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\");
}

function stripQuotes(path: string): string {
  return path.trim().replace(/^["']|["']$/g, "");
}

/**
 * `--server C:\Temp\zellij\contract_version_1\crew` → `C:\Temp`.
 * The session file sits in `…/zellij[-uid]/contract_version_N/<name>`; TEMP is
 * the parent of that `zellij` directory.
 */
export function tmpFromServerPath(serverPath: string): string | null {
  const trimmed = stripQuotes(serverPath);
  if (!trimmed) return null;
  const match = ZELLIJ_DIR.exec(trimmed);
  if (!match || match.index <= 0) return null;
  return trimmed.slice(0, match.index);
}

/**
 * Directory Zellij treats as `ZELLIJ_SOCKET_DIR` — the `zellij` / `zellij-<uid>`
 * folder that contains `contract_version_N`.
 */
export function socketDirFromServerPath(serverPath: string): string | null {
  const trimmed = stripQuotes(serverPath);
  if (!trimmed) return null;
  const match = ZELLIJ_DIR.exec(trimmed);
  if (!match || match.index < 0) return null;
  const name = match[1];
  if (!name) return null;
  return trimmed.slice(0, match.index + 1 + name.length);
}

export type IpcDirs = { tmp: string; socketDir: string };

/** Pull every `--server <path>` out of process command lines. */
export function parseZellijServerPaths(commandLines: string): string[] {
  const found: string[] = [];
  for (const line of commandLines.split(/\r?\n/)) {
    const match = SERVER_FLAG.exec(line);
    const captured = match?.[1] || match?.[2] || match?.[3];
    if (captured) found.push(stripQuotes(captured));
  }
  return found;
}

/** Majority vote so a stray SSH-session server does not win. */
export function pickIpcDirs(serverPaths: string[]): IpcDirs | null {
  const counts = new Map<string, { count: number; socketDir: string }>();
  for (const server of serverPaths) {
    const tmp = tmpFromServerPath(server);
    const socketDir = socketDirFromServerPath(server);
    if (!tmp || !socketDir) continue;
    const prev = counts.get(tmp);
    if (prev) prev.count += 1;
    else counts.set(tmp, { count: 1, socketDir });
  }
  let best: IpcDirs | null = null;
  let bestCount = 0;
  for (const [tmp, { count, socketDir }] of counts) {
    if (count > bestCount) {
      best = { tmp, socketDir };
      bestCount = count;
    }
  }
  return best;
}

export function pickIpcTmp(serverPaths: string[]): string | null {
  return pickIpcDirs(serverPaths)?.tmp ?? null;
}

export function concreteTmp(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.toLowerCase() === "auto") return undefined;
  return trimmed;
}

export type RemoteShell = "cmd" | "sh";

export function inferRemoteShell(input: {
  explicit?: string;
  tmp?: string;
  remoteBin?: string;
  mode?: string;
}): RemoteShell {
  const explicit = input.explicit?.trim().toLowerCase();
  if (explicit === "cmd" || explicit === "sh") return explicit;
  if (input.mode === "interactive") return "cmd";
  if (input.remoteBin && /\.exe$/i.test(input.remoteBin)) return "cmd";
  if (input.tmp && looksLikeWindowsPath(input.tmp)) return "cmd";
  return "sh";
}

/** cmd.exe quoting: double quotes, doubled inner quotes. */
export function cmdQuote(arg: string): string {
  if (arg === "") return '""';
  // cmd.exe expands %VAR% even inside quotes; double percents to keep literals.
  const escaped = arg.replace(/%/g, "%%");
  if (/^[A-Za-z0-9_@+=:,.\\/-]+$/.test(escaped.replace(/%%/g, ""))) {
    return escaped;
  }
  return `"${escaped.replace(/"/g, '""')}"`;
}

function defaultSocketDir(tmp: string, shell: RemoteShell): string | undefined {
  if (shell !== "cmd") return undefined;
  return tmp.replace(/[\\/]+$/, "") + "\\zellij";
}

export function wrapWithTmpEnv(
  command: string,
  tmp: string,
  shell: RemoteShell,
  socketDir?: string,
): string {
  const sock = socketDir || defaultSocketDir(tmp, shell);
  if (shell === "cmd") {
    let prefix = `set "TEMP=${tmp}" && set "TMP=${tmp}"`;
    if (sock) prefix += ` && set "ZELLIJ_SOCKET_DIR=${sock}"`;
    return `${prefix} && ${command}`;
  }
  const q = tmp.replace(/'/g, `'\\''`);
  let prefix = `TMPDIR='${q}' TEMP='${q}' TMP='${q}'`;
  if (sock) {
    const sq = sock.replace(/'/g, `'\\''`);
    prefix += ` ZELLIJ_SOCKET_DIR='${sq}'`;
  }
  return `${prefix} ${command}`;
}

const WINDOWS_DISCOVER_PS =
  "Get-CimInstance Win32_Process -Filter \"Name='zellij.exe'\" | ForEach-Object { $_.CommandLine }";

/** UTF-16LE base64, which `powershell -EncodedCommand` expects. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function windowsDiscoverRemote(): string {
  return `powershell.exe -NoProfile -EncodedCommand ${encodePowerShellCommand(WINDOWS_DISCOVER_PS)}`;
}

export function unixDiscoverRemote(): string {
  return "ps ax -o args=";
}

/**
 * Run `innerCmd` (a cmd.exe command line) in the interactive Windows session
 * via a one-shot `schtasks /IT` job. SSH itself stays in session 0; the task
 * is what can see the desktop's named pipes.
 */
export function windowsInteractiveRemote(
  innerCmd: string,
  timeoutMs: number,
): string {
  const innerB64 = Buffer.from(innerCmd, "utf8").toString("base64");
  const waitMs = Math.max(1000, timeoutMs - 2000);
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "$inner = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
      innerB64 +
      "'))",
    "$id = [guid]::NewGuid().ToString('n').Substring(0,8)",
    "$task = \"zswarm-$id\"",
    "$dir = Join-Path $env:LOCALAPPDATA 'Temp'",
    "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
    "$bat = Join-Path $dir \"zswarm-$id.bat\"",
    "$out = Join-Path $dir \"zswarm-$id.out\"",
    "$err = Join-Path $dir \"zswarm-$id.err\"",
    "$code = Join-Path $dir \"zswarm-$id.code\"",
    "$lines = @(",
    "  '@echo off'",
    "  'chcp 65001 >nul'",
    "  \"$inner > `\"$out`\" 2> `\"$err`\"\"",
    "  \"echo %ERRORLEVEL% > `\"$code`\"\"",
    ")",
    "[IO.File]::WriteAllLines($bat, $lines, [Text.UTF8Encoding]::new($false))",
    "try {",
    "  $create = & schtasks.exe /Create /TN $task /TR $bat /SC ONCE /ST 00:00 /IT /F /RL LIMITED 2>&1",
    "  if ($LASTEXITCODE -ne 0) {",
    "    [Console]::Error.Write(($create | Out-String).Trim())",
    "    exit 1",
    "  }",
    "  # schtasks /Run ignores /IT and stays in session 0. Start-ScheduledTask honours it.",
    "  Start-ScheduledTask -TaskName $task",
    "  $deadline = (Get-Date).AddMilliseconds(" + waitMs + ")",
    "  do { Start-Sleep -Milliseconds 200 } while (-not (Test-Path $code) -and (Get-Date) -lt $deadline)",
    "  if (Test-Path $out) { [Console]::Out.Write([IO.File]::ReadAllText($out)) }",
    "  if (Test-Path $err) { [Console]::Error.Write([IO.File]::ReadAllText($err)) }",
    "  if (Test-Path $code) { exit [int](((Get-Content $code -TotalCount 1) | Out-String).Trim()) }",
    "  [Console]::Error.Write('zswarm: interactive task produced no exit code; is a desktop session logged on?')",
    "  exit 1",
    "} finally {",
    "  & schtasks.exe /Delete /TN $task /F 2>&1 | Out-Null",
    "  Remove-Item $bat,$out,$err,$code -Force -ErrorAction SilentlyContinue",
    "}",
  ].join("\n");
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`;
}

export function applyIpcTmpEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const tmp = concreteTmp(env.ZSWARM_TMP);
  if (!tmp) return env;
  const out: NodeJS.ProcessEnv = { ...env, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
  const sock = defaultSocketDir(tmp, looksLikeWindowsPath(tmp) ? "cmd" : "sh");
  if (sock) out.ZELLIJ_SOCKET_DIR = sock;
  return out;
}
