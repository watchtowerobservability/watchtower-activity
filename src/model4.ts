// Background queue (I23) and framework middleware (I24) for the server SDK.
import type { EventIn, RecordResult } from './types';

/** Anything that records batches: an `Activity` client. */
interface Recorder { recordBatch(events: EventIn[], o?: { partial?: boolean }): Promise<RecordResult> }

export interface QueueOptions {
  /** Events per request (default 100, at most 1000). */
  maxBatch?: number;
  /** Flush at least this often, in ms (default 1000). */
  flushMs?: number;
  /** Events held in memory before new ones are dropped (default 10000). */
  maxBuffer?: number;
  /**
   * `open` (default): a full buffer or a failed send drops events and calls `onDrop`.
   * `closed`: `enqueue` rejects when the buffer is full, so the caller can refuse the action
   * (audit-or-fail).
   */
  mode?: 'open' | 'closed';
  /** Called with events that could not be recorded and why. */
  onDrop?: (events: EventIn[], reason: unknown) => void;
  /** Flush on process exit signals (default true in Node). */
  flushOnExit?: boolean;
}

/**
 * Non-blocking recording: `enqueue` returns at once; events go out in batches of `maxBatch` every
 * `flushMs` (with `partial`, so one bad event does not drop the rest). Each event gets its
 * idempotency key when enqueued, so the client's retries never duplicate. At-least-once while
 * the process lives; `flush()` before exit (done for SIGTERM/SIGINT/beforeExit by default).
 */
export class ActivityQueue {
  readonly #client: Recorder;
  readonly #o: Required<Omit<QueueOptions, 'onDrop'>> & Pick<QueueOptions, 'onDrop'>;
  #buf: EventIn[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #sending: Promise<void> = Promise.resolve();

  constructor(client: Recorder, o: QueueOptions = {}) {
    this.#client = client;
    this.#o = {
      maxBatch: Math.min(Math.max(o.maxBatch ?? 100, 1), 1000), flushMs: o.flushMs ?? 1000,
      maxBuffer: o.maxBuffer ?? 10000, mode: o.mode ?? 'open', onDrop: o.onDrop, flushOnExit: o.flushOnExit ?? true,
    };
    this.#timer = setInterval(() => { void this.flush(); }, this.#o.flushMs);
    (this.#timer as { unref?: () => void }).unref?.();
    const p = typeof process !== 'undefined' ? (process as { once?: (e: string, f: () => void) => void }) : undefined;
    if (this.#o.flushOnExit && p?.once) {
      for (const sig of ['beforeExit', 'SIGTERM', 'SIGINT']) p.once(sig, () => { void this.close(); });
    }
  }

  /** Events waiting to be sent. */
  get size() { return this.#buf.length; }

  /** Queue one event. In `closed` mode a full buffer rejects; in `open` mode it drops and calls `onDrop`. */
  async enqueue(e: EventIn): Promise<void> {
    const ev = { ...e, idempotency_key: e.idempotency_key ?? globalThis.crypto.randomUUID() };
    if (this.#buf.length >= this.#o.maxBuffer) {
      const err = new Error('activity queue full');
      if (this.#o.mode === 'closed') throw err;
      this.#o.onDrop?.([ev], err);
      return;
    }
    this.#buf.push(ev);
    if (this.#buf.length >= this.#o.maxBatch) void this.flush();
  }

  /** Send everything queued now; resolves when sent (or dropped). */
  flush(): Promise<void> {
    this.#sending = this.#sending.then(async () => {
      while (this.#buf.length) {
        const batch = this.#buf.splice(0, this.#o.maxBatch);
        try {
          const r = await this.#client.recordBatch(batch, { partial: true });
          const bad = (r.rejected ?? []).map((x) => batch[x.index]).filter((x): x is EventIn => !!x);
          if (bad.length) this.#o.onDrop?.(bad, r.rejected);
        } catch (err) {
          this.#o.onDrop?.(batch, err);
        }
      }
    });
    return this.#sending;
  }

  /** Stop the timer and flush. */
  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.flush();
  }
}

/** What the middleware knows about the request, for `event()`. */
export interface RequestContext { method: string; path: string; status: number; ip?: string; userAgent?: string; requestId?: string }

interface NodeReq { method?: string; url?: string; originalUrl?: string; ip?: string; headers?: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }
interface NodeRes { statusCode?: number; once?: (e: 'finish', f: () => void) => void; on?: (e: 'finish', f: () => void) => void }

const header = (r: NodeReq, k: string) => { const v = r.headers?.[k]; return Array.isArray(v) ? v[0] : v; };

/**
 * Express / Connect / Fastify (`fastify.addHook('onRequest', (req, reply, done) => mw(req.raw, reply.raw, done))`)
 * middleware: after each response, `event(req, ctx)` returns the event to record (or nothing to skip) and it is
 * queued; request context (ip, user agent, request id) is filled in. Never blocks or fails the request.
 */
export function middleware<Req extends NodeReq>(queue: ActivityQueue, event: (req: Req, ctx: RequestContext) => EventIn | undefined | null) {
  return (req: Req, res: NodeRes, next: (err?: unknown) => void) => {
    const done = () => {
      try {
        const ctx: RequestContext = {
          method: req.method ?? 'GET', path: (req.originalUrl ?? req.url ?? '/').split('?')[0]!, status: res.statusCode ?? 0,
          ip: req.ip ?? req.socket?.remoteAddress, userAgent: header(req, 'user-agent'), requestId: header(req, 'x-request-id'),
        };
        const e = event(req, ctx);
        if (!e) return;
        const context = { ...(ctx.ip ? { ip: ctx.ip } : {}), ...(ctx.userAgent ? { user_agent: ctx.userAgent } : {}), ...(ctx.requestId ? { request_id: ctx.requestId } : {}), ...e.context };
        void queue.enqueue({ ...e, context }).catch(() => {});
      } catch { /* never fail the request for its audit event */ }
    };
    (res.once ?? res.on)?.call(res, 'finish', done);
    next();
  };
}
