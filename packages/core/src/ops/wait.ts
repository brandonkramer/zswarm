import { ZellijError } from "../errors.js";
import type { ZellijClient } from "../zellij/client.js";
import type { ZellijPane } from "../zellij/panes.js";
import type { Clock, OpsResult } from "./types.js";
import {
  DEFAULT_WAIT_MAX_CHARS,
  dumpMaxChars,
  isTrue,
  normalizeScreen,
  numberArg,
  optionalString,
  truncateDumpText,
} from "./util.js";

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

export function buildMatcher(
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

type WaitContext = {
  session: string;
  pane: ZellijPane;
  text: string;
  args: Record<string, unknown>;
  started: number;
  at: number;
  polls: number;
  changes: number;
  idleMs: number;
};

function waitResult(
  reason: "idle" | "match" | "timeout",
  ctx: WaitContext,
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

/**
 * Poll a pane's screen until it goes quiet, prints a match, or the deadline
 * passes — so callers stop re-dumping in a loop of their own.
 */
export async function waitForPane(
  client: ZellijClient,
  target: { session: string; pane: ZellijPane },
  args: Record<string, unknown>,
  clock: Clock,
): Promise<OpsResult> {
  const { session, pane } = target;
  const matcher = buildMatcher(args);
  const requested = optionalString(args.for) ?? (matcher ? "match" : "idle");
  if (!["idle", "match", "either"].includes(requested)) {
    throw new ZellijError("bad_arg", "for must be idle|match|either");
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

  const started = clock.now();
  let previous: string | null = null;
  let lastChangeAt = started;
  let polls = 0;
  let changes = 0;

  for (;;) {
    const dumped = await client.dumpPane({
      session,
      paneId: pane.id,
      full: isTrue(args.full),
    });
    polls++;
    const text = dumped.text;
    const screen = normalizeScreen(text);
    const at = clock.now();
    const ctx: WaitContext = {
      session,
      pane,
      text,
      args,
      started,
      at,
      polls,
      changes,
      idleMs,
    };

    if (wantMatch && matcher && matcher(screen)) return waitResult("match", ctx);

    if (previous === null) {
      previous = screen;
      lastChangeAt = at;
    } else if (screen !== previous) {
      previous = screen;
      lastChangeAt = at;
      changes++;
      ctx.changes = changes;
    } else if (wantIdle && at - lastChangeAt >= idleMs) {
      return waitResult("idle", ctx);
    }

    if (at - started >= timeoutMs) return waitResult("timeout", ctx);
    await clock.sleep(pollMs);
  }
}
