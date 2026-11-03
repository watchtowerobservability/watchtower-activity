import { afterEach, describe, expect, it, vi } from 'vitest';
import { Activity, ActivityError, type EventIn } from './index';

const ev = (i = 0): EventIn => ({ account_id: 'a', actor: { id: 'u' }, action: `x.${i}` });
const json = (b: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' }, ...init });

function mk(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; body: any; auth?: string; method?: string }[] = [];
  const fetch = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.authorization, method: init.method });
    return handler(String(url), init);
  });
  const sleeps: number[] = [];
  const a = new Activity({ secretKey: 'sk_test', apiKey: 'wtk_test', baseUrl: 'https://x.test/', fetch: fetch as any, sleep: async (m) => { sleeps.push(m); } });
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

describe('v2', () => {
  it('dryRun validates without recording', async () => {
    const { a, calls } = mk(() => json({ data: [{ index: 0, ok: true, warnings: ['metadata.plan is not in the schema'], missing_template: true, pii: [] }] }));
    const r = await a.record({ ...ev(), changes: [{ field: 'role', old: 'member', new: 'admin' }], outcome: 'success' }, { dryRun: true });
    expect(calls[0]!.url).toBe('https://x.test/v1/activity/events/validate');
    expect(calls[0]!.body.events[0].changes[0].new).toBe('admin');
    expect(r.data[0]!.missing_template).toBe(true);
  });
  it('partial batches of 1000 shift reject indexes', async () => {
    const { a, calls } = mk((_u, i) => {
      const n = JSON.parse(i.body as string).events.length;
      return json({ accepted: n - 1, rejected: [{ index: 0, problem: { title: 'bad' } }] }, { status: 202 });
    });
    const r = await a.recordBatch(Array.from({ length: 1500 }, (_, i) => ev(i)), { partial: true });
    expect(calls.map((c) => c.body.events.length)).toEqual([1000, 500]);
    expect(calls[0]!.url).toContain('?partial=true');
    expect(r).toEqual({ accepted: 1498, rejected: [{ index: 0, problem: { title: 'bad' } }, { index: 1000, problem: { title: 'bad' } }] });
  });
  it('viewer session sends capabilities, locale, time zone, sub scope', async () => {
    const { a, calls } = mk(() => json({ token: 't', url: 'u', expires_at: 'e', jti: 'j' }));
    const s = await a.createViewerSession({ accountId: 'a', capabilities: ['read', 'export'], locale: 'de', timeZone: 'Europe/Berlin', subScope: { targetType: 'workspace', targetId: 'w1' } });
    expect(s.jti).toBe('j');
    expect(calls[0]!.body).toMatchObject({ capabilities: ['read', 'export'], locale: 'de', time_zone: 'Europe/Berlin', sub_scope: { target_type: 'workspace', target_id: 'w1' } });
  });
  it('revocation, tokens, streams and rules hit the contract paths', async () => {
    const { a, calls } = mk((_u, i) => (i.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ data: [], id: 's1', ok: true })));
    await a.revokeSession('j/1');
    await a.revokeAccountSessions('acme');
    await a.accountTokens('p', 'acme').create({ name: 'siem', capabilities: ['read'] });
    await a.accountTokens('p', 'acme').revoke('t1');
    await a.streams('p').create({ kind: 'splunk_hec', config: { url: 'https://h' }, credentials: { token: 's' }, format: 'ocsf' });
    await a.streams('p').test('s1');
    await a.rules('p').create({ name: 'keys', match: { actions: ['api_key.created'] }, channel: { kind: 'email', to: 'sec@acme.test' } });
    await a.export('p', { format: 'ocsf', targetId: 'i1', q: 'inv' });
    expect(calls.map((c) => c.url.replace('https://x.test', ''))).toEqual([
      '/v1/activity/sessions/j%2F1', '/v1/activity/sessions/revoke', '/v1/projects/p/activity/accounts/acme/tokens',
      '/v1/projects/p/activity/accounts/acme/tokens/t1', '/v1/projects/p/activity/streams', '/v1/projects/p/activity/streams/s1/test',
      '/v1/projects/p/activity/rules', '/v1/projects/p/activity/export?target_id=i1&q=inv&format=ocsf',
    ]);
    expect(calls[1]!.body).toEqual({ account_id: 'acme' });
    expect(calls[1]!.auth).toBe('Bearer sk_test');
    expect(calls[2]!.auth).toBe('Bearer wtk_test');
  });

  it('privacy calls: erase with approval, approve, delete one event', async () => {
    const { a, calls } = mk(() => json({ data: [], accounts: 1, rows: 2, fields_erased: 3 }));
    await a.privacy('p').eraseActor('u/1', { approval: true });
    await a.privacy('p').eraseActor('u2');
    await a.privacy('p').erasures();
    await a.privacy('p').approve('r1');
    await a.privacy('p').deleteEvent('e1');
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://x.test/v1/projects/p/activity', '')}`)).toEqual([
      'POST /actors/u%2F1/erase', 'POST /actors/u2/erase', 'GET /erasures', 'POST /erasures/r1/approve', 'DELETE /events/e1',
    ]);
    expect(calls[0]!.body).toEqual({ approval: { required: true } });
    expect(calls[1]!.body).toEqual({});
    expect(calls[4]!.auth).toBe('Bearer wtk_test');
  });

  it('fills trace ids from the span, keeps the caller\'s, and retries transport errors', async () => {
    let fail = 2;
    const calls: any[] = [];
    const sleeps: number[] = [];
    const a = new Activity({
      secretKey: 'sk', baseUrl: 'https://x.test', sleep: async (m) => { sleeps.push(m); },
      traceContext: () => ({ trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', span_id: '00f067aa0ba902b7' }),
      fetch: (async (_u: any, init: any) => {
        if (fail-- > 0) throw new TypeError('fetch failed');
        calls.push(JSON.parse(init.body));
        return json({ accepted: 2 }, { status: 202 });
      }) as any,
    });
    await a.recordBatch([ev(), { ...ev(1), trace_id: 'aa'.repeat(16), span_id: 'bb'.repeat(8) }]);
    expect(sleeps.length).toBe(2);
    const [e0, e1] = calls[0].events;
    expect([e0.trace_id, e0.span_id]).toEqual(['4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7']);
    expect([e1.trace_id, e1.span_id]).toEqual(['aa'.repeat(16), 'bb'.repeat(8)]);
    const off = mk(() => json({ accepted: 1 }, { status: 202 }));
    await new Activity({ secretKey: 'sk', baseUrl: 'https://x.test', traceContext: false, fetch: off.fetch as any }).record(ev());
    expect(off.calls[0]!.body.events[0].trace_id).toBeUndefined();
  });

  it('samples, export fields and chain, list order', async () => {
    const { a, calls } = mk(() => json({ account_id: 'sample', accepted: 25, data: [], next_cursor: null }, { status: 202 }));
    expect((await a.samples('p')).accepted).toBe(25);
    await a.samples('p', { accountId: 'demo' });
    await a.export('p', { format: 'ndjson', fields: ['id', 'actor.email'], chain: true });
    for await (const _ of a.list('p', { order: 'asc', q: 'actor:ada' })) { /* empty */ }
    expect(calls.map((c) => c.url.replace('https://x.test', ''))).toEqual([
      '/v1/projects/p/activity/samples', '/v1/projects/p/activity/samples',
      '/v1/projects/p/activity/export?format=ndjson&fields=id%2Cactor.email&chain=1',
      '/v1/projects/p/activity/events?q=actor%3Aada&order=asc',
    ]);
    expect([calls[0]!.body, calls[1]!.body]).toEqual([{}, { account_id: 'demo' }]);
  });
});

describe('residency, tokens, invites, delivery', () => {
  it('follows a 421 wrong_region once', async () => {
    const { a, calls } = mk((u) => (u.startsWith('https://x.test')
      ? json({ title: 'Wrong region', code: 'wrong_region', api_base_url: 'https://eu.test/' }, { status: 421 })
      : json({ accepted: 1 }, { status: 202 })));
    expect((await a.record(ev())).accepted).toBe(1);
    expect(calls.map((c) => c.url)).toEqual(['https://x.test/v1/activity/events', 'https://eu.test/v1/activity/events']);
  });
  it('region resolves the API base from the directory', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: any) => {
      calls.push(String(url));
      return String(url).endsWith('/v1/regions')
        ? json({ current: 'us', data: [{ region: 'eu', api_base_url: 'https://eu.test' }] })
        : json({ accepted: 1 }, { status: 202 });
    });
    const a = new Activity({ secretKey: 'sk', baseUrl: 'https://us.test', region: 'eu', fetch: fetch as any });
    await a.record(ev());
    await a.record(ev());
    expect(calls).toEqual(['https://us.test/v1/regions', 'https://eu.test/v1/activity/events', 'https://eu.test/v1/activity/events']);
  });
  it('account token limits, invites, replay, restore', async () => {
    const { a, calls } = mk(() => json({ id: 'x', jti: 'j', expires_at: 'e', queued: true }));
    await a.accountTokens('p', 'acme').create({ name: 'siem', expires_in_days: 30, allowed_cidrs: ['10.0.0.0/8'] });
    expect((await a.invite('p', 'acme', { email: 'ann@acme.test', capabilities: ['read'] })).queued).toBe(true);
    await a.streams('p').replay('s1', { from: '2026-10-01T00:00:00Z' });
    await a.archives('p').restore('ar1', { days: 3 });
    expect(calls.map((c) => [c.url.replace('https://x.test', ''), c.body])).toEqual([
      ['/v1/projects/p/activity/accounts/acme/tokens', { name: 'siem', expires_in_days: 30, allowed_cidrs: ['10.0.0.0/8'] }],
      ['/v1/projects/p/activity/accounts/acme/invite', { email: 'ann@acme.test', capabilities: ['read'] }],
      ['/v1/projects/p/activity/streams/s1/replay', { from: '2026-10-01T00:00:00Z' }],
      ['/v1/projects/p/activity/archives/ar1/restore', { days: 3 }],
    ]);
    expect(calls[0]!.auth).toBe('Bearer wtk_test');
  });
  it('viewer client sends the viewer token and the filters', async () => {
    const { a, calls } = mk((u) => json(u.includes('/feed?') ? { data: [{ id: 'e1' }], next_cursor: null } : { data: [], id: 'x1' }));
    const v = a.viewer('vt_1');
    const got: string[] = [];
    for await (const e of v.feed({ q: 'metadata.plan:pro' })) got.push(e.id);
    await v.facets('actor', { action: 'team.invite' });
    await v.exports.create({ format: 'csv' });
    await v.views.create({ name: 'denied', q: 'outcome:denied' });
    await v.consistency(4, 9);
    expect(got).toEqual(['e1']);
    expect(calls.map((c) => c.url.replace('https://x.test', ''))).toEqual([
      '/v1/activity/feed?q=metadata.plan%3Apro',
      '/v1/activity/feed/facets?action=team.invite&field=actor',
      '/v1/activity/exports',
      '/v1/activity/views',
      '/v1/activity/feed/consistency?from_size=4&to_size=9',
    ]);
    expect(calls.every((c) => c.auth === 'Bearer vt_1')).toBe(true);
  });
});
