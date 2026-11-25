import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyHookSignature } from './hooks.js';

const sign = (secret: string, t: number, body: string) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

describe('verifyHookSignature', () => {
  const body = '{"targets":[{"type":"listing","id":"l_81"}]}';
  it('accepts a valid signature, string or bytes', async () => {
    const h = sign('s3cret', 1000, body);
    expect(await verifyHookSignature('s3cret', body, h, { now: 1100 })).toBe(true);
    expect(await verifyHookSignature('s3cret', new TextEncoder().encode(body), h, { now: 1100 })).toBe(true);
  });
  it('rejects a wrong secret, a changed body, a stale timestamp and junk headers', async () => {
    const h = sign('s3cret', 1000, body);
    expect(await verifyHookSignature('other', body, h, { now: 1000 })).toBe(false);
    expect(await verifyHookSignature('s3cret', body + ' ', h, { now: 1000 })).toBe(false);
    expect(await verifyHookSignature('s3cret', body, h, { now: 1301 })).toBe(false);
    expect(await verifyHookSignature('s3cret', body, h, { now: 1301, toleranceSec: 600 })).toBe(true);
    for (const bad of [undefined, null, '', 'garbage', 't=1000', 't=x,v1=00', 't=1000,v1=zz']) expect(await verifyHookSignature('s3cret', body, bad, { now: 1000 })).toBe(false);
  });
});
