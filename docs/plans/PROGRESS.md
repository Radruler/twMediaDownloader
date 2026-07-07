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

> C1+C2 (milestones A+B DONE): app/ workspace already scaffolded
> (app/package.json + app/src/{config,db}.js written, NOT yet installed or
> tested). Steps: (1) add "app" to root package.json workspaces; (2)
> npm install (pulls ws + better-sqlite3 — if better-sqlite3 native build
> fails, fall back to node:sqlite DatabaseSync and note in SURPRISES);
> (3) write app/src/server.js (ws server 127.0.0.1:8465, pairing auth from
> config token, frames per plan 06 §2: hello/hello_ack, seen, archive,
> bulk_begin/bulk_end, request_template [strip cookie/auth headers],
> tombstone [NEW frame type — plan amendment], status) + app/src/main.js
> (loadConfig, print token on first run, log console); (4) vitest
> test/app-db.test.ts (ingest against graphql expected fixtures) +
> test/app-server.test.ts (real ws round-trip on port 0, in-memory db);
> (5) npm test/typecheck/build green → commit, push.

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
- [x] **A2** `done` (commit "core: sidecar serializers") —
      packages/core/src/sidecar.ts: sidecarTxt (plan 04 §3 layout — URL
      first line, partial marker line 2 when set, verbatim multiline text,
      aligned key: value block, optional lines omitted when empty, LF, one
      trailing newline), sidecarJsonObject/sidecarJsonText
      (sidecar_version=1, partial, saved_files, media_urls via
      planMediaDownload, full record). test/sidecar.test.ts (13 tests).
- [x] **A3** `done` (commit "core: media-url helpers") — done BEFORE A2
      because the sidecar embeds chosen media URLs.
      packages/core/src/media-url.ts: imageUrlForSize (REPLACES trailing
      ext with ?format=&name=), imageUrlFallbackChain (orig→4096x4096→large),
      extensionFromUrl, pickMp4Variant (mp4-only, bitrate null skipped,
      bitrate 0 gif OK), planMediaDownload(MediaRecord) → {urls, ext}|null.
      test/media-url.test.ts (14 tests). Exported from @twmd/core.

### MILESTONE B — save layer, extension wiring (plan 04)
- [x] **B1** `done` (commit "extension: standalone save layer") —
      build.mjs adds "downloads" to dist manifest permissions; verified in
      dist/manifest.json; src/manifest.json untouched.
- [x] **B2** `done` (same commit) — extension/content/save.js
      (buildSaveManifest pure planner + saveTweet orchestration: cache →
      planMediaDownload → plain fetch(url) w/ orig→4096→large fallback →
      data: URLs → PORT 'twmd-save'); extension/background/save-worker.js
      bundled to dist/js/save-worker.js; dist/background-wrapper.js
      regenerated to import legacy background.js + save-worker.js (src
      wrapper untouched). NOTE: uses chrome.runtime.connect PORT, not
      sendMessage — legacy background.js NGs all unknown sendMessage types
      synchronously, which would kill async responses.
- [x] **B3** `done` (same commit) — standaloneRelativePath →
      twMediaDownloader/<screen_name>/, conflictAction 'uniquify',
      sidecar 'txt' default ('json'|'both'|'none' options).
- [x] **B4** `done` (same commit) — __twmdDebug.save(tweetId, options?) in
      extension/content/index.js. test/save.test.ts (6 tests) covers the
      pure planner. Browser-side flow needs the owner's manual Chrome
      walkthrough (documented in handoff at end of work).

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
