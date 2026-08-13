export type OpsResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

import type { GitClient } from "../git.js";
import type { Policy } from "../policy.js";
import type { StateStore } from "../state.js";

/** Injectable clock, git, state, and policy so timing/IO ops stay testable. */
export type DispatchDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  git?: GitClient;
  state?: StateStore;
  policy?: Policy;
  env?: NodeJS.ProcessEnv;
  /** MCP cancellation; aborted waits stop instead of running to timeout. */
  signal?: AbortSignal;
};

export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};
