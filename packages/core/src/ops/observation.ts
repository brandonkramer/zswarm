import { ZellijError } from "../errors.js";
import type { Clock } from "./types.js";
import { throwIfAborted } from "./util.js";

/** One deadline shared by setup, child processes, retries, and sleeps. */
export function observationBudget(clock: Clock, timeoutMs: number, signal?: AbortSignal) {
  const deadline = clock.now() + timeoutMs;
  const remaining = () => {
    throwIfAborted(signal);
    return Math.max(0, deadline - clock.now());
  };
  return {
    deadline,
    remaining,
    require() {
      const left = remaining();
      if (left <= 0) throw new ZellijError("observation_timeout", "observation deadline expired");
      return left;
    },
    async pause(until = deadline) {
      const ms = Math.min(100, remaining(), Math.max(0, until - clock.now()));
      if (ms > 0) await clock.sleep(ms);
      throwIfAborted(signal);
    },
  };
}
