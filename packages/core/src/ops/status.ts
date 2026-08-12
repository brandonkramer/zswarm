import type { ZellijClient } from "../zellij/client.js";
import type { ZellijPane } from "../zellij/panes.js";
import type { Clock, OpsResult } from "./types.js";
import { isTrue, normalizeScreen, numberArg, optionalString } from "./util.js";

/** `running` only appears when sampling is off — busy and idle are indistinguishable then. */
export type PeerState = "busy" | "waiting" | "idle" | "exited" | "running";

/** Pane list already in hand, so status does not re-fetch what the caller has. */
export type StatusSource = {
  session: string;
  panes: ZellijPane[];
  source: "plugin" | "zellij";
};

/** Lines that mean the pane wants an answer rather than more time. */
const QUESTION =
  /(\(y\/n\)|\[y\/n\]|\(yes\/no\)|press\s+enter|continue\?|proceed\?|overwrite\?|\bcontinue\b\s*\(|password:|passphrase:|\[y\/n\/a\]|confirm)/i;

export function lastLine(screen: string): string {
  const lines = screen.split("\n").filter((l) => l.trim());
  return lines.length > 0 ? lines[lines.length - 1]!.trim() : "";
}

export function classify(input: {
  exited: boolean;
  before: string;
  after: string;
}): PeerState {
  if (input.exited) return "exited";
  if (input.before !== input.after) return "busy";
  return QUESTION.test(lastLine(input.after)) ? "waiting" : "idle";
}

/**
 * Sample every pane twice and say who is working, who is stuck on a prompt,
 * and who is free — the routing question `list` cannot answer.
 */
export async function peerStatus(
  client: ZellijClient,
  args: Record<string, unknown>,
  clock: Clock,
  supplied?: StatusSource | null,
): Promise<OpsResult> {
  const session =
    supplied?.session ??
    (
      await client.resolveSession(
        typeof args.session === "string" ? args.session : undefined,
      )
    ).session;
  const panes = supplied?.panes ?? (await client.listPanes(session));
  const source = supplied?.source ?? "zellij";
  const only = optionalString(args.to);
  const targets: ZellijPane[] = only
    ? [client.resolvePane(panes, only)]
    : panes.filter((p) => !p.isPlugin);

  // sampleMs=0 asks for the cheap answer: who is alive, from state the plugin
  // already holds. Below that, two samples too close together read as idle.
  const requested = numberArg(args, "sampleMs", 400, { min: 0, max: 10_000 });
  if (requested === 0) {
    const peers = targets
      .map((pane) => {
        const entry: Record<string, unknown> = {
          id: pane.id,
          title: pane.title,
          state: pane.exited ? "exited" : "running",
        };
        if (isTrue(args.verbose)) {
          entry.command = pane.command ?? null;
          entry.cwd = pane.cwd ?? null;
          entry.tab = pane.tabName ?? null;
        }
        return entry;
      })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    // No `free`: without sampling there is no way to tell busy from idle.
    return {
      ok: true,
      data: { session, source, sampled: false, sampleMs: 0, peers },
    };
  }
  const sampleMs = Math.max(50, requested);
  const before = new Map<string, string>();
  for (const pane of targets) {
    if (pane.exited) continue;
    const dumped = await client.dumpPane({ session, paneId: pane.id });
    before.set(pane.id, normalizeScreen(dumped.text));
  }
  await clock.sleep(sampleMs);

  const peers = [];
  for (const pane of targets) {
    const first = before.get(pane.id) ?? "";
    const after = pane.exited
      ? first
      : normalizeScreen(
          (await client.dumpPane({ session, paneId: pane.id })).text,
        );
    const state = classify({ exited: pane.exited, before: first, after });
    const entry: Record<string, unknown> = {
      id: pane.id,
      title: pane.title,
      state,
      lastLine: lastLine(after).slice(0, 160),
    };
    if (isTrue(args.verbose)) {
      entry.command = pane.command ?? null;
      entry.cwd = pane.cwd ?? null;
      entry.tab = pane.tabName ?? null;
    }
    peers.push(entry);
  }

  peers.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const free = peers.filter((p) => p.state === "idle").map((p) => p.id);
  return {
    ok: true,
    data: { session, source, sampled: true, sampleMs, peers, free },
  };
}
