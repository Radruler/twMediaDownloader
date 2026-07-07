# Step 2 handoff — network capture layer (plan 02)

Written 2026-07 by the step-2 agent, for the step 3a (UI), 3b (save), and 5
(companion app) agents. Read 00-overview's Decisions Log first; it still
overrides everything, including this file.

## What landed

```
packages/core/                    TypeScript, the shared contract (Decision 1)
  src/tweet-record.ts             TweetRecord / TombstoneEvent / NormalizeResult types
  src/graphql-normalize.ts        normalizePayload(payload, sourceOp, capturedAtMs)
  src/index.ts                    package entry (@twmd/core)
extension/content/                plain JS (bundled by esbuild)
  page-interceptor.js             MAIN world, document_start; fetch+XHR patch; 126 lines
  tweet-cache.js                  the 00-overview cache contract; LRU 5000; exports
                                  createTweetCache() + the TweetCache singleton
  index.js                        isolated-world entry: bridge -> normalize -> cache,
                                  debug overlay, fixture-capture mode
build.mjs                         npm run build -> dist/ (loadable unpacked MV3)
scripts/update-expected.mjs       regenerates test/fixtures/graphql/expected/*
test/fixtures/graphql/*.json      one fixture per op + edge case (ALL SYNTHETIC — see gaps)
test/*.test.ts                    52 tests: fixtures, cache, interceptor behavior
docs/CAPTURE_FIXTURES.md          owner workflow to replace synthetic fixtures with real ones
```

Build: `npm run build` copies `src/` (untouched, minus `src/deprecated/`) into
`dist/`, bundles the two capture entries to `dist/js/{page-interceptor,capture}.js`,
and writes `dist/manifest.json` = `src/manifest.json` + two content-script
entries (interceptor with `"world": "MAIN"`, both `document_start`).
`src/manifest.json` itself was deliberately NOT edited — it lacks the bundles,
so editing it would have broken loading `src/` directly. **Load `dist/`.**
`npm run watch` rebuilds bundles on change (re-run a full build after
touching `src/` or the manifest).

## The data flow (what you consume)

```
page's own fetch/XHR ▶ page-interceptor (MAIN) ▶ CustomEvent 'twmd:graphql'
  {v:1, op, url, body: <raw JSON string>, ts}
    ▶ extension/content/index.js (isolated) ▶ normalizePayload() ▶ TweetCache.put()
        ▶ your code: TweetCache.get(id) / TweetCache.onUpdate(cb)
```

- **3a (UI):** import `{ TweetCache }` from `extension/content/tweet-cache.js`
  in your isolated-world module and bundle alongside (add your entry to
  `build.mjs`, or extend `extension/content/index.js` — it's the wiring
  point). Everything you need per tweet is on the record; if a clicked tweet
  is missing, the fallback ladder is plan 02 §5 (DOM extraction, then "open
  the tweet") — there is NO rung 3, never fetch the API.
- **3b (save):** `media[].image_url` is the pbs base URL — you append
  `?format=<ext>&name=orig` (that logic belongs in your filename/save module;
  the normalizer deliberately stores the base). For video/gif pick the
  max-bitrate `video/mp4` variant from `video_variants`; HLS entries have
  `bitrate: null` — skip them.
- **5 (app):** `TweetRecord` is what the `seen`/`archive` frames carry
  (plan 06 §2). `edit_initial_id_str ?? id_str` is your `post_key`
  (Decision 17). Tombstone events are surfaced in
  `extension/content/index.js` (`state.tombstones`) but are NOT yet forwarded
  anywhere — wiring them into the ws protocol is yours; the normalizer
  already emits them per payload.

## Contract stability notes

- `TweetRecord` gained two fields over the original 00-overview draft
  (updated there in the same commit): `retweeted_status_id_str` and
  `edit_initial_id_str`. Additive only; nothing renamed.
- `created_at_ms` is `number | null` (Date.parse of `legacy.created_at`,
  snowflake fallback `(id >> 22) + 1288834974657`). Null only for pre-2010
  ids with no created_at — treat as "unknown", don't crash.
- `counts.views` is null when X hides views. All other counts default 0.
- `user` fields can each be null (defensive) — the fixtures cover both the
  2025 `user.core.{name,screen_name}` shape and the older `user.legacy` one.
- The normalizer walks the whole payload generically (no per-op envelope
  paths), so a new operation usually needs only a pass-list entry in
  `page-interceptor.js` — not a normalizer change.
- Duplicate suppression: one payload emits each tweet id once (later
  occurrence wins); across payloads, `TweetCache.put` replaces — fresher
  counts win. `onUpdate` fires per put, so the same id can fire repeatedly
  as the user scrolls; UI code must be idempotent per id.

## Known gaps / debts

1. **All fixtures are synthetic.** The plan's "live-site verification pass"
   could not run from this environment (no x.com login; and issuing requests
   is forbidden anyway). The owner must run docs/CAPTURE_FIXTURES.md and
   replace them. Until then, treat field locations as best-effort — the
   generic walker + both-locations user handling are the hedge.
2. Tombstone events stop at `extension/content/index.js` state (debug
   surface only). No consumer yet (step 5 wires them to the app).
3. `TweetResultsByRestIds` (batch) has no fixture — pass-listed, and the
   generic walker should handle it, but unverified.
4. The interceptor's unlisted-op telemetry only reaches the console
   (`twmd_debug` flag). Nobody aggregates it.
5. `npm run watch` watches only the bundles, not `src/` static copies.
6. Firefox: `world: "MAIN"` needs FF 128+; the plan's `<script>`-tag
   fallback for older Firefox is not implemented (Chrome-first, Decision 10).
7. Chrome MV3 `world:"MAIN"` content scripts need Chrome 111+ (fine for a
   self-distributed extension, Decision 11).

## Dry-run walkthrough (what the owner should see)

After `npm run build`, load `dist/` unpacked (chrome://extensions, Developer
mode). Expect no manifest/service-worker errors (the legacy SW warning
baseline is unchanged). On x.com set `localStorage.twmd_debug_overlay = '1'`
and reload:

1. **Home** — overlay appears bottom-right; `HomeTimeline` counter ticks,
   cache size jumps by ~20–40 per scroll chunk; last-ids list updates.
2. **A profile** — `UserTweets` ticks; retweets add two ids each (outer+inner).
3. **Profile → Media tab** — `UserMedia` ticks as the grid loads/scrolls.
4. **Likes / Bookmarks / a search** — respective counters tick.
5. **Open a status page** — `TweetDetail` ticks; replies appear in last-ids;
   a deleted reply in the thread increments the tombstone counter.
6. Console (extension context) `window.__twmdDebug.stats()` shows
   `{size, hitRate}`; `.last(10)` the newest ids; `.get('<id>')` a full record.
7. Nothing else changes: no new network requests from the extension on the
   Network tab (filter by "graphql" — every request is page-initiated;
   the extension's only footprint is reading responses).

## Verification status (this branch, 2026-07)

- `npm test` — 52 tests green (fixtures locked to expected/ + behavioral).
- `npm run typecheck` — clean.
- `npm run build` — produces dist/; manifest JSON verified to contain the two
  new entries with correct worlds. Loading in a real Chrome was not possible
  in this environment — the owner's dry-run above is the remaining check.
