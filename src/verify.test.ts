import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chainHash, fromB64, merkleLeaf, merkleRoot, origin, verdict, verifyNote, verifyCommitment, verifyConsistency, verifyInclusion, verifyReceipt, verifyRows, verifySignature, type Key } from './verify';

const load = (f: string) => JSON.parse(readFileSync(new URL(`../../../testdata/${f}`, import.meta.url), 'utf8'));
const V = load('activity_verify_vectors.json');
const M = load('activity_merkle_vectors.json');
const keys: Key[] = V.keys.keys;

describe('reference verifier against the shared vectors', () => {
  it('recomputes the chain', async () => {
    expect(await chainHash('', V.chain[0].body)).toBe(V.chain[0].hash);
    expect(await verifyRows(V.chain)).toBeNull();
    const bad = V.chain.map((r: { body: string }, i: number) => (i === 1 ? { ...r, body: r.body.replace('user.update', 'user.delete') } : r));
    expect(await verifyRows(bad)).toBe(2);
  });
  it('checks every signed document', async () => {
    for (const d of [V.checkpoint, V.sth, V.manifest, V.tombstone, V.completeness, ...V.digests]) expect(await verifySignature(d, keys)).toBe(true);
    expect(await verifySignature({ ...V.checkpoint, message: V.checkpoint.message + ' ' }, keys)).toBe(false);
  });
  it('checks Merkle roots, inclusion and consistency', async () => {
    const leaves = await Promise.all(M.data.map((d: string) => merkleLeaf(d)));
    for (const [n, root] of Object.entries(M.roots)) expect(await merkleRoot(leaves.slice(0, Number(n)))).toBe(root);
    for (const c of M.inclusion) expect(await verifyInclusion(leaves[c.index]!, c.index, c.size, c.path, M.roots[c.size])).toBe(true);
    for (const c of M.consistency) expect(await verifyConsistency(c.from, c.to, M.roots[c.from], M.roots[c.to], c.proof)).toBe(true);
    const i = V.disclosure.inclusion;
    expect(await verifyInclusion(i.leaf, i.index, i.size, i.path, i.root)).toBe(true);
  });
  it('checks disclosed fields', async () => {
    for (const f of V.disclosure.fields) expect(await verifyCommitment(f)).toBe(true);
    expect(await verifyCommitment({ ...V.disclosure.fields[0], value: 'someone else' })).toBe(false);
  });
  it('reaches every verdict', async () => {
    const trust = { rekorLogs: { [V.rekor_log.origin]: V.rekor_log.x }, witnesses: { [V.witness_key.name]: V.witness_key.x }, quorum: 1 };
    for (const v of V.verdicts) expect([v.name, await verdict(v.page, keys, v.head, trust)]).toEqual([v.name, v.expect]);
    const a = V.verdicts.find((v: { expect: string }) => v.expect === 'VALID');
    expect(await verdict(a.page, keys, a.head, { ...trust, rekorLogs: {} })).toBe('VALID_UNANCHORED');
    expect(await verdict(a.page, keys, a.head, { ...trust, quorum: 2 })).toBe('VALID_UNANCHORED');
    expect(await verifyNote(V.note.text, V.note.origin, fromB64(keys[0]!.x))).toBe(true);
    for (const o of V.origin_escaping) expect(origin(V.project, o.account)).toBe(o.origin);
  });
  it('checks write receipts', async () => {
    // a receipt signed with the vector key (seed 0x11...) by the server's message format
    const seed = Uint8Array.from({ length: 32 }, () => 0x11);
    const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
    const sk = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
    const r = { id: V.chain[2].id, account_id: V.account, seq: 3, leaf_index: 2, chain_hash: V.chain[2].hash, kid: V.key.kid, message: '', sig: '' };
    r.message = JSON.stringify(['wt.activity.receipt.v1', V.project, V.account, 3, r.chain_hash, 2, 1700000000, 1700003600]);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sk, new TextEncoder().encode(r.message)));
    r.sig = btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifyReceipt(r, keys, V.project)).toBe(true);
    expect(await verifyReceipt({ ...r, seq: 4 }, keys, V.project)).toBe(false);
  });
});
