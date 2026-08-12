import { ZellijError } from "./errors.js";

/**
 * One description of the zswarm surface. The MCP tool schema, the CLI flags,
 * and the CLI help text are all generated from it, so they cannot drift apart.
 */

export const OP_NAMES = [
  "list",
  "sessions",
  "send",
  "broadcast",
  "dump",
  "tail",
  "wait",
  "status",
  "keys",
  "interrupt",
  "spawn",
  "close",
  "worktrees",
  "unworktree",
  "signal",
  "signals",
  "await",
  "log",
  "rename",
  "focus",
  "tabs",
  "layout",
  "stack",
  "diff",
  "checkpoint",
] as const;

export type OpName = (typeof OP_NAMES)[number];

/** Ops that address an existing pane through `to`. */
export const TARGET_OPS: readonly OpName[] = [
  "send",
  "dump",
  "tail",
  "wait",
  "status",
  "keys",
  "interrupt",
  "close",
];

export type ParamType = "string" | "number" | "boolean" | "stringOrArray";

export type ParamSpec = {
  name: string;
  type: ParamType;
  /** CLI flags; empty means the parameter is reachable through MCP only. */
  flags: string[];
  /** Repeatable flags collect into an array (`--key a --key b`). */
  repeat?: boolean;
  values?: readonly string[];
  description: string;
};

export const PARAMS: readonly ParamSpec[] = [
  {
    name: "session",
    type: "string",
    flags: ["--session", "-s"],
    description:
      "Zellij session name (optional if sole live session or ZSWARM_SESSION / ZELLIJ_SESSION_NAME)",
  },
  {
    name: "to",
    type: "string",
    flags: ["--to", "-t"],
    description:
      "target pane: id (3 / terminal_3) or unique title/command; broadcast takes a comma list; log filters by it",
  },
  {
    name: "all",
    type: "boolean",
    flags: ["--all", "-a"],
    description: "broadcast: every terminal pane in the session",
  },
  {
    name: "group",
    type: "string",
    flags: ["--group", "-g"],
    description:
      "broadcast: narrow the selection to panes whose title or command contains this",
  },
  {
    name: "channel",
    type: "string",
    flags: ["--channel"],
    description: "signal/await: channel name",
  },
  {
    name: "payload",
    type: "string",
    flags: ["--payload"],
    description: "signal: short note stored with the post",
  },
  {
    name: "count",
    type: "number",
    flags: ["--count"],
    description: "await: how many posts to wait for (default 1)",
  },
  {
    name: "clear",
    type: "boolean",
    flags: ["--clear"],
    description: "signal: reset the channel (all channels when none is given)",
  },
  {
    name: "reset",
    type: "boolean",
    flags: ["--reset"],
    description: "tail: forget the stored cursor and return the whole screen",
  },
  {
    name: "sampleMs",
    type: "number",
    flags: ["--sample-ms"],
    description: "status: gap between the two screen samples (default 400)",
  },
  {
    name: "limit",
    type: "number",
    flags: ["--limit"],
    description: "log: how many entries to return (default 20)",
  },
  {
    name: "since",
    type: "string",
    flags: ["--since"],
    description: "log: only entries at or after this epoch millisecond",
  },
  {
    name: "failed",
    type: "boolean",
    flags: ["--failed"],
    description: "log: only deliveries that did not land",
  },
  {
    name: "body",
    type: "string",
    flags: ["--body", "-b", "--text"],
    description: "send: message body",
  },
  {
    name: "text",
    type: "string",
    flags: [],
    description: "send: alias for body",
  },
  {
    name: "from",
    type: "string",
    flags: ["--from", "-f"],
    description: "send: sender label in the [zswarm from=…] prefix",
  },
  {
    name: "raw",
    type: "boolean",
    flags: ["--raw"],
    description: "send: skip the peer prefix (default false)",
  },
  {
    name: "full",
    type: "boolean",
    flags: ["--full"],
    description: "dump/wait: include full scrollback (default false)",
  },
  {
    name: "max",
    type: "number",
    flags: ["--max"],
    description:
      "dump/wait: max text chars (dump 8000, wait 2000; keeps tail, 0 = unlimited)",
  },
  {
    name: "head",
    type: "boolean",
    flags: ["--head"],
    description: "dump: keep the start instead of the tail when truncating",
  },
  {
    name: "for",
    type: "string",
    flags: ["--for"],
    values: ["idle", "match", "either"],
    description:
      "wait: stop on a quiet screen, on a match, or whichever lands first (default: match if match= given, else idle)",
  },
  {
    name: "match",
    type: "string",
    flags: ["--match", "-m"],
    description: "wait: text to look for in the pane screen",
  },
  {
    name: "regex",
    type: "boolean",
    flags: ["--regex"],
    description: "wait: treat match as a regex (default false)",
  },
  {
    name: "ignoreCase",
    type: "boolean",
    flags: ["--ignore-case"],
    description: "wait: case-insensitive match (default false)",
  },
  {
    name: "idleMs",
    type: "number",
    flags: ["--idle-ms"],
    description:
      "wait: screen must be unchanged this long to count as idle (default 2000)",
  },
  {
    name: "pollMs",
    type: "number",
    flags: ["--poll-ms"],
    description: "wait: poll interval (default 600)",
  },
  {
    name: "timeoutMs",
    type: "number",
    flags: ["--timeout-ms"],
    description: "wait: give up after this long (default 60000)",
  },
  {
    name: "keys",
    type: "stringOrArray",
    flags: ["--key", "--keys", "-k"],
    repeat: true,
    description:
      'keys: key specs, one per entry — "Ctrl c", "Esc", "F1", "Up". A bare string is one key; comma-separate for several.',
  },
  {
    name: "chars",
    type: "string",
    flags: ["--chars"],
    description:
      "keys: literal characters to type instead of key specs (no Enter unless enter=true)",
  },
  {
    name: "enter",
    type: "boolean",
    flags: ["--enter"],
    description: "keys: press Enter after the keys/chars",
  },
  {
    name: "hard",
    type: "boolean",
    flags: ["--hard"],
    description: "interrupt: send Ctrl c instead of the default Esc",
  },
  {
    name: "command",
    type: "stringOrArray",
    flags: ["--command", "--cmd", "-c"],
    description:
      "spawn: program to run in the new pane, argv-style (no shell). Empty starts a plain shell.",
  },
  {
    name: "cwd",
    type: "string",
    flags: ["--cwd"],
    description:
      "spawn: working directory for the new pane; worktrees/unworktree: any directory inside the repo",
  },
  {
    name: "worktree",
    type: "string",
    flags: ["--worktree", "-w"],
    description:
      "spawn: branch to give the peer its own git worktree (overrides cwd); unworktree: alias for branch",
  },
  {
    name: "worktreeRoot",
    type: "string",
    flags: ["--worktree-root"],
    description:
      "where worktrees live (default <repo>-worktrees beside the repo, or ZSWARM_WORKTREE_ROOT)",
  },
  {
    name: "baseRef",
    type: "string",
    flags: ["--base-ref", "--base"],
    description: "spawn: ref to branch from when the worktree branch is new",
  },
  {
    name: "path",
    type: "string",
    flags: ["--path"],
    description: "unworktree: worktree path to remove",
  },
  {
    name: "branch",
    type: "string",
    flags: ["--branch"],
    description: "unworktree: remove the worktree holding this branch",
  },
  {
    name: "name",
    type: "string",
    flags: ["--name", "-n"],
    description: "spawn: pane (or tab) name; rename: the new name",
  },
  {
    name: "submit",
    type: "string",
    flags: ["--submit"],
    values: ["auto", "double-enter", "none"],
    description:
      "send/broadcast: auto verifies the paste actually submitted and presses Enter again if not (default)",
  },
  {
    name: "settleMs",
    type: "number",
    flags: ["--settle-ms"],
    description: "send/broadcast: pause before checking the paste landed (default 300)",
  },
  {
    name: "message",
    type: "string",
    flags: ["--message"],
    description: "checkpoint: commit message",
  },
  {
    name: "stat",
    type: "boolean",
    flags: ["--stat"],
    description: "diff: stat only, no patch body",
  },
  {
    name: "direction",
    type: "string",
    flags: ["--direction", "-d"],
    values: ["right", "left", "up", "down"],
    description: "spawn: split direction",
  },
  {
    name: "floating",
    type: "boolean",
    flags: ["--floating"],
    description: "spawn: open the pane floating",
  },
  {
    name: "width",
    type: "string",
    flags: ["--width"],
    description: "spawn: floating pane width (e.g. 80 or 50%)",
  },
  {
    name: "height",
    type: "string",
    flags: ["--height"],
    description: "spawn: floating pane height (e.g. 20 or 40%)",
  },
  {
    name: "tab",
    type: "string",
    flags: ["--tab"],
    description:
      "tab name: broadcast targets it, rename retitles it, spawn opens the new pane's tab by it",
  },
  {
    name: "newTab",
    type: "boolean",
    flags: ["--new-tab"],
    description: "spawn: open a new tab instead of splitting",
  },
  {
    name: "layout",
    type: "string",
    flags: ["--layout", "-l"],
    description: "spawn: layout name for the new tab (newTab=true)",
  },
  {
    name: "closeOnExit",
    type: "boolean",
    flags: ["--close-on-exit"],
    description: "spawn: close the pane when its command exits",
  },
  {
    name: "allowSelf",
    type: "boolean",
    flags: ["--allow-self"],
    description:
      "send/keys/close: allow targeting zswarm's own pane (default false)",
  },
  {
    name: "force",
    type: "boolean",
    flags: ["--force"],
    description:
      "send/keys: write to a pane whose command has exited; unworktree: remove a busy or dirty worktree",
  },
  {
    name: "verbose",
    type: "boolean",
    flags: ["--verbose", "-v"],
    description:
      "list/send/spawn: include cwd/focus/exited/floating (and the pane on send/spawn)",
  },
];

function propertyFor(param: ParamSpec): Record<string, unknown> {
  const base: Record<string, unknown> = { description: param.description };
  if (param.type === "stringOrArray") {
    base.anyOf = [
      { type: "string" },
      { type: "array", items: { type: "string" } },
    ];
    return base;
  }
  base.type = param.type;
  if (param.values) base.enum = [...param.values];
  return base;
}

/** JSON Schema for the single `zswarm` MCP tool. */
export function mcpInputSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    op: {
      type: "string",
      enum: [...OP_NAMES],
      description: OP_NAMES.join(" | "),
    },
  };
  for (const param of PARAMS) properties[param.name] = propertyFor(param);
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: ["op"],
  };
}

export const MCP_TOOL_DESCRIPTION =
  `zSwarm Zellij pane coordination (op=${OP_NAMES.join("|")}). ` +
  "List panes, send text into a CLI pane (paste+Enter), block until a pane goes idle or prints a match, " +
  "send raw keys, open or close panes, and give a peer its own git worktree. Local Zellij only.";

const FLAG_INDEX = new Map<string, ParamSpec>(
  PARAMS.flatMap((p) => p.flags.map((flag) => [flag, p] as const)),
);

export function cliUsage(): string {
  const lines = [
    `usage: zswarm <${OP_NAMES.join("|")}> [options]`,
    "",
    "  positional: first bare argument is --to, second is --body for send",
    "",
  ];
  for (const param of PARAMS) {
    if (param.flags.length === 0) continue;
    const value =
      param.type === "boolean" ? "" : param.type === "number" ? " N" : " VALUE";
    lines.push(`  ${param.flags.join(", ").padEnd(28)}${value.trim().padEnd(6)}${param.description}`);
  }
  lines.push(
    "",
    "Guards: writes refuse zswarm's own pane (--allow-self) and exited panes (--force).",
    "Env: ZSWARM_BIN, ZSWARM_PATH, ZSWARM_SESSION, ZSWARM_SELF_PANE, ZELLIJ_SESSION_NAME",
    "",
  );
  return lines.join("\n");
}

/** Turn argv (without the op) into dispatch args, driven by PARAMS. */
export function parseCliArgv(argv: string[]): Record<string, unknown> {
  const [op, ...rest] = argv;
  if (!op) throw new ZellijError("usage", "no op given");
  const out: Record<string, unknown> = { op };
  const repeated = new Map<string, string[]>();

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    const param = FLAG_INDEX.get(token);
    if (param) {
      if (param.type === "boolean") {
        out[param.name] = true;
        continue;
      }
      const value = rest[++i];
      if (value === undefined) {
        throw new ZellijError("usage", `${token} needs a value`);
      }
      if (param.repeat) {
        const bucket = repeated.get(param.name) ?? [];
        bucket.push(value);
        repeated.set(param.name, bucket);
        continue;
      }
      out[param.name] = param.type === "number" ? Number(value) : value;
      continue;
    }
    if (token.startsWith("-")) {
      throw new ZellijError("usage", `unknown arg: ${token}`);
    }
    if (!out.to && (TARGET_OPS as readonly string[]).includes(op)) {
      out.to = token;
      continue;
    }
    if (!out.body && op === "send") {
      out.body = token;
      continue;
    }
    throw new ZellijError("usage", `unexpected argument: ${token}`);
  }

  for (const [name, values] of repeated) out[name] = values;
  return out;
}
