import {
  createZellijClient,
  ZellijError,
  type NewPaneInput,
  type PaneDirection,
  type ZellijClient,
  type ZellijPane,
} from "./zellij.js";
import { normalizeKeys, tokenizeCommand } from "./keys.js";

export type OpsResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

/** Injectable clock so `wait` is testable without real time passing. */
export type DispatchDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** Default dump text budget (characters). Override with max=; max=0 disables. */
export const DEFAULT_DUMP_MAX_CHARS = 8_000;
/** `wait` returns a short tail by default — it is called in loops. */
export const DEFAULT_WAIT_MAX_CHARS = 2_000;

const WAIT_DEFAULTS = {
  idleMs: 2_000,
  pollMs: 600,
  timeoutMs: 60_000,
};
const WAIT_LIMITS = {
  idleMs: { min: 200, max: 600_000 },
  pollMs: { min: 100, max: 30_000 },
  timeoutMs: { min: 1_000, max: 900_000 },
};

function fail(err: unknown): OpsResult {
  if (err instanceof ZellijError) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: "failed", message } };
}

function isTrue(value: unknown): boolean {
  return value === true || value === "true";
}

function isVerbose(args: Record<string, unknown>): boolean {
  return isTrue(args.verbose);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function paneViewSlim(p: ZellijPane) {
  return {
    id: p.id,
    title: p.title,
    command: p.command ?? null,
    tab: p.tabName ?? null,
  };
}

function paneViewFull(p: ZellijPane) {
  return {
    ...paneViewSlim(p),
    cwd: p.cwd ?? null,
    focused: p.focused,
    exited: p.exited,
    floating: p.floating,
  };
}

/** Truncate dump text; default keeps the tail (recent output). */
export function truncateDumpText(
  text: string,
  maxChars: number,
  keep: "tail" | "head" = "tail",
): { text: string; truncated: boolean; chars: number } {
  const chars = text.length;
  if (maxChars <= 0 || chars <= maxChars) {
    return { text, truncated: false, chars };
  }
  if (keep === "head") {
    return { text: text.slice(0, maxChars), truncated: true, chars };
  }
  return { text: text.slice(chars - maxChars), truncated: true, chars };
}

/** Screen text with trailing blanks removed, so idle detection ignores padding. */
export function normalizeScreen(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

function numberArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  limits: { min: number; max: number },
): number {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new ZellijError("bad_arg", `${key} must be a number`);
  }
  return Math.min(limits.max, Math.max(limits.min, Math.floor(n)));
}

function dumpMaxChars(
  args: Record<string, unknown>,
  fallback = DEFAULT_DUMP_MAX_CHARS,
): number {
  if (args.max === undefined || args.max === null || args.max === "") {
    return fallback;
  }
  const n = Number(args.max);
  if (!Number.isFinite(n) || n < 0) {
    throw new ZellijError("bad_max", "max must be a non-negative number");
  }
  return Math.floor(n);
}

/**
 * Refuse writes that would loop back into the caller's own pane, land in a
 * dead pane, or hit a plugin pane. `allowSelf` / `force` opt out.
 */
function assertWritable(
  client: ZellijClient,
  pane: ZellijPane,
  args: Record<string, unknown>,
  action: string,
): void {
  if (pane.isPlugin) {
    throw new ZellijError(
      "pane_is_plugin",
      `${pane.id} is a plugin pane; ${action} targets terminal panes`,
    );
  }
  const self = client.selfPaneId;
  if (self && pane.id === self && !isTrue(args.allowSelf)) {
    throw new ZellijError(
      "self_target",
      `refusing to ${action} into zswarm's own pane (${self}); pass allowSelf=true to override`,
    );
  }
  if (pane.exited && !isTrue(args.force)) {
    throw new ZellijError(
      "pane_exited",
      `${pane.id} has exited; pass force=true to write to it anyway`,
    );
  }
}

async function resolveTarget(
  client: ZellijClient,
  args: Record<string, unknown>,
): Promise<{ session: string; panes: ZellijPane[]; pane: ZellijPane }> {
  const to = String(args.to ?? "").trim();
  if (!to) throw new ZellijError("missing_peer", "to required");
  const { session } = await client.resolveSession(
    typeof args.session === "string" ? args.session : undefined,
  );
  const panes = await client.listPanes(session);
  return { session, panes, pane: client.resolvePane(panes, to) };
}

function buildMatcher(
  args: Record<string, unknown>,
): ((text: string) => boolean) | null {
  const match = optionalString(args.match);
  if (!match) return null;
  if (isTrue(args.regex)) {
    try {
      const re = new RegExp(match, isTrue(args.ignoreCase) ? "im" : "m");
      return (text) => re.test(text);
    } catch (err) {
      throw new ZellijError(
        "bad_match",
        `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (isTrue(args.ignoreCase)) {
    const needle = match.toLowerCase();
    return (text) => text.toLowerCase().includes(needle);
  }
  return (text) => text.includes(match);
}

async function waitForPane(
  client: ZellijClient,
  args: Record<string, unknown>,
  deps: Required<DispatchDeps>,
): Promise<OpsResult> {
  const { session, pane } = await resolveTarget(client, args);
  const matcher = buildMatcher(args);
  const requested = optionalString(args.for) ?? (matcher ? "match" : "idle");
  if (!["idle", "match", "either"].includes(requested)) {
    throw new ZellijError("bad_arg", 'for must be idle|match|either');
  }
  if (requested !== "idle" && !matcher) {
    throw new ZellijError("missing_match", `for=${requested} needs match=`);
  }
  const wantMatch = requested !== "idle";
  const wantIdle = requested !== "match";

  const idleMs = numberArg(args, "idleMs", WAIT_DEFAULTS.idleMs, WAIT_LIMITS.idleMs);
  const pollMs = numberArg(args, "pollMs", WAIT_DEFAULTS.pollMs, WAIT_LIMITS.pollMs);
  const timeoutMs = numberArg(
    args,
    "timeoutMs",
    WAIT_DEFAULTS.timeoutMs,
    WAIT_LIMITS.timeoutMs,
  );

  const started = deps.now();
  let previous: string | null = null;
  let lastChangeAt = started;
  let polls = 0;
  let changes = 0;
  let text = "";

  for (;;) {
    const dumped = await client.dumpPane({
      session,
      paneId: pane.id,
      full: isTrue(args.full),
    });
    polls++;
    text = dumped.text;
    const screen = normalizeScreen(text);
    const at = deps.now();

    if (wantMatch && matcher && matcher(screen)) {
      return waitResult("match", { session, pane, text, args, started, at, polls, changes, idleMs });
    }

    if (previous === null) {
      previous = screen;
      lastChangeAt = at;
    } else if (screen !== previous) {
      previous = screen;
      lastChangeAt = at;
      changes++;
    } else if (wantIdle && at - lastChangeAt >= idleMs) {
      return waitResult("idle", { session, pane, text, args, started, at, polls, changes, idleMs });
    }

    if (at - started >= timeoutMs) {
      return waitResult("timeout", { session, pane, text, args, started, at, polls, changes, idleMs });
    }
    await deps.sleep(pollMs);
  }
}

function waitResult(
  reason: "idle" | "match" | "timeout",
  ctx: {
    session: string;
    pane: ZellijPane;
    text: string;
    args: Record<string, unknown>;
    started: number;
    at: number;
    polls: number;
    changes: number;
    idleMs: number;
  },
): OpsResult {
  const max = dumpMaxChars(ctx.args, DEFAULT_WAIT_MAX_CHARS);
  const clipped = truncateDumpText(ctx.text, max);
  return {
    ok: true,
    data: {
      session: ctx.session,
      to: ctx.pane.id,
      reason,
      elapsedMs: ctx.at - ctx.started,
      polls: ctx.polls,
      changes: ctx.changes,
      idleMs: ctx.idleMs,
      text: clipped.text,
      truncated: clipped.truncated,
      chars: clipped.chars,
    },
  };
}

function paneDirection(value: unknown): PaneDirection | null {
  const dir = optionalString(value);
  if (!dir) return null;
  const lowered = dir.toLowerCase();
  if (!["right", "left", "up", "down"].includes(lowered)) {
    throw new ZellijError("bad_arg", "direction must be right|left|up|down");
  }
  return lowered as PaneDirection;
}

async function spawnPane(
  client: ZellijClient,
  args: Record<string, unknown>,
): Promise<OpsResult> {
  const { session } = await client.resolveSession(
    typeof args.session === "string" ? args.session : undefined,
  );
  const command = tokenizeCommand(args.command ?? args.cmd);
  const cwd = optionalString(args.cwd);
  const name = optionalString(args.name);
  const closeOnExit = isTrue(args.closeOnExit);
  const before = new Set((await client.listPanes(session)).map((p) => p.id));

  let paneId: string | null = null;
  let tabId: number | null = null;
  if (isTrue(args.tab)) {
    const created = await client.newTab({
      session,
      command,
      cwd,
      name,
      layout: optionalString(args.layout),
      closeOnExit,
    });
    tabId = created.tabId;
  } else {
    const input: NewPaneInput = {
      session,
      command,
      cwd,
      name,
      direction: paneDirection(args.direction),
      floating: isTrue(args.floating),
      closeOnExit,
      width: optionalString(args.width),
      height: optionalString(args.height),
    };
    if (typeof args.tabId === "number") input.tabId = args.tabId;
    paneId = (await client.newPane(input)).paneId;
  }

  // new-tab reports a tab id, and a command that exits at once can vanish, so
  // fall back to diffing the pane list against the pre-spawn snapshot.
  const panes = await client.listPanes(session);
  let resolvedBy: "stdout" | "diff" | "unresolved" = paneId
    ? "stdout"
    : "unresolved";
  let pane = paneId ? (panes.find((p) => p.id === paneId) ?? null) : null;
  if (!paneId) {
    const fresh = panes.filter((p) => !p.isPlugin && !before.has(p.id));
    const inTab =
      tabId === null ? fresh : fresh.filter((p) => p.tabId === tabId);
    const candidates = inTab.length > 0 ? inTab : fresh;
    if (candidates.length === 1) {
      pane = candidates[0]!;
      paneId = pane.id;
      resolvedBy = "diff";
    }
  }

  const data: Record<string, unknown> = {
    session,
    paneId,
    resolvedBy,
    live: pane !== null,
    command: command.length > 0 ? command : null,
  };
  if (tabId !== null) data.tabId = tabId;
  if (pane && isVerbose(args)) data.pane = paneViewFull(pane);
  return { ok: true, data };
}

/** Shared MCP/CLI dispatch for zswarm ops. */
export async function dispatchZswarm(
  args: Record<string, unknown>,
  client: ZellijClient = createZellijClient(),
  deps: DispatchDeps = {},
): Promise<OpsResult> {
  const op = String(args.op ?? "");
  const verbose = isVerbose(args);
  const clock: Required<DispatchDeps> = {
    now: deps.now ?? (() => Date.now()),
    sleep:
      deps.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
  try {
    switch (op) {
      case "sessions": {
        const sessions = await client.listSessions();
        return {
          ok: true,
          data: { sessions, zellij: client.zellijPath },
        };
      }
      case "list": {
        const { session } = await client.resolveSession(
          typeof args.session === "string" ? args.session : undefined,
        );
        const view = verbose ? paneViewFull : paneViewSlim;
        const panes = (await client.listPanes(session))
          .filter((p) => !p.isPlugin)
          .map(view)
          .sort((a, b) => a.id.localeCompare(b.id));
        const data: Record<string, unknown> = { session, panes };
        if (verbose && client.selfPaneId) data.self = client.selfPaneId;
        return { ok: true, data };
      }
      case "send": {
        const body = String(args.body ?? args.text ?? "");
        if (!body.trim()) throw new ZellijError("missing_body", "body required");
        const { session, pane } = await resolveTarget(client, args);
        assertWritable(client, pane, args, "send");
        const from =
          (typeof args.from === "string" && args.from.trim()) || "swarm";
        const text = isTrue(args.raw)
          ? body
          : client.formatPeerMessage(from, body);
        const delivered = await client.injectPane({
          session,
          paneId: pane.id,
          text,
        });
        const data: Record<string, unknown> = {
          delivery: "zellij_paste",
          session: delivered.session,
          to: delivered.paneId,
          from,
        };
        if (verbose) data.pane = paneViewFull(pane);
        return { ok: true, data };
      }
      case "keys":
      case "interrupt": {
        const { session, pane } = await resolveTarget(client, args);
        assertWritable(client, pane, args, op);
        const chars = typeof args.chars === "string" ? args.chars : "";
        if (op === "keys" && chars) {
          await client.writeChars({ session, paneId: pane.id, chars });
          if (isTrue(args.enter)) {
            await client.sendKeys({
              session,
              paneId: pane.id,
              keys: ["Enter"],
            });
          }
          return {
            ok: true,
            data: {
              session,
              to: pane.id,
              delivery: "zellij_write_chars",
              chars: chars.length,
              enter: isTrue(args.enter),
            },
          };
        }
        const keys =
          op === "interrupt"
            ? normalizeKeys(args.keys ?? (isTrue(args.hard) ? "Ctrl c" : "Esc"))
            : normalizeKeys(args.keys);
        const sent = await client.sendKeys({
          session,
          paneId: pane.id,
          keys,
        });
        if (op === "keys" && isTrue(args.enter)) {
          await client.sendKeys({ session, paneId: pane.id, keys: ["Enter"] });
        }
        return {
          ok: true,
          data: {
            session,
            to: sent.paneId,
            delivery: "zellij_send_keys",
            keys: sent.keys,
          },
        };
      }
      case "dump": {
        const { session, pane } = await resolveTarget(client, args);
        const dumped = await client.dumpPane({
          session,
          paneId: pane.id,
          full: isTrue(args.full),
        });
        const max = dumpMaxChars(args);
        const keep = isTrue(args.head) ? "head" : "tail";
        const clipped = truncateDumpText(dumped.text, max, keep);
        return {
          ok: true,
          data: {
            session: dumped.session,
            to: dumped.paneId,
            text: clipped.text,
            truncated: clipped.truncated,
            chars: clipped.chars,
            max,
          },
        };
      }
      case "wait":
        return await waitForPane(client, args, clock);
      case "spawn":
        return await spawnPane(client, args);
      case "close": {
        const { session, pane } = await resolveTarget(client, args);
        // Not assertWritable: closing an exited pane is the point of close.
        if (pane.isPlugin) {
          throw new ZellijError(
            "pane_is_plugin",
            `${pane.id} is a plugin pane; close targets terminal panes`,
          );
        }
        const self = client.selfPaneId;
        if (self && pane.id === self && !isTrue(args.allowSelf)) {
          throw new ZellijError(
            "self_target",
            `refusing to close zswarm's own pane (${self}); pass allowSelf=true to override`,
          );
        }
        const closed = await client.closePane({ session, paneId: pane.id });
        return {
          ok: true,
          data: { session: closed.session, closed: closed.paneId },
        };
      }
      default:
        throw new ZellijError(
          "usage",
          "zswarm requires op=list|send|dump|wait|keys|interrupt|spawn|close|sessions",
        );
    }
  } catch (err) {
    return fail(err);
  }
}
