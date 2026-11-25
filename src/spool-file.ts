// A durable spool on local disk (Node only): append-only NDJSON segment files, fsync on every push.
import type { FileHandle } from 'node:fs/promises';
import type { EventIn } from './types.js';
import type { SpoolItem, SpoolStore } from './spool.js';

export interface FileSpoolOptions {
  /** Directory for the segment files (created, mode 0700). One process per directory. */
  dir: string;
  /** Pending data kept on disk at most; the oldest segments are dropped to fit (default 256 MiB). */
  maxBytes?: number;
  /** A segment is closed at about this size and a new one started (default 4 MiB). */
  segmentBytes?: number;
}

interface Seg { n: number; bytes: number; acked: Set<number> }
interface Item extends SpoolItem { seg: number; line: number }

const SEG = /^seg-(\d+)\.ndjson$/;
const name = (s: number) => `seg-${String(s).padStart(9, '0')}.ndjson`;

/**
 * Events are appended to `seg-<n>.ndjson` (one JSON line each) and fsynced before `push` resolves; acks are
 * appended to `seg-<n>.ack` and a segment whose events are all acked is deleted. On start the directory is
 * read back: whatever was pushed and not acked is pending again, in order (a torn last line from a crash is
 * skipped). When the pending data would pass `maxBytes`, whole oldest segments are dropped and counted in
 * `dropped`. Replays are safe because events keep their idempotency keys.
 *
 * Events are stored as you pushed them, before the client's `seal` runs: the files hold plaintext of the
 * sealed paths, so keep the directory private (it is created 0700, files 0600).
 *
 * shortcut: pending events are also held in memory (bounded by `maxBytes`), and a directory belongs to one
 * process; move to an index-only memory model or a lock file when either matters.
 */
export class FileSpool implements SpoolStore {
  readonly durable = true;
  /** Events dropped by the size bound since this object was created. */
  dropped = 0;
  readonly #dir: string;
  readonly #max: number;
  readonly #segBytes: number;
  #fs!: typeof import('node:fs/promises');
  #ready: Promise<void> | undefined;
  #chain: Promise<unknown> = Promise.resolve();
  #segs = new Map<number, Seg>();
  #items: Item[] = [];
  #last = 0;
  #active: { n: number; h: FileHandle } | undefined;

  constructor(o: FileSpoolOptions) {
    this.#dir = o.dir.replace(/[\\/]+$/, '');
    this.#max = o.maxBytes ?? 256 * 1024 * 1024;
    this.#segBytes = o.segmentBytes ?? 4 * 1024 * 1024;
  }

  get size() { return this.#items.length; }

  /** Run `f` after every earlier operation, one at a time. */
  #lock<T>(f: () => Promise<T>): Promise<T> {
    const r = this.#chain.then(async () => { await (this.#ready ??= this.#load()); return f(); });
    this.#chain = r.catch(() => {});
    return r;
  }

  async #load(): Promise<void> {
    this.#fs = await import('node:fs/promises');
    await this.#fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const nums = (await this.#fs.readdir(this.#dir)).map((f) => SEG.exec(f)?.[1]).filter((x): x is string => !!x).map(Number).sort((a, b) => a - b);
    for (const s of nums) {
      const acked = new Set<number>();
      try {
        for (const l of (await this.#fs.readFile(`${this.#dir}/${name(s).replace(/\.ndjson$/, '.ack')}`, 'utf8')).split('\n')) if (/^\d+$/.test(l)) acked.add(Number(l));
      } catch { /* no acks yet */ }
      const text = await this.#fs.readFile(`${this.#dir}/${name(s)}`, 'utf8');
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      const seg: Seg = { n: lines.length, bytes: Buffer.byteLength(text), acked };
      lines.forEach((l, i) => {
        if (acked.has(i)) return;
        try {
          const e = (JSON.parse(l) as { e?: EventIn }).e;
          if (e) this.#items.push({ id: `${s}:${i}`, event: e, seg: s, line: i });
          else acked.add(i);
        } catch { acked.add(i); } // a torn line from a crash: nothing to send
      });
      this.#segs.set(s, seg);
      this.#last = s;
    }
    for (const s of [...this.#segs.keys()]) await this.#dropIfDone(s);
  }

  async #unlink(s: number) {
    this.#segs.delete(s);
    for (const f of [name(s), name(s).replace(/\.ndjson$/, '.ack')]) await this.#fs.rm(`${this.#dir}/${f}`, { force: true });
  }

  /** Delete a closed segment whose events are all acked. */
  async #dropIfDone(s: number) {
    const g = this.#segs.get(s);
    if (g && g.acked.size >= g.n && this.#active?.n !== s) await this.#unlink(s);
  }

  async #roll() {
    const a = this.#active;
    if (!a) return;
    this.#active = undefined;
    await a.h.close();
    await this.#dropIfDone(a.n);
  }

  async #open(): Promise<FileHandle> {
    if (this.#active) return this.#active.h;
    const n = ++this.#last;
    const h = await this.#fs.open(`${this.#dir}/${name(n)}`, 'a', 0o600);
    this.#segs.set(n, { n: 0, bytes: 0, acked: new Set() });
    this.#active = { n, h };
    try { const d = await this.#fs.open(this.#dir, 'r'); await d.sync(); await d.close(); } catch { /* directories cannot be synced on Windows */ }
    return h;
  }

  push(event: EventIn): Promise<void> {
    return this.#lock(async () => {
      const line = `${JSON.stringify({ e: event })}\n`;
      const len = Buffer.byteLength(line);
      const total = () => [...this.#segs.values()].reduce((a, s) => a + s.bytes, 0);
      while (total() + len > this.#max) {
        const oldest = Math.min(...this.#segs.keys());
        if (!Number.isFinite(oldest)) break;
        if (oldest === this.#active?.n) {
          if (this.#segs.get(oldest)!.n === 0) break;
          await this.#roll();
          if (!this.#segs.has(oldest)) continue; // it was fully acked and went with the roll
        }
        this.dropped += this.#items.filter((i) => i.seg === oldest).length;
        this.#items = this.#items.filter((i) => i.seg !== oldest);
        await this.#unlink(oldest);
      }
      const cur = this.#active && this.#segs.get(this.#active.n);
      if (cur && cur.n > 0 && cur.bytes + len > this.#segBytes) await this.#roll();
      const h = await this.#open();
      const seg = this.#segs.get(this.#active!.n)!;
      await h.write(line);
      await h.datasync();
      const idx = seg.n++;
      seg.bytes += len;
      this.#items.push({ id: `${this.#active!.n}:${idx}`, event, seg: this.#active!.n, line: idx });
    });
  }

  peek(n: number): Promise<SpoolItem[]> {
    return this.#lock(async () => this.#items.slice(0, n).map(({ id, event }) => ({ id, event })));
  }

  ack(ids: string[]): Promise<void> {
    return this.#lock(async () => {
      const by = new Map<number, number[]>();
      const gone = new Set(ids);
      for (const i of this.#items) if (gone.has(i.id)) (by.get(i.seg) ?? by.set(i.seg, []).get(i.seg)!).push(i.line);
      if (!by.size) return;
      this.#items = this.#items.filter((i) => !gone.has(i.id));
      for (const [s, lines] of by) {
        const g = this.#segs.get(s)!;
        lines.forEach((l) => g.acked.add(l));
        // Not fsynced: a lost ack only means one more replay, which the idempotency key makes harmless.
        await this.#fs.appendFile(`${this.#dir}/${name(s).replace(/\.ndjson$/, '.ack')}`, `${lines.join('\n')}\n`, { mode: 0o600 });
        await this.#dropIfDone(s);
      }
    });
  }

  close(): Promise<void> {
    return this.#lock(() => this.#roll());
  }
}
