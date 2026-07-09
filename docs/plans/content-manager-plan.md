# Content Manager — Plan

**Scope owner note (2026-07-09):** for this iteration the content manager
is **primarily a downloader**. Its job: make sure we fetch the right
information and store it — local files on this device, plus the SQLite
library that future apps/components will build on. It must be
standalone-complete for downloading and archiving under the minimal-request
rules (00-overview Decisions 1, 11). It is **not** a content browser: no
feed UI, no search UI, no media viewing. Those are future components that
consume this service's data.

## What exists today (context, not work)

`app/` is a single Node service (run via `npm run app` in the
devcontainer; bundled to `app/dist/main.mjs`):

- **Protocol server** (`server.js`): ws on `127.0.0.1:8465`, pairing
  token, `{v:1}` frames — `hello/hello_ack`, `seen`, `archive`,
  `bulk_begin/bulk_end` (dormant), `request_template`, `tombstone`,
  `status`. Credential-shaped headers are stripped and never logged.
- **Library** (`db.js`): better-sqlite3, WAL —
  `posts` (one row per logical post, edit-group keyed) / `versions` (one
  per edit, full TweetRecord JSON retained) / `media` / `files`
  (sha256-unique) / `posts_fts` (FTS5). Passive deleted-flagging.
- **Downloader** (`downloader.js`): archive queue, ≤2 concurrent,
  500–1500 ms jittered gaps, headers shaped by the freshest observed
  browser request template, retry 3× then `archive_failed`, CDN hosts
  hard-enforced, 404/410 → deleted flag.
- **Disk writer** (`disk-writer.js`): `<archive_root>/<screen_name>/` with
  the frozen filename convention + sidecars from `@twmd/core`; sha256
  dedupe via the `files` table.

See `ARCHITECTURE.md` for contracts and data flow.

## Work items

### M-1 — Queue survives restarts (bug)

Posts persisted as `state='queued'` are never re-enqueued when the service
restarts: the in-memory queue strands them silently.

- On startup, select queued posts, reconstruct their TweetRecords from
  `versions.raw_record_json`, and enqueue them (normal politeness rules).
- `archive_failed` is NOT resumed (never auto-retry — Decision 11);
  only `queued`.
- Graceful shutdown: finish the in-flight download(s), leave the rest
  queued (they now resume next start).
- Test: ingest archive requests into a file-backed DB, close, reopen via
  the startup path, assert downloads resume and complete.

### M-2 — Service-shaped configuration & deployment

Keep every deployment door open without building for any specific one yet:

- Config (`config.json` / env overrides): ws bind host (default
  `127.0.0.1` — binding wider is an explicit owner action), port,
  `archive_root`, `db_path` already exist; add log verbosity. Document
  every key.
- One documented Docker story (the devcontainer image is 90% of it):
  volumes for config/db/archive, port mapping.
- Extension side already supports a configurable port
  (`localStorage.twmd_app_port`); add host override
  (`localStorage.twmd_app_host`, default `127.0.0.1`) so a non-local
  service is reachable when the owner chooses to.

### M-3 — Operator controls (CLI, since there is no UI)

Small subcommands on the service binary (e.g.
`node app/dist/main.mjs <cmd>`), reading the same config:

- `status` — library counts, queue depth, failure list.
- `requeue <post_key|--all-failed>` — manual re-queue of
  `archive_failed` posts (the only sanctioned retry path).
- `archive <tweet_id>` — queue a library post for archiving without the
  browser (its media URLs are already in the library; CDN GETs only).
- `purge --author X | --before DATE | --state S` — the manual purge tool,
  with a dry-run default and explicit `--yes`.
- `verify` — re-hash files on disk vs the `files` table; report missing/
  mismatched (report only; no auto-repair).

### M-4 — Legacy archive import (DEFERRED — details are a future job)

Placeholder only; do not build yet. Shape agreed so far: it will be a
**partial import** — the owner has years of files in the frozen naming
convention but no live tweet data. Walk the tree, parse stems
(screen_name / tweet_id / timestamp / media index+type all recoverable),
hash bytes into `files`, create stub `posts`/`versions` rows marked as
import-sourced. Dedupe then works immediately, and live capture enriches
stubs for free when a `seen` frame later arrives for an imported id.
Open details (completeness semantics, collision policy, sidecar backfill)
to be scoped in their own pass with the owner.

## Future — ideation only, NOT scoped work

### Acquisition modes (what replaces "bulk", eventually)

The old bulk feature (API-driven timeline ZIP) is removed. The useful
taxonomy for whatever replaces it:

1. **Passively captured while browsing (zero extra requests):** complete
   *metadata* for every tweet scrolled past — text, counts, entities, and
   the media *URLs*. This already works. Note the media *bytes* the page
   itself fetches are downscaled preview variants (timelines load
   small/medium images; videos stream only what's watched), so passive
   capture alone can never yield originals. Capturing those in-flight
   preview bytes was considered and rejected: heavy machinery for
   sub-original quality.
2. **Explicit archive (one CDN GET per file):** original quality requires
   one extra request per media item. This is the archive path that exists
   (button/frame → service downloads `name=orig` / max-bitrate mp4).
3. **Service-side archiving from the library (no browser involved):**
   because every seen record already carries its media URLs, the service
   can archive anything ever seen, any time — retroactive selection
   ("archive everything I saw from author X"), rules, or watch-mode
   ("archive every new seen post matching F as it arrives", which is the
   owner's grab-it-as-it-comes-in idea). Still bounded by the politeness
   rules, and quality-limited to what the URLs offer (full for photos/mp4
   variants).

The natural future bulk is (3): the user just browses (no auto-scroll
automation), the library fills passively, and archiving is a
filter/rule over the library. The `bulk_begin`/`bulk_end` frames and
`_runs/<date>-<label>/` routing already exist and stay dormant until this
is designed.

### Other future components (build on the data, not in this service)

- Content browser / search UI over the library.
- NAS/remote deployment of this service (config from M-2 makes it
  possible; `archive_root` on a network mount is the low-tech version).
- Media-server integration, multi-browser capture.
