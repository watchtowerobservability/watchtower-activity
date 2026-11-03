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
