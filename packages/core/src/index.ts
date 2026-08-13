export { ZellijError } from "./errors.js";
export {
  createExec,
  NOT_FOUND_EXIT,
  type ExecFn,
  type ExecOptions,
  type ExecResult,
} from "./exec.js";
export {
  createGitClient,
  defaultWorktreeRoot,
  normalizeRepoPath,
  parseWorktreeList,
  worktreeDirName,
  type GitClient,
  type GitClientOptions,
  type Worktree,
} from "./git.js";
export {
  expandHomePath,
  resolveZellijBinary,
  sanitizeZellijEnv,
  type ZellijExecFn,
  type ZellijExecResult,
} from "./zellij/binary.js";
export {
  normalizePaneId,
  parsePaneList,
  resolvePane,
  type ZellijPane,
} from "./zellij/panes.js";
export {
  parseSessionList,
  resolveSelfPaneId,
  type ZellijSessionResolve,
} from "./zellij/session.js";
export {
  buildClosePaneArgs,
  buildDumpArgs,
  buildLaunchPluginArgs,
  buildListPanesArgs,
  buildNewPaneArgs,
  buildNewTabArgs,
  buildPasteArgs,
  buildPipeArgs,
  buildSendEnterArgs,
  buildSendKeysArgs,
  buildWriteCharsArgs,
  scrollbackPayload,
  waitPayload,
  type LaunchPluginInput,
  type NewPaneInput,
  type NewTabInput,
  type PaneDirection,
  type PipeInput,
  type ScrollbackRequest,
  type WaitRequest,
} from "./zellij/args.js";
export {
  busPluginUrl,
  busToPanes,
  nextConfigKey,
  parseBusReply,
  parseScrollbackReply,
  resolveBusPlugin,
  scrollbackToScreen,
  BUS_PIPE_NAME,
  DEFAULT_BUS_KEY,
  DEFAULT_BUS_TIMEOUT_MS,
  type BusMarker,
  type BusPane,
  type BusScrollback,
  type BusScrollbackPane,
  type BusSnapshot,
} from "./zellij/bus.js";
export {
  busSnapshot,
  planBus,
  resetBusCache,
  type BusPlan,
} from "./ops/bus.js";
export {
  createZellijClient,
  type ZellijClient,
  type ZellijClientOptions,
} from "./zellij/client.js";
export {
  createStateStore,
  defaultStateDir,
  type LogEntry,
  type SignalChannel,
  type StateStore,
  type StateStoreOptions,
} from "./state.js";
export { dispatchZswarm } from "./ops/dispatch.js";
export {
  assertOpAllowed,
  assertPaneAllowed,
  isWriteOp,
  loadPolicy,
  type Policy,
} from "./policy.js";
export {
  buildSshRemoteCommand,
  createSshExec,
  quoteRemoteArg,
  shellQuote,
  type SshTarget,
} from "./exec.js";
export { resolveSshTarget } from "./zellij/binary.js";
export {
  applyIpcTmpEnv,
  cmdQuote,
  concreteTmp,
  encodePowerShellCommand,
  inferRemoteShell,
  parseZellijServerPaths,
  pickIpcDirs,
  pickIpcTmp,
  socketDirFromServerPath,
  tmpFromServerPath,
  unixDiscoverRemote,
  windowsDiscoverRemote,
  windowsInteractiveRemote,
  wrapWithTmpEnv,
} from "./zellij/ipc.js";
export {
  callServe,
  DEFAULT_SERVE_LISTEN,
  installServeLogon,
  isLoopbackHost,
  parseListenAddress,
  redactServeSecret,
  SERVE_CALL_TIMEOUT_CAP_MS,
  SERVE_MAX_REQUEST_BYTES,
  SERVE_TASK_NAME,
  serveCallTimeout,
  serveChildEnv,
  serveLogonCommand,
  startServe,
  uninstallServeLogon,
} from "./ops/serve.js";
export { parseTabList, resolveTab, type ZellijTab } from "./zellij/tabs.js";
export { selectTargets } from "./ops/broadcast.js";
export { diffScreens, cursorKey } from "./ops/tail.js";
export { classify, lastLine, type PeerState } from "./ops/status.js";
export {
  normalizeScreen,
  truncateDumpText,
  DEFAULT_DUMP_MAX_CHARS,
  DEFAULT_WAIT_MAX_CHARS,
} from "./ops/util.js";
export type { DispatchDeps, OpsResult } from "./ops/types.js";
export { normalizeKey, normalizeKeys, tokenizeCommand } from "./keys.js";
export {
  cliUsage,
  mcpInputSchema,
  parseCliArgv,
  MCP_TOOL_DESCRIPTION,
  OP_NAMES,
  PARAMS,
  TARGET_OPS,
  type OpName,
  type ParamSpec,
  type ParamType,
} from "./schema.js";
