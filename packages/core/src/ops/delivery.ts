import type { StateStore } from "../state.js";
import type { ZellijClient } from "../zellij/client.js";
import type { ZellijPane } from "../zellij/panes.js";
import type { Clock } from "./types.js";
import { isTrue, numberArg } from "./util.js";

export type Submitted = boolean | "unverified";

export type DeliveryResult = {
  to: string;
  ok: boolean;
  delivery?: string;
  submitted?: Submitted;
  error?: { code: string; message: string };
};

export type SubmitMode = "auto" | "double-enter" | "none";

/** Cursor / Claude leave this in scrollback after a successful submit. */
const PASTE_MARKER = "[Pasted text";

export function senderLabel(args: Record<string, unknown>): string {
  return (typeof args.from === "string" && args.from.trim()) || "swarm";
}

export function bodyText(
  client: ZellijClient,
  args: Record<string, unknown>,
  body: string,
): string {
  return isTrue(args.raw) ? body : client.formatPeerMessage(senderLabel(args), body);
}

function submitMode(args: Record<string, unknown>): SubmitMode {
  const raw = args.submit;
  if (raw === "none" || raw === "double-enter" || raw === "auto") return raw;
  return "auto";
}

function nonEmptyLines(screen: string): string[] {
  return screen
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
}

function isPasteLine(line: string, needle: string): boolean {
  if (line.includes(PASTE_MARKER)) return true;
  return needle.length > 0 && line.includes(needle);
}

/**
 * Compare the pane before vs after the paste. `true` only when new output
 * appeared below the paste; `[Pasted text` in scrollback is not evidence.
 */
export function classifySubmit(
  before: string,
  after: string,
  body: string,
): Submitted {
  const needle = body.slice(0, 40);
  const beforeLines = nonEmptyLines(before);
  const afterLines = nonEmptyLines(after);
  const beforeNorm = beforeLines.join("\n");
  const afterNorm = afterLines.join("\n");
  const last3 = afterLines.slice(-3);
  const last = afterLines[afterLines.length - 1] ?? "";
  const markerInLastLine = last.includes(PASTE_MARKER);
  const bodyInLastRegion =
    needle.length > 0 && last3.some((line) => line.includes(needle));

  if (afterNorm === beforeNorm) {
    // Marker may only count when it sits in the last-line region *and*
    // nothing else moved — leftover scrollback must not flip the answer.
    if (markerInLastLine) return false;
    return "unverified";
  }

  const withoutPaste = afterLines.filter((line) => !isPasteLine(line, needle));
  if (withoutPaste.join("\n") === beforeNorm) {
    if (bodyInLastRegion || markerInLastLine) return false;
    return "unverified";
  }

  const lastPasteIdx = afterLines.reduce(
    (found, line, i) => (isPasteLine(line, needle) ? i : found),
    -1,
  );
  if (lastPasteIdx < 0) return "unverified";

  const belowNovel = afterLines
    .slice(lastPasteIdx + 1)
    .filter((line) => !isPasteLine(line, needle))
    .filter((line) => !beforeLines.includes(line));
  return belowNovel.length > 0 ? true : "unverified";
}

async function verifySubmit(
  client: ZellijClient,
  input: {
    session: string;
    paneId: string;
    body: string;
    mode: SubmitMode;
    settleMs: number;
    clock: Clock;
    before: string | null;
  },
): Promise<Submitted> {
  const { session, paneId, body, mode, settleMs, clock, before } = input;

  if (mode === "none") return "unverified";

  if (mode === "double-enter") {
    await clock.sleep(settleMs);
    await client.sendKeys({ session, paneId, keys: ["Enter"] });
    return "unverified";
  }

  if (before === null) return "unverified";

  await clock.sleep(settleMs);
  let after: string;
  try {
    after = (await client.dumpPane({ session, paneId })).text;
  } catch {
    return "unverified";
  }
  const first = classifySubmit(before, after, body);
  if (first !== false) return first;

  await client.sendKeys({ session, paneId, keys: ["Enter"] });
  await clock.sleep(settleMs);
  try {
    after = (await client.dumpPane({ session, paneId })).text;
  } catch {
    return "unverified";
  }
  return classifySubmit(before, after, body);
}

/** Paste a body into one pane and record the attempt. */
export async function deliverTo(
  client: ZellijClient,
  state: StateStore,
  args: Record<string, unknown>,
  input: {
    session: string;
    pane: ZellijPane;
    body: string;
    op: string;
    at: number;
    clock: Clock;
  },
): Promise<DeliveryResult> {
  const { session, pane, body, op, at, clock } = input;
  const from = senderLabel(args);
  const mode = submitMode(args);
  const settleMs = numberArg(args, "settleMs", 300, { min: 50, max: 5000 });
  try {
    let before: string | null = null;
    if (mode === "auto") {
      try {
        before = (await client.dumpPane({ session, paneId: pane.id })).text;
      } catch {
        before = null;
      }
    }
    const delivered = await client.injectPane({
      session,
      paneId: pane.id,
      text: bodyText(client, args, body),
    });
    const submitted = await verifySubmit(client, {
      session,
      paneId: delivered.paneId,
      body,
      mode,
      settleMs,
      clock,
      before,
    });
    state.appendLog({
      at,
      op,
      session,
      to: delivered.paneId,
      from,
      bytes: body.length,
      ok: true,
      detail: `submitted=${submitted}`,
    });
    return {
      to: delivered.paneId,
      ok: true,
      delivery: "zellij_paste",
      submitted,
    };
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "failed";
    const message = err instanceof Error ? err.message : String(err);
    state.appendLog({
      at,
      op,
      session,
      to: pane.id,
      from,
      bytes: body.length,
      ok: false,
      detail: `${code}: ${message}`,
    });
    return { to: pane.id, ok: false, error: { code, message } };
  }
}
