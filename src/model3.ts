// Customer-signed events and client-side sealing (WebCrypto: Node 20+, Deno, Bun, workers).

/** Signs every recorded event: Ed25519 over `canonicalJson` of the event as sent, without `signature`. */
export interface SigningKey {
  /** The key registered at `PUT /v1/projects/{prj}/activity/signing-keys`. */
  kid: string;
  /** Base64 of the 32-byte Ed25519 seed (private key), or use `sign` (HSM, KMS). */
  privateKey?: string;
  sign?: (message: Uint8Array) => Promise<Uint8Array> | Uint8Array;
}

/** Encrypts the values at `paths` (dotted from the event root, e.g. `metadata.ssn`) with AES-256-GCM before they leave the process. */
export interface Seal {
  kid: string;
  /** Base64 of the 32-byte AES key. Never sent. */
  key: string;
  paths: string[];
}

export interface SealedEnvelope { $wt_cse: string; alg: 'A256GCM'; iv: string; ct: string }

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const byUtf8 = (a: string, b: string) => {
  const x = enc.encode(a), y = enc.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
};

/**
 * Keys sorted at every level, no whitespace, strings escaped as the server does: the bytes a
 * signature covers. shortcut: numbers print as JSON.stringify does; use integers or strings in signed events.
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort(byUtf8);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

async function signer(k: SigningKey): Promise<(m: Uint8Array) => Promise<Uint8Array>> {
  if (k.sign) return async (m) => k.sign!(m);
  if (!k.privateKey) throw new Error('signingKey needs privateKey or sign');
  // PKCS#8 wrapper of a raw Ed25519 seed (RFC 8410)
  const pkcs8 = new Uint8Array([...unb64('MC4CAQAwBQYDK2VwBCIEIA=='), ...unb64(k.privateKey)]);
  const key = await subtle().importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  return async (m) => new Uint8Array(await subtle().sign('Ed25519', key, m));
}

async function aes(key: string, use: KeyUsage) {
  return subtle().importKey('raw', unb64(key), 'AES-GCM', false, [use]);
}

/** Seals, then signs (the signature covers the envelopes). Returns new objects. */
export async function wire<T extends object>(events: T[], seal?: Seal, signingKey?: SigningKey): Promise<T[]> {
  if (!seal && !signingKey) return events;
  const key = seal ? await aes(seal.key, 'encrypt') : undefined;
  const sign = signingKey ? await signer(signingKey) : undefined;
  const out: T[] = [];
  for (const e of events) {
    const o = JSON.parse(JSON.stringify(e)) as Record<string, unknown>;
    for (const path of seal?.paths ?? []) {
      const parts = path.split('.');
      const last = parts.pop()!;
      let node: unknown = o;
      for (const p of parts) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[p] : undefined;
      if (!node || typeof node !== 'object' || !(last in node)) continue;
      const parent = node as Record<string, unknown>;
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(path) }, key!, enc.encode(canonicalJson(parent[last])));
      parent[last] = { $wt_cse: seal!.kid, alg: 'A256GCM', iv: b64(iv), ct: b64(new Uint8Array(ct)) } satisfies SealedEnvelope;
    }
    if (sign) {
      delete o.signature;
      const sig = await sign(enc.encode(canonicalJson(o)));
      o.signature = { kid: signingKey!.kid, alg: 'ed25519', sig: b64(sig) };
    }
    out.push(o as T);
  }
  return out;
}

/** Decrypts a `$wt_cse` envelope found at `path` (e.g. `metadata.ssn`) with the base64 AES key. Throws when it does not match. */
export async function openSealed(key: string, path: string, envelope: SealedEnvelope): Promise<unknown> {
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: enc.encode(path) }, await aes(key, 'decrypt'), unb64(envelope.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
