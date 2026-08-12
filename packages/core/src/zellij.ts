import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type ZellijExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type ZellijExecFn = (
  args: string[],
  options: { timeoutMs: number },
) => Promise<ZellijExecResult>;

export type ZellijPane = {
  id: string;
  numericId: number;
  isPlugin: boolean;
  title: string;
  command?: string | null;
  cwd?: string | null;
  tabName?: string | null;
  tabId?: number | null;
  focused: boolean;
  exited: boolean;
  floating: boolean;
};

export type ZellijSessionResolve = {
  session: string;
  source: "arg" | "env_zswarm" | "env_zellij" | "sole_live";
};

export type PaneDirection = "right" | "left" | "up" | "down";

export type NewPaneInput = {
  session: string;
  command?: string[];
  cwd?: string | null;
  name?: string | null;
  direction?: PaneDirection | null;
  floating?: boolean;
  closeOnExit?: boolean;
  tabId?: number | null;
  width?: string | null;
  height?: string | null;
};

export type NewTabInput = {
  session: string;
  command?: string[];
  cwd?: string | null;
  name?: string | null;
  layout?: string | null;
  closeOnExit?: boolean;
};

export class ZellijError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ZellijError";
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const NOT_FOUND_EXIT = 127;

/** Expand a leading `~/` or `~\` using USERPROFILE/HOME. */
export function expandHomePath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith("~/") && !trimmed.startsWith("~\\")) return trimmed;
  const home = env.USERPROFILE || env.HOME || homedir();
  if (!home) return trimmed;
  return join(home, trimmed.slice(2));
}

export function resolveZellijBinary(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = expandHomePath(
    (env.ZSWARM_BIN ?? env.ZSWARM_PATH ?? env.ZELLIJ_BIN ?? "")
      .trim()
      .replace(/^['"]|['"]$/g, ""),
    env,
  );
  if (fromEnv && existsSync(fromEnv)) {
    if (/\.cmd$/i.test(fromEnv)) {
      const exe = fromEnv.replace(/\.cmd$/i, ".exe");
      if (existsSync(exe)) return exe;
      const wingetExe = join(
        env.LOCALAPPDATA ||
          join(env.USERPROFILE || env.HOME || homedir(), "AppData", "Local"),
        "Zellij",
        "zellij.exe",
      );
      if (existsSync(wingetExe)) return wingetExe;
    }
    return fromEnv;
  }

  const home = env.USERPROFILE || env.HOME || homedir();
  const localAppData =
    env.LOCALAPPDATA || (home ? join(home, "AppData", "Local") : "");
  const candidates = [
    localAppData ? join(localAppData, "Zellij", "zellij.exe") : "",
    home ? join(home, ".local", "bin", "zellij") : "",
    home ? join(home, ".cargo", "bin", "zellij") : "",
    home ? join(home, ".cargo", "bin", "zellij.exe") : "",
    "/usr/local/bin/zellij",
    "/opt/homebrew/bin/zellij",
    ...(env.PATH ?? env.Path ?? "")
      .split(delimiter)
      .filter(Boolean)
      .flatMap((dir) =>
        process.platform === "win32"
          ? [join(dir, "zellij.exe"), join(dir, "zellij")]
          : [join(dir, "zellij")],
      ),
  ].filter(Boolean);

  for (const cand of candidates) {
    if (existsSync(cand)) return cand;
  }
  return process.platform === "win32" ? "zellij.exe" : "zellij";
}

/**
 * Pane hosting the caller, so writes can refuse to loop back into it.
 * `ZSWARM_SELF_PANE` wins; Zellij exports `ZELLIJ_PANE_ID` inside a pane.
 */
export function resolveSelfPaneId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = (env.ZSWARM_SELF_PANE ?? env.ZELLIJ_PANE_ID ?? "").trim();
  if (!raw || raw.toLowerCase() === "none") return null;
  if (/^\d+$/.test(raw)) return `terminal_${raw}`;
  if (/^(terminal|plugin)_\d+$/i.test(raw)) return raw.toLowerCase();
  return null;
}

export function sanitizeZellijEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (typeof value === "string") out[key] = value;
  }
  if (process.platform === "win32") {
    if (!out.SystemRoot && !out.SYSTEMROOT) {
      out.SystemRoot = process.env.SystemRoot || "C:\\Windows";
    }
    if (out.PATH && !out.Path) out.Path = out.PATH;
    if (out.Path && !out.PATH) out.PATH = out.Path;
  }
  return out;
}

function defaultExec(zellijPath: string, env: NodeJS.ProcessEnv): ZellijExecFn {
  const cleanEnv = sanitizeZellijEnv(env);
  return (args, options) =>
    new Promise<ZellijExecResult>((resolve) => {
      execFile(
        zellijPath,
        args,
        {
          timeout: options.timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          env: cleanEnv,
        },
        (error, stdout, stderr) => {
          const failure = error as
            | (Error & { code?: unknown; killed?: boolean; signal?: string })
            | null;
          if (failure && typeof failure.code === "string") {
            const missing =
              failure.code === "ENOENT" || failure.code === "ENOTDIR";
            resolve({
              code: missing ? NOT_FOUND_EXIT : 1,
              stdout: "",
              stderr: `${failure.code}: ${failure.message} (bin=${zellijPath})`,
            });
            return;
          }
          if (
            failure &&
            (failure.killed === true || typeof failure.signal === "string")
          ) {
            resolve({
              code: -1,
              stdout: String(stdout ?? ""),
              stderr: `zellij timed out after ${options.timeoutMs}ms`,
            });
            return;
          }
          const code =
            failure && typeof failure.code === "number"
              ? failure.code
              : failure
                ? 1
                : 0;
          resolve({
            code,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
          });
        },
      );
    });
}

export type ZellijClientOptions = {
  exec?: ZellijExecFn;
  zellijPath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export function createZellijClient(options: ZellijClientOptions = {}) {
  const env = options.env ?? process.env;
  const zellijPath = options.zellijPath ?? resolveZellijBinary(env);
  const exec = options.exec ?? defaultExec(zellijPath, env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const selfPaneId = resolveSelfPaneId(env);

  async function run(args: string[], label: string): Promise<ZellijExecResult> {
    const result = await exec(args, { timeoutMs });
    if (result.code === NOT_FOUND_EXIT) {
      throw new ZellijError(
        "zellij_missing",
        `zellij binary not found (${zellijPath}); install Zellij ≥ 0.42, add it to PATH, or set ZSWARM_BIN / ZSWARM_PATH`,
      );
    }
    if (result.code !== 0) {
      throw new ZellijError(
        "zellij_failed",
        `${label} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
      );
    }
    return result;
  }

  function sessionPrefix(session: string | undefined): string[] {
    return session ? ["--session", session] : [];
  }

  function normalizePaneId(raw: string, isPlugin = false): string {
    const t = raw.trim();
    if (!t) throw new ZellijError("invalid_pane", "empty pane id");
    if (/^(terminal|plugin)_\d+$/i.test(t)) return t.toLowerCase();
    if (/^\d+$/.test(t)) {
      return isPlugin ? `plugin_${t}` : `terminal_${t}`;
    }
    return t;
  }

  async function listSessions(): Promise<string[]> {
    const result = await run(
      ["list-sessions", "--short", "--no-formatting"],
      "zellij list-sessions",
    );
    return result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  async function resolveSession(
    explicit?: string | null,
  ): Promise<ZellijSessionResolve> {
    const arg = explicit?.trim();
    if (arg) return { session: arg, source: "arg" };

    const swarmEnv = env.ZSWARM_SESSION?.trim();
    if (swarmEnv) return { session: swarmEnv, source: "env_zswarm" };

    const zellijEnv = env.ZELLIJ_SESSION_NAME?.trim();
    if (zellijEnv) return { session: zellijEnv, source: "env_zellij" };

    const sessions = await listSessions();
    if (sessions.length === 1) {
      return { session: sessions[0]!, source: "sole_live" };
    }
    if (sessions.length === 0) {
      throw new ZellijError(
        "zellij_no_session",
        "no live Zellij sessions; start zellij or pass session=",
      );
    }
    throw new ZellijError(
      "zellij_session_ambiguous",
      `multiple Zellij sessions (${sessions.join(", ")}); pass session=`,
    );
  }

  function parsePaneRow(row: Record<string, unknown>): ZellijPane | null {
    const numericId = Number(row.id);
    if (!Number.isFinite(numericId)) return null;
    const isPlugin = row.is_plugin === true;
    const id = isPlugin ? `plugin_${numericId}` : `terminal_${numericId}`;
    const title = String(row.title ?? "");
    const command =
      (typeof row.pane_command === "string" && row.pane_command) ||
      (typeof row.terminal_command === "string" && row.terminal_command) ||
      null;
    return {
      id,
      numericId,
      isPlugin,
      title,
      command,
      cwd: typeof row.pane_cwd === "string" ? row.pane_cwd : null,
      tabName: typeof row.tab_name === "string" ? row.tab_name : null,
      tabId: typeof row.tab_id === "number" ? row.tab_id : null,
      focused: row.is_focused === true,
      exited: row.exited === true,
      floating: row.is_floating === true,
    };
  }

  async function listPanes(session: string): Promise<ZellijPane[]> {
    const result = await run(
      buildListPanesArgs(session),
      "zellij action list-panes",
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new ZellijError(
        "zellij_failed",
        "list-panes returned non-JSON output",
      );
    }
    if (!Array.isArray(parsed)) {
      throw new ZellijError("zellij_failed", "list-panes JSON was not an array");
    }
    const panes: ZellijPane[] = [];
    for (const row of parsed) {
      if (row && typeof row === "object") {
        const pane = parsePaneRow(row as Record<string, unknown>);
        if (pane) panes.push(pane);
      }
    }
    return panes;
  }

  function resolvePane(panes: ZellijPane[], to: string): ZellijPane {
    const key = to.trim();
    if (!key) {
      throw new ZellijError("peer_not_found", "to (pane id or title) required");
    }

    const byTypedId = panes.find((p) => p.id === key.toLowerCase());
    if (byTypedId) return byTypedId;

    if (/^\d+$/.test(key)) {
      const terminals = panes.filter(
        (p) => !p.isPlugin && String(p.numericId) === key,
      );
      if (terminals.length === 1) return terminals[0]!;
      const any = panes.filter((p) => String(p.numericId) === key);
      if (any.length === 1) return any[0]!;
      if (any.length > 1) {
        throw new ZellijError(
          "peer_ambiguous",
          `pane id ${key} matches both terminal and plugin; use terminal_${key} or plugin_${key}`,
        );
      }
    }

    const lowered = key.toLowerCase();
    const titleMatches = panes.filter(
      (p) => !p.isPlugin && p.title.toLowerCase() === lowered,
    );
    if (titleMatches.length === 1) return titleMatches[0]!;
    if (titleMatches.length > 1) {
      throw new ZellijError(
        "peer_ambiguous",
        `multiple panes titled "${key}"; use pane id from list`,
      );
    }

    const cmdMatches = panes.filter((p) => {
      if (p.isPlugin || !p.command) return false;
      const base = p.command.replace(/\\/g, "/").split("/").pop() ?? "";
      const baseNoExt = base.replace(/\.(exe|cmd|bat)$/i, "");
      return (
        base.toLowerCase() === lowered ||
        baseNoExt.toLowerCase() === lowered ||
        p.command.toLowerCase().includes(lowered)
      );
    });
    if (cmdMatches.length === 1) return cmdMatches[0]!;
    if (cmdMatches.length > 1) {
      throw new ZellijError(
        "peer_ambiguous",
        `multiple panes match command "${key}"; use pane id from list`,
      );
    }

    const titlePartial = panes.filter(
      (p) => !p.isPlugin && p.title.toLowerCase().includes(lowered),
    );
    if (titlePartial.length === 1) return titlePartial[0]!;
    if (titlePartial.length > 1) {
      throw new ZellijError(
        "peer_ambiguous",
        `multiple panes match "${key}"; use pane id from list`,
      );
    }

    throw new ZellijError(
      "peer_not_found",
      `no Zellij pane matching "${key}"; zswarm({op:"list"}) to list`,
    );
  }

  async function injectPane(input: {
    session: string;
    paneId: string;
    text: string;
  }): Promise<{ paneId: string; session: string }> {
    const paneId = normalizePaneId(input.paneId);
    const text = input.text;
    if (!text) {
      throw new ZellijError("missing_body", "inject text required");
    }
    await run(
      buildPasteArgs(input.session, paneId, text),
      "zellij action paste",
    );
    await run(
      buildSendEnterArgs(input.session, paneId),
      "zellij action send-keys",
    );
    return { paneId, session: input.session };
  }

  async function dumpPane(input: {
    session: string;
    paneId: string;
    full?: boolean;
  }): Promise<{ paneId: string; session: string; text: string }> {
    const paneId = normalizePaneId(input.paneId);
    const result = await run(
      buildDumpArgs(input.session, paneId, input.full),
      "zellij action dump-screen",
    );
    return { paneId, session: input.session, text: result.stdout };
  }

  async function sendKeys(input: {
    session: string;
    paneId: string;
    keys: string[];
  }): Promise<{ paneId: string; session: string; keys: string[] }> {
    const paneId = normalizePaneId(input.paneId);
    if (input.keys.length === 0) {
      throw new ZellijError("bad_key", "no keys given");
    }
    await run(
      buildSendKeysArgs(input.session, paneId, input.keys),
      "zellij action send-keys",
    );
    return { paneId, session: input.session, keys: input.keys };
  }

  async function writeChars(input: {
    session: string;
    paneId: string;
    chars: string;
  }): Promise<{ paneId: string; session: string }> {
    const paneId = normalizePaneId(input.paneId);
    if (!input.chars) {
      throw new ZellijError("missing_body", "chars required");
    }
    await run(
      buildWriteCharsArgs(input.session, paneId, input.chars),
      "zellij action write-chars",
    );
    return { paneId, session: input.session };
  }

  async function closePane(input: {
    session: string;
    paneId: string;
  }): Promise<{ paneId: string; session: string }> {
    const paneId = normalizePaneId(input.paneId);
    await run(
      buildClosePaneArgs(input.session, paneId),
      "zellij action close-pane",
    );
    return { paneId, session: input.session };
  }

  /** `new-pane` prints the created pane id; `new-tab` prints a tab id instead. */
  function parseCreatedPaneId(stdout: string): string | null {
    const match = /(terminal|plugin)_\d+/i.exec(stdout);
    return match ? match[0].toLowerCase() : null;
  }

  async function newPane(
    input: NewPaneInput,
  ): Promise<{ session: string; paneId: string | null; stdout: string }> {
    const result = await run(
      buildNewPaneArgs(input),
      "zellij action new-pane",
    );
    return {
      session: input.session,
      paneId: parseCreatedPaneId(result.stdout),
      stdout: result.stdout.trim(),
    };
  }

  async function newTab(
    input: NewTabInput,
  ): Promise<{ session: string; tabId: number | null; stdout: string }> {
    const result = await run(buildNewTabArgs(input), "zellij action new-tab");
    const digits = /-?\d+/.exec(result.stdout);
    return {
      session: input.session,
      tabId: digits ? Number(digits[0]) : null,
      stdout: result.stdout.trim(),
    };
  }

  /** Visible prefix so peer CLIs can tell zSwarm injects from human prompts. */
  function formatPeerMessage(from: string, body: string): string {
    const sender = from.trim() || "swarm";
    return `[zswarm from=${sender}]\n${body.trim()}`;
  }

  function buildListPanesArgs(session: string): string[] {
    return [
      ...sessionPrefix(session),
      "action",
      "list-panes",
      "--json",
      "--command",
      "--state",
      "--tab",
    ];
  }

  function buildPasteArgs(
    session: string,
    paneId: string,
    text: string,
  ): string[] {
    return [
      ...sessionPrefix(session),
      "action",
      "paste",
      "--pane-id",
      normalizePaneId(paneId),
      // Without the end-of-options marker, a body starting with `-` is parsed
      // as a zellij flag instead of being typed.
      "--",
      text,
    ];
  }

  function buildSendEnterArgs(session: string, paneId: string): string[] {
    return [
      ...sessionPrefix(session),
      "action",
      "send-keys",
      "--pane-id",
      normalizePaneId(paneId),
      "Enter",
    ];
  }

  function buildDumpArgs(
    session: string,
    paneId: string,
    full = false,
  ): string[] {
    const args = [
      ...sessionPrefix(session),
      "action",
      "dump-screen",
      "--pane-id",
      normalizePaneId(paneId),
    ];
    if (full) args.push("--full");
    return args;
  }

  function buildSendKeysArgs(
    session: string,
    paneId: string,
    keys: string[],
  ): string[] {
    for (const key of keys) {
      if (key.length > 1 && key.startsWith("-")) {
        throw new ZellijError("bad_key", `key "${key}" looks like a flag`);
      }
    }
    return [
      ...sessionPrefix(session),
      "action",
      "send-keys",
      "--pane-id",
      normalizePaneId(paneId),
      ...keys,
    ];
  }

  function buildWriteCharsArgs(
    session: string,
    paneId: string,
    chars: string,
  ): string[] {
    return [
      ...sessionPrefix(session),
      "action",
      "write-chars",
      "--pane-id",
      normalizePaneId(paneId),
      "--",
      chars,
    ];
  }

  function buildClosePaneArgs(session: string, paneId: string): string[] {
    return [
      ...sessionPrefix(session),
      "action",
      "close-pane",
      "--pane-id",
      normalizePaneId(paneId),
    ];
  }

  function buildNewPaneArgs(input: NewPaneInput): string[] {
    const args = [...sessionPrefix(input.session), "action", "new-pane"];
    if (input.cwd) args.push("--cwd", input.cwd);
    if (input.name) args.push("--name", input.name);
    if (input.direction) args.push("--direction", input.direction);
    if (input.floating) args.push("--floating");
    if (input.width) args.push("--width", input.width);
    if (input.height) args.push("--height", input.height);
    if (typeof input.tabId === "number") {
      args.push("--tab-id", String(input.tabId));
    }
    if (input.closeOnExit) args.push("--close-on-exit");
    if (input.command && input.command.length > 0) {
      args.push("--", ...input.command);
    }
    return args;
  }

  function buildNewTabArgs(input: NewTabInput): string[] {
    const args = [...sessionPrefix(input.session), "action", "new-tab"];
    if (input.cwd) args.push("--cwd", input.cwd);
    if (input.name) args.push("--name", input.name);
    if (input.layout) args.push("--layout", input.layout);
    if (input.closeOnExit) args.push("--close-on-exit");
    if (input.command && input.command.length > 0) {
      args.push("--", ...input.command);
    }
    return args;
  }

  return {
    zellijPath,
    selfPaneId,
    listSessions,
    resolveSession,
    listPanes,
    resolvePane,
    injectPane,
    dumpPane,
    sendKeys,
    writeChars,
    closePane,
    newPane,
    newTab,
    normalizePaneId,
    formatPeerMessage,
    buildListPanesArgs,
    buildPasteArgs,
    buildSendEnterArgs,
    buildDumpArgs,
    buildSendKeysArgs,
    buildWriteCharsArgs,
    buildClosePaneArgs,
    buildNewPaneArgs,
    buildNewTabArgs,
  };
}

export type ZellijClient = ReturnType<typeof createZellijClient>;
