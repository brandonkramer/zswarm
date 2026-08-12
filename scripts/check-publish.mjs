#!/usr/bin/env node
/**
 * Refuse to publish a package whose `workspace:*` specs have not been rewritten.
 *
 * pnpm replaces them with real version ranges at publish time; npm does not,
 * and would ship a dependency spec no consumer can resolve. Failing loudly here
 * is the difference between a broken release and a caught mistake.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
);
const FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

const unresolved = FIELDS.flatMap((field) =>
  Object.entries(manifest[field] ?? {})
    .filter(([, spec]) => typeof spec === "string" && spec.startsWith("workspace:"))
    .map(([name, spec]) => `  ${field}.${name} = ${spec}`),
);

if (unresolved.length > 0 && !process.env.npm_config_user_agent?.includes("pnpm")) {
  console.error(
    `\n${manifest.name}: workspace specs would ship unrewritten:\n` +
      `${unresolved.join("\n")}\n\n` +
      `Publish with \`pnpm publish\`, which rewrites them.\n`,
  );
  process.exit(1);
}
