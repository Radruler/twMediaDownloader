# PROGRESS — step 3b (save layer) + step 5 (companion app M1/M2)

**Read this first on resume.** This file is the session handoff state for the
dispatch covering plan 04 (save layer) and plan 06 M1/M2 (companion app).
Binding context, in order: docs/plans/00-overview.md (Decisions Log),
docs/plans/step-2-handoff.md, docs/plans/04-metadata-sidecar.md,
docs/plans/06-local-companion-app.md.

**Branch policy for this dispatch:** all work is committed and pushed to
`claude/twitter-media-archiver-cucc56` (the environment-designated branch;
this session may not push to master). The remote branch is the handoff
medium — every green commit is pushed immediately.

## NEXT ACTION

> A2: create `packages/core/src/sidecar.ts` (txt serializer per plan 04 §3
> exact layout + json serializer = TweetRecord + sidecar_version + saved
> filenames + chosen media URLs; support `partial` records with the
> `# (partial - reconstructed from DOM)` marker) + `test/sidecar.test.ts`
> (note_tweet long text, multiline, partial records). Export from
> packages/core/src/index.ts. Then npm test/typecheck/build, commit, push.

## Checklist

State: `todo` | `doing` | `done <sha>`

### MILESTONE A — save layer, core parts (plan 04)
- [x] **A1** `done` (sha: see commit "core: filename module") —
      packages/core/src/filename.ts + test/filename.test.ts (21 tests).
      Also exports mediaBasename/sidecarBasename/tweetFileStem/
      sanitizeForFilename/standaloneRelativePath from @twmd/core.
      Conventions (verified against src/js/main_react.user.js):
      `<screen_name>-<tweet_id>-<YYYYMMDD_hhmmss>-{img|gif|vid}<N>.<ext>`;
      timestamp = tweet creation time, LOCAL timezone, format_date-style
      zero-padded; N = media[].index (1-based position in tweet); prefixes:
      photo→img, animated_gif→gif, video→vid. Sidecar basenames:
      `<screen_name>-<tweet_id>-<ts>.txt` / `.json`. Windows-safe
      sanitization of screen_name (and any other injected segment).
      Exhaustive unit tests: emoji/RTL/multiline/hostile names, reserved
      device names, dots/spaces at end.
- [ ] **A2** `todo` — packages/core sidecar serializers.
      `.txt` exact layout plan 04 §3 (post URL first line, verbatim
      multi-line text, `key: value` block, UTF-8, LF). `.json` =
      TweetRecord + sidecar_version + saved filenames + chosen media URLs.
      Tests incl. note_tweet long text and partial/DOM-fallback records
      (partial → `# (partial - reconstructed from DOM)` marker).
- [ ] **A3** `todo` — packages/core media-URL selection helpers.
      Image orig URL: image_url ends `.jpg`/`.png` — REPLACE extension:
      `foo.jpg` → `foo?format=jpg&name=orig` (regex like
      media_extractor.js:90 `.replace(/\.([^.]+)$/, '?format=$1&name=orig')`),
      NOT append. Fallback chain: name=orig → name=4096x4096 → name=large.
      Video: max-bitrate `video/mp4` variant; HLS entries have bitrate:null —
      skip.

### MILESTONE B — save layer, extension wiring (plan 04)
- [ ] **B1** `todo` — "downloads" permission added by build.mjs manifest
      step (src/manifest.json NOT edited).
- [ ] **B2** `todo` — extension/content/save.js: tweetId → TweetCache.get →
      fetch media bytes (plain GET, NO custom headers) → message to service
      worker; sidecar text → data: URL download. New minimal
      extension/background.js bundled by build.mjs (src/js/background.js
      untouched).
- [ ] **B3** `todo` — saves land in Downloads/twMediaDownloader/<screen_name>/,
      conflictAction 'uniquify', sidecar .txt on by default (Decisions 7/8/9).
- [ ] **B4** `todo` — `__twmdDebug.save(tweetId)` debug trigger in
      extension/content/index.js debug surface.

### MILESTONE C — companion app M1 (plan 06 §2/§3/§7)
- [ ] **C1** `todo` — app/ Node workspace (plain Node daemon + log console;
      Electron deferred to M3). ws server 127.0.0.1:8465, pairing token
      generated+printed first run, stored in app config. hello/hello_ack,
      frames exactly per plan 06 §2 table, versioned {v:1,...}.
- [ ] **C2** `todo` — SQLite via better-sqlite3, schema per plan 06 §3
      (posts/versions/media/files/posts_fts). seen-ingest upsert;
      edit-group handling (edit_initial_id_str → post_key); tombstone →
      deleted=1.
- [ ] **C3** `todo` — extension ws client: reconnect w/ backoff, forwards
      every cache put as 'seen', wires tombstone events onward, buffers up
      to 200 'archive' frames offline. Pairing token via localStorage key
      (`twmd_app_token`); token set = connect, unset = pure standalone.

### MILESTONE D — companion app M2 (plan 06 §4)
- [ ] **D1** `todo` — 'archive' frames → download queue: ≤2 concurrent,
      500–1500 ms jittered gaps, CDN GETs shaped by latest request_template
      frame (observation-only chrome.webRequest capture in extension for
      this), NO cookies ever, retry 3×/backoff then archive_failed.
- [ ] **D2** `todo` — disk writer: <archive_root>/<screen_name>/<core
      filenames>, sidecars via core serializers, sha256 dedupe into files
      table, 404/410 → deleted=1.
- [ ] **D3** `todo` — bulk_begin/bulk_end → <archive_root>/_runs/<date>-<label>/.

### STRETCH (only if A–D green)
- [ ] **S1** `todo` — step 3a scaffolding ONLY: dom-selectors.js candidate
      lists + ui-buttons.js injection framework, marked
      UNVERIFIED-AGAINST-LIVE-DOM.

### End-of-work obligations
- [ ] docs/plans/step-3b5-handoff.md written (style of step-2-handoff.md).
- [ ] NEXT ACTION above kept precise at every commit.

## Verification expectations
- A/C/D: unit tests (vitest at root). App ingest tested against
  test/fixtures/graphql expected outputs.
- B + live ws loop: no browser here — provide a scripted fake (Node script
  replaying fixture TweetRecords over the ws protocol) so M1/M2 are provable
  end-to-end; document the manual Chrome walkthrough in the handoff.
- Every commit: `npm test && npm run typecheck && npm run build` green.

## HARD CONSTRAINTS (never violate)
- No request to x.com/api.x.com from any new code. Media/CDN GETs only
  (pbs.twimg.com / video.twimg.com); no custom headers from the extension;
  app uses only request_template headers, never cookies.
- Never log cookies or auth headers.
- Don't touch src/ legacy code; no step-1 deletions; no options UI.
- TypeScript only inside packages/core; app + extension are JS.

## SURPRISES

- (none yet)
