import { ZellijError } from "../errors.js";
import { BUS_PIPE_NAME } from "./bus.js";
import { normalizePaneId } from "./panes.js";

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

export type PipeInput = {
  session: string;
  /** `file:` url of the plugin wasm. */
  url: string;
  /** Value of the `instance` configuration key — see buildPipeArgs. */
  configKey: string;
  name?: string;
  payload: string;
};

/** JSON pipe payload for a multi-pane scrollback read. Keys match the frozen contract. */
export type ScrollbackRequest = { panes: string[]; full?: boolean };

/**
 * Emit `{op, panes, full}` in that order. Callers must not hand-roll this JSON —
 * a payload that does not start with `{` is treated as a bare-word bus command.
 */
export function scrollbackPayload(req: ScrollbackRequest): string {
  if (req.panes.length === 0) {
    throw new ZellijError("bad_arg", "scrollback panes must be a non-empty list");
  }
  return JSON.stringify({
    op: "scrollback",
    panes: req.panes,
    full: req.full === true,
  });
}

/** A wait the plugin serves by holding the pipe until it resolves. */
export type WaitRequest = {
  pane: string;
  for: "idle" | "match" | "either";
  match?: string | null;
  ignoreCase?: boolean;
  idleMs?: number;
  timeoutMs?: number;
  pollMs?: number;
};

/**
 * `regex` is deliberately absent: the plugin has no regex engine, refuses such
 * requests, and the caller falls back to polling where its own engine decides.
 */
export function waitPayload(req: WaitRequest): string {
  if (!req.pane.trim()) {
    throw new ZellijError("bad_arg", "wait needs a pane");
  }
  if (req.for !== "idle" && !req.match) {
    throw new ZellijError("bad_arg", "match waits need a needle");
  }
  return JSON.stringify({
    op: "wait",
    pane: req.pane,
    for: req.for,
    match: req.match ?? null,
    ignoreCase: req.ignoreCase === true,
    idleMs: req.idleMs ?? 2000,
    timeoutMs: req.timeoutMs ?? 60000,
    pollMs: req.pollMs ?? 50,
  });
}

/** Screens plus "did this move since you last asked", so status needs no gap. */
export function changedPayload(panes: string[]): string {
  if (panes.length === 0) {
    throw new ZellijError("bad_arg", "changed needs a non-empty pane list");
  }
  return JSON.stringify({ op: "changed", panes });
}

export type LaunchPluginInput = {
  session: string;
  url: string;
  configKey: string;
  floating?: boolean;
  skipCache?: boolean;
};

export function sessionPrefix(session: string | undefined): string[] {
  return session ? ["--session", session] : [];
}

/**
 * Ask the event-bus plugin a question over a CLI pipe.
 *
 * The configuration is not decoration: Zellij treats the same plugin under a
 * different configuration as a different pipe destination, so a distinct
 * `instance` key is what stops a dead instance from swallowing the message.
 */
export function buildPipeArgs(input: PipeInput): string[] {
  return [
    ...sessionPrefix(input.session),
    "pipe",
    "--plugin",
    input.url,
    "--plugin-configuration",
    `instance=${input.configKey}`,
    "--name",
    input.name ?? BUS_PIPE_NAME,
    "--",
    input.payload,
  ];
}

/**
 * Load the plugin in a visible pane. A pipe-launched plugin has no pane, so its
 * permission prompt cannot be answered — the first load has to be this one.
 */
export function buildLaunchPluginArgs(input: LaunchPluginInput): string[] {
  const args = [
    ...sessionPrefix(input.session),
    "action",
    "launch-or-focus-plugin",
    "--configuration",
    `instance=${input.configKey}`,
  ];
  if (input.floating) args.push("--floating");
  if (input.skipCache) args.push("--skip-plugin-cache");
  args.push(input.url);
  return args;
}

export function buildListPanesArgs(session: string): string[] {
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

export function buildPasteArgs(
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

export function buildSendEnterArgs(session: string, paneId: string): string[] {
  return [
    ...sessionPrefix(session),
    "action",
    "send-keys",
    "--pane-id",
    normalizePaneId(paneId),
    "Enter",
  ];
}

export function buildDumpArgs(
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

export function buildSendKeysArgs(
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

export function buildWriteCharsArgs(
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

export function buildRenamePaneArgs(
  session: string,
  paneId: string,
  name: string,
): string[] {
  return [
    ...sessionPrefix(session),
    "action",
    "rename-pane",
    "--pane-id",
    normalizePaneId(paneId),
    "--",
    name,
  ];
}

export function buildRenameTabArgs(
  session: string,
  tabId: number,
  name: string,
): string[] {
  return [
    ...sessionPrefix(session),
    "action",
    "rename-tab-by-id",
    String(tabId),
    "--",
    name,
  ];
}

export function buildFocusPaneArgs(session: string, paneId: string): string[] {
  return [
    ...sessionPrefix(session),
    "action",
    "focus-pane-id",
    normalizePaneId(paneId),
  ];
}

export function buildListTabsArgs(session: string): string[] {
  return [
    ...sessionPrefix(session),
    "action",
    "list-tabs",
    "--json",
    "--panes",
    "--state",
    "--layout",
  ];
}

export function buildDumpLayoutArgs(session: string): string[] {
  return [...sessionPrefix(session), "action", "dump-layout"];
}

export function buildStackPanesArgs(
  session: string,
  paneIds: string[],
): string[] {
  return [
    ...sessionPrefix(session),
    "action",
    "stack-panes",
    "--",
    ...paneIds.map((id) => normalizePaneId(id)),
  ];
}

export function buildClosePaneArgs(session: string, paneId: string): string[] {
  return [
    ...sessionPrefix(session),
    "action",
    "close-pane",
    "--pane-id",
    normalizePaneId(paneId),
  ];
}

export function buildNewPaneArgs(input: NewPaneInput): string[] {
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

export function buildNewTabArgs(input: NewTabInput): string[] {
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
