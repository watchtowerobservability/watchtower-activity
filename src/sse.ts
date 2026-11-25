// Typed reader of `GET /v1/activity/feed/stream` (server-sent events: `new`, then `end`).

/** `new`: events arrived in the session's scope since the last message; `end`: why the stream stopped. */
export type FeedStreamEvent =
  | { event: 'new'; count: number; latest_received_at?: string }
  | { event: 'end'; reason: 'expired' | 'revoked' | 'max_duration' | 'error' | (string & {}) };

/** Parse one SSE block (lines up to a blank line); keep-alive comments and unknown events give `undefined`. */
export function parseSseBlock(block: string): FeedStreamEvent | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  const text = data.join('\n');
  if (event === 'end') return { event: 'end', reason: text };
  if (event !== 'new') return undefined;
  try {
    const d = JSON.parse(text) as { count?: number; latest_received_at?: string };
    return { event: 'new', count: d.count ?? 0, ...(d.latest_received_at ? { latest_received_at: d.latest_received_at } : {}) };
  } catch {
    return undefined;
  }
}

/** Yield each `new`/`end` message of an event-stream body; returns after `end` or when the body closes. */
export async function* readFeedStream(body: ReadableStream<Uint8Array>): AsyncGenerator<FeedStreamEvent, void, undefined> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const ev = parseSseBlock(buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
        if (!ev) continue;
        yield ev;
        if (ev.event === 'end') return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
