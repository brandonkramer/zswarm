#!/usr/bin/env node
/**
 * Live harness conformance for the zswarm CLI. This is not a unit test: it
 * drives the real CLI against named Zellij panes and prints a matrix of
 * whether `send` claimed submission, whether the reply actually landed, and
 * ok/fail for each read op.
 *
 *   node scripts/harness-check.mjs agent-codex agent-cursor agent-pi
 *
 * The prompt asks for a product, so the token `ZSFIN:` that sits inside the
 * prompt text can never pass for an answer — only a real reply like `ZSFIN:
 * 121` matches. Budgets are generous because replies routinely take more than
 * a minute; the elapsed time per pane is printed so the number is visible.
 * The exit code is non-zero when a pane overclaims (`send` said true, nothing
 * landed), a read op failed, or a pane could not be processed at all.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUDGET_MS = 120_000;
const POLL_MS = 1_000;

const TOKEN = "ZSFIN";
const ANSWER = "121";
const PROMPT = `Reply with only the product of 11 and 11, prefixed by ${TOKEN}: and nothing else.`;
// Tolerant on whitespace and case — never an exact string. The prompt carries
// `ZSFIN:` but no `121`, so this can only match a real answer.
const EXPECTED_REPLY = new RegExp(`${TOKEN}:\\s*${ANSWER}`, "i");
// Never on screen, so the expect guard must refuse the write — the probe body
// never lands. 999 is the one product this prompt can never produce.
const GUARD_EXPECT = `${TOKEN}: 999`;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(repoRoot, "packages", "cli", "dist", "cli.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function usage() {
  return (
    "usage: node scripts/harness-check.mjs <pane> [<pane> ...] [--budget-ms N]\n" +
    "\n" +
    "  Sends a computed-answer prompt to each named Zellij pane, waits up to\n" +
    "  the per-pane budget for the reply, then exercises dump, tail, status,\n" +
    "  and the --expect guard. Prints a conformance matrix.\n" +
    "\n" +
    "  --budget-ms  how long to wait for each reply (default 120000)\n"
  );
}

function parseArgs(argv) {
  const panes = [];
  let budgetMs = BUDGET_MS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--budget-ms") {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`zswarm: --budget-ms needs a positive number, got ${raw}`);
        process.exit(2);
      }
      budgetMs = n;
    } else if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else if (arg.startsWith("-")) {
      console.error(`zswarm: unknown flag ${arg}\n${usage()}`);
      process.exit(2);
    } else {
      panes.push(arg);
    }
  }
  return { panes, budgetMs };
}

/** Run one zswarm CLI invocation and parse its JSON reply. */
function runCli(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      // ZSWARM_BIN / ZSWARM_SESSION / ZELLIJ_SESSION_NAME flow through.
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) =>
      resolve({
        ok: false,
        error: { code: "spawn", message: err.message },
      }),
    );
    child.on("close", () => {
      let reply = null;
      try {
        reply = JSON.parse(stdout);
      } catch {
        reply = null;
      }
      resolve({
        ok: reply?.ok === true,
        data: reply?.data,
        error: reply?.error,
        stderr: stderr.trim(),
      });
    });
  });
}

/**
 * One pane's pass: the expect guard must refuse a bogus probe, then a real
 * computed-answer send, then each read op. Returns the matrix row.
 */
async function checkPane(pane, budgetMs) {
  const row = {
    pane,
    submitted: null,
    landed: null,
    replyMs: null,
    ops: {},
    error: null,
  };

  // A write whose expect text is absent must be refused before anything lands;
  // that is the guard proving it fires live against this pane.
  const guard = await runCli([
    "send",
    "--to",
    pane,
    "--body",
    "guard probe",
    "--expect",
    GUARD_EXPECT,
  ]);
  row.ops.expect =
    !guard.ok && guard.error?.code === "expect_missing" ? "ok" : "fail";
  if (guard.ok) {
    // It let the write through; the probe body may be sitting in the composer.
    row.error = "expect guard let a write through";
  }

  const sent = await runCli(["send", "--to", pane, "--body", PROMPT]);
  if (!sent.ok) {
    row.error =
      row.error ??
      `${sent.error?.code ?? "send"}: ${sent.error?.message ?? (sent.stderr || "CLI failed")}`;
    return row;
  }
  row.submitted = sent.data?.submitted ?? "unverified";

  // Poll the pane's own screen — dump, not wait --match: a full-screen TUI owns
  // the alternate screen, so the reply can drop out of viewport between polls.
  const started = Date.now();
  row.landed = false;
  while (Date.now() - started < budgetMs) {
    const dumped = await runCli(["dump", "--to", pane]);
    if (dumped.ok && EXPECTED_REPLY.test(dumped.data?.text ?? "")) {
      row.landed = true;
      break;
    }
    await sleep(POLL_MS);
  }
  row.replyMs = Date.now() - started;

  const dumped = await runCli(["dump", "--to", pane]);
  row.ops.dump = dumped.ok ? "ok" : "fail";
  const tailed = await runCli(["tail", "--to", pane]);
  row.ops.tail = tailed.ok ? "ok" : "fail";
  const status = await runCli(["status", "--to", pane]);
  row.ops.status = status.ok ? "ok" : "fail";

  return row;
}

/** submitted vs landed: only overclaim is a lie; under and unverified are honest. */
function agree(row) {
  const s = row.submitted;
  if (s === true) return row.landed ? "ok" : "overclaim";
  if (s === false) return row.landed ? "under" : "ok";
  return "n/a";
}

function failed(row) {
  return (
    row.error !== null ||
    (row.submitted === true && row.landed !== true) ||
    Object.values(row.ops).some((v) => v === "fail")
  );
}

function printMatrix(rows) {
  const header = [
    "pane",
    "submitted",
    "landed",
    "agree",
    "dump",
    "tail",
    "status",
    "expect",
    "reply_ms",
  ];
  const cells = rows.map((r) => [
    r.pane,
    r.submitted === null ? "-" : String(r.submitted),
    r.landed === null ? "-" : r.landed ? "yes" : "no",
    agree(r),
    r.ops.dump ?? "-",
    r.ops.tail ?? "-",
    r.ops.status ?? "-",
    r.ops.expect ?? "-",
    r.replyMs === null ? "-" : r.replyMs.toLocaleString(),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...cells.map((c) => c[i].length)),
  );
  const line = (list) => list.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  console.log(line(header));
  for (const row of cells) console.log(line(row));
}

async function main() {
  const { panes, budgetMs } = parseArgs(process.argv.slice(2));
  if (panes.length === 0) {
    console.error(usage());
    process.exit(2);
  }
  if (!existsSync(CLI)) {
    console.error(
      "zswarm: CLI not built — run `pnpm install && pnpm run build` first",
    );
    process.exit(127);
  }

  console.log(
    `harness conformance — ${panes.length} pane(s), ${budgetMs.toLocaleString()}ms budget each`,
  );
  console.log(`prompt: ${JSON.stringify(PROMPT)}`);
  console.log("");

  const rows = [];
  for (const pane of panes) {
    process.stderr.write(`  → ${pane}…\n`);
    rows.push(await checkPane(pane, budgetMs));
  }

  printMatrix(rows);

  const overclaims = rows.filter((r) => r.submitted === true && r.landed !== true);
  const opFails = rows.filter((r) => Object.values(r.ops).includes("fail"));
  const unprocessed = rows.filter((r) => r.error !== null);
  const noReply = rows.filter((r) => r.submitted !== null && r.landed !== true);

  console.log("");
  console.log(
    `overclaim: ${overclaims.length ? overclaims.map((r) => r.pane).join(", ") : "none"}`,
  );
  console.log(
    `op failures: ${opFails.length ? opFails.map((r) => r.pane).join(", ") : "none"}`,
  );
  console.log(
    `unprocessed: ${unprocessed.length ? unprocessed.map((r) => r.pane).join(", ") : "none"}`,
  );
  for (const r of unprocessed) console.log(`  ${r.pane}: ${r.error}`);
  if (noReply.length) {
    console.log(
      `note: ${noReply.map((r) => r.pane).join(", ")} never answered in budget — replies can take over a minute; re-run or extend --budget-ms`,
    );
  }

  console.log(rows.some(failed) ? "result: FAIL — see matrix above" : "result: PASS — all panes conformed");
  process.exit(rows.some(failed) ? 1 : 0);
}

main();
