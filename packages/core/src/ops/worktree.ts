import { isAbsolute, join } from "node:path";
import { ZellijError } from "../errors.js";
import {
  defaultWorktreeRoot,
  normalizeRepoPath,
  worktreeDirName,
  type GitClient,
  type Worktree,
} from "../git.js";
import type { ZellijClient } from "../zellij/client.js";
import type { ZellijPane } from "../zellij/panes.js";
import type { OpsResult } from "./types.js";
import { isTrue, optionalString } from "./util.js";

export type PeerWorktree = {
  path: string;
  branch: string;
  root: string;
  created: boolean;
};

function startDir(args: Record<string, unknown>): string {
  return optionalString(args.cwd) ?? process.cwd();
}

function worktreeRootFor(
  args: Record<string, unknown>,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): string {
  const explicit =
    optionalString(args.worktreeRoot) ??
    (env.ZSWARM_WORKTREE_ROOT?.trim() || null);
  if (!explicit) return defaultWorktreeRoot(repoRoot);
  return isAbsolute(explicit) ? explicit : join(repoRoot, explicit);
}

function findByPath(trees: Worktree[], path: string): Worktree | null {
  const wanted = normalizeRepoPath(path);
  return trees.find((t) => normalizeRepoPath(t.path) === wanted) ?? null;
}

/** Panes whose cwd sits inside a worktree — the agents that would lose the floor. */
function panesIn(panes: ZellijPane[], path: string): string[] {
  const prefix = `${normalizeRepoPath(path)}/`;
  return panes
    .filter((p) => {
      if (!p.cwd) return false;
      const cwd = `${normalizeRepoPath(p.cwd)}/`;
      return cwd === prefix || cwd.startsWith(prefix);
    })
    .map((p) => p.id);
}

/**
 * Give a peer its own branch and working directory. Reuses the worktree when
 * one already sits at the target path, so spawn stays idempotent.
 */
export async function ensurePeerWorktree(
  git: GitClient,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PeerWorktree> {
  const branch = optionalString(args.worktree);
  if (!branch) {
    throw new ZellijError("bad_arg", "worktree must be a branch name");
  }
  const repoRoot = await git.repoRoot(startDir(args));
  const path = join(worktreeRootFor(args, repoRoot, env), worktreeDirName(branch));

  const existing = findByPath(await git.listWorktrees(repoRoot), path);
  if (existing) {
    if (existing.branch && existing.branch !== branch) {
      throw new ZellijError(
        "worktree_conflict",
        `${path} already holds branch ${existing.branch}, not ${branch}`,
      );
    }
    return { path: existing.path, branch, root: repoRoot, created: false };
  }

  await git.addWorktree({
    root: repoRoot,
    path,
    branch,
    baseRef: optionalString(args.baseRef),
    createBranch: !(await git.branchExists(repoRoot, branch)),
  });
  return { path, branch, root: repoRoot, created: true };
}

/** List the repo's worktrees, annotated with the panes working in each. */
export async function listPeerWorktrees(
  git: GitClient,
  client: ZellijClient,
  args: Record<string, unknown>,
): Promise<OpsResult> {
  const repoRoot = await git.repoRoot(startDir(args));
  const trees = await git.listWorktrees(repoRoot);

  let panes: ZellijPane[] = [];
  try {
    const { session } = await client.resolveSession(
      typeof args.session === "string" ? args.session : undefined,
    );
    panes = await client.listPanes(session);
  } catch {
    // Worktrees are useful to list even with no live Zellij session.
  }

  return {
    ok: true,
    data: {
      repo: repoRoot,
      worktrees: trees.map((t) => ({
        path: t.path,
        branch: t.branch,
        main: normalizeRepoPath(t.path) === normalizeRepoPath(repoRoot),
        detached: t.detached,
        locked: t.locked,
        panes: panesIn(panes, t.path),
      })),
    },
  };
}

/**
 * Remove a worktree. Refuses the main worktree, a worktree a pane is still
 * working in, and one with uncommitted changes — `force` overrides the last two.
 */
export async function removePeerWorktree(
  git: GitClient,
  client: ZellijClient,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpsResult> {
  const repoRoot = await git.repoRoot(startDir(args));
  const trees = await git.listWorktrees(repoRoot);
  const force = isTrue(args.force);

  const wantedPath = optionalString(args.path);
  const wantedBranch = optionalString(args.branch) ?? optionalString(args.worktree);
  if (!wantedPath && !wantedBranch) {
    throw new ZellijError("missing_target", "path or branch required");
  }

  let target: Worktree | null = null;
  if (wantedPath) {
    const abs = isAbsolute(wantedPath)
      ? wantedPath
      : join(worktreeRootFor(args, repoRoot, env), wantedPath);
    target = findByPath(trees, abs) ?? findByPath(trees, wantedPath);
  } else if (wantedBranch) {
    const matches = trees.filter((t) => t.branch === wantedBranch);
    if (matches.length > 1) {
      throw new ZellijError(
        "worktree_ambiguous",
        `multiple worktrees on branch ${wantedBranch}; pass path=`,
      );
    }
    target = matches[0] ?? null;
  }
  if (!target) {
    throw new ZellijError(
      "worktree_not_found",
      `no worktree for ${wantedPath ?? wantedBranch}`,
    );
  }
  if (normalizeRepoPath(target.path) === normalizeRepoPath(repoRoot)) {
    throw new ZellijError(
      "worktree_is_main",
      "refusing to remove the main worktree",
    );
  }

  let occupants: string[] = [];
  try {
    const { session } = await client.resolveSession(
      typeof args.session === "string" ? args.session : undefined,
    );
    occupants = panesIn(await client.listPanes(session), target.path);
  } catch {
    // No live session means nobody is working in it.
  }
  if (occupants.length > 0 && !force) {
    throw new ZellijError(
      "worktree_busy",
      `${occupants.join(", ")} still working in ${target.path}; close the pane or pass force=true`,
    );
  }

  const dirty = await git.isDirty(target.path);
  if (dirty && !force) {
    throw new ZellijError(
      "worktree_dirty",
      `${target.path} has uncommitted changes; commit them or pass force=true`,
    );
  }

  await git.removeWorktree({ root: repoRoot, path: target.path, force });
  return {
    ok: true,
    data: {
      repo: repoRoot,
      removed: target.path,
      branch: target.branch,
      wasDirty: dirty,
      evicted: occupants,
    },
  };
}
