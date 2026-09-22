/** Short-lived, completed observations only. Never shares a caller's promise or budget. */
export class ListingCache {
  private entries = new Map<string, { scope: string; expiresAt: number; value: unknown }>();
  private scopes = new Map<string, { version: number; revision?: string }>();

  constructor(private readonly limit = 512) {}

  begin(scope: string) {
    let state = this.scopes.get(scope);
    if (!state) {
      state = { version: 0 };
      this.scopes.set(scope, state);
      if (this.scopes.size > this.limit) {
        const oldest = this.scopes.keys().next().value!;
        this.scopes.delete(oldest);
        for (const [key, entry] of this.entries) if (entry.scope === oldest) this.entries.delete(key);
      }
    }
    return { state, version: state.version };
  }

  get<T>(key: string, now: number): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return structuredClone(entry.value) as T;
  }

  put<T>(key: string, scope: string, ticket: ReturnType<ListingCache["begin"]>, value: T, ttl: number, now: number): void {
    // A mutation/event during this read must not resurrect an older manifest.
    if (ttl <= 0 || this.scopes.get(scope) !== ticket.state || ticket.state.version !== ticket.version) return;
    this.entries.delete(key);
    this.entries.set(key, { scope, value: structuredClone(value), expiresAt: now + ttl });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }

  invalidate(scope: string): void {
    this.begin(scope).state.version++;
    for (const [key, entry] of this.entries) if (entry.scope === scope) this.entries.delete(key);
  }

  observe(scope: string, revision: string): boolean {
    const { state } = this.begin(scope);
    if (state.revision === revision) return false;
    this.invalidate(scope);
    state.revision = revision;
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.scopes.clear();
  }
}

export const sharedListings = new ListingCache();

const executors = new WeakMap<object, number>();
let nextExecutor = 0;
export function executorIdentity(exec?: object): number | null {
  if (!exec) return null;
  let id = executors.get(exec);
  if (id === undefined) { id = ++nextExecutor; executors.set(exec, id); }
  return id;
}

/** Environment fields that select local sockets or an SSH identity/config. */
export function routingEnvironment(env: NodeJS.ProcessEnv): Record<string, string | null> {
  return Object.fromEntries([
    "ZSWARM_TMP", "ZELLIJ_SOCKET_DIR", "TMPDIR", "TEMP", "TMP", "XDG_RUNTIME_DIR",
    "HOME", "USERPROFILE", "USER", "USERNAME", "LOGNAME", "USERDOMAIN", "SSH_AUTH_SOCK",
    "PATH", "Path", "PATHEXT", "XDG_CONFIG_HOME", "ZELLIJ_CONFIG_DIR",
    "ZELLIJ_SESSION_NAME", "ZSWARM_SESSION",
  ].map((key) => [key, env[key] ?? null]));
}

export function listingTtl(env: NodeJS.ProcessEnv): number {
  const value = env.ZSWARM_CACHE_TTL_MS;
  if (value === undefined || value.trim() === "") return 500;
  const ttl = Number(value);
  return Number.isFinite(ttl) ? Math.max(0, Math.min(5000, ttl)) : 500;
}
