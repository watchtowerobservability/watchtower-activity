// Event v2 and SaaS API shapes. snake_case like the API.
/** `id` is required except for `type: "anonymous"` (stored as `anonymous`). */
export interface ActorIn {
  id?: string; name?: string;
  /** "user" | "api_key" | "service" | "system" | "support" | "anonymous" or your own. */
  type?: string; email?: string; url?: string;
  /** Up to 50 keys, 40-character keys, depth 5 (every metadata object shares the 16 KB budget). */
  metadata?: Record<string, unknown>;
  /** An administrator or other privileged actor (PCI DSS 10.2.1.2); query `privileged:true`. */
  privileged?: boolean;
}
/** One hop of a delegation chain: an AI agent, service or support tool acting for the actor. */
export interface ViaHop {
  actor: { id: string; type?: string; name?: string };
  /** The credential the hop used (`type`, `id`, never the secret). */
  credential?: { type: string; id?: string };
  /** For AI agents: the model, e.g. `claude-opus-4`. */
  model?: string;
  /** The tool or function the agent called. */
  tool?: string;
  /** Who approved the hop's action (a human-in-the-loop). */
  approved_by?: string;
  /** Optional Ed25519 signature of the hop (same shape as the event `signature`). */
  sig?: { kid: string; sig: string };
}
export interface TargetIn { type: string; id: string; name?: string; url?: string; metadata?: Record<string, unknown> }
export interface Change { field: string; old?: unknown; new?: unknown }
export type AuthMethod = 'password' | 'sso' | 'oauth' | 'passkey' | 'magic_link' | 'otp' | 'api_key' | 'certificate' | 'other';
export interface Context {
  ip?: string; user_agent?: string; request_id?: string; session_id?: string; device_id?: string;
  /** How the actor authenticated. */
  auth_method?: AuthMethod;
  /** A second factor was used. */
  mfa?: boolean;
  /** Your clock source, e.g. `ntp:pool.ntp.org` (with clock-skew checks). */
  time_source?: string;
}
export type Outcome = 'success' | 'failure' | 'denied';
export type Severity = 'info' | 'notice' | 'warning' | 'critical';
export type Operation = 'create' | 'read' | 'update' | 'delete' | 'access' | 'auth';
export interface EventIn {
  /** Optional: the server derives SHA-256 of the canonical event when absent; the SDK sends a UUID. */
  idempotency_key?: string;
  account_id: string;
  action: string;
  occurred_at?: string;
  /** Schema version of the action. */
  version?: number;
  actor: ActorIn;
  /** The impersonated user when `actor` is staff (shown as "via support"). */
  on_behalf_of?: { id: string; name?: string };
  /** `fingerprint` is a SHA-256 of the key, never the key itself. */
  credential?: { type: string; id?: string; fingerprint?: string };
  target?: TargetIn;
  /** Up to 10. */
  targets?: TargetIn[];
  /** Up to 50. */
  changes?: Change[];
  context?: Context;
  outcome?: Outcome;
  severity?: Severity;
  operation?: Operation;
  metadata?: Record<string, unknown>;
  /** Alias of context.ip. */
  ip?: string;
  trace_id?: string;
  span_id?: string;
  /** Delegation chain, up to 5 hops: `via[0]` acted for `actor`, the last hop called you. */
  via?: ViaHop[];
  /** Count repeats of `key` within `window_secs` (default 60) instead of storing each one. */
  coalesce?: { key: string; window_secs?: number };
}
export interface ActivityEvent extends Omit<EventIn, 'idempotency_key' | 'occurred_at' | 'context'> {
  id: string;
  occurred_at: string;
  received_at: string;
  context?: Context & { country?: string; region?: string; asn?: number };
  schema_version?: number;
  /** The schema's event code plus `S`/`F`/`D` by outcome. */
  code?: string;
  observed_skew_ms?: number;
  skew_flagged?: boolean;
  /** A coalescing summary: `{of, key, count, first_at, last_at}`. */
  coalesced?: { of: string; key: string; count: number; first_at: string; last_at: string };
  /** Lookup table values of the actor and targets. */
  labels?: Record<string, unknown>;
}
/** A signed write receipt (`receipts: true`): where the event sits in its account's chain and Merkle log. */
export interface Receipt {
  index: number; id: string; account_id: string; seq: number; leaf_index: number; chain_hash: string;
  received_at: string;
  /** A signed tree head with at least `leaf_index + 1` leaves exists by then. */
  sth_promise_by: string;
  duplicate?: boolean; kid: string;
  /** The signed JSON array `["wt.activity.receipt.v1", project, account, seq, chain_hash, leaf_index, received_unix, promise_unix]`. */
  message: string;
  /** Base64url Ed25519 over `message`. */
  sig: string;
}
export interface Batch { id: string; state: 'pending' | 'done' | 'failed'; created_at: string; finished_at: string | null; result: RecordResult | null; error: string | null }
export interface Problem { type?: string; title?: string; status?: number; detail?: string; [k: string]: unknown }
export interface RecordResult {
  accepted: number;
  /** Only with `partial: true`. */
  rejected?: { index: number; problem: Problem }[];
  /** Schema `warn` mode, profile misses, clock skew. */
  warnings?: { index: number; message: string }[];
  /** With `receipts: true`. */
  receipts?: Receipt[];
  /** Events counted into a coalescing window. */
  coalesced?: { index: number; key: string; repeats: number }[];
  /** With `async: true`: the queued batch per request of 100 (1000 with `partial`); poll `batch(id)`. */
  batch_ids?: string[];
}
/** POST /v1/activity/events/validate: per event, the normalized stored form, warnings and detector hits; nothing is stored. */
export interface ValidateResult {
  data: {
    index: number; ok: boolean;
    /** Why the event would be refused. */
    problem?: string;
    /** The event as it would be stored (after defaults and redaction). */
    event?: ActivityEvent;
    warnings: string[];
    /** The theme has no display template for the action. */
    missing_template: boolean;
    /** Values redaction would mask or drop: `{path, kind}`. */
    pii: { path: string; kind: string }[];
  }[];
}
export type Capability = 'read' | 'export' | 'verify' | 'manage_streams' | 'manage_tokens' | 'manage_alerts';
export interface ViewerSessionOptions {
  accountId: string;
  actorId?: string;
  /** Seconds, 60 to 3600. */
  expiresIn?: number;
  /** Default ["read"]. */
  capabilities?: Capability[];
  /** BCP 47, e.g. "de" or "pt-BR". */
  locale?: string;
  /** IANA, e.g. "Europe/Berlin". */
  timeZone?: string;
  /** Show one object inside the account, e.g. a workspace. */
  subScope?: { targetType: string; targetId: string };
}
export interface ViewerSession { token: string; url: string; expiresAt: string; jti?: string }
export interface ListFilters {
  accountId?: string; actorId?: string; action?: string; targetType?: string; targetId?: string;
  /** Search: free text and qualifiers such as `actor:ada action:team.* -outcome:success created:>=2026-01-01`. */
  q?: string; outcome?: Outcome; severity?: Severity;
  /** Default `desc` (newest first). */
  order?: 'asc' | 'desc';
  from?: string; to?: string; limit?: number;
  /** `archive`: events restored from cold archives (`archives().restore`). */
  source?: 'live' | 'archive';
  /** RFC 3339: only events received after it. */
  since?: string;
}
export interface AccountToken {
  id: string; name: string; capabilities: Capability[]; created_at: string; last_used_at?: string;
  /** After this the token is refused (absent: never expires). */
  expires_at?: string;
  /** Source networks allowed to use the token (empty: any). */
  allowed_cidrs: string[];
  /** `wta_acct_...`, only in the create response; shown once. Revoked tokens leave the list. */
  token?: string;
}
export interface AccountTokenIn {
  name: string;
  capabilities?: Capability[];
  /** 1 to 366 days (default: never expires). */
  expires_in_days?: number;
  /** Up to 20 networks (`192.0.2.0/24`, `2001:db8::/32` or one address); default any. */
  allowed_cidrs?: string[];
}
/** POST .../accounts/{account_id}/invite: emails a one-time link to the hosted page. */
export interface InviteIn {
  email: string;
  capabilities?: Capability[];
  /** Seconds, 300 to 604800 (default 3 days). */
  expires_in?: number;
  locale?: string;
}
export interface Invite { jti: string; expires_at: string; queued: boolean }
export type StreamKind = 's3' | 'gcs' | 'azure_blob' | 'webhook' | 'https' | 'syslog' | 'kafka' | 'datadog' | 'splunk_hec' | 'sentinel' | 'elastic'
  | 'event_hubs' | 'snowflake' | 'sumo' | 'panther' | 'crowdstrike' | 'google_secops' | 'eventbridge' | 'coralogix';
export interface StreamIn {
  /** Omit for the SaaS's own stream of every account. */
  account_id?: string | null;
  kind: StreamKind;
  /** Per kind, e.g. splunk_hec `{url, index?, sourcetype?}`, s3 `{bucket, region?, endpoint?, prefix?}`, kafka `{brokers: [..], topic}`. */
  config: Record<string, unknown>;
  /** Write-only, never returned, e.g. splunk_hec `{token}`, s3 `{access_key_id, secret_access_key}`. Webhooks take none. */
  credentials?: Record<string, string>;
  format?: 'json' | 'ocsf';
  /** One address that gets an email when the stream breaks (at most daily). */
  notify_email?: string | null;
}
/** PATCH: `notify_email: ""` clears it. */
export type StreamPatch = Partial<Pick<StreamIn, 'config' | 'credentials' | 'format' | 'notify_email'>> & { state?: 'active' | 'paused' };
export interface Stream {
  id: string; account_id: string | null; kind: StreamKind; config: Record<string, unknown>; format: 'json' | 'ocsf';
  state: 'active' | 'paused' | 'error' | 'invalid';
  has_credentials: boolean; last_error: string | null; last_delivered_at: string | null;
  /** `received_at` of the last delivered event. */
  cursor: string; test_pending: boolean; last_test: { at: string; ok: boolean; error: string | null } | null;
  /** `webhook` only, create response only: the Standard Webhooks signing secret. */
  signing_secret?: string;
  created_at: string;
  /** Seconds behind the newest event. */
  lag_seconds: number;
  delivered_24h: number; failed_24h: number; bytes_24h: number;
  /** The last 7 UTC days. */
  daily: { day: string; delivered: number; failed: number; bytes: number }[];
  notify_email: string | null;
  /** S3 / EventBridge role streams: put it in your trust policy. */
  external_id: string | null;
  /** The AWS principal that assumes your role. */
  aws_principal: string | null;
}
export interface RuleIn {
  /** 1 to 100 characters. */
  name: string;
  account_id?: string | null;
  /** Actions are exact names or prefixes ending in `*`; `severity` is a minimum. */
  match: { actions: string[]; outcome?: Outcome; severity?: Severity };
  channel: { kind: 'email'; to: string } | { kind: 'slack' | 'webhook'; url: string };
}
export interface Rule {
  id: string; account_id: string | null; name: string; match: RuleIn['match'];
  /** URLs are not returned. */
  channel: { kind: 'email' | 'slack' | 'webhook'; to?: string };
  enabled: boolean;
  /** `webhook` only, create response only: the `X-Watchtower-Signature` HMAC secret. */
  signing_secret?: string;
  created_at: string;
}
export type RuleChannel = RuleIn['channel'];
export type RulePatch = Partial<Pick<RuleIn, 'name' | 'match'>> & { enabled?: boolean; channel?: RuleChannel };
export interface ExportRequest {
  format?: 'csv' | 'ndjson' | 'ocsf';
  filters?: { account_id?: string; actor_id?: string; action?: string; target_type?: string; outcome?: Outcome; severity?: Severity; from?: string; to?: string };
  /** Gets a 24 h signed download link when the file is ready. */
  notify_email?: string;
}
export interface Export {
  id: string; state: 'pending' | 'running' | 'done' | 'failed' | 'expired'; format: string; filters: ExportRequest['filters'];
  rows: number | null; error: string | null; expires_at: string | null; created_at: string;
  /** Signed link that works without credentials while the file exists. */
  download_url: string | null;
}
/** A schedule goes to a storage stream (`stream_id`) or by email (`emails`, 1 to 5), never both. */
export interface Schedule { id: string; name: string; cron: string; format: string; stream_id: string | null; emails: string[] | null; next_run_at: string; last_run_at: string | null; last_error: string | null }
export interface Archive {
  id: string; account_id: string; from: string; to: string; rows: number; sha256: string; created_at: string;
  restore_pending: boolean; restored_until: string | null; restore_error: string | null;
}
export interface Page<T> { data: T[]; next_cursor?: string | null }
/** A server-side saved view of an account token. */
export interface SavedView { id: string; name: string; q: string; params: Record<string, string>; created_at: string }
/** POST .../actors/{id}/erase with approval, and GET .../erasures. */
export interface ErasureRequest { id: string; actor_id: string; requested_by: string; approved_by?: string | null; state: 'pending' | 'done' | 'cancelled'; created_at: string }
export interface ErasureResult { accounts: number; rows: number; fields_erased: number }
