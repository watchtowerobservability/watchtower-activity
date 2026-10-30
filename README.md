# @watchtowerobservability/activity

Server SDK for the Watchtower hosted activity log. Node 18+, zero runtime dependencies, ESM and CommonJS. Throws at construction in a browser so the secret key never ships (use `@watchtowerobservability/activity-web` there).

```ts
import { Activity } from '@watchtowerobservability/activity';
// baseUrl: your Watchtower API URL (or set WT_API_URL)
const activity = new Activity({ secretKey: process.env.WT_SECRET_KEY!, baseUrl: process.env.WT_API_URL });

await activity.record({ account_id: 'acme', actor: { id: 'u1', name: 'Ann' }, action: 'invoice.paid',
  target: { type: 'invoice', id: 'i1', name: 'INV-7' }, idempotency_key: 'invoice-i1-paid' });

const { token, url } = await activity.createViewerSession({ accountId: 'acme', expiresIn: 900 });
for await (const e of activity.list('prj_1', { accountId: 'acme' })) console.log(e.action);
const stream = await activity.export('prj_1', { format: 'ndjson' });
```

Delivery is at-least-once: 429 and 5xx are retried with backoff (Retry-After honored), and batches are sent in chunks of 100. A missing `idempotency_key` gets a random UUID that is reused across retries; for dedupe across process restarts, pass your own stable key. Errors are RFC 9457 problems surfaced as `ActivityError` (`status`, `type`, `title`, `detail`). The key is never logged or serialized.

License: Apache-2.0
