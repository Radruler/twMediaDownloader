# Plan 04 — Save Layer: Files, Filenames, Metadata Sidecar

Goal: save media plus a **sidecar text file with the post's text and metadata, using zero additional network requests** (the data comes from the `TweetCache`, plan 02). Also modernize how files reach disk.

## 1. Saving mechanism: `chrome.downloads` replaces per-tweet ZIPs

Today a per-tweet download zips images client-side and clicks a blob/data URL (`async_download_zip`, `main_react.user.js:4183`) — a workaround for not having the `downloads` permission. Change:

- Add `"downloads"` permission. Content script sends `{save: [{url|blobText, filename}]}` to the service worker; worker calls `chrome.downloads.download({ url, filename: 'twMediaDownloader/<screen_name>/<basename>', saveAs: false, conflictAction: 'uniquify' })`.
- Per-tweet download saves **individual files** (media + sidecar) into a per-user subfolder of Downloads — no more one-zip-per-tweet (sidesteps the Firefox blob/data-URL warnings the legacy code fought, `main_react.user.js:4188-4193`).
- Sidecar/text content: service workers can't `URL.createObjectURL`; pass sidecar text to the worker and download as a `data:text/plain;charset=utf-8;base64,…` URL (fine at sidecar sizes). ZIP blobs (bulk flow) stay in the content-script context where blob URLs work, or use an offscreen document if needed.
- **Bulk download keeps producing a single ZIP in standalone mode** (unchanged user contract), now containing sidecars too (one per tweet) alongside the log/CSV. In app-connected mode, bulk output is folder-per-run via the app (Decision 13, plan 06).
- **Decision 8: per-tweet downloads are individual files only** — do not build a per-tweet-zip option.

## 2. Filenames (`content/filename.js`, pure + tested)

Preserve the existing convention exactly — users have years of archives named this way:

```
<screen_name>-<tweet_id>-<YYYYMMDD_hhmmss>-{img|gif|vid}<N>.<ext>     # media (N is 1-based)
<screen_name>-<tweet_id>-<YYYYMMDD_hhmmss>.txt                        # sidecar (new)
<screen_name>-<tweet_id>-<YYYYMMDD_hhmmss>.json                       # sidecar, json variant (new, optional)
```

Timestamp = tweet creation time in the user's local TZ (existing `format_date` behavior). Sanitize `screen_name` for path safety (Windows reserved chars); tweet IDs are numeric, safe. Centralize *all* naming here, including the bulk-ZIP name and in-ZIP paths.

## 3. Sidecar content

Source: `TweetCache.get(tweet_id)` — captured from the page's own traffic, so **no network request is ever made for sidecar data**. If the record is missing (cache-miss ladder, plan 02 §5), fall back to DOM-extracted fields and mark the sidecar `"partial": true` / `# (partial - reconstructed from DOM)` rather than making a request.

### `.txt` (default, human-readable)

```
https://x.com/<screen_name>/status/<tweet_id>

<full_text — long-form/note text when present, t.co links expanded, trailing media link stripped>

---
author:      <name> (@<screen_name>) [id:<user_id>]
date:        2026-07-04 21:03:11 +09:00 (2026-07-04T12:03:11.000Z)
lang:        ja
replies: 12 | retweets: 345 | likes: 6789 | quotes: 10 | bookmarks: 22 | views: 123456
in_reply_to: <status url, if any>
quoting:     <status url, if any>
media:
  1. photo  <orig url>   alt: <alt text, if any>
  2. video  <chosen mp4 url> (1280x720, 30012ms)
hashtags:    #a #b
mentions:    @x @y
links:       <expanded urls>
captured:    2026-07-06T… via GraphQL:<source_op>
```

Exact layout can be tuned; requirements: post URL first line, full text verbatim (multi-line preserved), then a stable `key: value` block (greppable), UTF-8, LF.

### `.json` (option, machine-readable)

The full `TweetRecord` (00-overview contract) plus `sidecar_version`, the list of saved filenames, and the chosen media URLs. Schema-versioned so downstream tooling can rely on it.

Options page additions: sidecar on/off (default **on**), format txt/json/both (default **txt**, Decision 7).

## 4. Media selection rules (restating from plan 02 for the implementer)

- Photos: `image_url` + `?format=<ext>&name=orig`; on 404 retry `name=4096x4096`, then `name=large`. Extension from the URL's `format`/path (`jpg`/`png`/`webp`).
- Video: highest-bitrate `content_type == 'video/mp4'` variant. Animated GIFs (X stores them as mp4): the single mp4 variant, `gif` filename prefix (legacy behavior).
- Fetch with plain `fetch(url)` from the content-script/page context — no custom headers (request parity, plan 02).
- Keep `DOWNLOAD_SIZE_LIMIT_MB` enforcement for the bulk flow.

## 5. Bulk-flow integration

The bulk ZIP gains, per tweet, the same sidecar file next to its media entries (in-ZIP path `<screen_name>-<tweet_id>-<ts>/` grouping is *not* introduced — keep the flat layout of the current ZIPs; sidecars sit flat too). The existing log + CSV in ZIP remain; the CSV columns can now be filled from `TweetRecord` (it already has text/counts columns wired for the old API shape — remap in one place).

## Acceptance criteria

- Clicking download on a photo tweet produces N image files + 1 sidecar in `Downloads/twMediaDownloader/<screen_name>/`, with **zero** requests other than the media `GET`s (verify in DevTools).
- Sidecar of a long-form (note) post contains the full text, not the truncated preview; t.co links expanded; alt text present.
- `filename.js` and sidecar serialization covered by unit tests incl. Windows-hostile names, emoji/RTL text, multi-line text.
- Existing users' options survive; new options appear localized (en/ja).
