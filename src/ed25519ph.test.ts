import { describe, expect, it } from 'vitest';
import { ed25519phVerify } from './ed25519ph';

const hex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const sha512 = async (s: string) => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-512', new TextEncoder().encode(s)));

describe('Ed25519ph', () => {
  it('checks the RFC 8032 7.3 vector', async () => {
    const pk = hex('ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf');
    const sig = hex('98a70222f0b8121aa9d30f813d683f809e462b469c7ff87639499bb94e6dae4131f85042463c2a355a2003d062adf5aaa10b8c61e636062aaad11c2a26083406');
    expect(await ed25519phVerify(pk, sig, await sha512('abc'))).toBe(true);
    expect(await ed25519phVerify(pk, sig, await sha512('abd'))).toBe(false);
    const bad = sig.slice();
    bad[63] = (bad[63] ?? 0) ^ 1;
    expect(await ed25519phVerify(pk, bad, await sha512('abc'))).toBe(false);
  });
});
