import { ZellijError } from "../errors.js";

export type ZellijSessionResolve = {
  session: string;
  source: "arg" | "env_zswarm" | "env_zellij" | "sole_live";
};

/** One row from `zellij list-sessions --no-formatting` (not `--short`). */
export type ZellijSession = {
  name: string;
  /** True when Zellij marks the row EXITED (resurrectable, no live server). */
  exited: boolean;
  /** True when the listing marks this session as the caller's current one. */
  current: boolean;
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

/**
 * Parse `list-sessions --no-formatting` output.
 *
 * Annotated form: `name [Created …] [(current)| (EXITED - …)]`.
 * Bare names (from `--short` or test mocks) are treated as live.
 */
export function parseSessionList(stdout: string): ZellijSession[] {
  const sessions: ZellijSession[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    // Drop ANSI in case a caller forgot --no-formatting.
    const line = raw.replace(/\x1B\[[0-9;]*m/g, "").trim();
    if (!line) continue;
    const created = line.indexOf(" [Created ");
    if (created >= 0) {
      const name = line.slice(0, created).trim();
      if (!name) continue;
      const suffix = line.slice(created);
      sessions.push({
        name,
        exited: /\(EXITED\b/i.test(suffix),
        current: /\(current\)/i.test(suffix),
      });
      continue;
    }
    // Bare name from --short or a mock.
    sessions.push({ name: line, exited: false, current: false });
  }
  return sessions;
}

/** Live session names only — used when auto-picking a sole session. */
export function liveSessionNames(sessions: ZellijSession[]): string[] {
  return sessions.filter((s) => !s.exited).map((s) => s.name);
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

/** Pick a session when the environment gave no answer. EXITED rows do not count. */
export function sessionFromList(sessions: ZellijSession[]): ZellijSessionResolve {
  const live = liveSessionNames(sessions);
  if (live.length === 1) {
    return { session: live[0]!, source: "sole_live" };
  }
  if (live.length === 0) {
    throw new ZellijError(
      "zellij_no_session",
      "no live Zellij sessions; start zellij or pass session=",
    );
  }
  throw new ZellijError(
    "zellij_session_ambiguous",
    `multiple Zellij sessions (${live.join(", ")}); pass session=`,
  );
}
