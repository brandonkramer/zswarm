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
import { createSshExec } from "../exec.js";
import {
  DEFAULT_TIMEOUT_MS,
  NOT_FOUND_EXIT,
  defaultExec,
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
  type ZellijSessionResolve,
} from "./session.js";

export type ZellijClientOptions = {
  exec?: ZellijExecFn;
  zellijPath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

/** Thin, stateless wrapper over the `zellij` binary. */
export function createZellijClient(options: ZellijClientOptions = {}) {
  const env = options.env ?? process.env;
  // A remote crew never resolves a local binary.
  const ssh = options.exec ? null : resolveSshTarget(env);
  const zellijPath =
    options.zellijPath ??
    (ssh ? `ssh://${ssh.host}/${ssh.remoteBin}` : resolveZellijBinary(env));
  const rawExec =
    options.exec ??
    (ssh
      ? createSshExec(ssh, sanitizeZellijEnv(env))
      : defaultExec(zellijPath, env));
  const exec: ZellijExecFn = (args, opts) =>
    rawExec(args, { ...opts, signal: opts.signal ?? options.signal });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const selfPaneId = resolveSelfPaneId(env);

  async function run(args: string[], label: string) {
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

  async function listSessions(): Promise<string[]> {
    const result = await exec(["list-sessions", "--short", "--no-formatting"], {
      timeoutMs,
    });
    if (result.code === NOT_FOUND_EXIT) {
      throw new ZellijError(
        "zellij_missing",
        `zellij binary not found (${zellijPath}); install Zellij ≥ 0.42, add it to PATH, or set ZSWARM_BIN / ZSWARM_PATH`,
      );
    }
    if (result.code !== 0) {
      // Nonzero here is Zellij's normal "none running", not a crash. Empty
      // lets resolveSession throw zellij_no_session so unworktree can treat
      // it as no occupants instead of zellij_failed.
      if (isZellijNoSessionsOutput(result.stdout, result.stderr)) return [];
      throw new ZellijError(
        "zellij_failed",
        `zellij list-sessions failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
      );
    }
    return parseSessionList(result.stdout);
  }

  async function resolveSession(
    explicit?: string | null,
  ): Promise<ZellijSessionResolve> {
    return sessionFromEnv(env, explicit) ?? sessionFromList(await listSessions());
  }

  async function listPanes(session: string): Promise<ZellijPane[]> {
    const result = await run(
      buildListPanesArgs(session),
      "zellij action list-panes",
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

  async function renamePane(input: {
    session: string;
    paneId: string;
    name: string;
  }): Promise<{ paneId: string; session: string; name: string }> {
    const paneId = normalizePaneId(input.paneId);
    if (!input.name.trim()) {
      throw new ZellijError("missing_name", "name required");
    }
    await run(
      buildRenamePaneArgs(input.session, paneId, input.name),
      "zellij action rename-pane",
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

  async function listTabs(session: string): Promise<ZellijTab[]> {
    const result = await run(
      buildListTabsArgs(session),
      "zellij action list-tabs",
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
    const match = /(terminal|plugin)_\d+/i.exec(stdout);
    return match ? match[0].toLowerCase() : null;
  }

  async function newPane(
    input: NewPaneInput,
  ): Promise<{ session: string; paneId: string | null; stdout: string }> {
    const result = await run(buildNewPaneArgs(input), "zellij action new-pane");
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
    input: { session: string; url: string; configKey: string; panes: string[] },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return exec(
      buildPipeArgs({
        session: input.session,
        url: input.url,
        configKey: input.configKey,
        payload: changedPayload(input.panes),
      }),
      {
        timeoutMs: DEFAULT_BUS_TIMEOUT_MS,
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
    return `[zswarm from=${sender}]\n${body.trim()}`;
  }

  return {
    zellijPath,
    selfPaneId,
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
