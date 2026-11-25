import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityQueue, FileSpool, MemorySpool, SpoolFullError, type EventIn } from './index.js';

const ev = (n: number, extra = ''): EventIn => ({ account_id: 'a', action: 'x.y', actor: { id: `u${n}` }, idempotency_key: `k${n}`, metadata: extra ? { pad: extra } : undefined });
const dirs: string[] = [];
const tmp = async () => { const d = await mkdtemp(join(tmpdir(), 'wt-spool-')); dirs.push(d); return d; };
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe('MemorySpool', () => {
  it('push, peek, ack and a full spool', async () => {
    const s = new MemorySpool({ maxItems: 2 });
    await s.push(ev(1)); await s.push(ev(2));
    await expect(s.push(ev(3))).rejects.toBeInstanceOf(SpoolFullError);
    const p = await s.peek(1);
    expect(p.map((i) => i.event.idempotency_key)).toEqual(['k1']);
    expect(s.size).toBe(2);
    await s.ack(p.map((i) => i.id));
    expect(s.size).toBe(1);
  });
});

describe('FileSpool', () => {
  it('replays unacked events in order after a restart; acked ones are gone', async () => {
    const dir = await tmp();
    const a = new FileSpool({ dir });
    for (let i = 0; i < 5; i++) await a.push(ev(i));
    const first = await a.peek(2);
    await a.ack(first.map((i) => i.id));
    // crash: a new process opens the same directory (the old handle is only closed so the test does not leak it)
    await a.close();
    const b = new FileSpool({ dir });
    const all = await b.peek(10);
    expect(all.map((i) => i.event.idempotency_key)).toEqual(['k2', 'k3', 'k4']);
    expect(b.size).toBe(3);
    await b.ack(all.map((i) => i.id));
    await b.close();
    const c = new FileSpool({ dir });
    expect(await c.peek(10)).toEqual([]);
    await c.close();
  });

  it('skips a torn last line left by a crash', async () => {
    const dir = await tmp();
    const a = new FileSpool({ dir });
    await a.push(ev(1));
    await a.close();
    const seg = (await readdir(dir)).find((f) => f.endsWith('.ndjson'))!;
    await appendFile(join(dir, seg), '{"e":{"account_id":"a","acti');
    const b = new FileSpool({ dir });
    expect((await b.peek(10)).map((i) => i.event.idempotency_key)).toEqual(['k1']);
    await b.push(ev(2));
    await b.close();
    const c = new FileSpool({ dir });
    expect((await c.peek(10)).map((i) => i.event.idempotency_key)).toEqual(['k1', 'k2']);
    await c.close();
  });

  it('ack removes events and deletes fully acked segments', async () => {
    const dir = await tmp();
    const s = new FileSpool({ dir, segmentBytes: 200 });
    for (let i = 0; i < 6; i++) await s.push(ev(i, 'x'.repeat(60)));
    expect((await readdir(dir)).filter((f) => f.endsWith('.ndjson')).length).toBeGreaterThan(1);
    const items = await s.peek(100);
    await s.ack(items.map((i) => i.id));
    expect(s.size).toBe(0);
    await s.close();
    expect(await readdir(dir)).toEqual([]);
  });

  it('is bounded by maxBytes: oldest segments go first and are counted', async () => {
    const dir = await tmp();
    const s = new FileSpool({ dir, segmentBytes: 300, maxBytes: 1000 });
    for (let i = 0; i < 20; i++) await s.push(ev(i, 'x'.repeat(100)));
    expect(s.dropped).toBeGreaterThan(0);
    const left = await s.peek(100);
    expect(left.length + s.dropped).toBe(20);
    expect(left.at(-1)!.event.idempotency_key).toBe('k19');
    expect(left[0]!.event.idempotency_key).not.toBe('k0');
    let bytes = 0;
    for (const f of await readdir(dir)) if (f.endsWith('.ndjson')) bytes += (await import('node:fs')).statSync(join(dir, f)).size;
    expect(bytes).toBeLessThanOrEqual(1000);
    await s.close();
  });
});

describe('ActivityQueue with a spool', () => {
  const client = (sent: EventIn[][], fail: () => unknown) => ({
    recordBatch: async (b: EventIn[]) => { const e = fail(); if (e) throw e; sent.push(b); return { accepted: b.length }; },
  });

  it('a crash before the send is replayed after restart with the same keys', async () => {
    const dir = await tmp();
    const sp = new FileSpool({ dir });
    const down = new ActivityQueue(client([], () => new TypeError('fetch failed')), { spool: sp, flushMs: 60000, flushOnExit: false });
    await down.enqueue({ account_id: 'a', action: 'x.y', actor: { id: 'u' } });
    await down.enqueue(ev(2));
    await down.flush(); // transient failure: events stay in the spool
    expect(down.size).toBe(2);
    // process dies here; a new one starts on the same directory
    await sp.close();
    const sent: EventIn[][] = [];
    const up = new ActivityQueue(client(sent, () => undefined), { spool: new FileSpool({ dir }), flushMs: 60000, flushOnExit: false });
    await up.close();
    expect(sent.flat().length).toBe(2);
    expect(sent.flat().every((e) => typeof e.idempotency_key === 'string' && e.idempotency_key.length > 0)).toBe(true);
    expect(sent.flat()[1]!.idempotency_key).toBe('k2');
    const again = new FileSpool({ dir });
    expect(await again.peek(10)).toEqual([]);
    await again.close();
  });

  it('a permanent 4xx drops the batch even with a durable spool', async () => {
    const dir = await tmp();
    const dropped: EventIn[] = [];
    const q = new ActivityQueue(client([], () => Object.assign(new Error('bad'), { status: 422 })), { spool: new FileSpool({ dir }), flushMs: 60000, flushOnExit: false, onDrop: (e) => dropped.push(...e) });
    await q.enqueue(ev(1));
    await q.close();
    expect(dropped.length).toBe(1);
    expect(q.size).toBe(0);
  });

  it('the default memory spool still drops on any failure', async () => {
    const dropped: EventIn[] = [];
    const q = new ActivityQueue(client([], () => new TypeError('fetch failed')), { flushMs: 60000, flushOnExit: false, onDrop: (e) => dropped.push(...e) });
    await q.enqueue(ev(1));
    await q.close();
    expect(dropped.length).toBe(1);
  });
});

