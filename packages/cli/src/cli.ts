#!/usr/bin/env node
import { dispatchZswarm } from "@zswarm/core";

function usage(): string {
  return `usage: zswarm <list|send|dump|sessions> [options]

  zswarm list [--session NAME]
  zswarm sessions
  zswarm send --to PANE --body TEXT [--from LABEL] [--session NAME] [--raw]
  zswarm dump --to PANE [--session NAME] [--full]

Env: ZSWARM_BIN, ZSWARM_PATH, ZSWARM_SESSION, ZELLIJ_SESSION_NAME
`;
}

function parseArgs(argv: string[]): Record<string, unknown> {
  const [op, ...rest] = argv;
  if (!op || op === "-h" || op === "--help") {
    process.stderr.write(usage());
    process.exit(op ? 0 : 2);
  }
  const out: Record<string, unknown> = { op };
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
    } else if (!a.startsWith("-") && !out.to && (op === "send" || op === "dump")) {
      out.to = a;
    } else if (!a.startsWith("-") && !out.body && op === "send") {
      out.body = a;
    } else {
      process.stderr.write(`unknown arg: ${a}\n${usage()}`);
      process.exit(2);
    }
  }
  return out;
}

const result = await dispatchZswarm(parseArgs(process.argv.slice(2)));
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
