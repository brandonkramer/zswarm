import { ZellijError } from "../errors.js";
import { createGitClient, type GitClient } from "../git.js";
import { tokenizeCommand } from "../keys.js";
import type { NewPaneInput, PaneDirection } from "../zellij/args.js";
import type { ZellijClient } from "../zellij/client.js";
import type { OpsResult } from "./types.js";
import { isTrue, isVerbose, optionalString, paneViewFull } from "./util.js";
import { ensurePeerWorktree, type PeerWorktree } from "./worktree.js";

function paneDirection(value: unknown): PaneDirection | null {
  const dir = optionalString(value);
  if (!dir) return null;
  const lowered = dir.toLowerCase();
  if (!["right", "left", "up", "down"].includes(lowered)) {
    throw new ZellijError("bad_arg", "direction must be right|left|up|down");
  }
  return lowered as PaneDirection;
}

/** Open a new pane (or tab) and report which pane it became. */
export async function spawnPane(
  client: ZellijClient,
  args: Record<string, unknown>,
  git?: GitClient,
): Promise<OpsResult> {
  const { session } = await client.resolveSession(
    typeof args.session === "string" ? args.session : undefined,
  );
  const command = tokenizeCommand(args.command ?? args.cmd);
  // A worktree peer works on its own branch, in its own directory.
  const worktree: PeerWorktree | null = optionalString(args.worktree)
    ? await ensurePeerWorktree(git ?? createGitClient(), args)
    : null;
  const cwd = worktree ? worktree.path : optionalString(args.cwd);
  const name = optionalString(args.name) ?? worktree?.branch ?? null;
  const closeOnExit = isTrue(args.closeOnExit);
  const before = new Set((await client.listPanes(session)).map((p) => p.id));

  let paneId: string | null = null;
  let tabId: number | null = null;
  if (isTrue(args.tab)) {
    const created = await client.newTab({
      session,
      command,
      cwd,
      name,
      layout: optionalString(args.layout),
      closeOnExit,
    });
    tabId = created.tabId;
  } else {
    const input: NewPaneInput = {
      session,
      command,
      cwd,
      name,
      direction: paneDirection(args.direction),
      floating: isTrue(args.floating),
      closeOnExit,
      width: optionalString(args.width),
      height: optionalString(args.height),
    };
    if (typeof args.tabId === "number") input.tabId = args.tabId;
    paneId = (await client.newPane(input)).paneId;
  }

  // new-tab reports a tab id, and a command that exits at once can vanish, so
  // fall back to diffing the pane list against the pre-spawn snapshot.
  const panes = await client.listPanes(session);
  let resolvedBy: "stdout" | "diff" | "unresolved" = paneId
    ? "stdout"
    : "unresolved";
  let pane = paneId ? (panes.find((p) => p.id === paneId) ?? null) : null;
  if (!paneId) {
    const fresh = panes.filter((p) => !p.isPlugin && !before.has(p.id));
    const inTab = tabId === null ? fresh : fresh.filter((p) => p.tabId === tabId);
    const candidates = inTab.length > 0 ? inTab : fresh;
    if (candidates.length === 1) {
      pane = candidates[0]!;
      paneId = pane.id;
      resolvedBy = "diff";
    }
  }

  const data: Record<string, unknown> = {
    session,
    paneId,
    resolvedBy,
    live: pane !== null,
    command: command.length > 0 ? command : null,
  };
  if (worktree) {
    data.worktree = {
      path: worktree.path,
      branch: worktree.branch,
      created: worktree.created,
    };
  }
  if (tabId !== null) data.tabId = tabId;
  if (pane && isVerbose(args)) data.pane = paneViewFull(pane);
  return { ok: true, data };
}
