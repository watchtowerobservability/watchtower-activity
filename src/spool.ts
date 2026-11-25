// The retry spool behind `ActivityQueue`: where events wait until Watchtower has accepted them.
import type { EventIn } from './types.js';

/** One spooled event with the id the spool gave it (pass the ids to `ack`). */
export interface SpoolItem { id: string; event: EventIn }

/**
 * Where queued events wait. `ActivityQueue` pushes every event (with its idempotency key already set), peeks
 * the oldest batch, sends it and acks what Watchtower took (or refused for good). Events are delivered at
 * least once: after a crash, whatever was not acked is sent again with the same key, and the server dedupes it.
 *
 * Adapter sketch for Redis (an `ioredis`-style client; the SDK has no Redis dependency):
 *
 * ```ts
 * class RedisSpool implements SpoolStore {
 *   readonly durable = true;
 *   constructor(private r: Redis, private key = 'wt:activity:spool') {}
 *   async push(e: EventIn) { await this.r.xadd(this.key, '*', 'e', JSON.stringify(e)); }
 *   async peek(n: number) {
 *     const rows = await this.r.xrange(this.key, '-', '+', 'COUNT', n);
 *     return rows.map(([id, f]) => ({ id, event: JSON.parse(f[1]) as EventIn }));
 *   }
 *   async ack(ids: string[]) { if (ids.length) await this.r.xdel(this.key, ...ids); }
 *   get size() { return this.r.xlen(this.key); }
 * }
 * ```
 */
export interface SpoolStore {
  /** True when events survive a restart of this process (the queue then keeps events after a transient send failure instead of dropping them). */
  readonly durable?: boolean;
  /** Add one event. Resolves when it is stored (a durable spool: flushed to disk). Rejects with `SpoolFullError` when the spool refuses it. */
  push(event: EventIn): Promise<void>;
  /** The oldest `n` events, oldest first, left in place until acked. */
  peek(n: number): Promise<SpoolItem[]>;
  /** Remove events by id. Unknown ids are ignored. */
  ack(ids: string[]): Promise<void>;
  /** Events waiting. */
  readonly size: number | Promise<number>;
  /** Release handles. */
  close?(): Promise<void>;
}

/** A spool that holds a fixed maximum and refuses more (`MemorySpool`). */
export class SpoolFullError extends Error {
  constructor() { super('activity queue full'); this.name = 'SpoolFullError'; }
}

/** In memory: the queue's behavior before spools existed. A full spool rejects new events. Lost on exit. */
export class MemorySpool implements SpoolStore {
  readonly durable = false;
  readonly #max: number;
  #items: SpoolItem[] = [];
  #n = 0;
  constructor(o: { maxItems?: number } = {}) { this.#max = o.maxItems ?? 10000; }
  async push(event: EventIn): Promise<void> {
    if (this.#items.length >= this.#max) throw new SpoolFullError();
    this.#items.push({ id: String(++this.#n), event });
  }
  async peek(n: number): Promise<SpoolItem[]> { return this.#items.slice(0, n); }
  async ack(ids: string[]): Promise<void> {
    const s = new Set(ids);
    this.#items = this.#items.filter((i) => !s.has(i.id));
  }
  get size() { return this.#items.length; }
}
