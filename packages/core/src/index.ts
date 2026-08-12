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
  buildListPanesArgs,
  buildNewPaneArgs,
  buildNewTabArgs,
  buildPasteArgs,
  buildSendEnterArgs,
  buildSendKeysArgs,
  buildWriteCharsArgs,
  type NewPaneInput,
  type NewTabInput,
  type PaneDirection,
} from "./zellij/args.js";
export {
  createZellijClient,
  type ZellijClient,
  type ZellijClientOptions,
} from "./zellij/client.js";
export { dispatchZswarm } from "./ops/dispatch.js";
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
