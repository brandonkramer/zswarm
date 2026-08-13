#!/usr/bin/env node
import {
  ZellijError,
  cliUsage,
  dispatchZswarm,
  parseCliArgv,
  serveChildEnv,
  startServe,
} from "@zswarm/core";

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

// TCP server holds the event loop; process.exit would tear it down.
if (args.op === "serve" && args.install !== true && args.clear !== true) {
  const listen = typeof args.listen === "string" ? args.listen : undefined;
  try {
    const { label } = await startServe(listen, (request) =>
      dispatchZswarm(request, undefined, { env: serveChildEnv(process.env) }),
    );
    process.stdout.write(
      `${JSON.stringify({ ok: true, data: { listening: label } }, null, 2)}\n`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "failed", message } }, null, 2)}\n`,
    );
    process.exit(1);
  }
} else {
  const result = await dispatchZswarm(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}
