import { ZellijError } from "../errors.js";
import {
  normalizeRepoPath,
  type GitClient,
  type Worktree,
} from "../git.js";
import type { Clock, OpsResult } from "./types.js";
import { dumpMaxChars, isTrue, optionalString } from "./util.js";

function findByPath(trees: Worktree[], path: string): Worktree | null {
  const wanted = normalizeRepoPath(path);
  return trees.find((t) => normalizeRepoPath(t.path) === wanted) ?? null;
}

function findByBranch(trees: Worktree[], branch: string): Worktree {
  const matches = trees.filter((t) => t.branch === branch);
  if (matches.length === 0) {
    throw new ZellijError("worktree_not_found", `no worktree for ${branch}`);
  }
  if (matches.length > 1) {
    throw new ZellijError(
      "worktree_ambiguous",
      `multiple worktrees on branch ${branch}; pass path=`,
    );
  }
  return matches[0]!;
}

/**
 * Resolve the peer working directory: args.path, else the worktree on
 * args.branch, else args.cwd, else process.cwd().
 */
async function resolvePeerDir(
  git: GitClient,
  args: Record<string, unknown>,
): Promise<{ path: string; branch: string | null }> {
  const pathArg = optionalString(args.path);
  const branchArg = optionalString(args.branch);
  const cwd = optionalString(args.cwd) ?? process.cwd();

  if (pathArg) {
    const root = await git.repoRoot(pathArg);
    const match = findByPath(await git.listWorktrees(root), pathArg);
    return { path: match?.path ?? pathArg, branch: match?.branch ?? null };
  }

  if (branchArg) {
    const root = await git.repoRoot(cwd);
    const match = findByBranch(await git.listWorktrees(root), branchArg);
    return { path: match.path, branch: match.branch };
  }

  const root = await git.repoRoot(cwd);
  const match = findByPath(await git.listWorktrees(root), cwd);
  return { path: match?.path ?? cwd, branch: match?.branch ?? null };
}

/** Show what a peer worktree changed vs HEAD (untracked included). */
export async function peerDiff(
  git: GitClient,
  args: Record<string, unknown>,
): Promise<OpsResult> {
  const { path, branch } = await resolvePeerDir(git, args);
  const max = dumpMaxChars(args);
  const statOnly = isTrue(args.stat);

  const stat = await git.diffStat(path);
  if (statOnly) {
    return {
      ok: true,
      data: {
        path,
        branch,
        stat,
        patch: "",
        truncated: false,
        chars: 0,
      },
    };
  }

  const { patch, truncated, chars } = await git.diffPatch(path, max);
  return {
    ok: true,
    data: { path, branch, stat, patch, truncated, chars },
  };
}

/**
 * Commit all changes in a peer worktree so the pane can close and resume.
 * A clean tree is success with committed:false, nothingToCommit:true.
 */
export async function peerCheckpoint(
  git: GitClient,
  args: Record<string, unknown>,
  clock: Clock,
): Promise<OpsResult> {
  const { path, branch } = await resolvePeerDir(git, args);
  const message =
    optionalString(args.message) ??
    `zswarm checkpoint ${new Date(clock.now()).toISOString()}`;

  if (!(await git.isDirty(path))) {
    const sha = await git.headSha(path);
    return {
      ok: true,
      data: {
        path,
        branch,
        sha,
        committed: false,
        nothingToCommit: true,
      },
    };
  }

  let sha: string;
  try {
    sha = await git.commitAll(path, message);
  } catch (err) {
    // git's own message here is long and buried; name the actual fix.
    const text = err instanceof Error ? err.message : String(err);
    if (/Author identity unknown|unable to auto-detect email/i.test(text)) {
      throw new ZellijError(
        "git_identity",
        "git has no author identity on this machine; set user.name and user.email (git config --global), or export GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL and GIT_COMMITTER_NAME/GIT_COMMITTER_EMAIL before checkpointing",
      );
    }
    throw err;
  }
  return {
    ok: true,
    data: {
      path,
      branch,
      sha,
      committed: true,
      nothingToCommit: false,
    },
  };
}
