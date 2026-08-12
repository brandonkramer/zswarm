import {
  createZellijClient,
  ZellijError,
  type ZellijClient,
  type ZellijPane,
} from "./zellij.js";

export type OpsResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

/** Default dump text budget (characters). Override with max=; max=0 disables. */
export const DEFAULT_DUMP_MAX_CHARS = 8_000;

function fail(err: unknown): OpsResult {
  if (err instanceof ZellijError) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: "failed", message } };
}

function isVerbose(args: Record<string, unknown>): boolean {
  return args.verbose === true || args.verbose === "true";
}

function paneViewSlim(p: ZellijPane) {
  return {
    id: p.id,
    title: p.title,
    command: p.command ?? null,
    tab: p.tabName ?? null,
  };
}

function paneViewFull(p: ZellijPane) {
  return {
    ...paneViewSlim(p),
    cwd: p.cwd ?? null,
    focused: p.focused,
    exited: p.exited,
    floating: p.floating,
  };
}

/** Truncate dump text; default keeps the tail (recent output). */
export function truncateDumpText(
  text: string,
  maxChars: number,
  keep: "tail" | "head" = "tail",
): { text: string; truncated: boolean; chars: number } {
  const chars = text.length;
  if (maxChars <= 0 || chars <= maxChars) {
    return { text, truncated: false, chars };
  }
  if (keep === "head") {
    return { text: text.slice(0, maxChars), truncated: true, chars };
  }
  return { text: text.slice(chars - maxChars), truncated: true, chars };
}

function dumpMaxChars(args: Record<string, unknown>): number {
  if (args.max === undefined || args.max === null || args.max === "") {
    return DEFAULT_DUMP_MAX_CHARS;
  }
  const n = Number(args.max);
  if (!Number.isFinite(n) || n < 0) {
    throw new ZellijError("bad_max", "max must be a non-negative number");
  }
  return Math.floor(n);
}

/** Shared MCP/CLI dispatch for zswarm ops. */
export async function dispatchZswarm(
  args: Record<string, unknown>,
  client: ZellijClient = createZellijClient(),
): Promise<OpsResult> {
  const op = String(args.op ?? "");
  const verbose = isVerbose(args);
  try {
    switch (op) {
      case "sessions": {
        const sessions = await client.listSessions();
        return {
          ok: true,
          data: { sessions, zellij: client.zellijPath },
        };
      }
      case "list": {
        const { session } = await client.resolveSession(
          typeof args.session === "string" ? args.session : undefined,
        );
        const view = verbose ? paneViewFull : paneViewSlim;
        const panes = (await client.listPanes(session))
          .filter((p) => !p.isPlugin)
          .map(view)
          .sort((a, b) => a.id.localeCompare(b.id));
        return { ok: true, data: { session, panes } };
      }
      case "send": {
        const to = String(args.to ?? "").trim();
        const body = String(args.body ?? args.text ?? "");
        if (!to) throw new ZellijError("missing_peer", "to required");
        if (!body.trim()) throw new ZellijError("missing_body", "body required");
        const { session } = await client.resolveSession(
          typeof args.session === "string" ? args.session : undefined,
        );
        const panes = await client.listPanes(session);
        const pane = client.resolvePane(panes, to);
        const from =
          (typeof args.from === "string" && args.from.trim()) || "swarm";
        const text =
          args.raw === true ? body : client.formatPeerMessage(from, body);
        const delivered = await client.injectPane({
          session,
          paneId: pane.id,
          text,
        });
        const data: Record<string, unknown> = {
          delivery: "zellij_paste",
          session: delivered.session,
          to: delivered.paneId,
          from,
        };
        if (verbose) data.pane = paneViewFull(pane);
        return { ok: true, data };
      }
      case "dump": {
        const to = String(args.to ?? "").trim();
        if (!to) throw new ZellijError("missing_peer", "to required");
        const { session } = await client.resolveSession(
          typeof args.session === "string" ? args.session : undefined,
        );
        const panes = await client.listPanes(session);
        const pane = client.resolvePane(panes, to);
        const dumped = await client.dumpPane({
          session,
          paneId: pane.id,
          full: args.full === true,
        });
        const max = dumpMaxChars(args);
        const keep = args.head === true || args.head === "true" ? "head" : "tail";
        const clipped = truncateDumpText(dumped.text, max, keep);
        return {
          ok: true,
          data: {
            session: dumped.session,
            to: dumped.paneId,
            text: clipped.text,
            truncated: clipped.truncated,
            chars: clipped.chars,
            max,
          },
        };
      }
      default:
        throw new ZellijError(
          "usage",
          "zswarm requires op=list|send|dump|sessions",
        );
    }
  } catch (err) {
    return fail(err);
  }
}
