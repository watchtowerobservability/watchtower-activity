import { describe, expect, it } from 'vitest';
import { Activity, canonicalJson, openSealed } from './index';

const SEED = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const VECTOR = { idempotency_key: 'k1', account_id: 'acme', action: 'user.login', actor: { id: 'u_1', name: 'Zoë "Z"' },
  metadata: { z: null, n: 3, ok: true, tags: ['a', 'b'], ctl: 'a\nb\u0001' } };

function mk(o: object) {
  const bodies: any[] = [];
  const fetch = async (_: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response('{"accepted":1}', { status: 202, headers: { 'content-type': 'application/json' } });
  };
  return { a: new Activity({ secretKey: 'sk', baseUrl: 'https://x.test', fetch: fetch as any, traceContext: false, ...o }), bodies };
}

describe('model 3', () => {
  it('canonical json and the cross-SDK signature vector', async () => {
    expect(canonicalJson(VECTOR)).toBe(
      '{"account_id":"acme","action":"user.login","actor":{"id":"u_1","name":"Zoë \\"Z\\""},"idempotency_key":"k1","metadata":{"ctl":"a\\nb\\u0001","n":3,"ok":true,"tags":["a","b"],"z":null}}');
    const { a, bodies } = mk({ signingKey: { kid: 'k1', privateKey: SEED } });
    await a.record(VECTOR as any);
    expect(bodies[0].events[0].signature).toEqual({ kid: 'k1', alg: 'ed25519',
      sig: '5JHlGdMEF18X64WAemXgrE6lQQ1jUtOUR0/wVekiIpCY5513Xsbt4v5BG/2bFxlLDTaz6rvhQz4GtQdSqXqmAQ==' });
  });

  it('seals then signs; opens with the path only', async () => {
    let signed = '';
    const { a, bodies } = mk({ seal: { kid: 's1', key: SEED, paths: ['metadata.ssn', 'metadata.absent'] },
      signingKey: { kid: 'k1', sign: (m: Uint8Array) => { signed = new TextDecoder().decode(m); return new Uint8Array(64); } } });
    await a.record({ account_id: 'a', action: 'x', actor: { id: 'u' }, metadata: { ssn: '123' } } as any);
    const sent = bodies[0].events[0];
    expect(sent.metadata.ssn.$wt_cse).toBe('s1');
    expect('absent' in sent.metadata).toBe(false);
    expect(await openSealed(SEED, 'metadata.ssn', sent.metadata.ssn)).toBe('123');
    await expect(openSealed(SEED, 'metadata.x', sent.metadata.ssn)).rejects.toThrow();
    const { signature: _, ...rest } = sent;
    expect(signed).toBe(canonicalJson(rest));
  });
});
