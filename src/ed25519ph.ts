// RFC 8032 Ed25519ph verification (empty context) in plain BigInt: WebCrypto and Node have Ed25519 but not
// Ed25519ph, which a Rekor v2 hashedrekord entry carries. Verification only, so constant time is not needed.
const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const md = (a: bigint) => ((a % P) + P) % P;
const pw = (b: bigint, e: bigint) => {
  let r = 1n;
  for (b = md(b); e > 0n; e >>= 1n, b = md(b * b)) if (e & 1n) r = md(r * b);
  return r;
};
const D = md(-121665n * pw(121666n, P - 2n));
const SQRT_M1 = pw(2n, (P - 1n) / 4n);
type Pt = [bigint, bigint, bigint, bigint];
const add = ([x1, y1, z1, t1]: Pt, [x2, y2, z2, t2]: Pt): Pt => {
  const a = md((y1 - x1) * (y2 - x2)), b = md((y1 + x1) * (y2 + x2));
  const c = md(t1 * 2n * D * t2), d = md(z1 * 2n * z2);
  const e = b - a, f = d - c, g = d + c, h = b + a;
  return [md(e * f), md(g * h), md(f * g), md(e * h)];
};
const mul = (s: bigint, p: Pt): Pt => {
  let q: Pt = [0n, 1n, 1n, 0n];
  for (; s > 0n; s >>= 1n, p = add(p, p)) if (s & 1n) q = add(q, p);
  return q;
};
const point = (y: bigint, sign: bigint): Pt | null => {
  const xx = md((y * y - 1n) * pw(D * y * y + 1n, P - 2n));
  let x = pw(xx, (P + 3n) / 8n);
  if (md(x * x - xx) !== 0n) x = md(x * SQRT_M1);
  if (md(x * x - xx) !== 0n || (x === 0n && sign === 1n)) return null;
  if ((x & 1n) !== sign) x = P - x;
  return [x, y, 1n, md(x * y)];
};
const le = (b: Uint8Array) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
const decode = (b: Uint8Array): Pt | null => {
  if (b.length !== 32) return null;
  const n = le(b), y = n & ((1n << 255n) - 1n);
  return y >= P ? null : point(y, n >> 255n);
};
const G = point(md(4n * pw(5n, P - 2n)), 0n)!;
const eq = (a: Pt, b: Pt) => md(a[0] * b[2] - b[0] * a[2]) === 0n && md(a[1] * b[2] - b[1] * a[2]) === 0n;
const DOM2 = new TextEncoder().encode('SigEd25519 no Ed25519 collisions\x01\x00');

/** Ed25519ph: `sig` by `pk` over `digest`, the SHA-512 of the message (RFC 8032 5.1, empty context). */
export async function ed25519phVerify(pk: Uint8Array, sig: Uint8Array, digest: Uint8Array): Promise<boolean> {
  if (sig.length !== 64 || digest.length !== 64) return false;
  const a = decode(pk), r = decode(sig.subarray(0, 32)), s = le(sig.subarray(32));
  if (!a || !r || s >= L) return false;
  const msg = new Uint8Array(DOM2.length + 128);
  msg.set(DOM2);
  msg.set(sig.subarray(0, 32), DOM2.length);
  msg.set(pk, DOM2.length + 32);
  msg.set(digest, DOM2.length + 64);
  const h = le(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-512', msg))) % L;
  return eq(mul(s, G), add(r, mul(h, a)));
}
