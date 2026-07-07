# Plan 06 — Local Companion App: Browser Captures, App Downloads, "Recently Viewed" Library

Status: direction accepted in discussion (see `discussion-02-vs-05.md`); supersedes Plan 05's
"D/E only if the product grows" hedge — the product *is* growing this way. Plan 05 stays as the
survey; this is the chosen hybrid: **Option D's local-app transport + Option E's product scope,
without CDP.**

## Architecture in one diagram

```
x.com page ──(its own GraphQL requests)──▶ X servers
    │
    ▼ (page-world interceptor observes responses — Plan 02, unchanged)
extension: normalize → TweetRecord ──┬──▶ in-page buttons (Plan 03, unchanged)
                                     ├──▶ chrome.downloads + sidecar   [standalone mode, Plan 04]
                                     └──▶ ws://127.0.0.1:<port> ───▶ local app  [connected mode]
                                              (records + request-header template)
                                                        │
                                                        ├─ SQLite library ("recently viewed")
                                                        ├─ download queue → CDN GETs (browser-
                                                        │    identical headers, mp4 variants)
                                                        └─ disk writer (any path, dedupe, sidecars)
```

Invariants:
- **Only the browser ever talks to X's API, and only passively.** The app never receives
  credentials or cookies for `x.com` — it receives tweet records and public CDN URLs.
- **Extension works standalone** (Plans 02–04 exactly as written) when the app isn't running;
  app connection upgrades behavior, never gates it.

## 1. What the extension sends

Over a localhost WebSocket (app = server, extension = client, reconnect with backoff):

- `tweet` messages: every normalized `TweetRecord` the interceptor captures (i.e. everything
  scrolled past), fire-and-forget. This is the "recently viewed" feed.
- `download` messages: explicit user actions (button click / bulk run) — record + chosen media
  selection, marked so the app queues them.
- `request_template` messages (occasional): the browser's real media-request header snapshot —
  captured via observation-only `chrome.webRequest` on `pbs.twimg.com`/`video.twimg.com` requests
  the page makes (UA, `Accept`, `Referer`, client hints). No cookies (public CDNs don't use them;
  never forward `x.com` cookies to the app).
- Security: pairing token (shown by app on first run, pasted into extension options once), app
  binds to 127.0.0.1 only, rejects unauthenticated frames; extension needs no extra host perms
  for ws://127.0.0.1.

## 2. What the app does

- **Ingest**: upsert every record into SQLite (tweets, users, media, capture_events tables).
  Dedupe by `id_str`/`media_key`; later captures refresh counts.
- **Library UI ("recently viewed tweets")**: reverse-chronological capture feed; thumbnails
  (lazy-load from CDN at small size), full text, author, counts; search (SQLite FTS on text +
  author + alt text); filters (has-video, date, author); actions: download now (retroactively —
  media URLs stay valid long after capture), open on X, copy text. Retention setting (e.g.
  30/90/∞ days) + pause capture toggle + purge — this is a log of everything the user views;
  keep it loudly local-only.
- **Downloader**: queue with per-host politeness (~2 concurrent, jittered); GETs use the request
  template so they match browser traffic (same machine = same IP; TLS fingerprint differs — if
  ever needed, adopt a browser-impersonating HTTP client, but public CDN traffic doesn't warrant
  it in v1). Images `name=orig` with the Plan 04 fallback chain; video = highest-bitrate
  `video/mp4` variant from the record.
  - **Note on m3u8**: no HLS reconstruction needed for normal tweets — GraphQL `video_info.variants`
    includes direct progressive mp4 URLs (this is what the legacy code used too;
    `main_react.user.js:4428`). Keep an ffmpeg-based HLS fallback *stub* for the rare
    no-mp4-variant cases (certain broadcasts); the app is the right home for ffmpeg.
- **Disk writer**: user-configured root(s), Plan 04 filename convention and sidecar formats
  verbatim (shared code, see §3), hash-based dedupe ("already saved" badge in library).

## 3. Code sharing — amendment to Plan 01

Anticipate the split now:

```
packages/core/     # graphql-normalize, TweetRecord types, filename, sidecar serializers
extension/         # Plans 02–04 implementation, imports core
app/               # this plan, imports core
```

- **Amendment**: Plan 01 deferred TypeScript; with `core` becoming a contract between two
  programs, TypeScript (or at minimum `.d.ts`-checked JSDoc) for `packages/core` moves into the
  first pass. Extension/app code can stay JS.
- App shell: **Electron or a plain Node daemon + local web UI** for v1 — maximizes reuse of the
  JS core in the download/sidecar path. Tauri is the size/memory-optimized alternative but forces
  re-implementing or bridging core logic in Rust; revisit only if Electron footprint hurts.

## 4. Sequencing (unchanged start, new tail)

1. Plans 01+02 (capture core) — required under every architecture; already first.
2. Plans 03+04 (standalone extension feature-complete).
3. WebSocket client in extension + minimal app (ingest + queue + downloader, no UI beyond a log).
4. Library UI, search, retention, dedupe polish.

## Open questions

- Bulk downloads in connected mode: keep ZIP output (user contract) or switch to
  folder-per-run via the app? Proposal: app writes folders; ZIP remains standalone-mode behavior.
- Should the app also accept records from other browsers/profiles (multi-source capture)? Token
  scheme already allows it; defer.
- Auto-launch app on browser start (tray daemon) vs manual launch? Defer to v1 feedback.
