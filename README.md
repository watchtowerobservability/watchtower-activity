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

// v2
await activity.record({ account_id: 'acme', actor: { id: 'u1', email: 'ann@acme.test' }, action: 'user.role_changed',
  changes: [{ field: 'role', old: 'member', new: 'admin' }], outcome: 'success', context: { request_id: 'req_1' } }, { dryRun: true });
await activity.recordBatch(events, { partial: true }); // up to 1000 per request, rejects listed per event
await activity.createViewerSession({ accountId: 'acme', capabilities: ['read', 'export', 'verify'], locale: 'de', timeZone: 'Europe/Berlin' });
await activity.revokeAccountSessions('acme');
// tokens, streams and rules are project management calls: pass an org API key as `apiKey` in the constructor
const { token: wta } = await activity.accountTokens('prj_1', 'acme').create({ name: 'SIEM pull', capabilities: ['read'] });
await activity.streams('prj_1').create({ kind: 'splunk_hec', config: { url: 'https://hec.example' }, credentials: { token: process.env.HEC_TOKEN! }, format: 'ocsf' });
await activity.rules('prj_1').create({ name: 'New API keys', match: { actions: ['api_key.created'] }, channel: { kind: 'email', to: 'security@example.com' } });
// Event model: operation, anonymous actor, actor/target metadata, target url, device id
await activity.record({ account_id: 'acme', action: 'doc.viewed', operation: 'read', actor: { type: 'anonymous' },
  targets: [{ type: 'doc', id: 'd1', url: 'https://app.example/d/d1', metadata: { folder: 'q3' } }], context: { device_id: 'dev_9' } });
for await (const e of activity.list('prj_1', { q: 'actor:ada action:team.* -outcome:success', order: 'asc' })) console.log(e.id);
await activity.export('prj_1', { format: 'csv', fields: ['id', 'occurred_at', 'actor.email'] });
await activity.export('prj_1', { format: 'ndjson', chain: true, accountId: 'acme' }); // seq, chain_hash, chain_body per line
await activity.samples('prj_1');                       // 25 realistic events into account "sample"
// Right to erasure (apiKey): a second member approves the request
const req = await activity.privacy('prj_1').eraseActor('user_42', { approval: true });
await activity.privacy('prj_1').approve((req as { id: string }).id);
await activity.privacy('prj_1').deleteEvent('evt_1'); // org owners only
// OpenTelemetry: with @opentelemetry/api installed, trace_id/span_id come from the active span (traceContext: false to opt out)
```

Delivery is at-least-once: 429 and 5xx are retried with backoff (Retry-After honored), and batches are sent in chunks of 100. A missing `idempotency_key` gets a random UUID that is reused across retries; for dedupe across process restarts, pass your own stable key. Errors are RFC 9457 problems surfaced as `ActivityError` (`status`, `type`, `title`, `detail`). The key is never logged or serialized.

## Open events, lookup by key, server-side reads

An action that takes time can be recorded when it starts and settled when it ends. Record it with `outcome: 'pending'` and your own `idempotency_key` (a pending event without one is a 422: the key is how you find it again), then finalize it from your backend (secret key, scope `ingest:activity`):

```
PATCH /v1/activity/events/by-key/{key}        {"outcome": "success", "changes": [...], "metadata": {...}}
```

- `outcome` is `success`, `failure` or `denied`. `changes` replaces the event's changes; `metadata` keys are merged over the event's metadata. Same limits and redaction as ingest.
- The stored event and its hash-chain link never change. The final state is stored beside it, and every read (list, feed, export, `outcome:` filters, facets, counts, the ClickHouse copy after its next sync) shows the event in its final state. Streams and the feed also get a `wt.activity.finalized` event (`metadata.event_id`, `idempotency_key`, `outcome`) in the account's log; hide it with the theme's `hideAccessEvents`.
- Unknown key: 404. Finalizing twice with the same body: 200 with `replay: true`, nothing changes. Finalizing with another body, or an event that was not recorded as pending: 409. A project with BYOK encryption on accepts `outcome` only (409 if `changes` or `metadata` are sent).
- A pending event never expires on its own; it stays `pending` until finalized and is pruned by retention like any event. List the stale ones with `q=outcome:pending created:<2026-01-01`. A key whose event has left the live log (past the hot window or erased) is a 404.

Look an event up by the key you recorded it with:

- `GET /v1/activity/feed/by-key/{key}` with a viewer token: the same answer as `GET /v1/activity/feed/{id}` (labels included, the session's scope and theme apply, so another account's event is a 404).
- `GET /v1/projects/{prj}/activity/events/by-key/{key}` with the secret key (or a member).

Read the log from your backend without minting a viewer session: `GET /v1/projects/{prj}/activity/events` accepts the secret key (scope `ingest:activity` or `read:activity`) and takes `account_id`, `q` and the other filters. `total=true` adds `total` and `total_exact` (counted up to 100,000 in the live log), and `GET /v1/projects/{prj}/activity/events/facets?field=action|actor|target_type|target|outcome|metadata.<path>` returns the 100 most frequent values with counts, over the same filters. The project is the credential's own; another project's id is a 404.

### 0.2: typed helpers for the calls above

```ts
await activity.record({ ...event, outcome: 'pending', idempotency_key: 'export-77' });
await activity.events.finalize('export-77', { outcome: 'success', metadata: { rows: 120 } });   // replay: true when repeated
const e = await activity.events.byKey('prj_1', 'export-77', { display: true, locale: 'de' });      // viewer: v.feed.byKey(key)
const page = await activity.events.page('prj_1', { accountId: 'acme', total: true });             // page.total, page.total_exact
await activity.events.facets('prj_1', { field: 'metadata.plan', accountId: 'acme' });              // viewer: v.facets('metadata.plan')
await activity.stats('prj_1', { by: 'hour' });  await activity.stats('prj_1', { distinct: 'account_id' });
const plan = await activity.config.plan('prj_1', { account_groups: { gold: { retention_days: 365 } } });   // apiKey; then config.apply
await activity.groups.put('prj_1', 'gold', { retention_days: 365 });  await activity.accounts.setGroup('prj_1', 'acme', 'gold');
const hook = await activity.hooks.put('prj_1', 'target_labels', { url: 'https://api.example.com/labels' }); // hook.signing_secret, shown once
await activity.createViewerSession({ accountId: 'acme', viewerId: 'user_1042' });
```

Check a hook delivery (`target_labels`, `digest`, rule webhooks) with the raw request body:

```ts
import { verifyHookSignature, type TargetLabelsRequest, type TargetLabelsResponse } from '@watchtowerobservability/activity';
const ok = await verifyHookSignature(secret, rawBody, req.headers['x-watchtower-signature']); // HMAC-SHA256 of "<t>." + body, 5 minute tolerance
```

Live "N new events" notices: `for await (const m of activity.viewer(token).feed.stream()) { if (m.event === 'new') refetch(); }` (`stream()` is the same; types `FeedStreamEvent`; one open stream per session).

### Retry spool (optional)

`ActivityQueue` keeps events in memory by default. Pass a `SpoolStore` (`push`, `peek(n)`, `ack(ids)`, `size`) to keep them across crashes and restarts. Events carry their idempotency key from `enqueue`, so a replay after a crash is deduplicated by the server (delivery stays at-least-once).

```ts
import { Activity, ActivityQueue, FileSpool } from '@watchtowerobservability/activity';
const spool = new FileSpool({ dir: '/var/lib/myapp/activity-spool', maxBytes: 256 * 1024 * 1024 }); // Node only
const queue = new ActivityQueue(activity, { spool });   // on start, events not yet acked are sent first
await queue.enqueue(event);
spool.dropped;   // events dropped (oldest first) because maxBytes was reached
```

`FileSpool` appends NDJSON segment files (fsync on every push, mode 0600 in a 0700 directory), deletes a segment when all its events are acked, and skips a torn last line after a crash. Use one process per directory. Events are stored as you enqueue them, before `seal` runs: keep the directory private. `MemorySpool` is the default and rejects when full (`maxBuffer`). For Redis or a database, implement `SpoolStore` (interface only, no dependency); see the Redis Streams sketch in the `SpoolStore` doc comment (`XADD` to push, `XRANGE` to peek, `XDEL` to ack, `XLEN` for size) and set `durable = true`.

License: Apache-2.0

## Signed events, client-side sealing, viewer API

Register an Ed25519 public key at `PUT /v1/projects/{prj}/activity/signing-keys` (dashboard: Integration > Advanced) and give the client the private key: every event then carries `signature {kid, alg: "ed25519", sig}` over the canonical JSON of the event (keys sorted, no whitespace). The API verifies it, stores it in the hash chain and shows `signed_by`; with `require_signature` on, unsigned events are refused. Use integers or strings in signed values (float formatting differs between languages).

A seal encrypts the listed paths (e.g. `metadata.ssn`) with AES-256-GCM before the event leaves your process (AAD = the path); Watchtower stores the `{"$wt_cse", "alg", "iv", "ct"}` envelope as is and never sees the key. The viewer client makes the browser feed's calls (feed, facets, histogram, saved views, proofs) with a viewer session or account token.

```ts
const a = new Activity({ secretKey, signingKey: { kid: 'k1', privateKey: seedB64 },   // or sign: (msg) => sig
  seal: { kid: 's1', key: aesKeyB64, paths: ['metadata.ssn'] } });                 // WebCrypto (Node 20+)
await openSealed(aesKeyB64, 'metadata.ssn', envelope);
const v = a.viewer(token); await v.histogram(); await v.views.list(); await v.proof('evt_1'); await v.consistency(10);
```
