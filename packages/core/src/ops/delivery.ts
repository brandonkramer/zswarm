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

/** True when the composer still looks like it is holding our paste. */
function looksQueued(screen: string, body: string): boolean {
  if (screen.includes("[Pasted text")) return true;
  const needle = body.slice(0, 40);
  if (!needle) return false;
  const lines = screen
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const last3 = lines.slice(-3);
  return last3.some((line) => line.includes(needle));
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
  },
): Promise<Submitted> {
  const { session, paneId, body, mode, settleMs, clock } = input;

  if (mode === "none") return "unverified";

  if (mode === "double-enter") {
    await clock.sleep(settleMs);
    await client.sendKeys({ session, paneId, keys: ["Enter"] });
    return "unverified";
  }

  // auto
  await clock.sleep(settleMs);
  let screen: string;
  try {
    screen = (await client.dumpPane({ session, paneId })).text;
  } catch {
    return "unverified";
  }
  if (!looksQueued(screen, body)) return true;

  await client.sendKeys({ session, paneId, keys: ["Enter"] });
  await clock.sleep(settleMs);
  try {
    screen = (await client.dumpPane({ session, paneId })).text;
  } catch {
    return "unverified";
  }
  return !looksQueued(screen, body);
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
