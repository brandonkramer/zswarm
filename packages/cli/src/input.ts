import { readFile } from "node:fs/promises";
import { ZellijError } from "@zswarm/core";

/** Local CLI preprocessing. File paths never cross SSH or the serve protocol. */
export async function readBodyFile(
  args: Record<string, unknown>,
  stdin: AsyncIterable<Uint8Array | string> = process.stdin,
): Promise<Record<string, unknown>> {
  if (args.bodyFile === undefined) return args;
  if (args.op !== "send" || args.body !== undefined || args.text !== undefined) {
    throw new ZellijError("usage", "--body-file requires send and cannot be combined with another body source");
  }
  const path = String(args.bodyFile);
  let body: string;
  try {
    if (path === "-") {
      const chunks: Buffer[] = [];
      for await (const chunk of stdin) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
      }
      body = Buffer.concat(chunks).toString("utf8");
    } else {
      body = await readFile(path, "utf8");
    }
  } catch (err) {
    throw new ZellijError("body_file_read", `cannot read body from ${JSON.stringify(path)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const out: Record<string, unknown> = { ...args, body };
  delete out.bodyFile;
  return out;
}
