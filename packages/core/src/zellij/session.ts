import { ZellijError } from "../errors.js";

export type ZellijSessionResolve = {
  session: string;
  source: "arg" | "env_zswarm" | "env_zellij" | "sole_live";
};

/**
 * Pane hosting the caller, so writes can refuse to loop back into it.
 * `ZSWARM_SELF_PANE` wins; Zellij exports `ZELLIJ_PANE_ID` inside a pane.
 */
export function resolveSelfPaneId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = (env.ZSWARM_SELF_PANE ?? env.ZELLIJ_PANE_ID ?? "").trim();
  if (!raw || raw.toLowerCase() === "none") return null;
  if (/^\d+$/.test(raw)) return `terminal_${raw}`;
  if (/^(terminal|plugin)_\d+$/i.test(raw)) return raw.toLowerCase();
  return null;
}

export function parseSessionList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Zellij exits 1 and prints this when the machine simply has no sessions. */
export function isZellijNoSessionsOutput(stdout: string, stderr: string): boolean {
  return /no active zellij sessions found/i.test(`${stderr}\n${stdout}`);
}

/** Session from an explicit argument or the environment, before asking Zellij. */
export function sessionFromEnv(
  env: NodeJS.ProcessEnv,
  explicit?: string | null,
): ZellijSessionResolve | null {
  const arg = explicit?.trim();
  if (arg) return { session: arg, source: "arg" };

  const swarmEnv = env.ZSWARM_SESSION?.trim();
  if (swarmEnv) return { session: swarmEnv, source: "env_zswarm" };

  const zellijEnv = env.ZELLIJ_SESSION_NAME?.trim();
  if (zellijEnv) return { session: zellijEnv, source: "env_zellij" };

  return null;
}

/** Pick a session when the environment gave no answer. */
export function sessionFromList(sessions: string[]): ZellijSessionResolve {
  if (sessions.length === 1) {
    return { session: sessions[0]!, source: "sole_live" };
  }
  if (sessions.length === 0) {
    throw new ZellijError(
      "zellij_no_session",
      "no live Zellij sessions; start zellij or pass session=",
    );
  }
  throw new ZellijError(
    "zellij_session_ambiguous",
    `multiple Zellij sessions (${sessions.join(", ")}); pass session=`,
  );
}
