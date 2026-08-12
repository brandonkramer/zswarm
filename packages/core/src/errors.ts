/** Every zSwarm failure carries a stable machine-readable code. */
export class ZellijError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ZellijError";
    this.code = code;
  }
}
