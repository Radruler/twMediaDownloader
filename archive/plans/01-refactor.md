# Plan 01 — Repository Refactor for Maintainability

Goal: make the codebase small, modular, and testable so that AI agents can safely modify it. No behavior change beyond removing code that is already dead in production (see 00-overview: the extension is currently non-functional, so "dead" is provable, not speculative).

## 1. Delete dead code (biggest single win: ~10,500 of ~18,000 JS lines)

| Path | Lines | Why it is dead |
|---|---|---|
| `src/js/twMediaDownloader.user.js` | 5,124 | Targets the pre-2019 legacy Twitter web UI, which no longer exists. Not referenced by any manifest. |
| `src/js/main_tweetdeck.user.js` | 1,639 | TweetDeck was shut down July 2023; `tweetdeck.twitter.com` is gone. |
| `src/js/twitter-oauth/` (sha1.js, oauth.js, twitter-api.js, LICENSE, `*.url`) | 2,151 | OAuth 1.0a API flow abandoned by the project itself in 2020 (`main_react.user.js:4734`: "2020.08.17: OAuth 1.0a認証を伴ったAPIは利用しないようになったので無効化"). Endpoints are dead anyway. |
| `src/js/session.js` | 12 | Only exists to drive the OAuth popup on `api.twitter.com` pages. Dead with the above. |
| `src/js/zip_request_legacy.js`, `src/js/zip_worker.js` | 577 | `ENABLE_ZIPREQUEST` is force-disabled (`main_react.user.js:4778-4781`), background handler commented out (`background.js:287-291`). |
| `src/js/decimal.min.js` | vendored | Only used for 64-bit tweet-ID math (`main_react.user.js:509-574`). Replace with native `BigInt` (snowflake epoch math: `(BigInt(id) >> 22n) + 1288834974657n`). |
| `background.js` commented blocks | ~120 | Lines 44-57, 125-134, 328-413 are commented-out MV2 webRequest history. Delete; git history preserves them. |
| Open-in-tabs + tab-sorting feature | ~200 | Decision 6 (00-overview): Alt+Click open-in-tabs is dropped, so delete `extension_functions.open_multi_tabs`/`request_tab_sorting` (`init.js:171-234`), `request_tab_sorting`/`TAB_SORT_REQUEST` in `background.js:99-172,235-244`, `is_open_media_mode()` and all `open_images`/`open_video` paths in `main_react.user.js`, the `OPEN_MEDIA_LINK_BY_DEFAULT` option everywhere (options page, locales), and the `pbs.twimg.com/media/*` content-script match in the manifests (it exists only for tab sorting). |

> **Re-verified against the imported baseline (commit `addb00f`, 2026-07-07):** the legacy
> userscript is already gone; TweetDeck script, firefox manifest and `chrome-mode`/`firefox-mode`
> now live in `src/deprecated/` — **delete that whole directory** in step 1 (git history is the
> archive). `twitter-oauth/`, `session.js`, `zip_request_legacy.js`, `zip_worker.js`,
> `decimal.min.js` are all still present and still to delete. Line numbers cited in this plan set
> refer to the pre-import code and will have shifted in `main_react.user.js`/`timeline.js`;
> the reasoning stands.

### 1a. Baseline-specific cleanup (new items from the imported iteration)

| Item | Action |
|---|---|
| `src/js/config.js` | **Seed, reshape.** Config extraction is the right instinct. `OPTIONS` → the new config module; `UI_STRINGS` → `_locales/` (proper i18n, not a JS table); `API_ENDPOINTS` → **delete** (all four are dead legacy REST endpoints, incl. the newly added `1.1/videos/tweet/config`); `LOADING_IMAGE_URL` → replace with a bundled asset (don't hotlink `abs.twimg.com`). Delete `OPEN_MEDIA_LINK*` strings (Decision 6). |
| `src/js/media_extractor.js` | **Seed for `packages/core`.** Solid pure function with unified_card array/object handling and `name=orig` URL building; it consumes the legacy REST `tweet_status` shape, which closely matches GraphQL's `legacy` object — adapt into the media section of `graphql-normalize` and port its logic into fixture-backed tests. Its UMD wrapper shows the intent to share with Node — exactly what `packages/core` formalizes. |
| `[xcom-xonly-debug]` / `[xcom-fix-*]` code in `main_react.user.js`, `background.js` | **Delete during rewrite.** The page-context-fetch and `__NEXT_DATA__` fallback attempts are dead ends superseded by plan 02; the debug logging includes cookie values (`ct0`/`gt`) — remove, never log cookies. Revert `background.js` `DEBUG = true`. |
| `options.js` commented-out bulk-button block | Delete (already disabled in baseline). |

Also remove the corresponding entries from `manifest*.json` content-script lists, the `*://api.twitter.com/*` match (only needed for OAuth), and the OAuth/TweetDeck strings from `_locales/` and `options.js`/`options.html` if present.

**Verification:** after deletion the extension must still load (`chrome://extensions` → load unpacked → no manifest/service-worker errors) and `main_react.user.js` must not reference any deleted symbol (`grep` for `ZipRequest|Twitter\.initialize|Decimal|session\.js`).

## 2. Vendored libraries

- **jQuery** — currently load-bearing throughout `main_react.user.js` (including a custom `hasClasses` plugin). Dropping it is desirable (smaller, fewer idioms for an agent to juggle) but do it *during* the rewrite of each module (plans 02/03/04), not as a standalone big-bang. New modules must not use jQuery; legacy code keeps it until replaced.
- **JSZip** — keep. Still the right tool for the bulk-download-as-ZIP feature. (Per-tweet downloads will stop zipping — see plan 04 — but bulk ZIP remains.)
- **decimal.min.js** — delete (BigInt, above).

## 3. Target file layout

Split `main_react.user.js` (5,026 lines, one IIFE, ~40 responsibilities) into single-purpose modules. Proposed layout:

```
src/
  manifest.json                # MV3, x.com + pbs.twimg.com matches
  manifest-firefox.json
  background.js                # service worker: options, downloads, commands, tab sorting
  content/
    page-interceptor.js        # MAIN world, document_start (plan 02) — no imports, self-contained
    index.js                   # isolated world entry: wires modules below
    tweet-cache.js             # the cache contract from 00-overview
    graphql-normalize.js       # raw GraphQL payload -> TweetRecord (pure, fixture-tested)
    dom-selectors.js           # every x.com selector lives here and nowhere else
    tweet-dom.js               # parse_tweet() successor: DOM -> {tweet_id, elements} (pure-ish)
    ui-buttons.js              # action-row + media-viewer button injection (plan 03)
    ui-dialog.js               # bulk-download dialog
    bulk-downloader.js         # auto-scroll driver + ZIP assembly
    save.js                    # media fetch + chrome.downloads + sidecar writing (plan 04)
    filename.js                # all naming conventions (pure, tested)
    i18n.js, options-client.js, log.js
  options/  (html/options.html, js/options.js, css/options.css moved together)
  img/, _locales/
test/
  fixtures/graphql/*.json      # captured real payloads (redacted)
  *.test.js
docs/
  ARCHITECTURE.md
  plans/
CLAUDE.md
```

### Build tooling

MV3 content scripts can't use ES modules directly, so add a minimal bundler:

- `esbuild` (single dev-dependency, no config file beyond a 20-line `build.mjs`): bundles `content/index.js` → `dist/content.js`, `page-interceptor.js` → `dist/page-interceptor.js` (separate bundle — it runs in MAIN world), `background.js` → `dist/background.js`; copies static assets and the right manifest. `npm run build`, `npm run watch`, `npm run build:firefox`.
- `vitest` for unit tests of the pure modules (`graphql-normalize`, `filename`, `tweet-dom` with jsdom).
- Keep ESLint, upgrade config to flat + modern env; drop `eslint-plugin-jquery` once jQuery is gone.
- Replace the mystery root scripts `chrome-mode`/`firefox-mode` (manifest swappers) with the build flags above.
- Current `package.json` deps (`acorn`, `lodash`, `minimist` — unused at runtime) → remove.

Current workflow amendment (2026-07-09): run the npm scripts above through
`.devcontainer/` rather than host npm. The devcontainer pins Node 22.12.0 and
keeps dependencies/cache in Docker volumes while writing build artifacts into
the checkout.

### Migration strategy (important — don't big-bang)

1. Land tooling + layout with the *existing* `main_react.user.js` as a temporary monolith module that the entry point imports. Extension must build and load at every commit.
2. Extract leaf modules first (`filename.js`, `log.js`, `i18n.js`), with tests.
3. Plans 02/03/04 then replace the monolith's data/UI/save layers piece by piece; delete the monolith when its last caller dies.

## 4. Documentation for AI maintainability

- **`CLAUDE.md`** (repo root): how to build/test/load the extension, the module map, the two "everything external goes through one file" rules (`dom-selectors.js`, `graphql-normalize.js`), the request-parity ground rules from 00-overview, and a "when X breaks the extension, look here first" triage table.
- **`docs/ARCHITECTURE.md`**: data-flow diagram (page traffic → interceptor → cache → UI/save), world/context boundaries (MAIN vs isolated vs service worker) and which APIs are available in each — this is the thing agents get wrong most often in extension work.
- **Comment language**: the codebase's comments are Japanese. New/rewritten modules use English comments; do not mass-translate untouched legacy code (churn without value, and the monolith is scheduled for deletion anyway).
- Update `README.md`: mark the userscript/TweetDeck variants as discontinued, document x.com support status honestly.

## 5. Explicitly *not* doing

- ~~No TypeScript migration in the first pass~~ **Amended by Decision 1 + plan 06:** `packages/core` (normalize, TweetRecord types, filename, sidecar) is TypeScript from the start — it's the contract shared by extension and companion app. Extension/app code stays JS. Layout becomes `packages/core/`, `extension/`, `app/` (plan 06 §3).
- No framework (React/Preact) for the dialog — it's one dialog; keep it as template-string DOM.
- No renaming of user-visible things: extension name, storage keys (`twMediaDownloader_*` in `chrome.storage.local`), filename conventions, shortcut keys. Users' saved options and archives must survive the upgrade.

## Acceptance criteria

- Devcontainer `npm run build` produces a loadable, error-free extension for
  Chrome; devcontainer `npm test` green.
- Repo JS (excluding vendored jszip/jquery, tests, fixtures) under ~4,000 lines after plans 02–04 land.
- Every x.com selector greps to exactly one file; every GraphQL field access greps to exactly one file.
- `CLAUDE.md` + `ARCHITECTURE.md` exist and match reality.
