# twMediaDownloader — Modernization Plan: Overview

**Status:** Planning. Nothing in this directory has been implemented yet.
**Audience:** AI agents (and humans) working on this repo, possibly in parallel. Each numbered plan document is scoped so one agent can own it.

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
| Alt+Click opens media in tabs instead of downloading | `is_open_media_mode()` | Yes |
| Bulk download of user/media/likes/bookmarks/search/notifications timelines into a ZIP, with tweet-ID range, count limit, media-type filters, dry-run, CSV+log in ZIP | dialog in `main_react.user.js`, data from `timeline.js` | Yes (rebuilt data source, plans 02/05) |
| Filename convention `<screen_name>-<tweet_id>-<YYYYMMDD_hhmmss>-{img|gif|vid}<N>.<ext>` | `setup_image_download_button()` etc. | Yes — users rely on this for existing archives |
| Original-size images (`name=orig`), max-bitrate MP4 | `get_img_url_orig()`, variant selection | Yes |
| Options page (en/ja), per-feature toggles, night-mode aware styling | `options.js`, `_locales/` | Yes |
| Keyboard shortcuts Shift+Alt+D / Shift+Alt+L | `manifest.json` `commands` | Yes |
| Tab-sorting when opening multiple images | `background.js` | Yes (low priority) |
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

**Suggested build order if serialized:** 01 → 02 → 03+04 → bulk-download rebuild (02 §6) → 06 (transport, app, library UI) → 05's Option B if still wanted.

## Module contract (agree on this before parallel work)

All plans reference this interface; implement it in `src/js/tweet-cache.js` (or `src/lib/tweet-cache.ts` if 01's tooling lands first):

```js
// Isolated-world singleton, populated by the interceptor bridge.
TweetCache.get(tweetId)         // -> TweetRecord | null   (synchronous, in-memory)
TweetCache.onUpdate(cb)         // cb(tweetId, TweetRecord) — fired as page traffic arrives
TweetCache.stats()              // { size, hitRate } for debugging

// TweetRecord (normalized from GraphQL tweet_results.result):
{
  id_str, created_at_ms, lang,
  user: { id_str, screen_name, name },
  full_text,                    // note_tweet (long-form) text when present, else legacy full_text, entities expanded
  urls: [{ short, expanded }], hashtags: [], mentions: [],
  in_reply_to_status_id_str, quoted_status_id_str, conversation_id_str,
  counts: { replies, retweets, likes, quotes, bookmarks, views },
  is_sensitive,
  media: [{
    type: 'photo'|'video'|'animated_gif',
    media_key, index,           // 1-based position in tweet
    image_url,                  // pbs.twimg.com base (no size suffix)
    alt_text,
    video_variants: [{ bitrate, content_type, url }],  // for video/gif
    width, height, duration_ms,
  }],
  source_op,                    // GraphQL operation that produced it (TweetDetail, UserMedia, …)
  captured_at_ms,
}
```

## Ground rules for all work

- **Never forge API requests when the data is already in the page.** The cache-first rule. Active fetches are a documented last-resort fallback only (02 §5).
- **Media fetches must be indistinguishable from normal browsing:** plain `GET` to `pbs.twimg.com`/`video.twimg.com` with no custom headers, browser-managed cookies — same as the user clicking "open image in new tab".
- **X's DOM and GraphQL surface rotate constantly.** Every selector and every GraphQL field access goes through one module each (`dom-selectors.js`, `graphql-normalize.js`) with fixture-based tests, so future breakage is a one-file fix. This is the core "easier for AI to maintain" move: small files, single responsibility, fixtures that encode what the external world looked like when the code was written.
- Verify selectors/payloads against the live site before trusting anything written here — these plans were written 2026-07 from code inspection, not live-DOM inspection.
- Do not delete or rewrite `README.md` history/credits; the project is MIT, originally by furyu — keep attribution.
