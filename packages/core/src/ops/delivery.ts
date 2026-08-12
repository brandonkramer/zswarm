import { resolveHarness } from "../harness.js";
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

/**
 * Caller `submit=` always wins. With none given, the pane's harness picks
 * auto vs double-enter (codex needs two Enters; the rest submit on one).
 */
export function resolveSubmitMode(
  args: Record<string, unknown>,
  pane: { command?: string | null; title?: string | null },
): SubmitMode {
  const raw = args.submit;
  if (raw === "none" || raw === "double-enter" || raw === "auto") return raw;
  if (raw !== undefined && raw !== null && raw !== "") return "auto";
  return resolveHarness(pane).submit;
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

/** True when the paste still sits in the composer (bottom of the screen). */
export function composerHolds(screen: string, body: string): boolean {
  const needle = body.slice(0, 40);
  const lines = nonEmptyLines(screen);
  const last3 = lines.slice(-3);
  const last = lines[lines.length - 1] ?? "";
  if (last.includes(PASTE_MARKER)) return true;
  return needle.length > 0 && last3.some((line) => line.includes(needle));
}

/**
 * Compare the pane before vs after the paste.
 * Composer clearing (pasted text left the bottom input region) is submission.
 * `[Pasted text` in scrollback is not evidence.
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
  const holds = bodyInLastRegion || markerInLastLine;

  if (afterNorm === beforeNorm) {
    // Marker may only count when it sits in the last-line region *and*
    // nothing else moved — leftover scrollback must not flip the answer.
    if (markerInLastLine) return false;
    return "unverified";
  }

  if (holds) {
    const withoutPaste = afterLines.filter((line) => !isPasteLine(line, needle));
    if (withoutPaste.join("\n") === beforeNorm) return false;
    const lastPasteIdx = afterLines.reduce(
      (found, line, i) => (isPasteLine(line, needle) ? i : found),
      -1,
    );
    const belowNovel = afterLines
      .slice(lastPasteIdx + 1)
      .filter((line) => !isPasteLine(line, needle))
      .filter((line) => !beforeLines.includes(line));
    return belowNovel.length > 0 ? true : false;
  }

  // Paste left the input region: still on screen, just not at the bottom.
  if (needle.length > 0 && afterLines.some((line) => line.includes(needle))) {
    return true;
  }
  return "unverified";
}

async function dumpOrNull(
  client: ZellijClient,
  session: string,
  paneId: string,
): Promise<string | null> {
  try {
    return (await client.dumpPane({ session, paneId })).text;
  } catch {
    return null;
  }
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
  const after = await dumpOrNull(client, session, paneId);
  if (after === null) return "unverified";
  let verdict = classifySubmit(before, after, body);
  if (verdict === true) return true;

  if (verdict === false) {
    await client.sendKeys({ session, paneId, keys: ["Enter"] });
    await clock.sleep(settleMs);
    const rescued = await dumpOrNull(client, session, paneId);
    if (rescued === null) return "unverified";
    verdict = classifySubmit(before, rescued, body);
    if (verdict === true) return true;
    if (verdict === false) return false;
  }

  // First look was inconclusive; TUIs often redraw after the first settle.
  await clock.sleep(Math.min(Math.max(settleMs * 2, 800), 5000));
  const later = await dumpOrNull(client, session, paneId);
  if (later === null) return "unverified";
  if (composerHolds(after, body) && !composerHolds(later, body)) return true;
  return classifySubmit(before, later, body);
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
  const mode = resolveSubmitMode(args, pane);
  const settleMs = numberArg(args, "settleMs", 300, { min: 50, max: 5000 });
  try {
    let before: string | null = null;
    if (mode === "auto") {
      before = await dumpOrNull(client, session, pane.id);
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
