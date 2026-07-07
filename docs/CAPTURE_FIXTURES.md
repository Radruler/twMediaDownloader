# Capturing real GraphQL fixtures from x.com

The normalizer (`packages/core/src/graphql-normalize.ts`) is tested against
fixtures in `test/fixtures/graphql/`. Fixtures are either **real captures**
(`*.captured.json` — each file's `__fixture` marker says when/how) or
**synthetic** (`*.synthetic.json`, hand-written from best-known payload
shapes). The agents that wrote the synthetics cannot log into x.com, so
capturing is the owner's job: capture real payloads while browsing normally,
redact them, and drop them in. When a real capture disagrees with a synthetic
fixture, the real one wins — fix the normalizer, not the capture.

**Status 2026-07-07:** real captures landed for `TweetDetail` (incl.
note_tweet, quote-RT, animated_gif, unified_card), `UserTweets` (pin,
RT-of-quote), `UserMedia`, `Likes`, and an empty `Bookmarks`. Still wanted:
`SearchTimeline`, `HomeTimeline`, a thread containing a deleted reply
(tombstone), and a non-empty `Bookmarks`.

Nothing in this workflow issues any request to X. The extension only saves
copies of responses the page fetched on its own.

## What to capture (one file each)

| # | Fixture | How to trigger it |
|---|---|---|
| 1 | `TweetDetail` | Open any tweet's status page (ideally one with replies) |
| 2 | `UserTweets` | Open a profile's main tab |
| 3 | `UserMedia` | Open a profile's Media tab, scroll once |
| 4 | `Likes` | Open your own Likes page |
| 5 | `Bookmarks` | Open your Bookmarks page |
| 6 | `SearchTimeline` | Run any search, view the results |
| 7 | note_tweet | Open the status page of a long-form (>280 chars, "Show more") post |
| 8 | quote-RT | Open the status page of a quote-retweet |
| 9 | tombstone | Open a thread that contains a deleted reply ("This Post was deleted…"), or a status page of a deleted/withheld tweet |

7–9 are `TweetDetail` payloads too — name them
`TweetDetail-note-tweet.captured.json`, `TweetDetail-quote.captured.json`,
`TweetDetail-tombstone.captured.json`.

## Path A (recommended): the built-in capture mode

1. `npm run build`, then load `dist/` unpacked via `chrome://extensions`
   (Developer mode → "Load unpacked").
2. On x.com, open DevTools → Console (top/page context is fine — these flags
   live in page `localStorage`, which both worlds share) and run:

   ```js
   localStorage.twmd_debug_overlay = '1';
   localStorage.twmd_capture_fixtures = '1';
   ```

3. Reload the page. A small dark overlay appears bottom-right showing
   cache size, payload counts per operation, and the last captured ids.
4. Browse the table above. As each operation fires, a `save <Op>` button
   appears in the overlay. Click it — the **last raw payload** for that
   operation downloads as `twmd-fixture-<Op>-<timestamp>.json`.
5. When done, turn it off:

   ```js
   delete localStorage.twmd_debug_overlay;
   delete localStorage.twmd_capture_fixtures;
   ```

## Path B (fallback): copy from DevTools

1. DevTools → Network tab, filter `graphql`.
2. Trigger the page per the table; click the request whose name starts with
   the operation you want (e.g. `UserMedia?...`).
3. Response sub-tab → right-click → Copy value (or select-all copy).
4. Paste into a new JSON file and add a `__fixture` marker by hand:

   ```json
   { "__fixture": { "op": "UserMedia", "captured_at": "2026-07-…" }, "data": { … } }
   ```

   (Path A writes this marker for you.)

## Redacting before committing

Committed fixtures are public. Strip user-identifying data:

- Replace your own screen_name/name/user ids anywhere they appear
  (`user_results`, `user_mentions`, `in_reply_to_*`, URLs).
- Cursor `value` strings encode session/position state — replace with
  `"REDACTED_CURSOR"`.
- Check for your handle in `source`, `card`, and profile image URLs.
- **Never** include request headers or cookies. Response bodies don't contain
  them, so Path A output is safe on that axis by construction; only identity
  fields need attention.
- Trim payloads if you like (fewer entries is fine) — but keep entries
  *complete*; don't delete fields inside a kept tweet.

Keep media URLs (`pbs.twimg.com`/`video.twimg.com`) intact if you're
comfortable — they're what the tests exercise. Swapping the path segments for
plausible fakes (same URL shape) is acceptable too.

## Wiring a capture into the tests

1. Save as `test/fixtures/graphql/<Op>[-variant].captured.json`. Make sure
   the `__fixture.op` field is the operation name (tests read it).
2. `npm run update-expected` — generates
   `test/fixtures/graphql/expected/<same name>.json`.
3. **Review both files** (the expected output is the contract: check
   `full_text`, media variants, user fields, tombstones look right).
4. `npm test`. If normalization dropped something the payload clearly
   contains, that's a normalizer bug: fix
   `packages/core/src/graphql-normalize.ts` until the expected output is
   correct, regenerate, re-review.
5. Once a real capture covers what a synthetic fixture covered, delete the
   synthetic file and its `expected/` counterpart in the same commit.

## Quick sanity walkthrough (no fixture saving)

With just `localStorage.twmd_debug_overlay = '1'` set, scroll Home, a
profile, its Media tab, Likes, Bookmarks, a search, and one status page. The
overlay's per-op counters should tick up for `HomeTimeline`, `UserTweets`,
`UserMedia`, `Likes`, `Bookmarks`, `SearchTimeline`, `TweetDetail`, and the
cache size should grow into the hundreds. Any op X has renamed will show up
via `localStorage.twmd_debug = '1'` console lines
(`unlisted GraphQL op: …`) — extend the pass-list in
`extension/content/page-interceptor.js` accordingly.
