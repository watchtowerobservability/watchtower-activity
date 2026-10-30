export interface ActorIn { id: string; name?: string; type?: string }
export interface TargetIn { type: string; id: string; name?: string }
export interface EventIn {
  idempotency_key?: string;
  account_id: string;
  actor: ActorIn;
  action: string;
  target?: TargetIn;
  metadata?: Record<string, unknown>;
  ip?: string;
  occurred_at?: string;
}
export interface ActivityEvent {
  id: string;
  account_id: string;
  actor: ActorIn;
  action: string;
  target?: TargetIn;
  metadata?: Record<string, unknown>;
  ip?: string;
  occurred_at: string;
  received_at: string;
}
export interface ViewerSession { token: string; url: string; expiresAt: string }
export interface ListFilters {
  accountId?: string; actorId?: string; action?: string; targetType?: string;
  from?: string; to?: string; limit?: number;
}
export interface ActivityOptions {
  secretKey: string;
  baseUrl?: string;
  /** Opt in to constructing in a browser. Do not: the secret key would ship to users. */
  allowBrowser?: boolean;
  maxRetries?: number;
  fetch?: typeof fetch;
  /** Test hook; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** RFC 9457 problem+json mapped to an Error. */
export class ActivityError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail?: string;
  readonly instance?: string;
  readonly extensions: Record<string, unknown>;
  constructor(status: number, p: Record<string, unknown> = {}) {
    const { type, title, detail, instance, status: _s, ...ext } = p;
    const t = typeof title === 'string' ? title : `HTTP ${status}`;
    super(typeof detail === 'string' ? `${t}: ${detail}` : t);
    this.name = 'ActivityError';
    this.status = status;
    this.type = typeof type === 'string' ? type : 'about:blank';
    this.title = t;
    this.detail = typeof detail === 'string' ? detail : undefined;
    this.instance = typeof instance === 'string' ? instance : undefined;
    this.extensions = ext;
  }
}

const BATCH = 100;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const d = Date.parse(h);
  return Number.isNaN(d) ? undefined : Math.max(0, d - Date.now());
}

export class Activity {
  readonly #key: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #retries: number;

  constructor(opts: ActivityOptions) {
    if (typeof window !== 'undefined' && !opts.allowBrowser) {
      throw new Error('@watchtowerobservability/activity is server-only: the secret key would ship to browsers. Use @watchtowerobservability/activity-web there.');
    }
    if (!opts?.secretKey) throw new Error('secretKey is required');
    this.#key = opts.secretKey;
    const base = opts.baseUrl ?? (typeof process !== 'undefined' ? process.env.WT_API_URL : undefined);
    if (!base) throw new Error('baseUrl (or the WT_API_URL environment variable) is required');
    this.#base = base.replace(/\/+$/, '');
    this.#fetch = opts.fetch ?? ((...a) => globalThis.fetch(...a));
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#retries = opts.maxRetries ?? 4;
  }

  /** Never expose the key via console.log / util.inspect / JSON.stringify. */
  toJSON() { return { baseUrl: this.#base }; }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.#fetch(this.#base + path, {
        method,
        headers: {
          authorization: `Bearer ${this.#key}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < this.#retries) {
        // Retry-After wins; else exponential backoff with jitter, capped at 30 s.
        const wait = retryAfterMs(res.headers.get('retry-after')) ?? Math.min(30000, 250 * 2 ** attempt * (0.5 + Math.random() / 2));
        await res.body?.cancel().catch(() => {});
        await this.#sleep(wait);
        continue;
      }
      let p: Record<string, unknown> | undefined;
      try { p = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON error body */ }
      throw new ActivityError(res.status, p);
    }
  }

  /**
   * At-least-once: a retry after a lost response can re-send, so supply your own stable
   * idempotency_key per business event; the server dedupes on (project, key).
   */
  async record(event: EventIn): Promise<{ accepted: number }> {
    return this.recordBatch([event]);
  }

  async recordBatch(events: EventIn[]): Promise<{ accepted: number }> {
    // Key is assigned once, before chunking and retries, so every re-send carries the same key.
    const prepared = events.map((e) => ({ ...e, idempotency_key: e.idempotency_key ?? globalThis.crypto.randomUUID() }));
    let accepted = 0;
    for (let i = 0; i < prepared.length; i += BATCH) {
      const res = await this.#request('POST', '/v1/activity/events', { events: prepared.slice(i, i + BATCH) });
      accepted += ((await res.json()) as { accepted: number }).accepted;
    }
    return { accepted };
  }

  async createViewerSession(o: { accountId: string; actorId?: string; expiresIn?: number }): Promise<ViewerSession> {
    const res = await this.#request('POST', '/v1/activity/sessions', {
      account_id: o.accountId, actor_id: o.actorId, expires_in: o.expiresIn,
    });
    const j = (await res.json()) as { token: string; url: string; expires_at: string };
    return { token: j.token, url: j.url, expiresAt: j.expires_at };
  }

  #query(f: ListFilters & { format?: string }, cursor?: string): string {
    const m: Record<string, string | number | undefined> = {
      account_id: f.accountId, actor_id: f.actorId, action: f.action, target_type: f.targetType,
      from: f.from, to: f.to, limit: f.limit, format: f.format, cursor,
    };
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(m)) if (v !== undefined) q.set(k, String(v));
    const s = q.toString();
    return s ? `?${s}` : '';
  }

  /** Async iterator over every event, following next_cursor page by page. */
  async *list(projectId: string, filters: ListFilters = {}): AsyncGenerator<ActivityEvent, void, undefined> {
    let cursor: string | undefined;
    do {
      const res = await this.#request('GET', `/v1/projects/${encodeURIComponent(projectId)}/activity/events${this.#query(filters, cursor)}`);
      const page = (await res.json()) as { data: ActivityEvent[]; next_cursor?: string | null };
      yield* page.data;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  /** Returns the streaming response body (csv or ndjson). */
  async export(projectId: string, o: { format: 'csv' | 'ndjson' } & ListFilters): Promise<ReadableStream<Uint8Array>> {
    const { format, limit: _limit, ...f } = o; // the export endpoint streams everything and takes no limit
    const res = await this.#request('GET', `/v1/projects/${encodeURIComponent(projectId)}/activity/export${this.#query({ ...f, format })}`);
    if (!res.body) throw new ActivityError(res.status, { title: 'Empty export body' });
    return res.body;
  }
}
