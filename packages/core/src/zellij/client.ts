import { ZellijError } from "../errors.js";
import {
  buildClosePaneArgs,
  buildDumpArgs,
  buildListPanesArgs,
  buildNewPaneArgs,
  buildNewTabArgs,
  buildPasteArgs,
  buildSendEnterArgs,
  buildSendKeysArgs,
  buildWriteCharsArgs,
  type NewPaneInput,
  type NewTabInput,
} from "./args.js";
import {
  DEFAULT_TIMEOUT_MS,
  NOT_FOUND_EXIT,
  defaultExec,
  resolveZellijBinary,
  type ZellijExecFn,
} from "./binary.js";
import {
  normalizePaneId,
  parsePaneList,
  resolvePane,
  type ZellijPane,
} from "./panes.js";
import {
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
};

/** Thin, stateless wrapper over the `zellij` binary. */
export function createZellijClient(options: ZellijClientOptions = {}) {
  const env = options.env ?? process.env;
  const zellijPath = options.zellijPath ?? resolveZellijBinary(env);
  const exec = options.exec ?? defaultExec(zellijPath, env);
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
    const result = await run(
      ["list-sessions", "--short", "--no-formatting"],
      "zellij list-sessions",
    );
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

  /** Visible prefix so peer CLIs can tell zSwarm injects from human prompts. */
  function formatPeerMessage(from: string, body: string): string {
    const sender = from.trim() || "swarm";
    return `[zswarm from=${sender}]\n${body.trim()}`;
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
