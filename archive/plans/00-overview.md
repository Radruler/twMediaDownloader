# twMediaDownloader — Modernization Plan: Overview

**Status:** Planning complete, decisions locked (see Decisions Log below). Nothing implemented yet.
**Audience:** AI agents (and humans) working on this repo, possibly in parallel. Each numbered plan document is scoped so one agent can own it.

> **PREREQUISITE — SATISFIED (2026-07-07):** the owner's newer local iteration (0.1.5.4 with
> x.com fixes) was imported as the repo baseline in commit `addb00f`. The assessment below is
> updated accordingly; plan 01's deletion table was re-verified. Dispatch step 0 is done —
> implementation can start at step 1.
>
> **Reconciliation summary vs the original assessment:**
> - Finding 1 (wrong domain) — **fixed in baseline**: manifest + code now target `x.com`.
> - Finding 2 (dead REST endpoints) — **still true**: endpoints were renamed to `api.x.com/1.1/…`
>   and `/2/timeline/…` but are the same shut-down legacy APIs. The baseline's own code comments
>   confirm the dead end ("Try to fetch via API (will fail due to CSP)") and its `__NEXT_DATA__`
>   DOM fallback cannot work — x.com is not a Next.js app; that global does not exist there.
>   Plan 02 (passive GraphQL interception) is unchanged and now evidence-backed by the baseline's
>   failed active-fetch attempts.
> - Findings 3–5 (TweetDeck/legacy/selector rot) — baseline removed the legacy userscript and
>   parked TweetDeck + packaging scripts in `src/deprecated/`; selectors unchanged (still rotted).
> - New in baseline, kept as seeds: `src/js/config.js` (config/strings extraction) and
>   `src/js/media_extractor.js` (shared media extraction with unified_card handling + `name=orig`
>   URLs) — both anticipate plan 01/02 module boundaries; see plan 01 §1a.

## Decisions Log (owner-confirmed, 2026-07-07)

These override anything else in the plan documents where they conflict:

1. **TypeScript for `packages/core` only**; extension/app code stays JS.
2. **No active API fetch, ever.** Plan 02 §5 rung 3 is rejected — the fallback ladder ends at "open the tweet so the page fetches it". The browser's own traffic is the only API data source.
3. **Bulk download is scroll-driven** (slower, zero forged requests) — accepted.
4. **Sensitive-media flag is always ignored** — download buttons work regardless of interstitials.
5. **Download buttons always grab ALL media in the post** — including in the media viewer. No "current item only" mode.
6. **No Alt+Click / open-in-tabs mode.** Delete `OPEN_MEDIA_LINK_BY_DEFAULT`, `open_multi_tabs`, and the tab-sorting machinery with it.
7. Sidecar default: **`.txt` on**, `.json` available as option.
8. Per-tweet downloads save **individual files** (no per-tweet ZIP).
9. Standalone mode saves to **Downloads subfolders only**; File System Access (plan 05 Option B) is deprioritized — the companion app is the path to arbitrary paths.
10. **Chrome-first**; Firefox best-effort.
11. **Self-distributed / personal use** — no store submission. Permissions and update cadence optimized for unpacked loading.
12. Companion app shell: **Electron/Node** (max reuse of JS core).
13. Connected-mode bulk output: **folder-per-run via the app**; ZIP remains standalone-mode behavior. (Media-server integration explicitly later.)
14. Library retention: **infinite, always**. No auto-expiry; manual purge tool only.
15. App launch: **manual** (no tray autostart in v1).
16. Multi-browser/profile capture: **later**.
17. **Edited tweets:** supported now as an edge case — logical-post grouping via `edit_control` initial ID, versions recorded.
18. **Deleted posts:** keep in library with a "deleted" indicator. Detection is **passive only** (captured tombstones, 404s during archiving) — never poll X.
19. **Auto-record everything scrolled** into a "seen" feed with a queue to formalize items into the archive (plan 06 §two-tier model).
20. **Non-thrashy maintenance:** smoke tests are manual, low-volume, normal-browsing-shaped. Nothing in this project may hammer X with unusual request patterns.
21. **No thumbnail store.** The library renders archived items from their original files on disk; unarchived items are text-first (on-demand CDN preview allowed, never persisted, never prefetched in bulk).
22. ToS risk acknowledged by owner; passive-capture posture is the deliberate mitigation.

## The single most important finding

**This extension is currently 100% non-functional on today's X/Twitter.** This is not an edge case — nothing works:

1. **Wrong domain.** Every manifest `matches`/`host_permissions` entry and every userscript `@include` targets `twitter.com` / `tweetdeck.twitter.com`. X migrated the web client to `x.com` in May 2024 (`twitter.com` now redirects). The content scripts never even inject.
2. **Every data API it calls is dead.** The code is built on Twitter's legacy REST endpoints, all shut down around mid-2023:
   - `api.twitter.com/1.1/statuses/user_timeline.json`, `1.1/search/universal.json`, `1.1/activity/about_me.json`, `1.1/favorites/list.json`, `1.1/statuses/show.json` (see `src/js/timeline.js:486-536`, `src/js/main_react.user.js:253`)
   - `api.twitter.com/2/timeline/{media,favorites,bookmark,conversation}/…` (`src/js/timeline.js`, `src/js/main_react.user.js:1104`)
   - The modern web client exclusively uses GraphQL at `x.com/i/api/graphql/<queryId>/<OperationName>`.
3. **TweetDeck is gone** (killed July 2023) — `src/js/main_tweetdeck.user.js` (1,639 lines) targets a product that no longer exists.
4. **Legacy Twitter web UI is gone** — `src/js/twMediaDownloader.user.js` (5,124 lines) targets the pre-2019 UI.
5. **DOM selectors have rotted** — e.g. individual-tweet detection keys off a `help.twitter.com` source-label link (`src/js/main_react.user.js:3955`) that no longer exists on x.com.

**Consequence for planning:** "Refactor without losing functionality" must be read as *preserve the feature set* (per-tweet media download, bulk timeline ZIP, filename conventions, options page, keyboard shortcuts), not *preserve the code paths* — the code paths are dead. The data layer must be rebuilt. This is also an opportunity: the modern rebuild (passive GraphQL interception, plan 02) directly satisfies the other goals — minimal/zero additional network requests and free access to full tweet metadata for sidecar files (plan 04).

## Feature set to preserve (the contract)

From the current code and README:

| Feature | Current implementation | Keep? |
|---|---|---|
| Per-tweet media download button in each tweet's action row | `main_react.user.js` `add_media_button_to_tweet()` | Yes (improved, plan 03) |
| Alt+Click opens media in tabs instead of downloading | `is_open_media_mode()` | **No — delete** (Decision 6) |
| Bulk download of user/media/likes/bookmarks/search/notifications timelines into a ZIP, with tweet-ID range, count limit, media-type filters, dry-run, CSV+log in ZIP | dialog in `main_react.user.js`, data from `timeline.js` | Yes (rebuilt data source, plans 02/05) |
| Filename convention `<screen_name>-<tweet_id>-<YYYYMMDD_hhmmss>-{img|gif|vid}<N>.<ext>` | `setup_image_download_button()` etc. | Yes — users rely on this for existing archives |
| Original-size images (`name=orig`), max-bitrate MP4 | `get_img_url_orig()`, variant selection | Yes |
| Options page (en/ja), per-feature toggles, night-mode aware styling | `options.js`, `_locales/` | Yes |
| Keyboard shortcuts Shift+Alt+D / Shift+Alt+L | `manifest.json` `commands` | Yes |
| Tab-sorting when opening multiple images | `background.js` | **No — delete** (Decision 6; only served open-in-tabs) |
| TweetDeck support, legacy-Twitter support, OAuth 1.0a flow | dead products/paths | **No — delete** (plan 01) |

## Target architecture (one paragraph)

A Manifest V3 extension (Chrome; Firefox via MV2/MV3 variant) for `x.com`. A tiny **MAIN-world interceptor** script observes the page's *own* GraphQL responses (fetch/XHR patch — zero requests are ever forged) and forwards raw payloads to the isolated content script, which normalizes them into a **tweet cache** (id → author, text, media variants, stats). The **UI layer** injects download buttons into tweets *and the media-viewer overlay* by watching the DOM, and reads everything it needs from the cache. The **save layer** fetches media bytes (one plain GET per file, identical to the browser's own image/video requests) and writes files plus a **metadata sidecar** via `chrome.downloads`. Bulk download drives the page (auto-scroll) so pagination requests are literally the browser's own. Details and alternatives: plans 02–05.

## Plan documents & suggested parallelization

| Doc | Scope | Depends on | Parallel-safe |
|---|---|---|---|
| [01-refactor.md](01-refactor.md) | Dead-code removal, repo structure, build/test tooling, docs (CLAUDE.md/ARCHITECTURE.md) | — | Yes — pure deletion/scaffolding |
| [02-network-capture.md](02-network-capture.md) | GraphQL response interception, tweet cache, payload normalization, request-parity rules | 01 (structure) | Yes — defines the cache API contract below |
| [03-ui.md](03-ui.md) | Download buttons everywhere (incl. media viewer full view — the reported bug), selectors, feedback UX | cache API *contract* only | Yes |
| [04-metadata-sidecar.md](04-metadata-sidecar.md) | Sidecar `.txt`/`.json` spec, filename module, save layer (`chrome.downloads`) | cache API *contract* only | Yes |
| [05-alternative-architectures.md](05-alternative-architectures.md) | Spec/evaluation: File System Access, `chrome.debugger` zero-request capture, native-messaging desktop helper, CDP desktop app | — | Yes — research/spec only |
| [06-local-companion-app.md](06-local-companion-app.md) | Local companion app: extension captures, app downloads/writes/keeps a "recently viewed" library. **Amends 05's verdict** (D+E hybrid is now the target end-state) and 01 (shared `packages/core`, TypeScript for core) | 01, 02 contracts | App itself: yes, after core lands |

See also [discussion-02-vs-05.md](discussion-02-vs-05.md) for the reasoning that led to plan 06.

## Dispatch sequence (the rewrite, in order)

Instruction format: "Read `docs/plans/` (00 first, Decisions Log is binding), then execute step N."

| Step | Work | Plan(s) | Parallel? |
|---|---|---|---|
| 0 | Owner pushes the newer repo version (x.com fixes); agent reconciles 00's assessment + 01's deletion table against it | — | gate for everything |
| 1 | Dead-code removal + `packages/core`/`extension`/`app` scaffold + esbuild/vitest + CLAUDE.md/ARCHITECTURE.md | 01 (+06 §6 layout) | single agent |
| 2 | **DONE 2026-07-07** (see [step-2-handoff.md](step-2-handoff.md)) — Interceptor + normalizer (TS, in core) + tweet cache + fixtures. Live-site verification: real captures for 5 ops landed; SearchTimeline/HomeTimeline/tombstone captures still pending | 02 | single agent; unlocks everything |
| 3a | UI layer: buttons everywhere incl. media viewer, toasts, selectors module | 03 | parallel with 3b |
| 3b | Save layer: chrome.downloads, filename+sidecar in core, standalone mode complete | 04 | parallel with 3a |
| 4 | Bulk rebuild: scroll driver + dialog port + standalone ZIP output | 02 §6, 03 §6, 04 §5 | after 3a+3b |
| 5 | App M1+M2: protocol, pairing, SQLite ingest (seen/queue/archive), downloader, folder-per-run | 06 §2–4, §7 | can start after 2 (needs only core + capture stream), i.e. parallel with 3–4 |
| 6 | App M3+M4: library UI, search, versions/deleted badges, purge, packaging | 06 §5, §7 | after 5 |

Steps 3a, 3b, and 5 are the maximum safe parallel width (three agents) once step 2 lands.

## Module contract (agree on this before parallel work)

All plans reference this interface. **Implemented in step 2 (2026-07):** the cache lives in
`extension/content/tweet-cache.js`; the authoritative `TweetRecord`/`TombstoneEvent` types live in
`packages/core/src/tweet-record.ts` (TS, Decision 1) and the normalizer in
`packages/core/src/graphql-normalize.ts`.

```js
// Isolated-world singleton, populated by the interceptor bridge.
TweetCache.get(tweetId)         // -> TweetRecord | null   (synchronous, in-memory; LRU-touches)
TweetCache.onUpdate(cb)         // cb(tweetId, TweetRecord) — fired as page traffic arrives;
                                //   returns an unsubscribe function
TweetCache.stats()              // { size, hitRate } for debugging
// (TweetCache.put(record) exists for the bridge; consumers read only.)

// TweetRecord (normalized from GraphQL tweet_results.result):
{
  id_str, created_at_ms, lang,  // created_at_ms falls back to snowflake-derived time, null if underivable
  user: { id_str, screen_name, name },
  full_text,                    // note_tweet (long-form) text when present, else legacy full_text, entities expanded
  urls: [{ short, expanded }], hashtags: [], mentions: [],
  in_reply_to_status_id_str, quoted_status_id_str, conversation_id_str,
  retweeted_status_id_str,      // step-2 addition: set on the outer RT record; inner tweet cached under its own id
  edit_initial_id_str,          // step-2 addition: edit_control initial id — plan 06's post_key (Decision 17)
  counts: { replies, retweets, likes, quotes, bookmarks, views },
  is_sensitive,
  media: [{
    type: 'photo'|'video'|'animated_gif',
    media_key, index,           // 1-based position in tweet
    image_url,                  // pbs.twimg.com base (no size suffix)
    alt_text,
    video_variants: [{ bitrate, content_type, url }],  // for video/gif; bitrate null for HLS entries
    width, height, duration_ms,
  }],
  source_op,                    // GraphQL operation that produced it (TweetDetail, UserMedia, …)
  captured_at_ms,
}
```

The normalizer also emits **tombstone events** (plan 02 §3 / Decision 18):
`{ tweet_id, entry_id, typename, text, source_op, captured_at_ms }` — `tweet_id` derived from the
timeline entryId when possible, null otherwise (e.g. a tombstoned `TweetResultByRestId`).

## Ground rules for all work

- **Never forge API requests when the data is already in the page.** The cache-first rule. Active fetches are a documented last-resort fallback only (02 §5).
- **Media fetches must be indistinguishable from normal browsing:** plain `GET` to `pbs.twimg.com`/`video.twimg.com` with no custom headers, browser-managed cookies — same as the user clicking "open image in new tab".
- **X's DOM and GraphQL surface rotate constantly.** Every selector and every GraphQL field access goes through one module each (`dom-selectors.js`, `graphql-normalize.js`) with fixture-based tests, so future breakage is a one-file fix. This is the core "easier for AI to maintain" move: small files, single responsibility, fixtures that encode what the external world looked like when the code was written.
- Verify selectors/payloads against the live site before trusting anything written here — these plans were written 2026-07 from code inspection, not live-DOM inspection.
- Do not delete or rewrite `README.md` history/credits; the project is MIT, originally by furyu — keep attribution.
