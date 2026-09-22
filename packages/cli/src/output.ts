import type { OpsResult } from "@zswarm/core";

/** Human diagnostics stay on stderr; stdout is always one JSON response. */
export function routingNotice(result: OpsResult, interactive: boolean): string {
  const route = result.context;
  if (!interactive || !route) return "";
  // Prevent terminal control characters or newlines in host/session labels.
  const label = (s: string) => JSON.stringify(s);
  const data = result.ok && result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : null;
  const polling = data?.polling as { recommendation?: string } | undefined;
  return `zswarm: ${route.transport} ${label(route.host)}` +
    (route.session ? ` session=${label(route.session)}` : "") +
    ` (via ${route.origin.transport}; session ${route.origin.session})\n` +
    (polling?.recommendation ? `zswarm: ${label(polling.recommendation)}\n` : "");
}
