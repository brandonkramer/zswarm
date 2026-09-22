import type { RoutingContext } from "./routing.js";
import type { ServeTunnelManager } from "./serve-tunnel.js";

export type OpsResult = (
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }
) & { context?: RoutingContext };

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
  /** Process-owned ssh:// LocalForward manager. CLI disposes; MCP reuses. */
  serveTunnels?: ServeTunnelManager;
  /**
   * Test seam for optional Tailscale `status --json`. Default runs the
   * `tailscale` CLI with a bounded timeout and output cap.
   */
  tailscaleStatus?: (input: {
    timeoutMs: number;
    signal?: AbortSignal;
    env: NodeJS.ProcessEnv;
  }) => Promise<{ code: number; stdout: string; stderr: string }>;
};

export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};
