# Changelog

## 0.2.0 (2026-11-25)

Catches up with the Activity API of build e5af7937b.

- Open events: `events.finalize(key, { outcome, changes?, metadata? })` settles an event recorded with `outcome: 'pending'` (PATCH `/v1/activity/events/by-key/{key}`).
- Lookup by key: `viewer(token).feed.byKey(key)` and `events.byKey(project, key)`.
- Rendered events: `display: true` on the viewer feed and on project reads (plus `locale` on project reads); `Display` type on events.
- Project reads: `events.page()` with `total: true` (`total`, `total_exact`), `events.facets(project, { field })` and viewer `facets(field)` accept `outcome` and `metadata.<path>`, `stats(project, { by: 'hour' | ... })` and `stats(project, { distinct })`.
- `config.plan(project, body)` / `config.apply(project, body)`: declarative project config with a typed change list.
- `hooks.list/put/delete` for `target_labels` and `digest`; `verifyHookSignature(secret, rawBody, header)` checks `X-Watchtower-Signature`; types `TargetLabelsRequest`, `TargetLabelsResponse`, `DigestPayload`.
- Account groups: `groups.list/put/delete`, `accounts.setGroup(project, account, group | null)`; sessions take `viewerId` (`viewer_id`).
- `viewer(token).feed.stream()` (also `stream()`) is documented and its types (`FeedStreamEvent`, `readFeedStream`) are exported from the package root.
- Optional durable retry spool for `ActivityQueue`: `spool?: SpoolStore` with `MemorySpool` (the previous behavior, still the default) and `FileSpool` (Node only: fsynced NDJSON segments in a directory, replayed after a restart, bounded by `maxBytes` with oldest-first drop and a `dropped` counter). Events keep their idempotency keys, so a replay is safe. With a durable spool a transient send failure keeps the events for the next flush; a permanent 4xx still drops them through `onDrop`.

## 0.1.4 (2026-11-23)

- The npm package no longer ships source maps (`.map` files and their `sourceMappingURL` comments). They pointed at minified SDK internals and made up most of the download; your own app's source maps are unaffected.

## 0.1.3 (2026-11-23)

- Fix: the type declarations now resolve under `moduleResolution: "node16"` / `"nodenext"` (relative imports carry `.js`; before, every import from the package was TS2834/TS2835). The declaration build runs with NodeNext so this cannot regress.

## 0.1.2

- Sync with the monorepo: Hermetica write-up follow-ups and standalone builds in the public mirror.
