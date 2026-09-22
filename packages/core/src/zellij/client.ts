import { ZellijError } from "../errors.js";
import {
  buildClosePaneArgs,
  buildDumpArgs,
  buildDumpLayoutArgs,
  buildFocusPaneArgs,
  buildLaunchPluginArgs,
  buildListPanesArgs,
  buildListTabsArgs,
  buildNewPaneArgs,
  buildNewTabArgs,
  buildPasteArgs,
  buildPipeArgs,
  buildRenamePaneArgs,
  buildRenameTabArgs,
  buildSendEnterArgs,
  buildSendKeysArgs,
  buildStackPanesArgs,
  buildWriteCharsArgs,
  changedPayload,
  scrollbackPayload,
  waitPayload,
  type WaitRequest,
  type LaunchPluginInput,
  type NewPaneInput,
  type NewTabInput,
  type PipeInput,
} from "./args.js";
import {
  DEFAULT_BUS_TIMEOUT_MS,
  parseBusReply,
  parseChangedReply,
  parseScrollbackReply,
  parseWaitReply,
} from "./bus.js";
import { parseTabList, resolveTab, type ZellijTab } from "./tabs.js";
import { createSshExec, type IpcDiscoveryState, type SshExecFn } from "../exec.js";
import {
  DEFAULT_TIMEOUT_MS,
  NOT_FOUND_EXIT,
  defaultExec,
  ensureZellijCapabilities,
  ensureZellijIdentity,
  identityCacheKey,
  resolveSshTarget,
  resolveZellijBinary,
  sanitizeZellijEnv,
  type ZellijExecFn,
} from "./binary.js";
import {
  normalizePaneId,
  parsePaneList,
  resolvePane,
  type ZellijPane,
} from "./panes.js";
import {
  isZellijNoSessionsOutput,
  parseSessionList,
  resolveSelfPaneId,
  sessionFromEnv,
  sessionFromList,
  type ZellijSession,
  type ZellijSessionResolve,
} from "./session.js";

export type ZellijClientOptions = {
  exec?: ZellijExecFn;
  zellijPath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Skip the one-time `zellij --version` identity probe (tests). */
  skipIdentityProbe?: boolean;
};

export type ZellijTransport = {
  kind: "local" | "ssh";
  mode: "local" | "ssh" | "interactive";
  host?: string;
  remoteBin?: string;
  /** Configured or resolved IPC temp (`auto` until discovery succeeds). */
  tmp?: string;
  /** Outcome of `ZSWARM_TMP=auto` discovery when SSH routing is active. */
  ipc?: IpcDiscoveryState;
};

/** Thin, stateless wrapper over the `zellij` binary. */
export function createZellijClient(options: ZellijClientOptions = {}) {
  const env = options.env ?? process.env;
  // A remote crew never resolves a local binary. An injected exec is a unit
  // test (or in-process stand-in) — skip PATH/env resolution so a poisoned
  // ZSWARM_BIN in the host environment cannot fail client construction.
  const ssh = options.exec ? null : resolveSshTarget(env);
  const zellijPath =
    options.zellijPath ??
    (options.exec
      ? "zellij"
      : ssh
        ? `ssh://${ssh.host}/${ssh.remoteBin}`
        : resolveZellijBinary(env));
  const sshExec: SshExecFn | null =
    options.exec || !ssh
      ? null
      : createSshExec(ssh, sanitizeZellijEnv(env));
  const rawExec: ZellijExecFn =
    options.exec ??
    (sshExec ? sshExec : defaultExec(zellijPath, env));
  const exec: ZellijExecFn = (args, opts) =>
    rawExec(args, { ...opts, signal: opts.signal ?? options.signal });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const selfPaneId = resolveSelfPaneId(env);
  const probeKey = identityCacheKey(zellijPath, ssh);

  function readTransport(): ZellijTransport {
    if (!ssh) return { kind: "local", mode: "local" };
    const ipc = sshExec?.ipcState;
    return {
      kind: "ssh",
      mode: ssh.mode ?? "ssh",
      host: ssh.host,
      remoteBin: ssh.remoteBin,
      tmp: ipc?.tmp ?? ssh.tmp,
      ipc: ipc
        ? {
            requested: ipc.requested,
            status: ipc.status,
            tmp: ipc.tmp,
            socketDir: ipc.socketDir,
          }
        : undefined,
    };
  }

  function operationBudget(budget: number, label: string): () => number {
    const deadline = Date.now() + budget;
    return () => {
      if (options.signal?.aborted) {
        throw new ZellijError("cancelled", "operation cancelled");
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new ZellijError(
          "zellij_failed",
          `${label} timed out after ${budget}ms`,
        );
      }
      return left;
    };
  }

  async function ensureIdentity(remaining: () => number): Promise<void> {
    if (options.skipIdentityProbe || options.exec) return;
    // Only the helpers' positively verified results are cached. In-flight or
    // unresolved probes must not tie this call to another operation's budget.
    await ensureZellijIdentity(exec, zellijPath, remaining(), probeKey);
    await ensureZellijCapabilities(exec, zellijPath, remaining(), probeKey);
  }

  async function run(
    args: string[],
    label: string,
    callTimeoutMs = timeoutMs,
  ) {
    const remaining = operationBudget(callTimeoutMs, label);
    await ensureIdentity(remaining);
    const result = await exec(args, { timeoutMs: remaining() });
    if (result.code === NOT_FOUND_EXIT) {
      throw new ZellijError(
        "zellij_missing",
        `zellij binary not found (${zellijPath}); install Zellij ≥ 0.42, add it to PATH, or set ZSWARM_BIN / ZSWARM_PATH`,
      );
    }
    if (result.code !== 0) {
      const detail =
        result.stderr.trim() || result.stdout.trim() || "no output";
      if (/usage:\s*zswarm/i.test(detail) || /unknown arg:/i.test(detail)) {
        throw new ZellijError(
          "zellij_wrong_bin",
          `resolved binary looks like zswarm, not Zellij (${zellijPath}): ${detail}`,
        );
      }
      throw new ZellijError(
        "zellij_failed",
        `${label} failed (exit ${result.code}): ${detail}`,
      );
    }
    return result;
  }

  async function listSessions(
    callTimeoutMs = timeoutMs,
  ): Promise<ZellijSession[]> {
    const remaining = operationBudget(callTimeoutMs, "zellij list-sessions");
    await ensureIdentity(remaining);
    // Keep annotations (EXITED / current); --short drops them.
    const result = await exec(["list-sessions", "--no-formatting"], {
      timeoutMs: remaining(),
    });
    if (result.code === NOT_FOUND_EXIT) {
      throw new ZellijError(
        "zellij_missing",
        `zellij binary not found (${zellijPath}); install Zellij ≥ 0.42, add it to PATH, or set ZSWARM_BIN / ZSWARM_PATH`,
      );
    }
    if (result.code !== 0) {
      const detail =
        result.stderr.trim() || result.stdout.trim() || "no output";
      if (/usage:\s*zswarm/i.test(detail) || /unknown arg:/i.test(detail)) {
        throw new ZellijError(
          "zellij_wrong_bin",
          `resolved binary looks like zswarm, not Zellij (${zellijPath}): ${detail}`,
        );
      }
      if (isZellijNoSessionsOutput(result.stdout, result.stderr)) return [];
      throw new ZellijError(
        "zellij_failed",
        `zellij list-sessions failed (exit ${result.code}): ${detail}`,
      );
    }
    return parseSessionList(result.stdout);
  }

  async function resolveSession(
    explicit?: string | null,
    callTimeoutMs = timeoutMs,
  ): Promise<ZellijSessionResolve> {
    return (
      sessionFromEnv(env, explicit) ??
      sessionFromList(await listSessions(callTimeoutMs))
    );
  }

  async function listPanes(
    session: string,
    callTimeoutMs = timeoutMs,
  ): Promise<ZellijPane[]> {
    const result = await run(
      buildListPanesArgs(session),
      "zellij action list-panes",
      callTimeoutMs,
    );
    return parsePaneList(result.stdout);
  }

  async function injectPane(input: {
    session: string;
    paneId: string;
    text: string;
  }): Promise<{ paneId: string; session: string }> {
    const paneId = normalizePaneId(input.paneId);
    if (!input.text) {
      throw new ZellijError("missing_body", "inject text required");
    }
    await run(
      buildPasteArgs(input.session, paneId, input.text),
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
    timeoutMs?: number;
  }): Promise<{ paneId: string; session: string; text: string }> {
    const paneId = normalizePaneId(input.paneId);
    const result = await run(
      buildDumpArgs(input.session, paneId, input.full),
      "zellij action dump-screen",
      input.timeoutMs ?? timeoutMs,
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

  async function renamePane(input: {
    session: string;
    paneId: string;
    name: string;
    timeoutMs?: number;
  }): Promise<{ paneId: string; session: string; name: string }> {
    const paneId = normalizePaneId(input.paneId);
    if (!input.name.trim()) {
      throw new ZellijError("missing_name", "name required");
    }
    await run(
      buildRenamePaneArgs(input.session, paneId, input.name),
      "zellij action rename-pane",
      input.timeoutMs ?? timeoutMs,
    );
    return { paneId, session: input.session, name: input.name };
  }

  async function renameTab(input: {
    session: string;
    tabId: number;
    name: string;
  }): Promise<{ tabId: number; session: string; name: string }> {
    if (!input.name.trim()) {
      throw new ZellijError("missing_name", "name required");
    }
    await run(
      buildRenameTabArgs(input.session, input.tabId, input.name),
      "zellij action rename-tab-by-id",
    );
    return { tabId: input.tabId, session: input.session, name: input.name };
  }

  async function focusPane(input: {
    session: string;
    paneId: string;
  }): Promise<{ paneId: string; session: string }> {
    const paneId = normalizePaneId(input.paneId);
    await run(
      buildFocusPaneArgs(input.session, paneId),
      "zellij action focus-pane-id",
    );
    return { paneId, session: input.session };
  }

  async function listTabs(session: string, callTimeoutMs = timeoutMs): Promise<ZellijTab[]> {
    const result = await run(
      buildListTabsArgs(session),
      "zellij action list-tabs",
      callTimeoutMs,
    );
    return parseTabList(result.stdout);
  }

  async function dumpLayout(session: string): Promise<string> {
    const result = await run(
      buildDumpLayoutArgs(session),
      "zellij action dump-layout",
    );
    return result.stdout;
  }

  async function stackPanes(input: {
    session: string;
    paneIds: string[];
  }): Promise<{ session: string; paneIds: string[] }> {
    if (input.paneIds.length < 2) {
      throw new ZellijError("bad_arg", "stack needs at least two panes");
    }
    await run(
      buildStackPanesArgs(input.session, input.paneIds),
      "zellij action stack-panes",
    );
    return {
      session: input.session,
      paneIds: input.paneIds.map((id) => normalizePaneId(id)),
    };
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
    const ids = new Set(stdout.split(/\r?\n/).map((line) => line.trim().toLowerCase())
      .filter((line) => /^(terminal|plugin)_\d+$/.test(line)));
    return ids.size === 1 ? [...ids][0]! : null;
  }

  async function newPane(
    input: NewPaneInput,
  ): Promise<{ session: string; paneId: string | null; stdout: string }> {
    const result = await run(buildNewPaneArgs(input), "zellij action new-pane", input.timeoutMs ?? timeoutMs);
    return {
      session: input.session,
      paneId: parseCreatedPaneId(result.stdout),
      stdout: result.stdout.trim(),
    };
  }

  async function newTab(
    input: NewTabInput,
  ): Promise<{ session: string; tabId: number | null; stdout: string }> {
    const result = await run(buildNewTabArgs(input), "zellij action new-tab", input.timeoutMs ?? timeoutMs);
    const ids = new Set(result.stdout.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line)).map(Number).filter(Number.isSafeInteger));
    return {
      session: input.session,
      tabId: ids.size === 1 ? [...ids][0]! : null,
      stdout: result.stdout.trim(),
    };
  }

  /**
   * Ask the event-bus plugin, without the usual failure handling: a missing or
   * unresponsive plugin is an expected outcome the caller falls back from, not
   * an error worth raising.
   */
  async function pipePlugin(
    input: PipeInput & { timeoutMs?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return exec(buildPipeArgs(input), {
      timeoutMs: input.timeoutMs ?? DEFAULT_BUS_TIMEOUT_MS,
      // The answer is what we want; the process outliving it is not our problem.
      until: (stdout) => parseBusReply(stdout) !== null,
    });
  }

  /**
   * Multi-pane scrollback over the same pipe. Missing/unresponsive plugin is a
   * value, not a throw — same fallback contract as pipePlugin. Wait on the JSON
   * reply, not process exit: zellij pipe answers in ~40ms but stays resident
   * when it has no terminal.
   */
  async function scrollbackPlugin(input: {
    session: string;
    url: string;
    configKey: string;
    panes: string[];
    full?: boolean;
    timeoutMs?: number;
  }): Promise<{ code: number; stdout: string; stderr: string }> {
    return exec(
      buildPipeArgs({
        session: input.session,
        url: input.url,
        configKey: input.configKey,
        payload: scrollbackPayload({ panes: input.panes, full: input.full }),
      }),
      {
        timeoutMs: input.timeoutMs ?? DEFAULT_BUS_TIMEOUT_MS,
        until: (stdout) => parseScrollbackReply(stdout) !== null,
      },
    );
  }

  /**
   * A wait the plugin holds open. The transport timeout has to outlast the
   * caller's own, or the pipe dies before the wait it is carrying.
   */
  async function waitPlugin(
    input: { session: string; url: string; configKey: string } & WaitRequest,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const budget = (input.timeoutMs ?? 60_000) + DEFAULT_BUS_TIMEOUT_MS;
    return exec(
      buildPipeArgs({
        session: input.session,
        url: input.url,
        configKey: input.configKey,
        payload: waitPayload(input),
      }),
      {
        timeoutMs: budget,
        until: (stdout) => parseWaitReply(stdout) !== null,
      },
    );
  }

  async function changedPlugin(
    input: {
      session: string;
      url: string;
      configKey: string;
      panes: string[];
      timeoutMs?: number;
    },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return exec(
      buildPipeArgs({
        session: input.session,
        url: input.url,
        configKey: input.configKey,
        payload: changedPayload(input.panes),
      }),
      {
        timeoutMs: input.timeoutMs ?? DEFAULT_BUS_TIMEOUT_MS,
        until: (stdout) => parseChangedReply(stdout) !== null,
      },
    );
  }

  async function launchPlugin(
    input: LaunchPluginInput,
  ): Promise<{ session: string; paneId: string | null }> {
    const result = await run(
      buildLaunchPluginArgs(input),
      "zellij action launch-or-focus-plugin",
    );
    return {
      session: input.session,
      paneId: parseCreatedPaneId(result.stdout),
    };
  }

  /** Visible prefix so peer CLIs can tell zSwarm injects from human prompts. */
  function formatPeerMessage(from: string, body: string): string {
    const sender = from.trim() || "swarm";
    return `[zswarm from=${sender}]\n${body}`;
  }

  return {
    zellijPath,
    selfPaneId,
    get transport() {
      return readTransport();
    },
    /** A `file:` plugin url only names a path on the machine running Zellij. */
    remote: ssh !== null,
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
    renamePane,
    renameTab,
    focusPane,
    listTabs,
    dumpLayout,
    stackPanes,
    pipePlugin,
    scrollbackPlugin,
    waitPlugin,
    changedPlugin,
    launchPlugin,
    resolveTab,
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
