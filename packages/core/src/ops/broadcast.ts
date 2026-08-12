import { ZellijError } from "../errors.js";
import type { StateStore } from "../state.js";
import type { ZellijClient } from "../zellij/client.js";
import type { ZellijPane } from "../zellij/panes.js";
import { deliverTo, type DeliveryResult } from "./delivery.js";
import type { Clock, OpsResult } from "./types.js";
import { isTrue, optionalString } from "./util.js";

export type Skipped = { id: string; reason: string };

/**
 * Pick the panes a broadcast should reach: an explicit comma list, a tab, or
 * every terminal pane — then drop the ones it must not write to.
 */
export function selectTargets(
  client: ZellijClient,
  panes: ZellijPane[],
  args: Record<string, unknown>,
): { targets: ZellijPane[]; skipped: Skipped[] } {
  const skipped: Skipped[] = [];
  const list = optionalString(args.to);
  const tab = optionalString(args.tab);
  const group = optionalString(args.group);

  let candidates: ZellijPane[];
  if (list) {
    candidates = [];
    for (const key of list.split(",").map((k) => k.trim()).filter(Boolean)) {
      try {
        candidates.push(client.resolvePane(panes, key));
      } catch (err) {
        skipped.push({
          id: key,
          reason: err instanceof ZellijError ? err.code : "peer_not_found",
        });
      }
    }
  } else if (tab) {
    const wanted = tab.toLowerCase();
    candidates = panes.filter((p) => (p.tabName ?? "").toLowerCase() === wanted);
  } else if (isTrue(args.all)) {
    candidates = panes.slice();
  } else {
    throw new ZellijError("missing_target", "broadcast needs to, tab, or all");
  }

  // `group` narrows whatever the selector produced, by title or command.
  if (group) {
    const needle = group.toLowerCase();
    candidates = candidates.filter(
      (p) =>
        p.title.toLowerCase().includes(needle) ||
        (p.command ?? "").toLowerCase().includes(needle),
    );
  }

  const seen = new Set<string>();
  const targets: ZellijPane[] = [];
  for (const pane of candidates) {
    if (seen.has(pane.id)) continue;
    seen.add(pane.id);
    if (pane.isPlugin) {
      skipped.push({ id: pane.id, reason: "pane_is_plugin" });
      continue;
    }
    if (pane.id === client.selfPaneId && !isTrue(args.allowSelf)) {
      skipped.push({ id: pane.id, reason: "self_target" });
      continue;
    }
    if (pane.exited && !isTrue(args.force)) {
      skipped.push({ id: pane.id, reason: "pane_exited" });
      continue;
    }
    targets.push(pane);
  }
  return { targets, skipped };
}

/** Send one body to many panes, reporting per-pane outcomes. */
export async function broadcast(
  client: ZellijClient,
  state: StateStore,
  args: Record<string, unknown>,
  clock: Clock,
): Promise<OpsResult> {
  const body = String(args.body ?? args.text ?? "");
  if (!body.trim()) throw new ZellijError("missing_body", "body required");

  const { session } = await client.resolveSession(
    typeof args.session === "string" ? args.session : undefined,
  );
  const panes = await client.listPanes(session);
  const { targets, skipped } = selectTargets(client, panes, args);
  if (targets.length === 0) {
    throw new ZellijError(
      "no_targets",
      `nothing to broadcast to${skipped.length > 0 ? ` (skipped ${skipped.map((s) => `${s.id}:${s.reason}`).join(", ")})` : ""}`,
    );
  }

  const results: DeliveryResult[] = [];
  for (const pane of targets) {
    results.push(
      await deliverTo(client, state, args, {
        session,
        pane,
        body,
        op: "broadcast",
        at: clock.now(),
      }),
    );
  }

  const delivered = results.filter((r) => r.ok);
  return {
    ok: true,
    data: {
      session,
      from: (typeof args.from === "string" && args.from.trim()) || "swarm",
      delivered: delivered.map((r) => r.to),
      failed: results.filter((r) => !r.ok),
      skipped,
    },
  };
}
