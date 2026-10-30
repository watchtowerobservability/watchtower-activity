import { afterEach, describe, expect, it, vi } from 'vitest';
import { Activity, ActivityError, type EventIn } from './index';

const ev = (i = 0): EventIn => ({ account_id: 'a', actor: { id: 'u' }, action: `x.${i}` });
const json = (b: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' }, ...init });

function mk(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; body: any }[] = [];
  const fetch = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    return handler(String(url), init);
  });
  const sleeps: number[] = [];
  const a = new Activity({ secretKey: 'sk_test', baseUrl: 'https://x.test/', fetch: fetch as any, sleep: async (m) => { sleeps.push(m); } });
  return { a, calls, sleeps, fetch };
}

afterEach(() => vi.unstubAllGlobals());

describe('record', () => {
  it('adds an idempotency key only when absent', async () => {
    const { a, calls } = mk(() => json({ accepted: 2 }, { status: 202 }));
    await a.recordBatch([{ ...ev(), idempotency_key: 'mine' }, ev(1)]);
    const [e0, e1] = calls[0]!.body.events;
    expect(e0.idempotency_key).toBe('mine');
    expect(e1.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('chunks into batches of 100', async () => {
    const { a, calls } = mk((_u, i) => json({ accepted: JSON.parse(i.body as string).events.length }, { status: 202 }));
    const r = await a.recordBatch(Array.from({ length: 250 }, (_, i) => ev(i)));
    expect(calls.map((c) => c.body.events.length)).toEqual([100, 100, 50]);
    expect(r.accepted).toBe(250);
    expect(calls[0]!.url).toBe('https://x.test/v1/activity/events');
  });

  it('retries 429/5xx honoring Retry-After and keeps the same keys', async () => {
    let n = 0;
    const { a, calls, sleeps } = mk(() => {
      n++;
      if (n === 1) return json({}, { status: 429, headers: { 'retry-after': '2' } });
      if (n === 2) return json({}, { status: 503 });
      return json({ accepted: 1 }, { status: 202 });
    });
    await a.record(ev());
    expect(n).toBe(3);
    expect(sleeps[0]).toBe(2000);
    expect(sleeps[1]).toBeGreaterThan(0);
    const keys = calls.map((c) => c.body.events[0].idempotency_key);
    expect(new Set(keys).size).toBe(1);
  });

  it('does not retry 4xx and gives up after maxRetries', async () => {
    const { a, fetch } = mk(() => json({ title: 'Bad' }, { status: 400 }));
    await expect(a.record(ev())).rejects.toBeInstanceOf(ActivityError);
    expect(fetch).toHaveBeenCalledTimes(1);
    const m = mk(() => json({ title: 'down' }, { status: 500 }));
    await expect(m.a.record(ev())).rejects.toMatchObject({ status: 500 });
    expect(m.fetch).toHaveBeenCalledTimes(5);
  });
});

describe('problem+json', () => {
  it('maps to ActivityError', async () => {
    const { a } = mk(() => json({ type: 'https://e/validation', title: 'Invalid', status: 422, detail: 'bad action', errors: [1] }, { status: 422, headers: { 'content-type': 'application/problem+json' } }));
    const err = await a.record(ev()).catch((e) => e);
    expect(err).toBeInstanceOf(ActivityError);
    expect(err).toMatchObject({ status: 422, type: 'https://e/validation', title: 'Invalid', detail: 'bad action', extensions: { errors: [1] } });
    expect(err.message).toBe('Invalid: bad action');
  });
  it('survives a non-JSON error body', async () => {
    const { a } = mk(() => new Response('nope', { status: 404 }));
    await expect(a.createViewerSession({ accountId: 'a' })).rejects.toMatchObject({ status: 404, title: 'HTTP 404' });
  });
});

describe('sessions, list, export', () => {
  it('maps session fields', async () => {
    const { a, calls } = mk(() => json({ token: 't', url: 'u', expires_at: 'e' }));
    expect(await a.createViewerSession({ accountId: 'a1', expiresIn: 60 })).toEqual({ token: 't', url: 'u', expiresAt: 'e' });
    expect(calls[0]!.body).toMatchObject({ account_id: 'a1', expires_in: 60 });
  });
  it('list follows cursors', async () => {
    const pages = [{ data: [{ id: '1' }, { id: '2' }], next_cursor: 'c2' }, { data: [{ id: '3' }], next_cursor: null }];
    const { a, calls } = mk(() => json(pages.shift()));
    const ids: string[] = [];
    for await (const e of a.list('p/1', { accountId: 'a', limit: 2 })) ids.push(e.id);
    expect(ids).toEqual(['1', '2', '3']);
    expect(calls[0]!.url).toBe('https://x.test/v1/projects/p%2F1/activity/events?account_id=a&limit=2');
    expect(calls[1]!.url).toContain('cursor=c2');
  });
  it('export returns the body stream', async () => {
    const { a, calls } = mk(() => new Response('a,b\n'));
    const s = await a.export('p', { format: 'csv' });
    expect(await new Response(s).text()).toBe('a,b\n');
    expect(calls[0]!.url).toContain('/activity/export?format=csv');
  });
});

describe('guards', () => {
  it('throws in a browser unless allowBrowser', () => {
    vi.stubGlobal('window', {});
    expect(() => new Activity({ secretKey: 'k' })).toThrow(/server-only/);
    expect(() => new Activity({ secretKey: 'k', baseUrl: 'https://x.test', allowBrowser: true })).not.toThrow();
  });
  it('needs a base URL from the option or WT_API_URL', () => {
    vi.stubEnv('WT_API_URL', '');
    expect(() => new Activity({ secretKey: 'k' })).toThrow(/baseUrl/);
    vi.stubEnv('WT_API_URL', 'https://env.test/');
    expect(new Activity({ secretKey: 'k' }).toJSON()).toEqual({ baseUrl: 'https://env.test' });
    vi.unstubAllEnvs();
  });
  it('does not leak the key when serialized', () => {
    const a = new Activity({ secretKey: 'sk_secret', baseUrl: 'https://x.test' });
    expect(JSON.stringify(a) + String(Object.keys(a))).not.toContain('sk_secret');
  });
});
