# Step 3b + 5 handoff — save layer (plan 04) & companion app M1/M2 (plan 06)

Written 2026-07 by the step-3b/5 agent, for the step 3a (UI), step 4
(bulk), and app-M3 (library UI) agents. Read 00-overview's Decisions Log
first; it still overrides everything, including this file. Read
step-2-handoff.md for the capture layer this builds on. Live task state:
docs/plans/PROGRESS.md.

## STATUS MARKER (final, 2026-07-07) — steps 3b and 5(M1+M2) are DONE

**Done in this pass:**
- `packages/core` additions (TS): `filename.ts` (exact legacy naming,
  Windows-safe sanitization), `media-url.ts` (orig-image URL building,
  size fallback chain, max-bitrate mp4 picking, `planMediaDownload`),
  `sidecar.ts` (plan 04 §3 `.txt` layout + versioned `.json`).
- Extension standalone save layer: `extension/content/save.js`,
  `extension/background/save-worker.js`, `chrome.downloads` with
  `downloads` permission (dist manifest only), debug trigger
  `__twmdDebug.save(tweetId)`.
- Companion app M1+M2: `app/` Node daemon (ws protocol server, pairing,
  better-sqlite3 library per plan 06 §3, M2 download queue + disk writer
  with sha256 dedupe and bulk-run folders). Extension ws client with
  offline archive buffering. `scripts/fake-extension.mjs` proves the loop
  without Chrome.
- 145 tests green, `tsc --noEmit` clean, `npm run build` produces both
  the loadable `dist/` extension and `app/dist/main.mjs`.

**Deliberately NOT done (scope boundaries, not oversights):**
- No UI layer (3a) — the only save triggers are `__twmdDebug.save()` /
  `__twmdDebug.archive()`. No options-page UI: the pairing token lives in
  `localStorage.twmd_app_token` for now.
- No bulk/scroll driver (step 4): `bulk_begin`/`bulk_end` frames and
  `_runs/` routing are implemented and tested, but nothing sends them yet.
- No app library UI (M3), no Electron shell, no packaging (M4).
- No live-Chrome verification (no browser in this environment) — see the
  owner walkthrough below.
- Stretch 3a scaffolding (dom-selectors candidates) only if it exists in
  the repo when you read this — check PROGRESS.md S1.

## What landed

```
packages/core/src/
  filename.ts        <screen_name>-<id>-<YYYYMMDD_hhmmss>-{img|gif|vid}<N>.<ext>,
                     sidecar basenames, sanitizeForFilename, standaloneRelativePath
  media-url.ts       imageUrlForSize (REPLACES trailing ext with ?format=&name=),
                     fallback chain orig→4096x4096→large, pickMp4Variant (HLS
                     bitrate:null skipped), planMediaDownload(MediaRecord)
  sidecar.ts         sidecarTxt (plan 04 §3 layout), sidecarJsonObject/Text
                     (sidecar_version 1 + saved_files + chosen URLs + record)
extension/content/
  save.js            buildSaveManifest (pure, tested) + saveTweet: cache →
                     plan → plain fetch (no headers) → data: URLs → SW port
  app-client.js      ws client: hello gate, backoff reconnect, seen fire-and-
                     forget, archive buffer ≤200 replayed in order, tombstone/
                     bulk/request_template senders. Injectable WebSocket.
  index.js           wiring: onUpdate→seen, tombstones→app, template polling,
                     __twmdDebug.save/.archive/.app
extension/background/
  save-worker.js     'twmd-save' port → chrome.downloads (uniquify, subfolders)
  request-template.js OBSERVATION-ONLY webRequest header capture (no cookies,
                     by construction — 'extraHeaders' deliberately not used)
app/src/
  config.js          ~/.twmd-app (or $TWMD_APP_DIR): port 8465, pairing token
                     (printed on first run), archive_root, db_path
  server.js          ws 127.0.0.1 only; frames per plan 06 §2 (+ new
                     'tombstone' frame — plan amended); header sanitization
  db.js              plan 06 §3 schema exactly; ingestSeen upsert; edit-groups
                     via edit_initial_id_str; passive deleted=1; FTS5; files
                     sha256 UNIQUE
  downloader.js      M2 queue: ≤2 concurrent, 500–1500 ms jittered gaps, CDN
                     hosts hard-enforced, retry 3×→archive_failed, 404/410→deleted
  disk-writer.js     <root>/<screen_name>/ or <root>/_runs/<date>-<label>/;
                     same core filenames+sidecars as standalone; sha256 dedupe
scripts/fake-extension.mjs   replay fixtures over real ws against a running app
test/                filename, media-url, sidecar, save, app-db, app-protocol
                     (real ws server+client), app-downloader (real files)
```

Build: `npm run build` → `dist/` (extension; now also grows the
`downloads`+`webRequest` permissions and a regenerated
`background-wrapper.js` that imports the two new worker bundles) and
`app/dist/main.mjs` (the app bundled for plain Node; `better-sqlite3`/`ws`
external). `npm run app` runs the daemon.

## How the pieces talk

```
TweetCache ──onUpdate──▶ app-client 'seen' ─▶ app server ─▶ db.ingestSeen
__twmdDebug.save(id) ─▶ save.js ─▶ fetch CDN bytes ─▶ 'twmd-save' port ─▶
                                             chrome.downloads (standalone)
__twmdDebug.archive(id) ─▶ app-client 'archive' (buffered ≤200 offline) ─▶
       app server ─▶ db state 'queued' ─▶ downloader ─▶ CDN GET (template
       headers, ≤2, jittered) ─▶ disk-writer ─▶ files + sidecars + 'archived'
tombstones ─▶ app-client 'tombstone' ─▶ db.markDeleted (deleted=1)
webRequest observation ─▶ 'twmd-template' port ─▶ app-client
       'request_template' ─▶ server sanitize ─▶ downloader header shape
```

- **3a (UI):** call `saveTweet(tweetId, {sidecar})` from
  `extension/content/save.js` for the standalone download button, and
  `appClient.sendArchive(record, 'button')` for connected mode. Both are
  already wired in `index.js` — copy the `__twmdDebug.save/.archive`
  handlers. Everything is idempotent per id; `conflictAction: 'uniquify'`
  handles double-clicks.
- **4 (bulk):** brackets are ready — send `sendBulk(run_id, 'begin',
  label)` / `'end'`, pass `run_id` on each `sendArchive`. The app routes
  those to `_runs/<date>-<label>/`. Standalone bulk ZIP is untouched
  scope (plan 04 §5).
- **M3 (library UI):** `app/src/db.js` exposes `searchPosts` (FTS),
  `getPost/getVersions/getMedia`, `stats`. `raw` is the better-sqlite3
  handle for anything else. The daemon prints a log line per event —
  replace `main.js` logging with your UI feed.

## Contract/protocol notes

- Protocol frames are `{v:1, type, ...}`; the table in plan 06 §2 now
  includes the added `tombstone` frame. Servers reject non-v1 with an
  `error` frame + close 4002; bad token → close 4001; frame-before-hello
  → close 4003.
- `seen` is fire-and-forget and NOT buffered offline (per plan);
  `archive` buffers up to 200 and replays in order on reconnect.
- The extension's `sendMessage` channel is booby-trapped: the legacy
  `src/js/background.js` (untouched by design) answers EVERY unknown
  message type synchronously with `{result:'NG'}`, killing async
  responders. **Use `chrome.runtime.connect` ports for anything new**
  ('twmd-save' and 'twmd-template' exist).
- Filenames/sidecars come from `@twmd/core` in BOTH writers — never
  reimplement naming anywhere else.
- Hard lines that tests enforce: the app fetches only
  `pbs.twimg.com`/`video.twimg.com` (`isAllowedCdnUrl`); cookie/auth-like
  headers are stripped at capture AND at the server AND at the
  downloader; the extension's media fetch is a bare `fetch(url)`.

## Known gaps / debts

1. **No live-Chrome run.** Everything network/browser is proven via the
   scripted fake (`scripts/fake-extension.mjs`) and unit tests with real
   ws/SQLite/files — but `chrome.downloads` behavior, content-script
   `fetch` CORS on pbs/video CDNs, ws-from-content-script on x.com, and
   the webRequest capture have not run in a real browser. The walkthrough
   below is the acceptance test.
2. Data-URL transfer to the service worker means media bytes are
   base64-encoded through one message per file — fine for images, may be
   slow/memory-heavy for very large videos. If it bites, move the fetch
   into the SW (still a plain GET) or chunk the transfer.
3. `seen` frames flow only while a tab is open and connected; nothing
   backfills library rows for tweets scrolled while the app was closed
   (accepted, plan 06 §2).
4. The app's `status` frame updates on archive events, not continuously.
5. Firefox: untested entirely this pass (Chrome-first, Decision 10).
6. `npm run watch` doesn't rebuild the copied `src/` statics (pre-existing).
7. better-sqlite3 is a native dep — a Node major upgrade needs a rebuild
   (`npm rebuild better-sqlite3`).

## Owner walkthrough (manual, in Chrome)

Standalone save (plan 04 acceptance):
1. `npm install && npm run build`, load `dist/` unpacked.
2. On x.com, open DevTools → console → this extension's context. Scroll
   any timeline; `__twmdDebug.stats()` should show cache entries.
3. Pick a photo tweet's id (from `__twmdDebug.last()`), run
   `__twmdDebug.save('<id>')`.
4. Expect: files in `Downloads/twMediaDownloader/<screen_name>/` named
   `<screen_name>-<id>-<YYYYMMDD_hhmmss>-img1.jpg` … plus the `.txt`
   sidecar; DevTools Network shows ONLY the media GETs (no graphql, no
   api.x.com — filter and verify); the sidecar text matches the tweet
   incl. full long-form text.
5. Repeat for a video tweet (expect `-vid1.mp4`, max bitrate) and a GIF
   (`-gif1.mp4`).

Companion app (plan 06 M1/M2 acceptance):
6. `npm run app` in a terminal — copy the pairing token it prints.
7. In the extension console: `localStorage.twmd_app_token = '<token>'`,
   reload the x.com tab. App log should print "extension connected".
8. Scroll — app log stays quiet but `__twmdDebug.app()` shows sent.seen
   climbing; stop the app, scroll more, `__twmdDebug.archive('<id>')`
   twice, restart the app — the buffered archives must replay and
   download into `~/.twmd-app/archive/<screen_name>/`.
9. Re-archive the same tweet: the app log must say "dedupe hit" and write
   nothing new.
10. Check `~/.twmd-app/library.sqlite3` (any sqlite browser):
    posts/versions rows for scrolled tweets; the archived post has
    state='archived' and files rows.
11. Confirm politeness: the app log's download lines should be spaced
    (500–1500 ms) and never more than 2 in flight.

## Verification status (this branch, 2026-07-07)

- `npm test` — 145 tests green (10 files), incl. real-ws protocol tests
  and real-file downloader tests.
- `npm run typecheck` / `npm run build` — clean.
- Live daemon smoke: first-run token banner, 109 fixture records ingested
  via `scripts/fake-extension.mjs` → 106 posts (cross-fixture dedup),
  tombstone → deleted=1, FTS query returns matches, graceful SIGTERM.
