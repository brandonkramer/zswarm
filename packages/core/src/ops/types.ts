export type OpsResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

/** Injectable clock so `wait` is testable without real time passing. */
export type DispatchDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type Clock = Required<DispatchDeps>;
