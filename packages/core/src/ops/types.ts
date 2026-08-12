export type OpsResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

import type { GitClient } from "../git.js";

/** Injectable clock and git so `wait`/worktree ops are testable. */
export type DispatchDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  git?: GitClient;
};

export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};
