import type {
  AccountToken, AccountTokenIn, ActivityEvent, Archive, Batch, ErasureRequest, ErasureResult, EventIn, Export, ExportRequest, Invite, InviteIn,
  ListFilters, Page, RecordResult, Rule, RuleIn, RulePatch, SavedView, Stream, StreamIn, StreamPatch, ValidateResult, ViewerSession, ViewerSessionOptions,
} from './types';

import { type Seal, type SigningKey, wire } from './model3';

export type * from './types';
export { canonicalJson, openSealed } from './model3';
export type { Seal, SealedEnvelope, SigningKey } from './model3';

export interface ActivityOptions {
  /** The project's `wti_` secret key with scope `ingest:activity`: record, validate, sessions, list, export. */
  secretKey: string;
  /** An org API key with access to the project, for `accountTokens()`, `streams()` and `rules()` (project management routes do not take `wti_` keys). */
  apiKey?: string;
  baseUrl?: string;
  /**
   * Data residency: the org's region (`us`, `eu`, ...). The client asks `GET /v1/regions` of `baseUrl` once and
   * then talks to that region's API. Either way a `421 wrong_region` answer is followed once.
   */
  region?: string;
  /** Opt in to constructing in a browser. Do not: the secret key would ship to users. */
  allowBrowser?: boolean;
  maxRetries?: number;
  fetch?: typeof fetch;
  /** Test hook; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Fill `trace_id`/`span_id` of events that have none from the active OpenTelemetry span.
   * Default: on when `@opentelemetry/api` is installed (an optional peer, loaded lazily); `false`
   * turns it off; a function supplies the ids yourself.
   */
  traceContext?: boolean | (() => SpanIds | undefined);
  /** Sign every recorded event (customer-signed events; register the public key under `kid`). */
  signingKey?: SigningKey;
  /** Encrypt these event paths here (AES-256-GCM); `openSealed` decrypts. */
  seal?: Seal;
}

export interface SpanIds { trace_id: string; span_id: string }

const OTEL = '@opentelemetry/api';
const HEX32 = /^[0-9a-f]{32}$/;
let otel: Promise<(() => SpanIds | undefined) | undefined> | undefined;

/** The active span's ids via `@opentelemetry/api`, or undefined when it is absent or no span is recording. */
function otelSpan(): Promise<(() => SpanIds | undefined) | undefined> {
  // A variable specifier keeps bundlers and tsc from requiring the optional peer.
  otel ??= import(OTEL).then(
    (m: { trace?: { getActiveSpan?: () => { spanContext(): { traceId: string; spanId: string } } | undefined } }) => () => {
      const c = m.trace?.getActiveSpan?.()?.spanContext();
      return c && HEX32.test(c.traceId) && !/^0+$/.test(c.traceId) ? { trace_id: c.traceId, span_id: c.spanId } : undefined;
    },
    () => undefined,
  );
  return otel;
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
/** With `partial: true` the server takes up to 1000 per request and reports rejects per event. */
const PARTIAL_BATCH = 1000;

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
  readonly #apiKey: string | undefined;
  #base: string;
  readonly #region: string | undefined;
  #regionDone = false;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #retries: number;
  readonly #trace: boolean | (() => SpanIds | undefined);
  readonly #signingKey: SigningKey | undefined;
  readonly #seal: Seal | undefined;

  constructor(opts: ActivityOptions) {
    if (typeof window !== 'undefined' && !opts.allowBrowser) {
      throw new Error('@watchtowerobservability/activity is server-only: the secret key would ship to browsers. Use @watchtowerobservability/activity-web there.');
    }
    if (!opts?.secretKey) throw new Error('secretKey is required');
    this.#key = opts.secretKey;
    this.#apiKey = opts.apiKey;
    const base = opts.baseUrl ?? (typeof process !== 'undefined' ? process.env.WT_API_URL : undefined);
    if (!base) throw new Error('baseUrl (or the WT_API_URL environment variable) is required');
    this.#base = base.replace(/\/+$/, '');
    this.#region = opts.region;
    this.#fetch = opts.fetch ?? ((...a) => globalThis.fetch(...a));
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#retries = opts.maxRetries ?? 4;
    this.#trace = opts.traceContext ?? true;
    this.#signingKey = opts.signingKey;
    this.#seal = opts.seal;
  }

  /** Never expose the key via console.log / util.inspect / JSON.stringify. */
  toJSON() { return { baseUrl: this.#base }; }

  /** With `region`: that region's API base from the directory, once (a failed lookup keeps `baseUrl`). */
  async #resolveRegion() {
    if (!this.#region || this.#regionDone) return;
    this.#regionDone = true;
    try {
      const res = await this.#fetch(`${this.#base}/v1/regions`, { method: 'GET' });
      const d = (await res.json()) as { current?: string | null; data?: { region: string; api_base_url: string }[] };
      const hit = d.current === this.#region ? undefined : d.data?.find((r) => r.region === this.#region);
      if (hit) this.#base = hit.api_base_url.replace(/\/+$/, '');
    } catch { /* keep baseUrl; a 421 still redirects */ }
  }

  async #request(method: string, path: string, body?: unknown, key = this.#key): Promise<Response> {
    const backoff = (attempt: number) => Math.min(30000, 250 * 2 ** attempt * (0.5 + Math.random() / 2));
    await this.#resolveRegion();
    let moved = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(this.#base + path, {
          method,
          headers: {
            authorization: `Bearer ${key}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        // fetch rejects on connection, DNS and TLS failures: retry those like a 5xx
        if (attempt >= this.#retries) throw e;
        await this.#sleep(backoff(attempt));
        continue;
      }
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < this.#retries) {
        // Retry-After wins; else exponential backoff with jitter, capped at 30 s.
        const wait = retryAfterMs(res.headers.get('retry-after')) ?? backoff(attempt);
        await res.body?.cancel().catch(() => {});
        await this.#sleep(wait);
        continue;
      }
      let p: Record<string, unknown> | undefined;
      try { p = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON error body */ }
      // 421 wrong_region: the org lives elsewhere; follow its API once
      if (res.status === 421 && !moved && typeof p?.api_base_url === 'string') {
        moved = true;
        this.#base = p.api_base_url.replace(/\/+$/, '');
        attempt--;
        continue;
      }
      throw new ActivityError(res.status, p);
    }
  }

  /**
   * At-least-once: a retry after a lost response can re-send, so supply your own stable
   * idempotency_key per business event; the server dedupes on (project, key).
   * `dryRun` validates without storing (POST /v1/activity/events/validate).
   */
  record(event: EventIn, o: { dryRun: true }): Promise<ValidateResult>;
  record(event: EventIn, o?: { dryRun?: false }): Promise<RecordResult>;
  async record(event: EventIn, o: { dryRun?: boolean } = {}): Promise<RecordResult | ValidateResult> {
    return o.dryRun ? this.validate([event]) : this.recordBatch([event]);
  }

  /** Normalized stored form, schema warnings, missing template and PII detector hits; stores nothing. */
  async validate(events: EventIn | EventIn[]): Promise<ValidateResult> {
    return this.#json('POST', '/v1/activity/events/validate', { events: Array.isArray(events) ? events : [events] });
  }

  /**
   * `partial: true`: batches of 1000, bad events are listed in `rejected` instead of failing the batch.
   * `receipts: true`: a signed receipt per accepted event (check with `verifyReceipt`).
   * `async: true`: queued server-side; poll `batch(id)` for each of `batch_ids`.
   */
  async recordBatch(events: EventIn[], o: { partial?: boolean; receipts?: boolean; async?: boolean } = {}): Promise<RecordResult> {
    // Key is assigned once, before chunking and retries, so every re-send carries the same key.
    const span = await this.#spanIds();
    const prepared = await wire(events.map((e) => ({
      ...(span && !e.trace_id ? span : {}),
      ...e,
      idempotency_key: e.idempotency_key ?? globalThis.crypto.randomUUID(),
    })), this.#seal, this.#signingKey);
    const size = o.partial ? PARTIAL_BATCH : BATCH;
    const out: Required<RecordResult> = { accepted: 0, rejected: [], warnings: [], receipts: [], coalesced: [], batch_ids: [] };
    const q = [o.partial && 'partial=true', o.receipts && 'receipts=true', o.async && 'async=true'].filter(Boolean).join('&');
    for (let i = 0; i < prepared.length; i += size) {
      const r = await this.#json<RecordResult & { batch_id?: string }>('POST', `/v1/activity/events${q ? `?${q}` : ''}`, { events: prepared.slice(i, i + size) });
      out.accepted += r.accepted;
      // Indexes are per request; shift them to the caller's array.
      for (const x of r.rejected ?? []) out.rejected.push({ ...x, index: x.index + i });
      for (const x of r.warnings ?? []) out.warnings.push({ ...x, index: x.index + i });
      for (const x of r.receipts ?? []) out.receipts.push({ ...x, index: x.index + i });
      for (const x of r.coalesced ?? []) out.coalesced.push({ ...x, index: x.index + i });
      if (r.batch_id) out.batch_ids.push(r.batch_id);
    }
    return {
      accepted: out.accepted, ...(o.partial ? { rejected: out.rejected } : {}), ...(out.warnings.length ? { warnings: out.warnings } : {}),
      ...(out.receipts.length ? { receipts: out.receipts } : {}), ...(out.coalesced.length ? { coalesced: out.coalesced } : {}),
      ...(out.batch_ids.length ? { batch_ids: out.batch_ids } : {}),
    };
  }

  /** The state of an async batch (`recordBatch(..., { async: true })`). */
  async batch(id: string): Promise<Batch> {
    return this.#json('GET', `/v1/activity/batches/${encodeURIComponent(id)}`);
  }

  /** One event by id (with lookup `labels`). */
  async getEvent(projectId: string, id: string): Promise<ActivityEvent> {
    return this.#json('GET', `${this.#prj(projectId)}/events/${encodeURIComponent(id)}`);
  }

  async #spanIds(): Promise<SpanIds | undefined> {
    if (this.#trace === false) return undefined;
    if (typeof this.#trace === 'function') return this.#trace();
    return (await otelSpan())?.();
  }

  /** Write 25 realistic sample events into one account (default `sample`) through the ingest pipeline. */
  async samples(projectId: string, o: { accountId?: string } = {}): Promise<{ account_id: string; accepted: number }> {
    return this.#json('POST', `${this.#prj(projectId)}/samples`, o.accountId ? { account_id: o.accountId } : {});
  }

  async createViewerSession(o: ViewerSessionOptions): Promise<ViewerSession> {
    const j = await this.#json<{ token: string; url: string; expires_at: string; jti?: string }>('POST', '/v1/activity/sessions', {
      account_id: o.accountId, actor_id: o.actorId, expires_in: o.expiresIn, capabilities: o.capabilities,
      locale: o.locale, time_zone: o.timeZone,
      sub_scope: o.subScope && { target_type: o.subScope.targetType, target_id: o.subScope.targetId },
    });
    return { token: j.token, url: j.url, expiresAt: j.expires_at, ...(j.jti ? { jti: j.jti } : {}) };
  }

  /** Revoke one viewer session by its `jti`. */
  async revokeSession(jti: string): Promise<void> {
    await this.#request('DELETE', `/v1/activity/sessions/${encodeURIComponent(jti)}`);
  }

  /** Revoke every live viewer session of an account (e.g. on offboarding). Returns how many were live. */
  async revokeAccountSessions(accountId: string): Promise<{ revoked: number }> {
    return this.#json('POST', '/v1/activity/sessions/revoke', { account_id: accountId });
  }

  /** Project management calls authenticate with `apiKey`. */
  #mgmt(method: string, path: string, body?: unknown) {
    if (!this.#apiKey) throw new Error('apiKey (an org API key) is required for accountTokens(), streams(), rules() and privacy()');
    return this.#request(method, path, body, this.#apiKey);
  }
  async #mjson<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await this.#mgmt(method, path, body)).json()) as T;
  }

  /** End-customer API tokens (`wta_acct_...`) of one account; the token string is in the create response only. */
  accountTokens(projectId: string, accountId: string) {
    const base = `${this.#prj(projectId)}/accounts/${encodeURIComponent(accountId)}/tokens`;
    return {
      list: () => this.#mjson<Page<AccountToken>>('GET', base),
      create: (o: AccountTokenIn) => this.#mjson<AccountToken>('POST', base, o),
      revoke: (id: string) => this.#mgmt('DELETE', `${base}/${encodeURIComponent(id)}`).then(() => undefined),
    };
  }

  /** Email a one-time link to the account's hosted page (single use; it becomes a fresh session when opened). */
  async invite(projectId: string, accountId: string, o: InviteIn): Promise<Invite> {
    return this.#mjson('POST', `${this.#prj(projectId)}/accounts/${encodeURIComponent(accountId)}/invite`, o);
  }

  /** SIEM / log streams (secrets are write-only). */
  streams(projectId: string) {
    const base = `${this.#prj(projectId)}/streams`;
    const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
    return {
      list: () => this.#mjson<Page<Stream>>('GET', base),
      get: (id: string) => this.#mjson<Stream>('GET', one(id)),
      create: (s: StreamIn) => this.#mjson<Stream>('POST', base, s),
      update: (id: string, patch: StreamPatch) => this.#mjson<Stream>('PATCH', one(id), patch),
      /** Re-send everything received since `from` (RFC 3339, within retention). */
      replay: (id: string, o: { from: string }) => this.#mjson<Stream>('POST', `${one(id)}/replay`, o),
      delete: (id: string) => this.#mgmt('DELETE', one(id)).then(() => undefined),
      /** Queues a test delivery (202); poll `get(id)` for `last_test`. */
      test: (id: string) => this.#mgmt('POST', `${one(id)}/test`, {}).then(() => undefined),
    };
  }

  /** Alert rules on chosen actions (email, Slack, signed webhook). */
  rules(projectId: string) {
    const base = `${this.#prj(projectId)}/rules`;
    const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
    return {
      list: () => this.#mjson<Page<Rule>>('GET', base),
      create: (r: RuleIn) => this.#mjson<Rule>('POST', base, r),
      /** A new `channel` returns a new `signing_secret` for webhooks. */
      update: (id: string, patch: RulePatch) => this.#mjson<Rule>('PATCH', one(id), patch),
      delete: (id: string) => this.#mgmt('DELETE', one(id)).then(() => undefined),
    };
  }

  /** Async exports (the file is kept 24 h) and restores of cold archives. */
  exports(projectId: string) {
    const base = `${this.#prj(projectId)}/exports`;
    const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
    return {
      create: (r: ExportRequest = {}) => this.#mjson<Export>('POST', base, r),
      get: (id: string) => this.#mjson<Export>('GET', one(id)),
      download: async (id: string): Promise<ReadableStream<Uint8Array>> => {
        const res = await this.#mgmt('GET', `${one(id)}/download`);
        if (!res.body) throw new ActivityError(res.status, { title: 'Empty export body' });
        return res.body;
      },
    };
  }

  archives(projectId: string) {
    const base = `${this.#prj(projectId)}/archives`;
    return {
      list: (o: { accountId?: string } = {}) => this.#mjson<Page<Archive>>('GET', `${base}${o.accountId ? `?account_id=${encodeURIComponent(o.accountId)}` : ''}`),
      /** Load an archive back for `days` (1 to 30, default 7); list it with `list(.., { source: 'archive' })`. */
      restore: (id: string, o: { days?: number } = {}) => this.#mjson<Archive>('POST', `${base}/${encodeURIComponent(id)}/restore`, o),
    };
  }

  /** Right to erasure. With `approval: true` the erase waits for a second member's `approve` (202 request). */
  privacy(projectId: string) {
    const base = this.#prj(projectId);
    return {
      eraseActor: (actorId: string, o: { approval?: boolean } = {}) =>
        this.#mjson<ErasureResult | ErasureRequest>('POST', `${base}/actors/${encodeURIComponent(actorId)}/erase`, o.approval ? { approval: { required: true } } : {}),
      /** Pending requests. */
      erasures: () => this.#mjson<Page<ErasureRequest>>('GET', `${base}/erasures`),
      /** By a member other than the requester (else 404). */
      approve: (id: string) => this.#mjson<ErasureResult>('POST', `${base}/erasures/${encodeURIComponent(id)}/approve`, {}),
      /** Withdraw a pending request: its requester, or a member with the privacy permission (else 404). */
      cancel: async (id: string) => { await this.#mgmt('POST', `${base}/erasures/${encodeURIComponent(id)}/cancel`, {}); },
      /** One event, org owners only. */
      deleteEvent: (id: string) => this.#mjson<{ committed: boolean; fields_erased: number }>('DELETE', `${base}/events/${encodeURIComponent(id)}`),
    };
  }

  #prj(projectId: string) { return `/v1/projects/${encodeURIComponent(projectId)}/activity`; }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await this.#request(method, path, body)).json()) as T;
  }

  #query(f: ListFilters & { format?: string; fields?: string[]; chain?: boolean }, cursor?: string): string {
    const m: Record<string, string | number | undefined> = {
      account_id: f.accountId, actor_id: f.actorId, action: f.action, target_type: f.targetType,
      target_id: f.targetId, q: f.q, outcome: f.outcome, severity: f.severity, order: f.order, from: f.from, to: f.to, limit: f.limit,
      source: f.source, since: f.since,
      format: f.format, fields: f.fields?.length ? f.fields.join(',') : undefined, chain: f.chain ? 1 : undefined, cursor,
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
      const page = await this.#json<Page<ActivityEvent>>('GET', `${this.#prj(projectId)}/events${this.#query(filters, cursor)}`);
      yield* page.data;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  /**
   * Returns the streaming response body (csv, ndjson or OCSF NDJSON). `fields` keeps only those
   * columns/keys (e.g. `['id', 'occurred_at', 'actor.email']`); `chain: true` (ndjson) adds `seq`,
   * `chain_hash`, `prev_hash` and `chain_body` per line for offline verification.
   */
  async export(projectId: string, o: { format: 'csv' | 'ndjson' | 'ocsf'; fields?: string[]; chain?: boolean } & ListFilters): Promise<ReadableStream<Uint8Array>> {
    const { format, limit: _limit, ...f } = o; // the export endpoint streams everything and takes no limit
    const res = await this.#request('GET', `${this.#prj(projectId)}/export${this.#query({ ...f, format })}`);
    if (!res.body) throw new ActivityError(res.status, { title: 'Empty export body' });
    return res.body;
  }

  /**
   * The browser feed's calls with one viewer credential (a viewer token from
   * `createViewerSession` or an account token `wta_acct_...`), from server code: a backend that
   * renders the log itself, or a support tool. The session's scopes always apply.
   */
  viewer(token: string) {
    const json = async <T,>(method: string, path: string, body?: unknown) =>
      (await (await this.#request(method, path, body, token)).json()) as T;
    const stream = async (path: string) => {
      const res = await this.#request('GET', path, undefined, token);
      if (!res.body) throw new ActivityError(res.status, { title: 'Empty export body' });
      return res.body;
    };
    const q = (f: ListFilters, extra: Record<string, string> = {}, cursor?: string) => {
      const s = new URLSearchParams(this.#query(f, cursor).slice(1));
      for (const [k, v] of Object.entries(extra)) s.set(k, v);
      return s.toString() ? `?${s}` : '';
    };
    return {
      /** Every event of the session's scope, page by page. */
      feed: async function* (filters: ListFilters = {}): AsyncGenerator<ActivityEvent, void, undefined> {
        let cursor: string | undefined;
        do {
          const page = await json<Page<ActivityEvent>>('GET', `/v1/activity/feed${q(filters, {}, cursor)}`);
          yield* page.data;
          cursor = page.next_cursor ?? undefined;
        } while (cursor);
      },
      facets: (field: 'action' | 'actor' | 'target_type' | 'target', filters: ListFilters = {}) =>
        json<Page<{ value: string; label?: string | null; count: number }>>('GET', `/v1/activity/feed/facets${q(filters, { field })}`),
      histogram: (filters: ListFilters = {}) =>
        json<Page<{ at: string; count: number }>>('GET', `/v1/activity/feed/histogram${q(filters, { bucket: 'day' })}`),
      /** Server-side saved views; account tokens only (a session gets 404 and keeps views in the browser). */
      views: {
        list: () => json<Page<SavedView>>('GET', '/v1/activity/views'),
        create: (v: { name: string; q?: string; params?: Record<string, string> }) => json<SavedView>('POST', '/v1/activity/views', v),
        delete: async (id: string) => { await this.#request('DELETE', `/v1/activity/views/${encodeURIComponent(id)}`, undefined, token); },
      },
      /** Merkle inclusion proof of one event (capability `verify`; 409 until its hour is signed). */
      proof: (eventId: string) => json<Record<string, unknown>>('GET', `/v1/activity/feed/proof?event_id=${encodeURIComponent(eventId)}`),
      /** Consistency proof between two signed tree heads (`toSize` defaults to the latest). */
      consistency: (fromSize: number, toSize?: number) =>
        json<Record<string, unknown>>('GET', `/v1/activity/feed/consistency?from_size=${fromSize}${toSize ? `&to_size=${toSize}` : ''}`),
      /** Synchronous download (capability `export`). */
      export: (format: 'csv' | 'ndjson' | 'ocsf', filters: ListFilters = {}) => stream(`/v1/activity/feed/export${q(filters, { format })}`),
      exports: {
        list: () => json<Page<Export>>('GET', '/v1/activity/exports'),
        create: (r: ExportRequest) => json<Export>('POST', '/v1/activity/exports', r),
        get: (id: string) => json<Export>('GET', `/v1/activity/exports/${encodeURIComponent(id)}`),
        download: (id: string) => stream(`/v1/activity/exports/${encodeURIComponent(id)}/download`),
      },
    };
  }
}

export { ActivityQueue, middleware } from './model4';
export type { QueueOptions, RequestContext } from './model4';
export * from './verify';
