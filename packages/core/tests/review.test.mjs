import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitClient } from "../dist/index.js";
import { peerCheckpoint, peerDiff } from "../dist/ops/review.js";

const REPO = "D:/repo/demo";
const REVIEWER = "D:/repo/demo-worktrees/reviewer";

const PORCELAIN = [
  `worktree ${REPO}`,
  "HEAD aaaa",
  "branch refs/heads/master",
  "",
  `worktree ${REVIEWER}`,
  "HEAD bbbb",
  "branch refs/heads/reviewer",
  "",
].join("\n");

const STAT = " src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n";
const PATCH = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

function fakeClock(start = Date.parse("2026-08-12T15:00:00.000Z")) {
  return { now: () => start, sleep: async () => {} };
}

/** Git client over a scripted exec, recording every argv it is asked to run. */
function gitHarness({
  porcelain = PORCELAIN,
  dirty = " M src/a.ts\n",
  stat = STAT,
  patch = PATCH,
  sha = "abc1234",
} = {}) {
  const calls = [];
  const git = createGitClient({
    env: {},
    exec: async (args, opts) => {
      calls.push({ args: [...args], cwd: opts.cwd });
      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
        return { code: 0, stdout: `${REPO}\n`, stderr: "" };
      }
      if (args[0] === "rev-parse" && args.includes("--short")) {
        return { code: 0, stdout: `${sha}\n`, stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return { code: 0, stdout: porcelain, stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stdout: dirty, stderr: "" };
      }
      if (args[0] === "add") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "diff" && args.includes("--stat")) {
        return { code: 0, stdout: stat, stderr: "" };
      }
      if (args[0] === "diff") {
        return { code: 0, stdout: patch, stderr: "" };
      }
      if (args[0] === "commit") {
        return { code: 0, stdout: `[reviewer ${sha}] checkpoint\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return {
    git,
    calls,
    argvFor: (predicate) => calls.find((c) => predicate(c.args)),
    allArgv: (predicate) => calls.filter((c) => predicate(c.args)),
  };
}

test("peerDiff by path runs intent-to-add then diff against HEAD", async () => {
  const { git, calls } = gitHarness();
  const res = await peerDiff(git, { path: REVIEWER });
  assert.equal(res.ok, true);
  assert.equal(res.data.path, REVIEWER);
  assert.equal(res.data.branch, "reviewer");
  assert.equal(res.data.stat, STAT);
  assert.equal(res.data.patch, PATCH);
  assert.equal(res.data.truncated, false);
  assert.equal(res.data.chars, PATCH.length);

  const intent = calls.find(
    (c) =>
      c.args[0] === "add" &&
      c.args.includes("-A") &&
      c.args.includes("--intent-to-add"),
  );
  assert.ok(intent);
  assert.equal(intent.cwd, REVIEWER);
  assert.ok(
    calls.some(
      (c) =>
        c.cwd === REVIEWER &&
        c.args[0] === "diff" &&
        c.args.includes("--stat") &&
        c.args.includes("HEAD"),
    ),
  );
  assert.ok(
    calls.some(
      (c) =>
        c.cwd === REVIEWER &&
        c.args[0] === "diff" &&
        c.args.includes("HEAD") &&
        !c.args.includes("--stat"),
    ),
  );
});

test("peerDiff by branch resolves the worktree from porcelain", async () => {
  const { git, calls } = gitHarness();
  const res = await peerDiff(git, { branch: "reviewer", cwd: REPO });
  assert.equal(res.ok, true);
  assert.equal(res.data.path, REVIEWER);
  assert.equal(res.data.branch, "reviewer");
  assert.ok(
    calls.some(
      (c) => c.args[0] === "worktree" && c.args[1] === "list" && c.cwd === REPO,
    ),
  );
  assert.ok(calls.some((c) => c.cwd === REVIEWER && c.args[0] === "diff"));
});

test("peerDiff stat-only skips the full patch", async () => {
  const { git, calls } = gitHarness();
  const res = await peerDiff(git, { path: REVIEWER, stat: true });
  assert.equal(res.ok, true);
  assert.equal(res.data.stat, STAT);
  assert.equal(res.data.patch, "");
  assert.equal(res.data.truncated, false);
  assert.equal(res.data.chars, 0);
  assert.equal(
    calls.filter((c) => c.args[0] === "diff" && !c.args.includes("--stat"))
      .length,
    0,
  );
});

test("peerDiff truncates a long patch at max", async () => {
  const longPatch = "x".repeat(100);
  const { git } = gitHarness({ patch: longPatch });
  const res = await peerDiff(git, { path: REVIEWER, max: 40 });
  assert.equal(res.ok, true);
  assert.equal(res.data.truncated, true);
  assert.equal(res.data.patch, "x".repeat(40));
  assert.equal(res.data.chars, 100);
});

test("peerCheckpoint commits a dirty tree", async () => {
  const { git, calls } = gitHarness({ dirty: " M src/a.ts\n", sha: "def5678" });
  const clock = fakeClock();
  const res = await peerCheckpoint(
    git,
    { path: REVIEWER, message: "save work" },
    clock,
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, {
    path: REVIEWER,
    branch: "reviewer",
    sha: "def5678",
    committed: true,
    nothingToCommit: false,
  });
  assert.ok(
    calls.some(
      (c) =>
        c.cwd === REVIEWER &&
        c.args[0] === "add" &&
        c.args.includes("-A") &&
        !c.args.includes("--intent-to-add"),
    ),
  );
  assert.deepEqual(
    calls.find((c) => c.args[0] === "commit")?.args,
    ["commit", "-m", "save work"],
  );
  assert.ok(
    calls.some(
      (c) =>
        c.args[0] === "rev-parse" &&
        c.args.includes("--short") &&
        c.cwd === REVIEWER,
    ),
  );
});

test("peerCheckpoint on a clean tree is not an error", async () => {
  const { git, calls } = gitHarness({ dirty: "", sha: "bbbbbbb" });
  const clock = fakeClock();
  const res = await peerCheckpoint(git, { branch: "reviewer", cwd: REPO }, clock);
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, {
    path: REVIEWER,
    branch: "reviewer",
    sha: "bbbbbbb",
    committed: false,
    nothingToCommit: true,
  });
  assert.equal(calls.some((c) => c.args[0] === "commit"), false);
  // Default message unused when clean, but head sha still read.
  assert.ok(calls.some((c) => c.args[0] === "rev-parse" && c.args.includes("--short")));
});

test("peerDiff unknown branch fails with worktree_not_found", async () => {
  const { git } = gitHarness();
  await assert.rejects(
    () => peerDiff(git, { branch: "nope", cwd: REPO }),
    (err) => err.code === "worktree_not_found",
  );
});
