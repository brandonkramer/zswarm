import { ZellijError } from "../errors.js";
import type { ZellijClient } from "../zellij/client.js";
import type { ZellijPane } from "../zellij/panes.js";
import { isTrue } from "./util.js";

export function assertNotPlugin(pane: ZellijPane, action: string): void {
  if (pane.isPlugin) {
    throw new ZellijError(
      "pane_is_plugin",
      `${pane.id} is a plugin pane; ${action} targets terminal panes`,
    );
  }
}

export function assertNotSelf(
  client: ZellijClient,
  pane: ZellijPane,
  args: Record<string, unknown>,
  action: string,
): void {
  const self = client.selfPaneId;
  if (self && pane.id === self && !isTrue(args.allowSelf)) {
    throw new ZellijError(
      "self_target",
      `refusing to ${action} into zswarm's own pane (${self}); pass allowSelf=true to override`,
    );
  }
}

/**
 * Refuse writes that would loop back into the caller's own pane, land in a
 * dead pane, or hit a plugin pane. `allowSelf` / `force` opt out.
 */
export function assertWritable(
  client: ZellijClient,
  pane: ZellijPane,
  args: Record<string, unknown>,
  action: string,
): void {
  assertNotPlugin(pane, action);
  assertNotSelf(client, pane, args, action);
  if (pane.exited && !isTrue(args.force)) {
    throw new ZellijError(
      "pane_exited",
      `${pane.id} has exited; pass force=true to write to it anyway`,
    );
  }
}
