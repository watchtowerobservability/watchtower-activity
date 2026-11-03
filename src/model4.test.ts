import { describe, expect, it } from 'vitest';
import { ActivityQueue, middleware } from './model4';
import type { EventIn } from './types';

const ev = (n: number): EventIn => ({ account_id: 'a', action: 'x.y', actor: { id: `u${n}` } });

describe('ActivityQueue', () => {
  it('batches, keys every event once and reports rejects', async () => {
    const sent: EventIn[][] = [];
    const dropped: EventIn[] = [];
    const q = new ActivityQueue({
      recordBatch: async (b) => { sent.push(b); return { accepted: b.length - 1, rejected: [{ index: 0, problem: {} }] }; },
    }, { maxBatch: 2, flushMs: 60000, flushOnExit: false, onDrop: (e) => dropped.push(...e) });
    for (let i = 0; i < 3; i++) await q.enqueue(ev(i));
    await q.close();
    expect(sent.map((b) => b.length)).toEqual([2, 1]);
    expect(sent.flat().every((e) => typeof e.idempotency_key === 'string')).toBe(true);
    expect(dropped.length).toBe(2);
  });
  it('closed mode refuses when full', async () => {
    const q = new ActivityQueue({ recordBatch: async () => ({ accepted: 0 }) }, { maxBuffer: 1, maxBatch: 10, flushMs: 60000, flushOnExit: false, mode: 'closed' });
    await q.enqueue(ev(1));
    await expect(q.enqueue(ev(2))).rejects.toThrow('full');
    await q.close();
  });
  it('middleware records after the response with request context', async () => {
    const sent: EventIn[] = [];
    const q = new ActivityQueue({ recordBatch: async (b) => { sent.push(...b); return { accepted: b.length }; } }, { flushMs: 60000, flushOnExit: false });
    let finish = () => {};
    const mw = middleware(q, (_req, ctx) => (ctx.status < 400 ? { ...ev(1), metadata: { path: ctx.path } } : null));
    mw({ method: 'POST', url: '/invoices?x=1', headers: { 'user-agent': 'ua', 'x-request-id': 'r1' }, ip: '1.2.3.4' }, { statusCode: 201, once: (_e, f) => { finish = f; } }, () => {});
    finish();
    await q.close();
    expect(sent[0]?.context).toEqual({ ip: '1.2.3.4', user_agent: 'ua', request_id: 'r1' });
    expect(sent[0]?.metadata).toEqual({ path: '/invoices' });
  });
});
