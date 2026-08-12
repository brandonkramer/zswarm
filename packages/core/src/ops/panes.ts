import { ZellijError } from "../errors.js";
import type { ZellijClient } from "../zellij/client.js";
import type { OpsResult } from "./types.js";
import { dumpMaxChars, optionalString, truncateDumpText } from "./util.js";

async function session(
  client: ZellijClient,
  args: Record<string, unknown>,
): Promise<string> {
  const resolved = await client.resolveSession(
    typeof args.session === "string" ? args.session : undefined,
  );
  return resolved.session;
}

/**
 * Give a pane (or its tab) a stable name, so peers can be addressed as
 * `reviewer` instead of whatever id Zellij handed out.
 */
export async function renameTarget(
  client: ZellijClient,
  args: Record<string, unknown>,
): Promise<OpsResult> {
  const name = optionalString(args.name);
  if (!name) throw new ZellijError("missing_name", "name required");
  const sess = await session(client, args);

  const tabKey = optionalString(args.tab);
  if (tabKey) {
    const tab = client.resolveTab(await client.listTabs(sess), tabKey);
    const renamed = await client.renameTab({
      session: sess,
      tabId: tab.id,
      name,
    });
    return {
      ok: true,
      data: { session: sess, tab: renamed.tabId, was: tab.name, name },
    };
  }

  const to = optionalString(args.to);
  if (!to) throw new ZellijError("missing_peer", "to (or tab) required");
  const pane = client.resolvePane(await client.listPanes(sess), to);
  await client.renamePane({ session: sess, paneId: pane.id, name });
  return {
    ok: true,
    data: { session: sess, to: pane.id, was: pane.title, name },
  };
}

export async function focusTarget(
  client: ZellijClient,
  args: Record<string, unknown>,
): Promise<OpsResult> {
  const to = optionalString(args.to);
  if (!to) throw new ZellijError("missing_peer", "to required");
  const sess = await session(client, args);
  const pane = client.resolvePane(await client.listPanes(sess), to);
  // Zellij exits non-zero when asked to focus the already-focused pane.
  if (pane.focused) {
    return {
      ok: true,
      data: {
        session: sess,
        focused: pane.id,
        title: pane.title,
        already: true,
      },
    };
  }
  const focused = await client.focusPane({ session: sess, paneId: pane.id });
  return {
    ok: true,
    data: { session: sess, focused: focused.paneId, title: pane.title },
  };
}

export async function listTabsOp(
  client: ZellijClient,
  args: Record<string, unknown>,
): Promise<OpsResult> {
  const sess = await session(client, args);
  const tabs = await client.listTabs(sess);
  return {
    ok: true,
    data: {
      session: sess,
      tabs: tabs.map((t) => ({
        id: t.id,
        name: t.name,
        panes: t.panes,
        active: t.active,
        layout: t.layout,
      })),
    },
  };
}

/** The session's current layout as KDL — a spawnable description of the crew. */
export async function dumpLayoutOp(
  client: ZellijClient,
  args: Record<string, unknown>,
): Promise<OpsResult> {
  const sess = await session(client, args);
  const layout = await client.dumpLayout(sess);
  const max = dumpMaxChars(args);
  const clipped = truncateDumpText(layout, max, "head");
  return {
    ok: true,
    data: {
      session: sess,
      layout: clipped.text,
      truncated: clipped.truncated,
      chars: clipped.chars,
    },
  };
}

/** Collapse several peers into one stack so a big crew stays readable. */
export async function stackTargets(
  client: ZellijClient,
  args: Record<string, unknown>,
): Promise<OpsResult> {
  const list = optionalString(args.to);
  if (!list) throw new ZellijError("missing_peer", "to (comma list) required");
  const sess = await session(client, args);
  const panes = await client.listPanes(sess);
  const ids = list
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((key) => client.resolvePane(panes, key).id);
  const unique = [...new Set(ids)];
  const stacked = await client.stackPanes({ session: sess, paneIds: unique });
  return { ok: true, data: { session: sess, stacked: stacked.paneIds } };
}
