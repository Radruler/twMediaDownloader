# Architecture — current state (2026-07)

How the rebuilt system works today. For what remains to be built, see
`docs/plans/00-overview.md` (its Decisions section is binding). Historical
plans/handoffs are in `archive/` — reference, not instructions.

## System shape

```
x.com page ──(its own GraphQL requests)──▶ X servers
    │
    ▼ page-interceptor (MAIN world, observe-only)
extension (isolated world): normalizePayload → TweetRecord → TweetCache
    ├─▶ save layer: fetch media (plain GET) → service worker → chrome.downloads
    │        Downloads/twMediaDownloader/<screen_name>/…      [standalone]
    └─▶ ws client ───▶ content manager (app/, Node service)   [connected]
                          ├─ SQLite library (everything seen)
                          ├─ download queue (CDN GETs, polite)
                          └─ disk writer (originals + sidecars, sha256 dedupe)
```

The extension is fully functional standalone; the service upgrades it.
Nothing in the system ever sends a request to `x.com`/`api.x.com` — the
page's own traffic is the only API source; the only outbound requests are
media GETs to `pbs.twimg.com`/`video.twimg.com`, browser-shaped, cookie-free
(from the service side, enforced in code).

## Repo layout

```
packages/core/        TypeScript — ALL shared logic ("@twmd/core")
  src/tweet-record.ts     TweetRecord/TombstoneEvent contract (see below)
  src/graphql-normalize.ts normalizePayload(payload, op, ts) — generic walker
  src/filename.ts         frozen naming convention + Windows-safe sanitizing
  src/media-url.ts        orig-image URLs, size fallbacks, mp4 variant picking
  src/sidecar.ts          .txt/.json sidecar serializers
extension/            plain JS, bundled by esbuild
  content/page-interceptor.js  MAIN world; patches fetch/XHR to OBSERVE
  content/index.js             isolated entry: bridge → normalize → cache,
                               debug surface (window.__twmdDebug)
  content/tweet-cache.js       LRU cache; get/onUpdate/stats (+put for bridge)
  content/save.js              standalone save: cache → plan → fetch → SW port
  content/app-client.js        ws client to the service (reconnect, buffering)
  content/dom-selectors.js     ALL live-DOM selectors (CSS parts UNVERIFIED)
  content/ui-buttons.js        button-injection skeleton (flag-gated, inert)
  background/save-worker.js    'twmd-save' port → chrome.downloads
  background/request-template.js observation-only webRequest header capture
app/                  plain JS Node service ("content manager")
  src/config.js  src/server.js  src/db.js  src/downloader.js
  src/disk-writer.js  src/cli.js  src/main.js
src/                  LEGACY extension — untouched by design until cleanup
build.mjs             builds dist/ (loadable extension) + app/dist/main.mjs
scripts/fake-extension.mjs  replays fixtures over real ws against the service
test/                 vitest suite (see docs/VERIFICATION.md)
docs/CAPTURE_FIXTURES.md    how the owner captures real GraphQL fixtures
```

## The TweetRecord contract

Defined in `packages/core/src/tweet-record.ts` (authoritative). One record
per tweet id: author, `full_text` (note_tweet long text when present, t.co
expanded), entities, counts, `media[]` (type photo/video/animated_gif,
`image_url` base, `video_variants`, alt text, dims), reply/quote/RT links,
`edit_initial_id_str` (logical-post key: `edit_initial_id_str ?? id_str`),
`source_op`, `captured_at_ms`. Field rules:

- `created_at_ms` is `number | null` (snowflake-derived fallback; null only
  for pre-2010 ids) — treat null as "unknown", don't crash.
- `counts.views` null when X hides views; user fields individually nullable.
- Retweets: outer record carries `retweeted_status_id_str`; the inner tweet
  is cached under its own id. Same pattern for quotes.
- Fields may be ADDED with null-safe defaults; never renamed/re-meant.

The normalizer also emits `TombstoneEvent`s (deleted/withheld tweets seen
in timelines) — the service flags those posts `deleted=1`.

## Media URL rules (core, do not reimplement)

- `image_url` ends in a real extension (`…/GqFG….jpg`). Originals REPLACE
  it: `…/GqFG…?format=jpg&name=orig` (never append). 404 fallback chain:
  `orig → 4096x4096 → large`.
- Video/GIF: highest-bitrate `video/mp4` variant; HLS entries have
  `bitrate: null` — skipped. GIFs are single mp4 variants with bitrate 0
  (valid picks; `gif` filename prefix).
- `planMediaDownload(media)` returns the decided `{urls, ext}` — both the
  extension save layer and the service downloader use it.

## Filename convention (frozen)

```
<screen_name>-<tweet_id>-<YYYYMMDD_hhmmss>-{img|gif|vid}<N>.<ext>   media
<screen_name>-<tweet_id>-<YYYYMMDD_hhmmss>.txt / .json             sidecars
```

Timestamp = tweet creation time in LOCAL timezone; `N` = 1-based position
in the tweet. Every path segment goes through `sanitizeForFilename`
(Windows reserved chars/names, control chars, trailing dots). Standalone
saves: `Downloads/twMediaDownloader/<screen_name>/`. Service saves:
`<archive_root>/<screen_name>/` (or `<archive_root>/_runs/<date>-<label>/`
for the dormant bulk-run routing).

## Extension ⇄ service protocol

WebSocket, service = server on `127.0.0.1:8465` by default (host/port
configurable), extension = client with jittered exponential backoff. All
frames JSON `{v: 1, type, …}`.
First frame must be `hello` with the pairing token (printed by the service
on first run; extension reads `localStorage.twmd_app_token` — no token =
standalone, client never starts). Extension-side operator overrides:
`localStorage.twmd_app_host` and `localStorage.twmd_app_port`; any `*.x.com`
host override is refused.

| type | direction | payload |
|---|---|---|
| `hello` / `hello_ack` | ext→app / app→ext | token + versions / versions |
| `seen` | ext→app | `{record}` — every cache put; fire-and-forget, NOT buffered offline |
| `archive` | ext→app | `{record, reason, run_id?}` — buffered ≤200 offline, replayed in order |
| `bulk_begin`/`bulk_end` | ext→app | `{run_id, label}` — dormant (bulk feature removed) |
| `request_template` | ext→app | `{headers, observed_at}` — sanitized browser media-request shape |
| `tombstone` | ext→app | `{event: TombstoneEvent}` |
| `status` | app→ext | `{queue_depth, last_error, archived_count}` |
| `error` | app→ext | close codes: 4001 bad token, 4002 bad version, 4003 hello required |

## Service data model (SQLite, WAL)

```
posts     one row per LOGICAL post (post_key = edit_initial_id_str ?? id_str)
          state: seen → queued → archived | archive_failed;  deleted flag
versions  one row per tweet id (= per edit); full TweetRecord JSON retained
media     per media item; media_key PK (synthetic <id>:<index> when null)
files     written files; sha256 UNIQUE = content dedupe across posts
posts_fts FTS5 over full_text / alt_text / author
```

Ingest is an upsert: later captures refresh counts/last_seen_at; new ids in
an edit-group accrete version rows; state is never downgraded by a re-seen.
On startup, the service reconstructs only persisted `queued` jobs from the
latest `versions.raw_record_json` and resumes them through the normal
downloader. `archive_failed` rows are never auto-retried; the CLI is the
manual retry path.

## Service config and operator controls

Config is `$TWMD_APP_DIR/config.json` (default `~/.twmd-app/config.json`)
with runtime env overrides:

- `bind_host` / `TWMD_APP_HOST` or `TWMD_BIND_HOST` (default `127.0.0.1`)
- `port` / `TWMD_APP_PORT` (default `8465`)
- `archive_root` / `TWMD_ARCHIVE_ROOT`
- `db_path` / `TWMD_DB_PATH`
- `log_level` / `TWMD_LOG_LEVEL`
- `token` (pairing secret; generated on first run)

After `npm run build`, the service binary also exposes operator CLI
commands that read the same config:

```sh
node app/dist/main.mjs status
node app/dist/main.mjs archive <tweet_id-or-post_key>
node app/dist/main.mjs requeue <post_key>
node app/dist/main.mjs requeue --all-failed
node app/dist/main.mjs purge --author <screen_name> [--yes]
node app/dist/main.mjs purge --before 2026-07-01 [--state archive_failed] [--yes]
node app/dist/main.mjs verify
```

`archive` and `requeue` run through the same CDN-only downloader path.
`purge` is dry-run by default and requires `--yes`; `verify` reports
missing or mismatched recorded files only.

## Politeness / safety invariants (enforced in code, tested)

- Service downloader: ≤2 concurrent, 500–1500 ms jittered gap after every
  request, retry 3× then `archive_failed`, never auto-retry later.
- CDN hosts hard-enforced: any URL not on `pbs.twimg.com`/`video.twimg.com`
  is refused before any request.
- Cookie/authorization-shaped headers are stripped at capture (webRequest
  without `extraHeaders`, so Chrome itself withholds them), at the service
  ingest, AND at the downloader. Header values are never logged.

## Sharp edges (learned the hard way — do not rediscover)

1. **Never use `chrome.runtime.sendMessage` for new extension↔worker
   communication.** The legacy `src/js/background.js` (untouched by
   design) answers EVERY unknown message type synchronously with
   `{result:'NG'}`, closing the channel before async work can respond.
   Use `chrome.runtime.connect` ports — `'twmd-save'` and
   `'twmd-template'` exist as patterns.
2. `src/manifest.json` is never edited; `build.mjs` copies `src/` to
   `dist/` and patches the manifest (adds capture content scripts +
   `downloads`/`webRequest` permissions) and regenerates
   `background-wrapper.js` there. **Load `dist/`, not `src/`.**
3. TS infers overly-narrow types from JS default parameter values when
   TS tests import JS modules (e.g. `run = null` → type `null`). Pattern:
   inline JSDoc casts, `run = /** @type {any} */ (null)`.
4. The CSS selectors in `dom-selectors.js` are UNVERIFIED against live
   x.com; only its URL-parsing helpers are trusted. Verify before use.
5. Media bytes travel to the save worker as data: URLs (base64) — fine
   for images, may strain very large videos; revisit if it bites.

## Build & run

Everything runs in the devcontainer (Node 22.12 pinned; see README):

```sh
npm run build   # dist/ (load unpacked) + app/dist/main.mjs
npm test        # vitest suite
npm run typecheck
npm run app     # the content-manager service (config in $TWMD_APP_DIR)
node app/dist/main.mjs status  # operator CLI, after npm run build
```

Debug surface on x.com (extension console context): `__twmdDebug.stats()/
.last()/.get(id)/.save(id)/.archive(id)/.app()/.tombstones()`; overlay via
`localStorage.twmd_debug_overlay='1'`; fixture capture via
`localStorage.twmd_capture_fixtures='1'` (see docs/CAPTURE_FIXTURES.md).

Verification tiers and the owner's live-Chrome walkthrough:
`docs/VERIFICATION.md`.
