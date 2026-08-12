import { ZellijError } from "../errors.js";
import type { StateStore } from "../state.js";
import type { Clock, OpsResult } from "./types.js";
import { isTrue, numberArg, optionalString } from "./util.js";

const AWAIT_LIMITS = {
  pollMs: { min: 100, max: 30_000 },
  timeoutMs: { min: 1_000, max: 900_000 },
  count: { min: 1, max: 1_000 },
};

function channelOf(args: Record<string, unknown>): string {
  const channel = optionalString(args.channel);
  if (!channel) throw new ZellijError("missing_channel", "channel required");
  return channel;
}

/**
 * Post to a channel. Counts are cumulative and survive across processes, so a
 * crew can rendezvous without any of them staying resident.
 */
export function postSignal(
  state: StateStore,
  args: Record<string, unknown>,
  clock: Clock,
): OpsResult {
  if (isTrue(args.clear)) {
    const channel = optionalString(args.channel);
    state.clearSignal(channel);
    return { ok: true, data: { cleared: channel ?? "all" } };
  }
  const channel = channelOf(args);
  const posted = state.postSignal(channel, optionalString(args.payload), clock.now());
  return {
    ok: true,
    data: { channel, count: posted.count, at: posted.at, payload: posted.last },
  };
}

export function listSignals(state: StateStore): OpsResult {
  const all = state.readSignals();
  return {
    ok: true,
    data: {
      channels: Object.entries(all)
        .map(([channel, v]) => ({
          channel,
          count: v.count,
          at: v.at,
          last: v.last ?? null,
        }))
        .sort((a, b) => a.channel.localeCompare(b.channel)),
    },
  };
}

/** Block until a channel reaches `count` posts, or the deadline passes. */
export async function awaitSignal(
  state: StateStore,
  args: Record<string, unknown>,
  clock: Clock,
): Promise<OpsResult> {
  const channel = channelOf(args);
  const count = numberArg(args, "count", 1, AWAIT_LIMITS.count);
  const pollMs = numberArg(args, "pollMs", 500, AWAIT_LIMITS.pollMs);
  const timeoutMs = numberArg(args, "timeoutMs", 60_000, AWAIT_LIMITS.timeoutMs);
  const started = clock.now();

  for (;;) {
    const current = state.readSignals()[channel];
    const have = current?.count ?? 0;
    const at = clock.now();
    if (have >= count) {
      return {
        ok: true,
        data: {
          channel,
          reason: "signalled",
          count: have,
          wanted: count,
          waitedMs: at - started,
          last: current?.last ?? null,
        },
      };
    }
    if (at - started >= timeoutMs) {
      return {
        ok: true,
        data: {
          channel,
          reason: "timeout",
          count: have,
          wanted: count,
          waitedMs: at - started,
          last: current?.last ?? null,
        },
      };
    }
    await clock.sleep(pollMs);
  }
}
