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

> ALL WORK IN THIS DISPATCH IS DONE (milestones A–D, handoff, stretch S1).
> Nothing is pending. If you are a resumed session: verify with
> `npm test && npm run typecheck && npm run build` (148 tests green as of
> the last commit) and stop — the next work items belong to other
> dispatches: step 3a (live-DOM selector verification + real button UI,
> see plan 03 §5 + step-3b5-handoff.md), step 4 (bulk/scroll driver), app
> M3 (library UI). The owner's manual Chrome walkthrough is in
> docs/plans/step-3b5-handoff.md.

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
- [x] **C1** `done` (commit "app: companion daemon M1") — app/ workspace
      (added to root workspaces): app/src/{config,server,main,downloader}.js.
      ws server 127.0.0.1:8465 (config port), pairing token generated +
      printed on first run ($TWMD_APP_DIR or ~/.twmd-app/config.json),
      hello/hello_ack, versioned {v:1,...} frames, error frames for bad
      token / unsupported version, heartbeat ping. downloader.js is an M1
      STUB (queue bookkeeping only — real M2 next). App is bundled by
      build.mjs to app/dist/main.mjs (imports @twmd/core TS): npm run app.
      Smoke-run verified (first-run banner, listen, SIGTERM shutdown).
- [x] **C2** `done` (same commit) — app/src/db.js: better-sqlite3, WAL,
      exact plan 06 §3 schema (posts/versions/media/files+UNIQUE(sha256)/
      posts_fts FTS5). ingestSeen upsert (state never downgraded),
      ingestArchiveRequest (seen|archive_failed → queued), markDeleted
      (version id → edit-group, no phantom rows), searchPosts,
      recordFile/findFileBySha. test/app-db.test.ts (11 tests, incl.
      ingest of ALL expected/ fixture TweetRecords).
- [x] **C3** `done` (same commit) — extension/content/app-client.js
      (injectable WebSocket, hello→hello_ack gate, backoff reconnect w/
      jitter, fatal stop on bad_token, seen fire-and-forget, archive
      buffer ≤200 drop-oldest with in-order replay, tombstone/bulk/
      request_template senders). Wired in index.js: token from
      localStorage twmd_app_token (port twmd_app_port), TweetCache.onUpdate
      → seen, tombstones forwarded, __twmdDebug.app()/.archive(id).
      test/app-protocol.test.ts: REAL server + REAL client over real ws
      (8 tests — pairing, ingest, queued, tombstone→deleted=1, bad token,
      hello-required close 4003, kill-app/buffer/restart/replay, cap 200).

### MILESTONE D — companion app M2 (plan 06 §4)
- [x] **D1** `done` (commit "app: M2 downloader") — app/src/downloader.js:
      ≤2 concurrent workers, jittered gap after EVERY request (default
      500–1500 ms, injectable), headers from latest request_template with a
      second credential-strip (defense in depth — Cookie can never pass),
      retry 3× exponential backoff → archive_failed, non-CDN hosts refused
      outright (isAllowedCdnUrl: pbs/video.twimg.com ONLY). Extension side:
      extension/background/request-template.js (observation-only
      chrome.webRequest.onSendHeaders WITHOUT 'extraHeaders' so Chrome
      itself omits Cookie/Authorization; values never logged) + "webRequest"
      permission via build.mjs + content polls 'twmd-template' port every
      5 min and forwards via sendRequestTemplate when connected.
- [x] **D2** `done` (same commit) — app/src/disk-writer.js:
      <archive_root>/<screen_name>/<core mediaBasename> + sidecars from the
      SAME core serializers as standalone mode; sha256 dedupe via files
      table (UNIQUE) — identical bytes never written twice; 404/410 walks
      the photo fallback chain then db.markDeleted (Decision 18);
      media-less tweets still archive their sidecar.
- [x] **D3** `done` (same commit) — bulk runs route to
      <archive_root>/_runs/<YYYYMMDD>-<sanitized label>/; run registry
      kept past bulk_end for late frames. test/app-downloader.test.ts
      (10 tests: archive e2e on real files, dedupe, 404 chain+deleted,
      retry, exhaustion, bulk routing, CDN-only refusal, concurrency ≤2,
      text-only sidecar, hostile dir names). scripts/fake-extension.mjs
      replays fixture records over real ws against a running app —
      verified live: 109 records → 106 posts, tombstone → deleted=1,
      FTS search working.

### STRETCH (only if A–D green)
- [x] **S1** `done` (commit "extension: step-3a scaffolding") —
      extension/content/dom-selectors.js (candidate lists + validate()
      per plan 03 §3, ALL marked UNVERIFIED-AGAINST-LIVE-DOM; the pure
      URL-based tweet-id extractors are the only trusted+tested part) and
      extension/content/ui-buttons.js (debounced MutationObserver,
      data-twmd dedupe, history/popstate SPA hooks, re-entrancy-guarded
      button with URL re-read at click time for the viewer). Gated behind
      localStorage.twmd_experimental_buttons = '1' — inert otherwise.
      test/dom-selectors.test.ts (3 tests, URL parsing only). The 3a
      agent owns: live-DOM selector verification (plan 03 §5 checklist),
      real styling/toasts/themes, viewer surface polish, quoted-tweet
      media exclusion.

### End-of-work obligations
- [x] docs/plans/step-3b5-handoff.md written (style of step-2-handoff.md;
      includes the owner's manual Chrome walkthrough).
- [x] NEXT ACTION above kept precise at every commit.

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

- **Legacy background.js answers every unknown sendMessage type
  synchronously with {result:'NG'}** (src/js/background.js default case),
  which closes the response channel before async work can reply. All new
  SW communication therefore uses chrome.runtime.connect PORTS
  ('twmd-save', 'twmd-template') — do the same for any future addition.
- **Plan 06 §2 had no frame for tombstones** though §3 requires captured
  tombstones to set deleted=1. Added a `tombstone` frame
  `{event: TombstoneEvent}` (ext→app); plan 06 updated in the same commit.
- **TS infers overly-narrow types from JS default parameter values**
  (e.g. `run = null` → type null) even with checkJs off, because tests
  import the JS from TS. Pattern used: inline JSDoc casts like
  `run = /** @type {any} */ (null)`.
- npm workspaces: `app` added to root package.json workspaces;
  better-sqlite3 installed with working FTS5 in this environment.
