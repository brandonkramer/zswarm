import { copyFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { ZellijError } from "./errors.js";
import { createExec, NOT_FOUND_EXIT, type ExecFn } from "./exec.js";

const DEFAULT_TIMEOUT_MS = 20_000;

export type Worktree = {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
};

/** Compare paths across separators and case, so pane cwds match git output. */
export function normalizeRepoPath(input: string): string {
  return input
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Branch names may contain `/`; directory names may not. */
export function worktreeDirName(branch: string): string {
  const cleaned = branch
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) {
    throw new ZellijError("bad_branch", `branch "${branch}" has no usable name`);
  }
  return cleaned;
}

/** Sibling of the repo, matching the common `<repo>-worktrees` convention. */
export function defaultWorktreeRoot(repoRoot: string): string {
  return join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`);
}

export function parseWorktreeList(stdout: string): Worktree[] {
  const trees: Worktree[] = [];
  let current: Worktree | null = null;
  const push = () => {
    if (current) trees.push(current);
    current = null;
  };
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      push();
      continue;
    }
    if (line.startsWith("worktree ")) {
      push();
      current = {
        path: line.slice("worktree ".length),
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch "))
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (line === "bare") current.bare = true;
    else if (line === "detached") current.detached = true;
    else if (line.startsWith("locked")) current.locked = true;
    else if (line.startsWith("prunable")) current.prunable = true;
  }
  push();
  return trees;
}

export type GitClientOptions = {
  exec?: ExecFn;
  gitPath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export function createGitClient(options: GitClientOptions = {}) {
  const env = options.env ?? process.env;
  const gitPath = options.gitPath ?? env.ZSWARM_GIT_BIN?.trim() ?? "git";
  const exec = options.exec ?? createExec(gitPath, env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function run(
    args: string[],
    cwd: string,
    label: string,
    extraEnv?: NodeJS.ProcessEnv,
  ) {
    const result = await exec(args, { timeoutMs, cwd, env: extraEnv });
    if (result.code === NOT_FOUND_EXIT) {
      throw new ZellijError(
        "git_missing",
        `git not found (${gitPath}); install git or set ZSWARM_GIT_BIN`,
      );
    }
    if (result.code !== 0) {
      throw new ZellijError(
        "git_failed",
        `${label} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
      );
    }
    return result;
  }

  /** Top level of the working tree containing `cwd`. */
  async function repoRoot(cwd: string): Promise<string> {
    const result = await exec(["rev-parse", "--show-toplevel"], {
      timeoutMs,
      cwd,
    });
    if (result.code === NOT_FOUND_EXIT) {
      throw new ZellijError(
        "git_missing",
        `git not found (${gitPath}); install git or set ZSWARM_GIT_BIN`,
      );
    }
    if (result.code !== 0) {
      throw new ZellijError(
        "not_a_repo",
        `${cwd} is not inside a git repository`,
      );
    }
    return result.stdout.trim();
  }

  async function branchExists(root: string, branch: string): Promise<boolean> {
    const result = await exec(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { timeoutMs, cwd: root },
    );
    return result.code === 0;
  }

  async function listWorktrees(root: string): Promise<Worktree[]> {
    const result = await run(
      ["worktree", "list", "--porcelain"],
      root,
      "git worktree list",
    );
    return parseWorktreeList(result.stdout);
  }

  async function addWorktree(input: {
    root: string;
    path: string;
    branch: string;
    baseRef?: string | null;
    createBranch: boolean;
  }): Promise<void> {
    const args = ["worktree", "add"];
    if (input.createBranch) args.push("-b", input.branch);
    args.push(input.path);
    if (input.createBranch) {
      if (input.baseRef) args.push(input.baseRef);
    } else {
      args.push(input.branch);
    }
    await run(args, input.root, "git worktree add");
  }

  async function removeWorktree(input: {
    root: string;
    path: string;
    force?: boolean;
  }): Promise<void> {
    const args = ["worktree", "remove"];
    if (input.force) args.push("--force");
    args.push(input.path);
    await run(args, input.root, "git worktree remove");
  }

  /** Uncommitted changes, including untracked files. */
  async function isDirty(path: string): Promise<boolean> {
    const result = await run(
      ["status", "--porcelain"],
      path,
      "git status",
    );
    return result.stdout.trim().length > 0;
  }

  /**
   * Stage untracked paths as intent-to-add in a scratch index so they appear
   * in `git diff` without mutating the real `.git/index`.
   */
  async function withScratchIndex<T>(
    path: string,
    fn: (indexEnv: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    const located = await run(
      ["rev-parse", "--git-path", "index"],
      path,
      "git rev-parse --git-path index",
    );
    const indexRel = located.stdout.trim();
    const indexAbs = isAbsolute(indexRel) ? indexRel : join(path, indexRel);
    const scratch = `${indexAbs}.zswarm-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      copyFileSync(indexAbs, scratch);
    } catch {
      // No index yet (empty repo / new worktree).
    }
    try {
      return await fn({ GIT_INDEX_FILE: scratch });
    } finally {
      rmSync(scratch, { force: true });
    }
  }

  async function intentAddUntracked(
    path: string,
    indexEnv: NodeJS.ProcessEnv,
  ): Promise<void> {
    await run(
      ["add", "-A", "--intent-to-add"],
      path,
      "git add --intent-to-add",
      indexEnv,
    );
  }

  /** `git diff --stat HEAD`, including untracked via a scratch intent-to-add. */
  async function diffStat(path: string): Promise<string> {
    return withScratchIndex(path, async (indexEnv) => {
      await intentAddUntracked(path, indexEnv);
      const result = await run(
        ["diff", "--stat", "HEAD"],
        path,
        "git diff --stat",
        indexEnv,
      );
      return result.stdout;
    });
  }

  /**
   * `git diff HEAD`, including untracked via a scratch intent-to-add.
   * When `maxChars > 0` and the patch is longer, keep the head and set
   * `truncated`. `chars` is always the full patch length before truncating.
   */
  async function diffPatch(
    path: string,
    maxChars: number,
  ): Promise<{ patch: string; truncated: boolean; chars: number }> {
    return withScratchIndex(path, async (indexEnv) => {
      await intentAddUntracked(path, indexEnv);
      const result = await run(["diff", "HEAD"], path, "git diff", indexEnv);
      const full = result.stdout;
      const chars = full.length;
      if (maxChars <= 0 || chars <= maxChars) {
        return { patch: full, truncated: false, chars };
      }
      return { patch: full.slice(0, maxChars), truncated: true, chars };
    });
  }

  /** `git add -A` then `git commit -m`; returns the new short HEAD sha. */
  async function commitAll(path: string, message: string): Promise<string> {
    await run(["add", "-A"], path, "git add");
    await run(["commit", "-m", message], path, "git commit");
    return headSha(path);
  }

  /** Short sha of HEAD. */
  async function headSha(path: string): Promise<string> {
    const result = await run(
      ["rev-parse", "--short", "HEAD"],
      path,
      "git rev-parse",
    );
    return result.stdout.trim();
  }

  return {
    gitPath,
    repoRoot,
    branchExists,
    listWorktrees,
    addWorktree,
    removeWorktree,
    isDirty,
    diffStat,
    diffPatch,
    commitAll,
    headSha,
  };
}

export type GitClient = ReturnType<typeof createGitClient>;
