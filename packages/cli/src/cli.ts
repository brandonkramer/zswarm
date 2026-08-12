#!/usr/bin/env node
import { ZellijError, cliUsage, dispatchZswarm, parseCliArgv } from "@zswarm/core";

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
  process.stderr.write(cliUsage());
  process.exit(argv.length === 0 ? 2 : 0);
}

let args: Record<string, unknown>;
try {
  args = parseCliArgv(argv);
} catch (err) {
  const message = err instanceof ZellijError ? err.message : String(err);
  process.stderr.write(`${message}\n${cliUsage()}`);
  process.exit(2);
}

const result = await dispatchZswarm(args);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
