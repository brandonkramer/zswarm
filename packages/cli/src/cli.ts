#!/usr/bin/env node
import { dispatchZswarm } from "@zswarm/core";

function usage(): string {
  return `usage: zswarm <list|send|dump|wait|keys|interrupt|spawn|close|sessions> [options]

  zswarm list [--session NAME] [--verbose]
  zswarm sessions
  zswarm send --to PANE --body TEXT [--from LABEL] [--session NAME] [--raw] [--verbose]
  zswarm dump --to PANE [--session NAME] [--full] [--max N] [--head]
  zswarm wait --to PANE [--for idle|match|either] [--match TEXT] [--regex] [--ignore-case]
               [--idle-ms N] [--poll-ms N] [--timeout-ms N] [--max N] [--full]
  zswarm keys --to PANE --key "Ctrl c" [--key Esc] | --chars TEXT [--enter]
  zswarm interrupt --to PANE [--hard]
  zswarm spawn [--command "claude --model opus"] [--cwd DIR] [--name NAME]
               [--direction right|left|up|down] [--floating] [--tab] [--layout NAME]
               [--close-on-exit] [--verbose]
  zswarm close --to PANE

Guards: writes refuse zswarm's own pane (--allow-self) and exited panes (--force).
Env: ZSWARM_BIN, ZSWARM_PATH, ZSWARM_SESSION, ZSWARM_SELF_PANE, ZELLIJ_SESSION_NAME
`;
}

function parseArgs(argv: string[]): Record<string, unknown> {
  const [op, ...rest] = argv;
  if (!op || op === "-h" || op === "--help") {
    process.stderr.write(usage());
    process.exit(op ? 0 : 2);
  }
  const out: Record<string, unknown> = { op };
  const keys: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--session" || a === "-s") {
      out.session = rest[++i];
    } else if (a === "--to" || a === "-t") {
      out.to = rest[++i];
    } else if (a === "--body" || a === "-b" || a === "--text") {
      out.body = rest[++i];
    } else if (a === "--from" || a === "-f") {
      out.from = rest[++i];
    } else if (a === "--raw") {
      out.raw = true;
    } else if (a === "--full") {
      out.full = true;
    } else if (a === "--verbose" || a === "-v") {
      out.verbose = true;
    } else if (a === "--head") {
      out.head = true;
    } else if (a === "--max") {
      out.max = Number(rest[++i]);
    } else if (a === "--for") {
      out.for = rest[++i];
    } else if (a === "--match" || a === "-m") {
      out.match = rest[++i];
    } else if (a === "--regex") {
      out.regex = true;
    } else if (a === "--ignore-case") {
      out.ignoreCase = true;
    } else if (a === "--idle-ms") {
      out.idleMs = Number(rest[++i]);
    } else if (a === "--poll-ms") {
      out.pollMs = Number(rest[++i]);
    } else if (a === "--timeout-ms") {
      out.timeoutMs = Number(rest[++i]);
    } else if (a === "--key" || a === "--keys" || a === "-k") {
      keys.push(String(rest[++i]));
    } else if (a === "--chars") {
      out.chars = rest[++i];
    } else if (a === "--enter") {
      out.enter = true;
    } else if (a === "--hard") {
      out.hard = true;
    } else if (a === "--command" || a === "--cmd" || a === "-c") {
      out.command = rest[++i];
    } else if (a === "--cwd") {
      out.cwd = rest[++i];
    } else if (a === "--name" || a === "-n") {
      out.name = rest[++i];
    } else if (a === "--direction" || a === "-d") {
      out.direction = rest[++i];
    } else if (a === "--floating") {
      out.floating = true;
    } else if (a === "--tab") {
      out.tab = true;
    } else if (a === "--layout" || a === "-l") {
      out.layout = rest[++i];
    } else if (a === "--close-on-exit") {
      out.closeOnExit = true;
    } else if (a === "--allow-self") {
      out.allowSelf = true;
    } else if (a === "--force") {
      out.force = true;
    } else if (
      !a.startsWith("-") &&
      !out.to &&
      (op === "send" ||
        op === "dump" ||
        op === "wait" ||
        op === "keys" ||
        op === "interrupt" ||
        op === "close")
    ) {
      out.to = a;
    } else if (!a.startsWith("-") && !out.body && op === "send") {
      out.body = a;
    } else {
      process.stderr.write(`unknown arg: ${a}\n${usage()}`);
      process.exit(2);
    }
  }
  if (keys.length > 0) out.keys = keys;
  return out;
}

const result = await dispatchZswarm(parseArgs(process.argv.slice(2)));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
