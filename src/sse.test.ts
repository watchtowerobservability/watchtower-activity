import { describe, expect, it } from 'vitest';
import { Activity, parseSseBlock, readFeedStream } from './index.js';

const body = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
      c.close();
    },
  });

async function all<T>(g: AsyncGenerator<T>) {
  const out: T[] = [];
  for await (const x of g) out.push(x);
  return out;
}

describe('feed stream', () => {
  it('parses new and end blocks, ignores keep-alives', () => {
    expect(parseSseBlock('event: new\ndata: {"count":3,"latest_received_at":"t"}')).toEqual({ event: 'new', count: 3, latest_received_at: 't' });
    expect(parseSseBlock('event: end\ndata: expired')).toEqual({ event: 'end', reason: 'expired' });
    expect(parseSseBlock(': keep-alive')).toBeUndefined();
  });

  it('reads messages split across chunks and stops at end', async () => {
    const r = await all(readFeedStream(body(': ka\n\nevent: new\ndata: {"cou', 'nt":2}\n\nevent: end\ndata: revoked\n\nevent: new\ndata: {"count":9}\n\n')));
    expect(r).toEqual([{ event: 'new', count: 2 }, { event: 'end', reason: 'revoked' }]);
  });

  it('viewer(token).stream() calls the stream route with the viewer token', async () => {
    const calls: { url: string; auth?: string }[] = [];
    const fetch = async (url: any, init: any) => {
      calls.push({ url: String(url), auth: init.headers?.authorization });
      return new Response(body('event: new\ndata: {"count":1}\n\n', 'event: end\ndata: expired\n\n'), { headers: { 'content-type': 'text/event-stream' } });
    };
    const a = new Activity({ secretKey: 'sk_test', baseUrl: 'https://x.test', fetch: fetch as any });
    const r = await all(a.viewer('tok').stream());
    expect(r.map((x) => x.event)).toEqual(['new', 'end']);
    expect(calls).toEqual([{ url: 'https://x.test/v1/activity/feed/stream', auth: 'Bearer tok' }]);
  });
});
