import { ZellijError } from "../errors.js";

export type ZellijPane = {
  id: string;
  numericId: number;
  isPlugin: boolean;
  title: string;
  command?: string | null;
  cwd?: string | null;
  tabName?: string | null;
  tabId?: number | null;
  focused: boolean;
  exited: boolean;
  floating: boolean;
};

export function normalizePaneId(raw: string, isPlugin = false): string {
  const t = raw.trim();
  if (!t) throw new ZellijError("invalid_pane", "empty pane id");
  if (/^(terminal|plugin)_\d+$/i.test(t)) return t.toLowerCase();
  if (/^\d+$/.test(t)) {
    return isPlugin ? `plugin_${t}` : `terminal_${t}`;
  }
  return t;
}

function parsePaneRow(row: Record<string, unknown>): ZellijPane | null {
  const numericId = Number(row.id);
  if (!Number.isFinite(numericId)) return null;
  const isPlugin = row.is_plugin === true;
  const id = isPlugin ? `plugin_${numericId}` : `terminal_${numericId}`;
  const title = String(row.title ?? "");
  const command =
    (typeof row.pane_command === "string" && row.pane_command) ||
    (typeof row.terminal_command === "string" && row.terminal_command) ||
    null;
  return {
    id,
    numericId,
    isPlugin,
    title,
    command,
    cwd: typeof row.pane_cwd === "string" ? row.pane_cwd : null,
    tabName: typeof row.tab_name === "string" ? row.tab_name : null,
    tabId: typeof row.tab_id === "number" ? row.tab_id : null,
    focused: row.is_focused === true,
    exited: row.exited === true,
    floating: row.is_floating === true,
  };
}

/** Parse `list-panes --json` output. */
export function parsePaneList(stdout: string): ZellijPane[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ZellijError("zellij_failed", "list-panes returned non-JSON output");
  }
  if (!Array.isArray(parsed)) {
    throw new ZellijError("zellij_failed", "list-panes JSON was not an array");
  }
  const panes: ZellijPane[] = [];
  for (const row of parsed) {
    if (row && typeof row === "object") {
      const pane = parsePaneRow(row as Record<string, unknown>);
      if (pane) panes.push(pane);
    }
  }
  return panes;
}

/**
 * Find a pane by typed id, bare number, exact title, command, then partial
 * title. Ambiguity is an error rather than a guess.
 */
export function resolvePane(panes: ZellijPane[], to: string): ZellijPane {
  const key = to.trim();
  if (!key) {
    throw new ZellijError("peer_not_found", "to (pane id or title) required");
  }

  const byTypedId = panes.find((p) => p.id === key.toLowerCase());
  if (byTypedId) return byTypedId;

  if (/^\d+$/.test(key)) {
    const terminals = panes.filter(
      (p) => !p.isPlugin && String(p.numericId) === key,
    );
    if (terminals.length === 1) return terminals[0]!;
    const any = panes.filter((p) => String(p.numericId) === key);
    if (any.length === 1) return any[0]!;
    if (any.length > 1) {
      throw new ZellijError(
        "peer_ambiguous",
        `pane id ${key} matches both terminal and plugin; use terminal_${key} or plugin_${key}`,
      );
    }
  }

  const lowered = key.toLowerCase();
  const titleMatches = panes.filter(
    (p) => !p.isPlugin && p.title.toLowerCase() === lowered,
  );
  if (titleMatches.length === 1) return titleMatches[0]!;
  if (titleMatches.length > 1) {
    throw new ZellijError(
      "peer_ambiguous",
      `multiple panes titled "${key}"; use pane id from list`,
    );
  }

  const cmdMatches = panes.filter((p) => {
    if (p.isPlugin || !p.command) return false;
    const base = p.command.replace(/\\/g, "/").split("/").pop() ?? "";
    const baseNoExt = base.replace(/\.(exe|cmd|bat)$/i, "");
    return (
      base.toLowerCase() === lowered ||
      baseNoExt.toLowerCase() === lowered ||
      p.command.toLowerCase().includes(lowered)
    );
  });
  if (cmdMatches.length === 1) return cmdMatches[0]!;
  if (cmdMatches.length > 1) {
    throw new ZellijError(
      "peer_ambiguous",
      `multiple panes match command "${key}"; use pane id from list`,
    );
  }

  const titlePartial = panes.filter(
    (p) => !p.isPlugin && p.title.toLowerCase().includes(lowered),
  );
  if (titlePartial.length === 1) return titlePartial[0]!;
  if (titlePartial.length > 1) {
    throw new ZellijError(
      "peer_ambiguous",
      `multiple panes match "${key}"; use pane id from list`,
    );
  }

  throw new ZellijError(
    "peer_not_found",
    `no Zellij pane matching "${key}"; zswarm({op:"list"}) to list`,
  );
}
