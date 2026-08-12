import type { StateStore } from "../state.js";
import type { OpsResult } from "./types.js";
import { isTrue, numberArg, optionalString } from "./util.js";

/** Read back the delivery log: what zswarm sent where, and whether it landed. */
export function readDeliveryLog(
  state: StateStore,
  args: Record<string, unknown>,
): OpsResult {
  const limit = numberArg(args, "limit", 20, { min: 1, max: 1_000 });
  const to = optionalString(args.to);
  const since = optionalString(args.since);
  const sinceAt = since ? Number(since) : null;
  const failures = isTrue(args.failed);

  let entries = state.readLog();
  if (to) entries = entries.filter((e) => e.to === to);
  if (sinceAt !== null && Number.isFinite(sinceAt)) {
    entries = entries.filter((e) => e.at >= sinceAt);
  }
  if (failures) entries = entries.filter((e) => !e.ok);

  return {
    ok: true,
    data: {
      dir: state.dir,
      logging: state.logging,
      total: entries.length,
      entries: entries.slice(-limit),
    },
  };
}
