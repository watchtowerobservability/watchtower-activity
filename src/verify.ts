// Reference verifier (B6): checks what Watchtower hands out without trusting the server. Shared vectors:
// testdata/activity_verify_vectors.json and activity_merkle_vectors.json (every SDK runs them).
//   chain row     hash = SHA-256(prev_hash bytes || body), links and seqs contiguous
//   signed docs   checkpoint, tree head (STH), manifest, digest, tombstone, completeness, receipt:
//                 Ed25519 (base64url `signature`/`sig`) over the UTF-8 `message` by the key `kid`
//                 from GET /v1/activity/keys ({keys: [{kid, x: base64url raw key}]})
//   Merkle        RFC 9162: leaf = SHA-256(0x00 || chain hash), node = SHA-256(0x01 || l || r)
//   disclosure    commitment = SHA-256(salt bytes || canonical JSON of the value)
import type { Receipt } from './types';
import { ed25519phVerify } from './ed25519ph';

const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;
export interface Key { kid: string; x: string }
export interface Signed { kid: string; message: string; signature?: string; sig?: string }
export interface ChainRow { seq: number; prev_hash: string; hash: string; body: string; id?: string }

export function fromHex(s: string): Bytes {
  return new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
}
export function fromB64(s: string): Bytes {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
export const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const cat = (...p: Uint8Array[]): Bytes => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  p.reduce((o, x) => (out.set(x, o), o + x.length), 0);
  return out;
};
const sha = async (b: Uint8Array): Promise<Bytes> => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', cat(b)));

/** Canonical JSON as the server writes it: sorted keys, no whitespace. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return v === undefined ? 'null' : JSON.stringify(v);
}

/** Hex SHA-256(prev || body) of a chain row. */
export async function chainHash(prevHex: string, body: string): Promise<string> {
  return toHex(await sha(cat(fromHex(prevHex), enc.encode(body))));
}

/** Rows ascending and contiguous after `anchor` (or from seq 1 with an empty link): the first bad seq, or null. */
export async function verifyRows(rows: ChainRow[], anchor?: { seq: number; hash: string } | null): Promise<number | null> {
  let seq = anchor?.seq ?? 0, prev = anchor?.hash ?? '';
  for (const r of rows) {
    let bodySeq: unknown;
    try { bodySeq = (JSON.parse(r.body) as { seq?: unknown }).seq; } catch { bodySeq = undefined; }
    if (r.seq !== seq + 1 || r.prev_hash !== prev || bodySeq !== r.seq || (await chainHash(r.prev_hash, r.body)) !== r.hash) return r.seq;
    seq = r.seq; prev = r.hash;
  }
  return null;
}

/** Ed25519 over `message` by `kid`; false for an unknown kid or a bad signature. */
export async function verifySignature(s: Signed, keys: Key[]): Promise<boolean> {
  const k = keys.find((x) => x.kid === s.kid);
  const sig = s.signature ?? s.sig;
  if (!k || !sig) return false;
  try {
    const key = await globalThis.crypto.subtle.importKey('raw', fromB64(k.x), { name: 'Ed25519' }, false, ['verify']);
    return await globalThis.crypto.subtle.verify({ name: 'Ed25519' }, key, fromB64(sig), enc.encode(s.message));
  } catch {
    return false;
  }
}

export const merkleLeaf = async (chainHashHex: string) => toHex(await sha(cat(new Uint8Array([0]), fromHex(chainHashHex))));
const node = (l: Uint8Array, r: Uint8Array) => sha(cat(new Uint8Array([1]), l, r));

/** RFC 9162 tree hash of leaf hashes (hex). */
export async function merkleRoot(leaves: string[]): Promise<string> {
  const rec = async (l: Uint8Array[]): Promise<Bytes> => {
    if (l.length === 0) return sha(new Uint8Array());
    if (l.length === 1) return cat(l[0]!);
    let k = 1;
    while (k * 2 < l.length) k *= 2;
    return node(await rec(l.slice(0, k)), await rec(l.slice(k)));
  };
  return toHex(await rec(leaves.map(fromHex)));
}

/** RFC 9162 2.1.3.2: `leaf` (hex leaf hash) at `index` of a tree of `size` with `root`. */
export async function verifyInclusion(leaf: string, index: number, size: number, path: string[], root: string): Promise<boolean> {
  if (index >= size) return false;
  let f = index, s = size - 1, r: Uint8Array = fromHex(leaf);
  for (const p of path.map(fromHex)) {
    if (s === 0) return false;
    if (f % 2 === 1 || f === s) {
      r = await node(p, r);
      while (f % 2 === 0 && f !== 0) { f >>= 1; s >>= 1; }
    } else r = await node(r, p);
    f >>= 1; s >>= 1;
  }
  return s === 0 && toHex(r) === root;
}

/** RFC 9162 2.1.4.2: the tree (m, oldRoot) is a prefix of (n, newRoot). */
export async function verifyConsistency(m: number, n: number, oldRoot: string, newRoot: string, proof: string[]): Promise<boolean> {
  if (m < 1 || m > n) return false;
  if (m === n) return proof.length === 0 && oldRoot === newRoot;
  const p: Uint8Array[] = proof.map(fromHex);
  if ((m & (m - 1)) === 0) p.unshift(fromHex(oldRoot));
  let fn = m - 1, sn = n - 1;
  while (fn % 2 === 1) { fn >>= 1; sn >>= 1; }
  let fr = p[0], sr = p[0];
  if (!fr || !sr) return false;
  for (const c of p.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = await node(c, fr); sr = await node(c, sr);
      while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else sr = await node(sr, c);
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && toHex(fr) === oldRoot && toHex(sr) === newRoot;
}

/** A selectively disclosed field: SHA-256(salt || canonical(value)) equals the commitment in the chain body. */
export async function verifyCommitment(f: { salt: string; value: unknown; commitment: string }): Promise<boolean> {
  return toHex(await sha(cat(fromHex(f.salt), enc.encode(canonical(f.value))))) === f.commitment;
}

type ReceiptLike = Pick<Receipt, 'account_id' | 'seq' | 'leaf_index' | 'chain_hash' | 'kid' | 'message' | 'sig'>;

/** A write receipt: signed by a project key, and its message names the receipt's own fields. */
export async function verifyReceipt(r: ReceiptLike, keys: Key[], projectId?: string): Promise<boolean> {
  let m: unknown[];
  try { m = JSON.parse(r.message) as unknown[]; } catch { return false; }
  const shape = m[0] === 'wt.activity.receipt.v1' && (!projectId || m[1] === projectId) && m[2] === r.account_id
    && m[3] === r.seq && m[4] === r.chain_hash && m[5] === r.leaf_index;
  return shape && verifySignature(r, keys);
}

export type Verdict = 'VALID' | 'VALID_UNANCHORED' | 'VALID_PRUNED' | 'INVALID';
type Obj = Record<string, unknown>;
export interface VerifyPage {
  data: ChainRow[]; head_seq?: number; anchor_seq?: number | null;
  checkpoint: (Signed & { seq: number; hash: string }) | null;
  pruned?: (Signed & { from_seq: number; to_seq: number; last_hash: string })[];
  erased?: { from_seq: number; to_seq: number }[];
}
export interface TreeHead extends Signed {
  from_seq: number; to_seq: number; size: number; root: string; note?: string;
  cosignatures?: { line: string }[]; anchor?: { top: string; index: number; size: number; path: string[]; receipts: Obj[] } | null;
}
/** What the verifier pins beyond the project keys: Rekor v2 logs `{origin: base64url key}`, witnesses `{name: key}`, the quorum. */
export interface Trust { rekorLogs?: Record<string, string>; witnesses?: Record<string, string>; quorum?: number }

const parse = (m: string): unknown[] => { try { const v = JSON.parse(m) as unknown; return Array.isArray(v) ? v : []; } catch { return []; } };
const b64std = (s: string): Bytes => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64enc = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const eqb = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The C2SP checkpoint origin (key name) of an account's log; the account percent-encoded. */
export function origin(project: string, account: string): string {
  const safe = /[A-Za-z0-9\-._~]/;
  const acct = [...enc.encode(account)].map((c) => (safe.test(String.fromCharCode(c)) && c < 128 ? String.fromCharCode(c) : `%${c.toString(16).toUpperCase().padStart(2, '0')}`)).join('');
  return `watchtower.dev/activity/${project}/${acct}`;
}
const keyHash = async (name: string, typ: number, pk: Uint8Array) => (await sha(cat(enc.encode(name), new Uint8Array([0x0a, typ]), pk))).slice(0, 4);
function note(text: string): { body: string; sigs: [string, Bytes][] } | null {
  const i = text.indexOf('\n\n');
  if (i < 0) return null;
  const sigs: [string, Bytes][] = [];
  for (const l of text.slice(i + 2).replace(/\n$/, '').split('\n')) {
    const m = /^— (\S+) (\S+)$/.exec(l);
    if (!m) return null;
    try { sigs.push([m[1]!, b64std(m[2]!)]); } catch { return null; }
  }
  return { body: text.slice(0, i + 1), sigs };
}
const ed = async (pk: Uint8Array, sig: Uint8Array, msg: Uint8Array) => {
  try {
    const key = await globalThis.crypto.subtle.importKey('raw', cat(pk), { name: 'Ed25519' }, false, ['verify']);
    return await globalThis.crypto.subtle.verify({ name: 'Ed25519' }, key, cat(sig), cat(msg));
  } catch { return false; }
};
/** A C2SP signed note carries a valid Ed25519 signature by key `name`. */
export async function verifyNote(text: string, name: string, pk: Uint8Array): Promise<boolean> {
  const n = note(text), kh = await keyHash(name, 1, pk);
  if (!n) return false;
  for (const [nm, s] of n.sigs) if (nm === name && s.length === 68 && eqb(s.slice(0, 4), kh) && (await ed(pk, s.slice(4), enc.encode(n.body)))) return true;
  return false;
}
const checkpointOf = (body: string) => {
  const l = body.split('\n');
  try { return { origin: l[0]!, size: Number(l[1]), root: b64std(l[2]!) }; } catch { return null; }
};
async function cosigned(body: string, sigs: [string, Bytes][], name: string, pk: Uint8Array) {
  const kh = await keyHash(name, 4, pk);
  for (const [nm, s] of sigs) {
    if (nm !== name || s.length !== 76 || !eqb(s.slice(0, 4), kh)) continue;
    const t = new DataView(s.buffer, s.byteOffset + 4, 8).getBigUint64(0);
    if (await ed(pk, s.slice(12), enc.encode(`cosignature/v1\ntime ${t}\n${body}`))) return true;
  }
  return false;
}
async function rekorV2(e: Obj, top: string, keys: Key[], logs: Record<string, Bytes>): Promise<boolean> {
  const statement = JSON.stringify(['wt.activity.rekor.v1', top]);
  if (e.statement !== statement) return false;
  try {
    const body = b64std(String(e.canonicalized_body));
    const h = (JSON.parse(new TextDecoder().decode(body)) as { spec: { hashedRekordV002: { data: { digest: string }; signature: { content: string; verifier: { publicKey: { rawBytes: string } } } } } }).spec.hashedRekordV002;
    const k = keys.find((x) => x.kid === e.kid);
    const p = e.inclusion_proof as { log_index: number; tree_size: number; root_hash: string; hashes: string[]; checkpoint: { envelope: string } };
    const dig = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-512', enc.encode(statement)));
    if (!k || h.data.digest !== b64enc(dig) || !eqb(b64std(h.signature.verifier.publicKey.rawBytes), cat(fromHex('302a300506032b6570032100'), fromB64(k.x)))) return false;
    if (!(await ed25519phVerify(fromB64(k.x), b64std(h.signature.content), dig))) return false;
    const root = toHex(b64std(p.root_hash));
    if (!(await verifyInclusion(toHex(await sha(cat(new Uint8Array([0]), body))), p.log_index, p.tree_size, p.hashes.map((x) => toHex(b64std(x))), root))) return false;
    const n = note(p.checkpoint.envelope), c = n && checkpointOf(n.body);
    const pk = c ? logs[c.origin] : undefined;
    return !!c && !!pk && c.size === p.tree_size && toHex(c.root) === root && verifyNote(p.checkpoint.envelope, c.origin, pk);
  } catch { return false; }
}
async function anchored(head: TreeHead, keys: Key[], logs: Record<string, Bytes>): Promise<boolean> {
  const a = head.anchor;
  if (!a || !(await verifyInclusion(await merkleLeaf(head.root), a.index, a.size, a.path, a.top))) return false;
  for (const r of a.receipts ?? []) {
    if (r.kind !== 'rekor' || r.version !== 2) continue;
    for (const e of (r.entries as Obj[] | undefined) ?? []) if (await rekorV2(e, a.top, keys, logs)) return true;
  }
  return false;
}

/**
 * The spec's verdict over one account's merged verify pages (oldest first) and optionally its tree head: INVALID
 * beats VALID_PRUNED (signed tombstones from seq 1) beats VALID (head signed, the rows' Merkle root, anchored by a
 * Rekor v2 receipt in a trusted log, its Ed25519ph signature included, witness quorum met) beats
 * VALID_UNANCHORED. Other receipt kinds are checked by `wtctl activity verify`.
 */
export async function verdict(p: VerifyPage, keys: Key[], head?: TreeHead | null, trust: Trust = {}): Promise<Verdict> {
  const rows = p.data;
  const first = rows[0];
  if (!first) return 'VALID_UNANCHORED';
  if (first.seq === 1 && first.prev_hash) return 'INVALID';
  if ((await verifyRows(rows, { seq: first.seq - 1, hash: first.prev_hash })) !== null) return 'INVALID';
  const body = JSON.parse(first.body) as { project_id?: string; account_id?: string };
  let pruned = false;
  if (first.seq > 1) {
    let next = 1;
    for (const t of [...(p.pruned ?? [])].sort((a, b) => a.from_seq - b.from_seq)) {
      const m = parse(t.message);
      if (!(await verifySignature(t, keys)) || m[0] !== 'wt.activity.pruned.v1' || m[3] !== t.from_seq || m[4] !== t.to_seq || m[5] !== t.last_hash) return 'INVALID';
      if (t.from_seq > next) break;
      next = Math.max(next, t.to_seq + 1);
      if (t.to_seq === first.seq - 1 && t.last_hash !== first.prev_hash) return 'INVALID';
    }
    const erased = (p.erased ?? []).some((e) => e.from_seq <= next && e.to_seq >= first.seq - 1);
    if (next < first.seq && !erased) return 'INVALID';
    pruned = true;
  }
  const hashes = new Map(rows.map((r) => [r.seq, r.hash]));
  const cp = p.checkpoint;
  if (cp) {
    const m = parse(cp.message);
    if (m[0] !== 'wt.activity.checkpoint.v1' || m[3] !== cp.seq || m[4] !== cp.hash || (hashes.get(cp.seq) ?? cp.hash) !== cp.hash || !(await verifySignature(cp, keys))) return 'INVALID';
  }
  let ok = false;
  if (head) {
    const m = parse(head.message);
    if (m[0] !== 'wt.activity.merkle.v1' || m[3] !== head.from_seq || m[4] !== head.to_seq || m[5] !== head.root
      || head.size !== head.to_seq - head.from_seq + 1 || !(await verifySignature(head, keys))) return 'INVALID';
    const cover: string[] = [];
    for (let s = head.from_seq; s <= head.to_seq; s++) { const h = hashes.get(s); if (h) cover.push(h); }
    if (cover.length === head.size) {
      if ((await merkleRoot(await Promise.all(cover.map(merkleLeaf)))) !== head.root) return 'INVALID';
      const k = keys.find((x) => x.kid === head.kid);
      if (head.note) {
        const n = note(head.note), c = n && checkpointOf(n.body);
        if (!k || !c || c.size !== head.size || toHex(c.root) !== head.root
          || !(await verifyNote(head.note, origin(body.project_id ?? '', body.account_id ?? ''), fromB64(k.x)))) return 'INVALID';
      }
      let text = head.note ?? '';
      for (const c of head.cosignatures ?? []) if (!text.includes(c.line)) text += `${c.line}\n`;
      const n = text ? note(text) : null;
      let count = 0;
      for (const [name, x] of Object.entries(trust.witnesses ?? {})) if (n && (await cosigned(n.body, n.sigs, name, fromB64(x)))) count++;
      const logs = Object.fromEntries(Object.entries(trust.rekorLogs ?? {}).map(([o, x]) => [o, fromB64(x)]));
      ok = count >= (trust.quorum ?? 0) && (await anchored(head, keys, logs));
    }
  }
  if (pruned) return 'VALID_PRUNED';
  return ok ? 'VALID' : 'VALID_UNANCHORED';
}
