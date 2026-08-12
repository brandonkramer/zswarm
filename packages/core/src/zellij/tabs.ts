import { ZellijError } from "../errors.js";

export type ZellijTab = {
  id: number;
  position: number;
  name: string;
  active: boolean;
  panes: number;
  fullscreen: boolean;
  sync: boolean;
  layout: string | null;
};

/** Parse `list-tabs --json` output. */
export function parseTabList(stdout: string): ZellijTab[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ZellijError("zellij_failed", "list-tabs returned non-JSON output");
  }
  if (!Array.isArray(parsed)) {
    throw new ZellijError("zellij_failed", "list-tabs JSON was not an array");
  }
  const tabs: ZellijTab[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const position = Number(row.position);
    if (!Number.isFinite(position)) continue;
    const id = Number(row.tab_id);
    tabs.push({
      id: Number.isFinite(id) ? id : position,
      position,
      name: String(row.name ?? ""),
      active: row.active === true,
      panes: Number(row.selectable_tiled_panes_count ?? 0),
      fullscreen: row.is_fullscreen_active === true,
      sync: row.is_sync_panes_active === true,
      layout:
        typeof row.active_swap_layout_name === "string"
          ? row.active_swap_layout_name
          : null,
    });
  }
  return tabs;
}

/** Find a tab by name (case-insensitive), position, or stable id. */
export function resolveTab(tabs: ZellijTab[], key: string): ZellijTab {
  const wanted = key.trim();
  if (!wanted) throw new ZellijError("tab_not_found", "tab name or id required");

  const byName = tabs.filter(
    (t) => t.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new ZellijError(
      "tab_ambiguous",
      `multiple tabs named "${key}"; use the tab id`,
    );
  }
  if (/^\d+$/.test(wanted)) {
    const n = Number(wanted);
    const byId = tabs.find((t) => t.id === n) ?? tabs.find((t) => t.position === n);
    if (byId) return byId;
  }
  throw new ZellijError("tab_not_found", `no tab matching "${key}"`);
}
