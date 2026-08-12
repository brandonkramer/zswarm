import {
  createZellijClient,
  ZellijError,
  type ZellijClient,
} from "./zellij.js";

export type OpsResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

function fail(err: unknown): OpsResult {
  if (err instanceof ZellijError) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: "failed", message } };
}

function paneView(p: {
  id: string;
  title: string;
  command?: string | null;
  cwd?: string | null;
  tabName?: string | null;
  focused: boolean;
  exited: boolean;
  floating: boolean;
}) {
  return {
    id: p.id,
    title: p.title,
    command: p.command,
    cwd: p.cwd,
    tab: p.tabName,
    focused: p.focused,
    exited: p.exited,
    floating: p.floating,
  };
}

/** Shared MCP/CLI dispatch for zswarm ops. */
export async function dispatchZswarm(
  args: Record<string, unknown>,
  client: ZellijClient = createZellijClient(),
): Promise<OpsResult> {
  const op = String(args.op ?? "");
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
        const panes = (await client.listPanes(session))
          .filter((p) => !p.isPlugin)
          .map(paneView)
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
        return {
          ok: true,
          data: {
            delivery: "zellij_paste",
            session: delivered.session,
            to: delivered.paneId,
            from,
            pane: paneView(pane),
          },
        };
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
        return {
          ok: true,
          data: {
            session: dumped.session,
            to: dumped.paneId,
            text: dumped.text,
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
