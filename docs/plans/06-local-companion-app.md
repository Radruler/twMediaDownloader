# Plan 06 — Local Companion App (Complete Plan)

Status: **accepted and fully decided** (owner decisions 2026-07-07 — see 00-overview Decisions
Log; this doc bakes them in). Supersedes plan 05's verdict: the target end-state is this D+E
hybrid — extension captures, app archives — without CDP.

## 0. Goals / non-goals

**Goals**
- The browser (extension) is the *only* process that ever touches X's API, and only passively
  (plan 02). The app never holds `x.com` credentials or cookies.
- Auto-record **every tweet scrolled past** into a local "seen" feed; a queue lets the user
  formalize items into the archive (Decision 19).
- App performs all media downloading (CDN only, browser-shaped requests), writes originals +
  sidecars to arbitrary disk paths, dedupes, and provides a searchable library.
- Infinite retention, local-only, manual purge tool (Decision 14).

**Non-goals (explicitly later)**
- Media-server integration / serving the archive (Decision 13 note).
- Multi-browser/profile capture (Decision 16) — protocol allows it; don't build UI for it.
- Tray autostart (Decision 15) — manual launch in v1.
- Thumbnail generation/storage of any kind (Decision 21).

## 1. Architecture

```
x.com page ──(its own GraphQL requests)──▶ X servers
    │
    ▼ page-world interceptor (plan 02, unchanged)
extension: normalize → TweetRecord ──┬─▶ in-page buttons (plan 03)
                                     ├─▶ chrome.downloads + sidecar    [standalone mode, plan 04]
                                     └─▶ ws://127.0.0.1:<port>  ─────▶ app   [connected mode]
                                                                        │
                                                        ┌───────────────┼───────────────┐
                                                        ▼               ▼               ▼
                                                  SQLite (seen/     download queue   disk writer
                                                  queue/archive)    (CDN GETs)       (originals+sidecars)
                                                        └───────── library UI ────────┘
```

Invariants:
- Extension is fully functional standalone; app connection *upgrades*, never gates (buttons keep
  working via `chrome.downloads` when the app is down).
- Nothing in the system ever polls or probes X. Deleted-tweet detection, edit detection,
  everything derives from traffic the user's browsing naturally generates (Decisions 18, 20).

## 2. Extension ⇄ app protocol

Transport: WebSocket, app = server on `127.0.0.1:<configurable port, default 8465>`, extension =
client, exponential-backoff reconnect, heartbeat ping. All frames JSON, `{v: 1, type, ...}`.
Versioned; app rejects unknown major versions with a clear error the extension surfaces.

Auth: on first run the app displays a pairing token; user pastes it into extension options once.
Extension sends it in the first frame (`hello`); app drops unauthenticated connections. Bind to
127.0.0.1 only.

| type | direction | payload | notes |
|---|---|---|---|
| `hello` | ext→app | `{token, ext_version, core_version}` | app replies `hello_ack` w/ app+core versions; mismatched `core` majors → warn |
| `seen` | ext→app | `{record: TweetRecord}` | fire-and-forget, every captured tweet (dedup on app side) |
| `archive` | ext→app | `{record, reason: 'button'\|'bulk', run_id?}` | explicit user action → enqueue download |
| `bulk_begin`/`bulk_end` | ext→app | `{run_id, label}` | brackets a scroll-driven bulk run → folder-per-run (Decision 13) |
| `request_template` | ext→app | `{headers: {...}, observed_at}` | browser's real media-request headers (via observation-only `chrome.webRequest` on `pbs.twimg.com`/`video.twimg.com`); **no cookies ever** |
| `tombstone` | ext→app | `{event: TombstoneEvent}` | added during M1 implementation (2026-07): §3 requires captured tombstones to set `deleted=1`, but this table had no frame carrying them |
| `status` | app→ext | `{queue_depth, last_error, archived_count}` | drives a small badge in the extension |

Offline behavior: extension buffers `archive` messages (bounded, ~200) while disconnected and
replays on reconnect; `seen` messages are *not* buffered beyond the in-memory cache (the library
misses only what was scrolled while the app was closed — acceptable).

## 3. Data model (SQLite, WAL mode)

Two-tier model (Decision 19): **seen** (metadata only, automatic) → **queue** (user picked, or
rule-based later) → **archived** (media on disk).

```sql
posts(            -- one row per LOGICAL post (edit-group), Decision 17
  post_key TEXT PRIMARY KEY,          -- edit_control initial tweet id, else id_str
  author_id, author_screen_name, first_seen_at, last_seen_at,
  state TEXT CHECK(state IN ('seen','queued','archived','archive_failed')),
  deleted INTEGER DEFAULT 0,          -- Decision 18: set passively (tombstone capture / 404 on archive)
  deleted_detected_at
)
versions(         -- one row per tweet id (= per edit), Decision 17
  id_str TEXT PRIMARY KEY, post_key REFERENCES posts,
  created_at_ms, full_text, lang, counts_json, entities_json,
  source_op, captured_at_ms, raw_record_json      -- full TweetRecord for fidelity
)
media(
  media_key TEXT PRIMARY KEY, id_str REFERENCES versions,
  type, position, orig_url, video_variants_json, alt_text, width, height, duration_ms
)
files(
  media_key REFERENCES media, path, bytes, sha256, downloaded_at,
  UNIQUE(sha256)                       -- content dedupe: "already saved" even across posts
)
posts_fts(        -- FTS5: full_text + alt_text + author fields
)
```

- `seen` ingest is an upsert: later captures refresh counts/last_seen_at; a capture with a new
  tweet id in an existing edit-group adds a `versions` row (edit history accretes passively).
- A captured `TweetTombstone` for a known id sets `deleted=1` (plan 02's normalizer emits
  tombstone events for known ids instead of skipping silently — small amendment to plan 02 §3).
- 404/410 on an archive download also sets `deleted=1` (and `archive_failed` if nothing saved).
- Retention: none. Manual purge tool = delete by filter (author/date/state) with confirmation.

## 4. Downloader

- Queue with per-host politeness: ≤2 concurrent, 500–1500 ms jittered gaps — CDN fetches only,
  shaped by the freshest `request_template` (UA/Accept/Referer/client hints). Same machine ⇒ same
  IP as the browser. TLS-fingerprint impersonation: not in v1; revisit only if CDN behavior
  changes (Decision 20's spirit: boring, browser-like, low-volume).
- Images: `?format=<ext>&name=orig`, fallback `4096x4096` → `large` (plan 04 rules).
- Video/GIF: highest-bitrate `video/mp4` variant from the record. **No HLS work for normal
  tweets** (GraphQL variants include progressive mp4). Keep an ffmpeg-based HLS fallback stub
  behind a flag for rare no-mp4 cases; ship disabled.
- Writes: `<archive_root>/<screen_name>/<plan-04 filenames>`; bulk runs:
  `<archive_root>/_runs/<date>-<label>/…` (Decision 13). Sidecars per plan 04, both writers share
  `packages/core` serializers.
- Retry: 3 attempts w/ backoff, then `archive_failed` + library badge. Never auto-retry later
  (no background traffic); user can re-queue manually.

## 5. Library UI ("recently viewed tweets")

Electron app (Decision 12), single window, local React/Preact front-end (this UI is complex
enough to justify a framework, unlike the extension dialog).

- **Feed view**: reverse-chron by `last_seen_at`; each row: author, time, full text, media-type
  chips, state (seen/queued/archived/failed), deleted badge. **Text-first — no stored
  thumbnails** (Decision 21). Archived items render previews from the original files on disk.
  Unarchived items may load an on-demand CDN preview when a row is explicitly expanded — never
  prefetched, never persisted.
- **Queue actions**: per-row and multi-select "Archive"; "Archive all in view" respecting current
  filter. (Rule-based auto-archiving — e.g. "always archive author X" — is a natural v2; schema
  supports it, don't build yet.)
- **Search/filter**: FTS over text/alt/author; filters: state, has-video, author, date range,
  deleted.
- **Detail view**: all versions (edits) with diff-ish display, media grid from disk, sidecar
  preview, "open on X", "reveal file".
- **Settings**: archive root path, port, pairing token reset, purge tool, ffmpeg-fallback flag.
- Status bar: connection state, queue depth, disk usage.

## 6. Code layout & sharing (amends plan 01 §3)

```
packages/core/    # TypeScript (Decision 1): TweetRecord types, graphql-normalize,
                  # filename, sidecar serializers, protocol frame types
extension/        # JS, plans 02–04; imports core via esbuild
app/              # Electron main (Node: ws server, sqlite via better-sqlite3, downloader)
                  # + renderer (library UI); imports core directly
```

One esbuild-driven build for all three; vitest at the root; fixtures shared (the same captured
GraphQL fixtures test normalizer AND app ingest).

## 7. Milestones & acceptance

- **M1 — protocol + headless ingest**: app runs (no UI beyond a log pane), pairing works,
  `seen`/`archive` frames land in SQLite, extension buffers/replays when app restarts.
  *Accept:* scroll a timeline → rows appear; kill app mid-scroll → extension stays functional
  standalone; restart → buffered archives replay.
- **M2 — downloader + disk**: `archive` produces originals + sidecar at the archive root with
  hash dedupe; folder-per-run bulk; deleted/404 flagging.
  *Accept:* DevTools + app logs show only CDN GETs, browser-shaped headers, ≤2 concurrent;
  re-archiving the same media downloads nothing.
- **M3 — library UI**: feed, search, queue actions, detail view w/ versions, purge tool.
  *Accept:* find a tweet seen yesterday by a word in its alt text, archive it from the library
  retroactively; a tweet whose tombstone was captured shows the deleted badge.
- **M4 — polish**: settings, status badge in extension, error surfacing, packaging
  (electron-builder, unsigned local build is fine for personal use — Decision 11).

## 8. Explicitly rejected / deferred (do not re-propose)

- CDP / `chrome.debugger` capture (plan 05 C/E analysis stands).
- Any app-originated request to `x.com` or `api.x.com` — the app talks to CDNs only.
- Polling X for deletions/edits (Decision 18/20 — passive only).
- Thumbnail store, auto-expiry/retention, tray autostart, store distribution, media server,
  multi-browser UI — all deferred or rejected per Decisions Log.
