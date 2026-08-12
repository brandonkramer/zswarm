export type OpsResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

import type { GitClient } from "../git.js";
import type { StateStore } from "../state.js";

/** Injectable clock, git, and state so timing/IO ops stay testable. */
export type DispatchDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  git?: GitClient;
  state?: StateStore;
};

export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};
