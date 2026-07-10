# Verification

Three tiers. Tiers 1–2 run in any environment (CI, agent sessions, the
devcontainer) and are required green for every commit. Tier 3 is the
owner's live-browser walkthrough — the only part of the system not yet
machine-verifiable, and the gate for `docs/plans/cleanup-plan.md`.

## Tier 1 — unit/integration suite

```sh
docker compose -f .devcontainer/docker-compose.yml run --rm app \
  sh -lc 'npm test && npm run typecheck && npm run build'
```

154 tests as of 2026-07-10, including: normalization against real captured
GraphQL fixtures; filename/sidecar/media-URL rules; the ws protocol with a
REAL server + REAL extension client over a real socket (pairing, ingest,
tombstones, offline buffer/replay); the downloader writing REAL files with
an injected fetch (dedupe, 404 fallback chain, retry, concurrency cap,
CDN-host refusal); content-manager restart resume and operator CLI
controls.

## Tier 2 — no-Chrome end-to-end (scripted fake extension)

Proves the service loop with real ws + real SQLite, standing in for the
browser:

```sh
# terminal 1 — note the pairing token it prints on first run
docker compose -f .devcontainer/docker-compose.yml exec app npm run app

# terminal 2 — replay every fixture TweetRecord as 'seen' frames
node scripts/fake-extension.mjs --token <token> [--host 127.0.0.1] [--port 8465] \
  [--archive <tweet_id>]     # also exercise the downloader (REAL CDN GETs)
  [--tombstone <tweet_id>]   # flag a post deleted
```

Expected: ~109 records → ~106 posts (cross-fixture dedup), tombstoned id
shows `deleted=1`, FTS queries return matches, `status` frames flow.
After a build, `TWMD_APP_DIR=<same-dir> node app/dist/main.mjs status`
should report the same post counts and queue depth.

## Tier 3 — live Chrome walkthrough (owner; NOT yet performed)

Everything below exercises assumptions no test can reach: content-script
CORS to the CDNs, `chrome.downloads` with data: URLs, ws from an x.com
page to the service, and the observation-only webRequest capture.

Standalone save:

1. Build (Tier 1 command), load `dist/` unpacked via `chrome://extensions`.
2. On x.com, open DevTools → console → select this extension's context.
   Scroll any timeline; `__twmdDebug.stats()` should show cache entries;
   `__twmdDebug.last()` lists recent ids.
3. Pick a photo tweet's id and run `__twmdDebug.save('<id>')`.
4. Expect files in `Downloads/twMediaDownloader/<screen_name>/` named
   `<screen_name>-<id>-<YYYYMMDD_hhmmss>-img1.jpg` … plus the `.txt`
   sidecar with the full tweet text. In the DevTools Network tab the only
   extension-caused requests are the media GETs — nothing to
   x.com/api.x.com.
5. Repeat for a video tweet (`-vid1.mp4`, highest bitrate) and a GIF
   (`-gif1.mp4`).

Service pairing + archive:

6. Start the service (Tier 2, terminal 1); copy the pairing token.
7. In the extension console: `localStorage.twmd_app_token = '<token>'`,
   reload the x.com tab. Service log prints "extension connected".
8. Scroll; `__twmdDebug.app()` shows `sent.seen` climbing. Stop the
   service, keep scrolling, run `__twmdDebug.archive('<id>')` twice,
   restart the service — the buffered archives must replay and download
   into the archive root (`twmd-app-data` volume in the devcontainer).
9. Re-archive the same tweet: the log must say "dedupe hit", writing
   nothing new.
10. Politeness check: download log lines spaced 500–1500 ms, never more
    than 2 in flight.

Fixture gaps the owner can close from ANY Chrome (no extension install
needed) via DevTools → Network → copy response (workflow:
`docs/CAPTURE_FIXTURES.md`): SearchTimeline, HomeTimeline, a real
tombstone thread, a non-empty Bookmarks.

Record Tier 3 results (pass/fail per step) in `docs/plans/00-overview.md`'s
work table when done — cleanup is gated on it.
