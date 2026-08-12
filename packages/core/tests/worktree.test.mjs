import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  createGitClient,
  createZellijClient,
  defaultWorktreeRoot,
  dispatchZswarm,
  normalizeRepoPath,
  parseWorktreeList,
  worktreeDirName,
} from "../dist/index.js";

const REPO = "D:/repo/demo";
const WT_ROOT = defaultWorktreeRoot(REPO);

const PORCELAIN = [
  `worktree ${REPO}`,
  "HEAD aaaa",
  "branch refs/heads/master",
  "",
  `worktree ${WT_ROOT}/reviewer`,
  "HEAD bbbb",
  "branch refs/heads/reviewer",
  "",
].join("\n");

function panesJson(rows) {
  return JSON.stringify(rows);
}

/** Git client over a scripted exec, recording every argv it is asked to run. */
function gitHarness({ porcelain = PORCELAIN, branches = [], dirty = "" } = {}) {
  const calls = [];
  const git = createGitClient({
    env: {},
    exec: async (args, opts) => {
      calls.push({ args, cwd: opts.cwd });
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: `${REPO}\n`, stderr: "" };
      }
      if (args[0] === "show-ref") {
        const branch = args[args.length - 1].replace("refs/heads/", "");
        return { code: branches.includes(branch) ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return { code: 0, stdout: porcelain, stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stdout: dirty, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return { git, calls, argvFor: (verb) => calls.find((c) => c.args.includes(verb)) };
}

function zellijHarness(panes = []) {
  const calls = [];
  const client = createZellijClient({
    env: {},
    exec: async (args) => {
      calls.push(args);
      if (args.includes("list-sessions")) {
        return { code: 0, stdout: "demo\n", stderr: "" };
      }
      if (args.includes("list-panes")) {
        return { code: 0, stdout: panesJson(panes), stderr: "" };
      }
      if (args.includes("new-pane")) {
        return { code: 0, stdout: "terminal_5\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return { client, calls, argvFor: (verb) => calls.find((a) => a.includes(verb)) };
}

const PANE_IN_WORKTREE = {
  id: 3,
  is_plugin: false,
  is_focused: false,
  title: "reviewer",
  exited: false,
  is_floating: false,
  tab_id: 0,
  pane_cwd: `${WT_ROOT}\\reviewer\\packages`,
  pane_command: "claude.exe",
};

test("parseWorktreeList reads the porcelain blocks", () => {
  const trees = parseWorktreeList(PORCELAIN);
  assert.equal(trees.length, 2);
  assert.equal(trees[0].path, REPO);
  assert.equal(trees[0].branch, "master");
  assert.equal(trees[1].branch, "reviewer");
  assert.equal(trees[1].detached, false);
  assert.deepEqual(parseWorktreeList(""), []);
});

test("worktreeDirName flattens branch paths", () => {
  assert.equal(worktreeDirName("feature/login"), "feature-login");
  assert.equal(worktreeDirName("refs/heads/fix"), "fix");
  assert.equal(worktreeDirName("a b"), "a-b");
  assert.throws(() => worktreeDirName("///"), /no usable name/);
});

test("normalizeRepoPath makes windows and git paths comparable", () => {
  assert.equal(
    normalizeRepoPath("D:\\Repo\\Demo\\"),
    normalizeRepoPath("d:/repo/demo"),
  );
});

test("spawn creates a worktree and runs the pane inside it", async () => {
  const { git, argvFor } = gitHarness();
  const { client, argvFor: zellijArgv } = zellijHarness([
    {
      id: 5,
      is_plugin: false,
      is_focused: true,
      title: "builder",
      exited: false,
      is_floating: false,
      tab_id: 0,
      pane_cwd: `${WT_ROOT}/builder`,
      pane_command: "claude.exe",
    },
  ]);
  const res = await dispatchZswarm(
    { op: "spawn", worktree: "builder", cwd: REPO, command: "claude" },
    client,
    { git },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.worktree, {
    path: join(WT_ROOT, "builder"),
    branch: "builder",
    created: true,
  });
  // New branch -> `-b`, and the pane opens in the worktree, not the repo.
  assert.deepEqual(argvFor("add").args, [
    "worktree",
    "add",
    "-b",
    "builder",
    join(WT_ROOT, "builder"),
  ]);
  const spawnArgv = zellijArgv("new-pane");
  assert.equal(spawnArgv[spawnArgv.indexOf("--cwd") + 1], join(WT_ROOT, "builder"));
  // The pane is named after the branch when no name was given.
  assert.equal(spawnArgv[spawnArgv.indexOf("--name") + 1], "builder");
});

test("spawn checks out an existing branch instead of recreating it", async () => {
  const { git, argvFor } = gitHarness({ branches: ["hotfix"] });
  const { client } = zellijHarness();
  const res = await dispatchZswarm(
    { op: "spawn", worktree: "hotfix", cwd: REPO, baseRef: "origin/main" },
    client,
    { git },
  );
  assert.equal(res.ok, true);
  // Existing branch: no -b, no base ref, branch given as the checkout target.
  assert.deepEqual(argvFor("add").args, [
    "worktree",
    "add",
    join(WT_ROOT, "hotfix"),
    "hotfix",
  ]);
});

test("spawn reuses a worktree that already sits at the path", async () => {
  const { git, calls } = gitHarness();
  const { client } = zellijHarness();
  const res = await dispatchZswarm(
    { op: "spawn", worktree: "reviewer", cwd: REPO },
    client,
    { git },
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.worktree.created, false);
  assert.equal(res.data.worktree.path, `${WT_ROOT}/reviewer`);
  assert.equal(calls.some((c) => c.args.includes("add")), false);
});

test("worktrees lists trees with the panes working in them", async () => {
  const { git } = gitHarness();
  const { client } = zellijHarness([PANE_IN_WORKTREE]);
  const res = await dispatchZswarm({ op: "worktrees", cwd: REPO }, client, { git });
  assert.equal(res.ok, true);
  assert.equal(res.data.repo, REPO);
  assert.deepEqual(res.data.worktrees[0], {
    path: REPO,
    branch: "master",
    main: true,
    detached: false,
    locked: false,
    panes: [],
  });
  // Pane cwd is a windows path below the worktree; it still matches.
  assert.deepEqual(res.data.worktrees[1].panes, ["terminal_3"]);
});

test("unworktree removes a clean, empty worktree by branch", async () => {
  const { git, argvFor } = gitHarness();
  const { client } = zellijHarness();
  const res = await dispatchZswarm(
    { op: "unworktree", branch: "reviewer", cwd: REPO },
    client,
    { git },
  );
  assert.equal(res.ok, true);
  assert.equal(res.data.removed, `${WT_ROOT}/reviewer`);
  assert.equal(res.data.wasDirty, false);
  assert.deepEqual(argvFor("remove").args, [
    "worktree",
    "remove",
    `${WT_ROOT}/reviewer`,
  ]);
});

test("unworktree refuses the main worktree", async () => {
  const { git } = gitHarness();
  const { client } = zellijHarness();
  const res = await dispatchZswarm(
    { op: "unworktree", path: REPO, cwd: REPO },
    client,
    { git },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "worktree_is_main");
});

test("unworktree refuses a worktree a pane is still working in", async () => {
  const { git, calls } = gitHarness();
  const { client } = zellijHarness([PANE_IN_WORKTREE]);
  const busy = await dispatchZswarm(
    { op: "unworktree", branch: "reviewer", cwd: REPO },
    client,
    { git },
  );
  assert.equal(busy.ok, false);
  assert.equal(busy.error.code, "worktree_busy");
  assert.match(busy.error.message, /terminal_3/);
  assert.equal(calls.some((c) => c.args.includes("remove")), false);

  const forced = await dispatchZswarm(
    { op: "unworktree", branch: "reviewer", cwd: REPO, force: true },
    client,
    { git },
  );
  assert.equal(forced.ok, true);
  assert.deepEqual(forced.data.evicted, ["terminal_3"]);
});

test("unworktree refuses uncommitted changes unless forced", async () => {
  const { git, argvFor } = gitHarness({ dirty: " M packages/core/src/ops.ts\n" });
  const { client } = zellijHarness();
  const dirty = await dispatchZswarm(
    { op: "unworktree", branch: "reviewer", cwd: REPO },
    client,
    { git },
  );
  assert.equal(dirty.ok, false);
  assert.equal(dirty.error.code, "worktree_dirty");

  const forced = await dispatchZswarm(
    { op: "unworktree", branch: "reviewer", cwd: REPO, force: true },
    client,
    { git },
  );
  assert.equal(forced.ok, true);
  assert.equal(forced.data.wasDirty, true);
  assert.ok(argvFor("remove").args.includes("--force"));
});

test("unworktree needs a target and reports unknown ones", async () => {
  const { git } = gitHarness();
  const { client } = zellijHarness();
  const missing = await dispatchZswarm({ op: "unworktree", cwd: REPO }, client, {
    git,
  });
  assert.equal(missing.error.code, "missing_target");

  const unknown = await dispatchZswarm(
    { op: "unworktree", branch: "nope", cwd: REPO },
    client,
    { git },
  );
  assert.equal(unknown.error.code, "worktree_not_found");
});

test("worktree ops report a directory outside any repo", async () => {
  const git = createGitClient({
    env: {},
    exec: async () => ({ code: 128, stdout: "", stderr: "not a git repository" }),
  });
  const { client } = zellijHarness();
  const res = await dispatchZswarm({ op: "worktrees", cwd: "D:/tmp" }, client, {
    git,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "not_a_repo");
});
