import type { StateStore } from "../state.js";
import type { ZellijClient } from "../zellij/client.js";
import type { ZellijPane } from "../zellij/panes.js";
import { isTrue } from "./util.js";

export type DeliveryResult = {
  to: string;
  ok: boolean;
  delivery?: string;
  error?: { code: string; message: string };
};

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

/** Paste a body into one pane and record the attempt. */
export async function deliverTo(
  client: ZellijClient,
  state: StateStore,
  args: Record<string, unknown>,
  input: { session: string; pane: ZellijPane; body: string; op: string; at: number },
): Promise<DeliveryResult> {
  const { session, pane, body, op, at } = input;
  const from = senderLabel(args);
  try {
    const delivered = await client.injectPane({
      session,
      paneId: pane.id,
      text: bodyText(client, args, body),
    });
    state.appendLog({
      at,
      op,
      session,
      to: delivered.paneId,
      from,
      bytes: body.length,
      ok: true,
    });
    return { to: delivered.paneId, ok: true, delivery: "zellij_paste" };
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
