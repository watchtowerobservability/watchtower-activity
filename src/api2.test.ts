import { describe, expect, it, vi } from 'vitest';
import { Activity, type EventIn } from './index.js';

const json = (b: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' }, ...init });

function mk(reply: unknown = {}, init: ResponseInit = {}) {
  const calls: { url: string; method?: string; body: any; auth?: string }[] = [];
  const fetch = vi.fn(async (url: any, i: any) => {
    calls.push({ url: String(url), method: i.method, body: i.body ? JSON.parse(i.body) : undefined, auth: i.headers?.authorization });
    return init.status === 204 ? new Response(null, init) : json(reply, init);
  });
  const a = new Activity({ secretKey: 'sk', apiKey: 'wtk', baseUrl: 'https://x.test', fetch: fetch as any, sleep: async () => {} });
  return { a, calls };
}

describe('pending events and finalize', () => {
  it('records outcome pending and finalizes by key with the secret key', async () => {
    const { a, calls } = mk({ id: 'e1', idempotency_key: 'k/1', outcome: 'success', replay: false });
    const ev: EventIn = { account_id: 'a', actor: { id: 'u' }, action: 'export.run', outcome: 'pending', idempotency_key: 'k/1' };
    expect(ev.outcome).toBe('pending');
    const r = await a.events.finalize('k/1', { outcome: 'success', changes: [{ field: 'rows', new: 3 }], metadata: { took_ms: 9 } });
    expect(r.replay).toBe(false);
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: 'https://x.test/v1/activity/events/by-key/k%2F1', auth: 'Bearer sk' });
    expect(calls[0]!.body).toEqual({ outcome: 'success', changes: [{ field: 'rows', new: 3 }], metadata: { took_ms: 9 } });
  });
});

describe('reads by key and display', () => {
  it('viewer feed.byKey, display flag, and the stream helper hang off feed', async () => {
    const { a, calls } = mk({ id: 'e1' });
    const v = a.viewer('tok');
    await v.feed.byKey('k 1', { display: true });
    expect(calls[0]!.url).toBe('https://x.test/v1/activity/feed/by-key/k%201?display=1');
    expect(calls[0]!.auth).toBe('Bearer tok');
    expect(typeof v.feed.stream).toBe('function');
  });
  it('viewer feed sends display but never locale or total', async () => {
    const { a, calls } = mk({ data: [], next_cursor: null });
    for await (const _ of a.viewer('tok').feed({ display: true, locale: 'de', total: true, limit: 5 })) void _;
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get('display')).toBe('1');
    expect(u.searchParams.has('locale')).toBe(false);
    expect(u.searchParams.has('total')).toBe(false);
  });
  it('project events.byKey and events.page with total, display and locale', async () => {
    const { a, calls } = mk({ data: [], total: 7, total_exact: true });
    await a.events.byKey('prj_1', 'k1', { display: true, locale: 'pt-BR' });
    expect(calls[0]!.url).toBe('https://x.test/v1/projects/prj_1/activity/events/by-key/k1?display=1&locale=pt-BR');
    const p = await a.events.page('prj_1', { total: true, display: true, locale: 'de', cursor: 'c1' });
    expect(p.total).toBe(7);
    const u = new URL(calls[1]!.url);
    expect([u.searchParams.get('total'), u.searchParams.get('display'), u.searchParams.get('locale'), u.searchParams.get('cursor')]).toEqual(['true', '1', 'de', 'c1']);
  });
});

describe('facets, stats', () => {
  it('facets on both paths take metadata.<path>', async () => {
    const { a, calls } = mk({ data: [{ value: 'gold', count: 2 }] });
    await a.events.facets('prj_1', { field: 'metadata.plan.tier', accountId: 'acme', q: 'action:x.*' });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/v1/projects/prj_1/activity/events/facets');
    expect([u.searchParams.get('field'), u.searchParams.get('account_id'), u.searchParams.get('q')]).toEqual(['metadata.plan.tier', 'acme', 'action:x.*']);
    await a.viewer('tok').facets('metadata.plan', { outcome: 'success' });
    const v = new URL(calls[1]!.url);
    expect(v.pathname).toBe('/v1/activity/feed/facets');
    expect([v.searchParams.get('field'), v.searchParams.get('outcome')]).toEqual(['metadata.plan', 'success']);
  });
  it('stats by hour and distinct', async () => {
    const { a, calls } = mk({ data: [{ key: 'account_id', value: 41 }] });
    await a.stats('prj_1', { by: 'hour', from: '2026-11-24T00:00:00Z' });
    expect(new URL(calls[0]!.url).searchParams.get('by')).toBe('hour');
    const r = await a.stats('prj_1', { distinct: 'account_id', q: 'outcome:failure' });
    const u = new URL(calls[1]!.url);
    expect(u.pathname).toBe('/v1/projects/prj_1/activity/stats');
    expect([u.searchParams.get('distinct'), u.searchParams.has('by')]).toEqual(['account_id', false]);
    expect(r.data[0]!.value).toBe(41);
  });
});

describe('sessions, config, hooks, groups', () => {
  it('createViewerSession sends viewer_id', async () => {
    const { a, calls } = mk({ token: 't', url: 'u', expires_at: 'x', jti: 'j' });
    await a.createViewerSession({ accountId: 'acme', viewerId: 'user_1042' });
    expect(calls[0]!.body.viewer_id).toBe('user_1042');
  });
  it('config.plan and apply use mode and the org api key', async () => {
    const { a, calls } = mk({ mode: 'plan', applied: false, changes: [{ kind: 'schema', name: 'x.y', op: 'create' }], summary: { create: 1, update: 0, delete: 0 } });
    const body = { schemas: { 'x.y': { code: 'XY0001' } }, account_groups: { gold: { retention_days: 365 } } };
    const r = await a.config.plan('prj_1', body);
    expect(r.changes[0]!.op).toBe('create');
    await a.config.apply('prj_1', body);
    expect(calls.map((c) => [c.method, c.url, c.auth])).toEqual([
      ['PUT', 'https://x.test/v1/projects/prj_1/activity/config?mode=plan', 'Bearer wtk'],
      ['PUT', 'https://x.test/v1/projects/prj_1/activity/config?mode=apply', 'Bearer wtk'],
    ]);
    expect(calls[0]!.body).toEqual(body);
  });
  it('hooks list, put and delete', async () => {
    const { a, calls } = mk({ kind: 'digest', created_at: 'now', signing_secret: 's' });
    expect((await a.hooks.put('prj_1', 'digest', { url: 'https://h.example/d' })).signing_secret).toBe('s');
    await a.hooks.list('prj_1');
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['PUT', 'https://x.test/v1/projects/prj_1/activity/hooks/digest'],
      ['GET', 'https://x.test/v1/projects/prj_1/activity/hooks'],
    ]);
    expect(calls[0]!.body).toEqual({ url: 'https://h.example/d' });
    const d = mk({}, { status: 204 });
    await d.a.hooks.delete('prj_1', 'target_labels');
    expect(d.calls[0]).toMatchObject({ method: 'DELETE', url: 'https://x.test/v1/projects/prj_1/activity/hooks/target_labels' });
  });
  it('groups and accounts.setGroup', async () => {
    const { a, calls } = mk({ name: 'gold', accounts: 2, retention_days: 365 });
    await a.groups.put('prj_1', 'gold plan', { retention_days: 365 });
    await a.accounts.setGroup('prj_1', 'acme', null);
    await a.groups.list('prj_1');
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['PUT', 'https://x.test/v1/projects/prj_1/activity/account-groups/gold%20plan'],
      ['PUT', 'https://x.test/v1/projects/prj_1/activity/accounts/acme/group'],
      ['GET', 'https://x.test/v1/projects/prj_1/activity/account-groups'],
    ]);
    expect(calls[1]!.body).toEqual({ group: null });
    const d = mk({}, { status: 204 });
    await d.a.groups.delete('prj_1', 'gold');
    expect(d.calls[0]!.method).toBe('DELETE');
  });
});
