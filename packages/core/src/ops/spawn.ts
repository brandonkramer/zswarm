import { ZellijError } from "../errors.js";
import { createGitClient, type GitClient } from "../git.js";
import { tokenizeCommand } from "../keys.js";
import type { NewPaneInput, PaneDirection } from "../zellij/args.js";
import type { ZellijClient } from "../zellij/client.js";
import type { ZellijPane } from "../zellij/panes.js";
import type { Clock, OpsResult } from "./types.js";
import { isTrue, isVerbose, numberArg, optionalString, paneViewFull, throwIfAborted } from "./util.js";
import { observationBudget } from "./observation.js";
import { ensurePeerWorktree, type PeerWorktree } from "./worktree.js";

function paneDirection(value: unknown): PaneDirection | null {
  const dir = optionalString(value)?.toLowerCase();
  if (!dir) return null;
  if (!["right", "left", "up", "down"].includes(dir)) {
    throw new ZellijError("bad_arg", "direction must be right|left|up|down");
  }
  return dir as PaneDirection;
}

/** Create exactly once. Only observations are retried, never the create action. */
export async function spawnPane(
  client: ZellijClient,
  args: Record<string, unknown>,
  git?: GitClient,
  clock: Clock = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  signal?: AbortSignal,
): Promise<OpsResult> {
  const started = clock.now();
  const budget = observationBudget(clock, numberArg(args, "timeoutMs", 30_000, { min: 1, max: 900_000 }), signal);
  const observeMs = numberArg(args, "observeMs", 3_000, { min: 0, max: 30_000 });
  const command = tokenizeCommand(args.command ?? args.cmd);
  const direction = paneDirection(args.direction);
  const newTab = isTrue(args.newTab) || args.tab === true;
  const { session } = await client.resolveSession(optionalString(args.session), budget.require());
  const worktree: PeerWorktree | null = optionalString(args.worktree)
    ? await ensurePeerWorktree(git ?? createGitClient(), args)
    : null;
  const cwd = worktree ? worktree.path : optionalString(args.cwd);
  const name = optionalString(args.name) ?? worktree?.branch ?? null;
  const beforePanes = await client.listPanes(session, budget.require(), { fresh: true });
  const before = new Set(beforePanes.map((p) => p.id));
  let paneId: string | null = null;
  let tabId: number | null = null;
  let tabSource = newTab ? "created" : "explicit";
  if (newTab) {
    tabId = (await client.newTab({
      session, command, cwd, name, layout: optionalString(args.layout),
      closeOnExit: isTrue(args.closeOnExit), timeoutMs: budget.require(),
    })).tabId;
  } else {
    const input: NewPaneInput = {
      session, command, cwd, name, direction, floating: isTrue(args.floating),
      closeOnExit: isTrue(args.closeOnExit),
      width: optionalString(args.width), height: optionalString(args.height),
    };
    const tabName = optionalString(args.tab);
    if (typeof args.tabId === "number") {
      tabId = args.tabId;
    } else if (tabName) {
      tabId = client.resolveTab(await client.listTabs(session, budget.require(), { fresh: true }), tabName).id;
    } else {
      // Address a tab explicitly even when no viewer is attached.
      const focused = beforePanes.find((p) => p.focused && p.tabId != null);
      const first = beforePanes.find((p) => !p.isPlugin && p.tabId != null);
      tabId = focused?.tabId ?? first?.tabId ?? null;
      tabSource = focused ? "focused-pane" : "first-tab";
      if (tabId === null) {
        const tabs = await client.listTabs(session, budget.require(), { fresh: true });
        tabId = [...tabs].sort((a, b) => a.position - b.position)[0]?.id ?? null;
      }
      if (tabId === null) throw new ZellijError("tab_not_found", "no tab for spawn; use --new-tab");
    }
    input.tabId = tabId;
    input.timeoutMs = budget.require();
    paneId = (await client.newPane(input)).paneId;
  }

  const observedUntil = Math.min(budget.deadline, clock.now() + observeMs);
  let pane: ZellijPane | null = null;
  let resolvedBy = paneId ? "stdout" : "unresolved";
  let observation = "timeout";
  let diagnostic: string | undefined;
  let renameAttempted = false;
  let aliasObserved = !name;
  const candidatesSeen = new Set<string>();
  let firstRead = true;
  let candidateId: string | null = null;
  try {
    while (budget.remaining() > 0 && (firstRead || clock.now() < observedUntil)) {
      firstRead = false;
      try {
        const left = observeMs === 0 ? budget.require() : Math.min(budget.require(), Math.max(1, observedUntil - clock.now()));
        const panes = await client.listPanes(session, left, { fresh: true });
        throwIfAborted(signal);
        if (paneId) {
          pane = panes.find((p) => p.id === paneId && !p.isPlugin) ?? null;
        } else if (newTab && tabId !== null) {
          const candidates = panes.filter((p) => !p.isPlugin && !before.has(p.id) && p.tabId === tabId);
          for (const candidate of candidates) candidatesSeen.add(candidate.id);
          if (candidatesSeen.size === 1 && candidates.length === 1) {
            const candidate = candidates[0]!;
            // A second observation catches a layout whose panes arrive in
            // separate manifests. Never lock onto its first partial snapshot.
            if (candidateId === candidate.id) {
              pane = candidate;
              paneId = pane.id;
              resolvedBy = "tab";
            }
            candidateId = candidate.id;
          } else if (candidatesSeen.size > 1) {
            observation = "ambiguous";
            break;
          }
        } else {
          // A global before/after diff cannot identify our concurrent creation.
          observation = "unresolved";
          break;
        }
        if (pane) {
          aliasObserved = !name || pane.title === name;
          if (!aliasObserved && !renameAttempted) {
            renameAttempted = true;
            await client.renamePane({ session, paneId: pane.id, name: name!, timeoutMs: observeMs === 0 ? budget.require() : Math.min(budget.require(), Math.max(1, observedUntil - clock.now())) });
            throwIfAborted(signal);
          } else if (aliasObserved) {
            observation = "observed";
            break;
          }
        }
      } catch (err) {
        throwIfAborted(signal);
        if (err instanceof ZellijError && err.code === "cancelled") throw err;
        diagnostic = err instanceof Error ? err.message : String(err);
      }
      if (observeMs === 0 || clock.now() >= observedUntil) break;
      await budget.pause(observedUntil);
    }
  } catch (err) {
    if (signal?.aborted || (err instanceof ZellijError && err.code === "cancelled")) {
      return { ok: false, error: {
        code: "cancelled", message: "spawn was acknowledged; observation cancelled",
        details: { session, paneId, tabId, created: true },
      } };
    }
    throw err;
  }
  const data: Record<string, unknown> = {
    session, paneId, tabId, tabSource, resolvedBy, created: true,
    observed: pane !== null, exited: pane?.exited ?? null,
    live: pane !== null && !pane.exited,
    ready: pane?.exited ? false : "unknown",
    observation: { status: observation, elapsedMs: clock.now() - started, ...(diagnostic ? { diagnostic } : {}) },
    command: command.length ? command : null,
  };
  if (name) data.alias = { name, observed: aliasObserved };
  if (worktree) data.worktree = { path: worktree.path, branch: worktree.branch, created: worktree.created };
  if (pane && isVerbose(args)) data.pane = paneViewFull(pane);
  return { ok: true, data };
}
