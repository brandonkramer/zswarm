import { hostname } from "node:os";
import type { ZellijTransport } from "../zellij/client.js";
import { sessionFromEnv } from "../zellij/session.js";
import { describeServeTarget } from "./serve-tunnel.js";
import { isTrue, optionalString } from "./util.js";

export type RoutingContext = {
  transport: "local" | "ssh" | "serve";
  host: string;
  session: string | null;
  origin: { transport: string; session: string };
  /** The serve endpoint can be a local tunnel; this identifies its server. */
  server?: RoutingContext;
};

export function invocationContext(
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  injected?: ZellijTransport,
): RoutingContext {
  const serve = optionalString(env.ZSWARM_SERVE);
  const ssh = optionalString(env.ZSWARM_SSH);
  // Serve forwards explicit arguments; inherited session defaults belong to
  // the server, not the caller (which might only be a local tunnel).
  const selected = sessionFromEnv(serve && !injected ? {} : env, optionalString(args.session));
  return {
    transport: injected?.kind ?? (serve ? "serve" : ssh ? "ssh" : "local"),
    host: injected ? injected.host ?? hostname() : serve ? describeServeTarget(serve) : ssh ?? hostname(),
    session: selected?.session ?? null,
    origin: {
      transport: injected ? "injected" : isTrue(args.local) ? "--local"
        : optionalString(args.ssh) ? "--ssh" : optionalString(args.serveAddress) ? "--serve" : serve ? "ZSWARM_SERVE"
        : ssh ? "ZSWARM_SSH" : "default",
      session: selected?.source ?? "unresolved",
    },
  };
}
