import { ZellijError } from "./errors.js";

export type Policy = {
  readOnly: boolean;
  allowPanes: string[] | null; // null = no allowlist
  denyPanes: string[];
  allowSpawn: boolean;
  allowClose: boolean;
  allowWorktreeRemove: boolean;
};

const WRITE_OPS = new Set([
  "send",
  "broadcast",
  "keys",
  "interrupt",
  "spawn",
  "close",
  "unworktree",
]);

/** Explicit disable tokens for ZSWARM_ALLOW_* switches. */
function isDisabled(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no";
}

/** Affirmative tokens for ZSWARM_READONLY. */
function isEnabled(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function parseList(raw: string | undefined): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadPolicy(env: NodeJS.ProcessEnv = process.env): Policy {
  const allowRaw = (env.ZSWARM_ALLOW_PANES ?? "").trim();
  return {
    readOnly: isEnabled(env.ZSWARM_READONLY),
    allowPanes: allowRaw ? parseList(allowRaw) : null,
    denyPanes: parseList(env.ZSWARM_DENY_PANES),
    allowSpawn: !isDisabled(env.ZSWARM_ALLOW_SPAWN),
    allowClose: !isDisabled(env.ZSWARM_ALLOW_CLOSE),
    allowWorktreeRemove: !isDisabled(env.ZSWARM_ALLOW_WORKTREE_REMOVE),
  };
}

export function isWriteOp(op: string): boolean {
  return WRITE_OPS.has(op);
}

function deny(envVar: string, detail: string): never {
  throw new ZellijError(
    "policy_denied",
    `${detail}; denied by ${envVar}`,
  );
}

export function assertOpAllowed(policy: Policy, op: string): void {
  if (policy.readOnly && isWriteOp(op)) {
    deny("ZSWARM_READONLY", `op "${op}" is a write`);
  }
  if (op === "spawn" && !policy.allowSpawn) {
    deny("ZSWARM_ALLOW_SPAWN", `op "spawn" disabled`);
  }
  if (op === "close" && !policy.allowClose) {
    deny("ZSWARM_ALLOW_CLOSE", `op "close" disabled`);
  }
  if (op === "unworktree" && !policy.allowWorktreeRemove) {
    deny("ZSWARM_ALLOW_WORKTREE_REMOVE", `op "unworktree" disabled`);
  }
}

function paneMatches(
  entry: string,
  pane: { id: string; title: string },
): boolean {
  if (pane.id === entry) return true;
  const needle = entry.toLowerCase();
  return pane.title.toLowerCase().includes(needle);
}

export function assertPaneAllowed(
  policy: Policy,
  pane: { id: string; title: string },
  op: string,
): void {
  if (policy.denyPanes.some((entry) => paneMatches(entry, pane))) {
    deny(
      "ZSWARM_DENY_PANES",
      `op "${op}" on pane ${pane.id} ("${pane.title}")`,
    );
  }
  if (
    policy.allowPanes !== null &&
    !policy.allowPanes.some((entry) => paneMatches(entry, pane))
  ) {
    deny(
      "ZSWARM_ALLOW_PANES",
      `op "${op}" on pane ${pane.id} ("${pane.title}") not in allowlist`,
    );
  }
}
