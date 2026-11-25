// Verify a Watchtower webhook-style delivery: `X-Watchtower-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>." + body)>`.
// Used by the project hooks (`target_labels`, `digest`) and by rule webhooks, which share the scheme.

/**
 * True when `header` carries a `v1` that is the HMAC-SHA256 of `"<t>." + rawBody` under `secret` and `t` is
 * within `toleranceSec` (default 300) of now. `rawBody` must be the bytes as received, not re-serialized JSON.
 * Never throws on a malformed header. `now` (unix seconds) is a test hook.
 */
export async function verifyHookSignature(
  secret: string, rawBody: string | Uint8Array, header: string | null | undefined, o: { toleranceSec?: number; now?: number } = {},
): Promise<boolean> {
  const parts = Object.fromEntries((header ?? '').split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || typeof v1 !== 'string' || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (o.toleranceSec ?? 300)) return false;
  const enc = new TextEncoder();
  const body = typeof rawBody === 'string' ? enc.encode(rawBody) : rawBody;
  const msg = new Uint8Array([...enc.encode(`${t}.`), ...body]);
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sig = Uint8Array.from(v1.toLowerCase().match(/../g)!, (h) => parseInt(h, 16));
  return globalThis.crypto.subtle.verify('HMAC', key, sig, msg); // constant-time compare inside WebCrypto
}
