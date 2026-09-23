/** Every zSwarm failure carries a stable machine-readable code. */
export class ZellijError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ZellijError";
    this.code = code;
    if (details && Object.keys(details).length > 0) this.details = details;
  }
}
