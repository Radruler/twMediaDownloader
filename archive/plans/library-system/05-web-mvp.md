# Archive Library — Web MVP

## Product shape

Build one private web application with route-level surfaces rather than three
separately deployed frontends. The primary surface is a media-forward library;
identity/history and administration are adjacent routes using the same API,
auth, filters, and design system. A future collage editor remains a separate
API client.

The MVP should feel like a useful archive browser, not an admin panel with
thumbnails attached. It must still expose enough state to trust ingest and
archive operations.

## Implementation choice

Use Preact in plain JavaScript/JSX, bundled with the repository's existing
esbuild workflow (or a small dedicated esbuild entry invoked by it). This
keeps the runtime and bundle light while making stateful filters, optimistic
curation, and detail navigation maintainable. Do not introduce TypeScript
outside the existing `packages/core` policy during this phase.

Suggested layout:

```text
web/
  src/
    app.jsx
    api.js
    router.js
    state/
    components/
    routes/library/
    routes/item/
    routes/people/
    routes/accounts/
    routes/imports/
    routes/settings/
    styles/
  index.html
```

The server serves fingerprinted production assets and an HTML history
fallback. Development may use esbuild watch plus the real API server; avoid a
mock backend becoming a parallel truth.

Keep dependencies purposeful:

- Preact and a small router, or a tiny in-repo URL router if it stays clear;
- no global state framework initially—URL query state plus route-local stores
  are sufficient;
- no component megaframework or build-heavy SSR stack;
- use browser `fetch`, `IntersectionObserver`, and `EventSource` directly;
- add a focused accessible combobox/dialog primitive only if implementing it
  correctly in-house is taking product time.

## Information architecture

Primary navigation:

- **Library** — content/media grid and saved filter presets;
- **People** — curated people/personas and linked service accounts;
- **Accounts** — provider accounts, handle/name history, state evidence;
- **Imports** — scan manifests and import results (hidden until enabled);
- **Activity** — archive/import failures and job progress;
- **Settings** — devices, owner accounts, API tokens, server/storage status.

Routes:

```text
/library
/items/:itemId
/media/:mediaId
/people
/people/:personId
/accounts/:accountId
/imports/:batchId
/activity
/settings/devices
/settings/tokens
/settings/system
```

Every filterable library state is encoded in the URL so it can be bookmarked,
refreshed, and shared between the owner's devices without local hidden state.
The server remains private; "shareable" means stable within the owner's
instance.

## Library grid

### Default view

- archived items with at least one available media asset;
- newest source creation time first;
- one card per logical content item, so edits and multi-image posts do not
  flood the grid;
- the first/preferred media fills the card, with a clear multi-item count and
  optional small mosaic for 2–4 assets;
- video/GIF badges and duration where known;
- compact author handle, source icon, date, rating/local-favorite state, and
  source liked/bookmarked markers;
- deleted/unavailable and partial-archive badges are visible without dominating
  the media.

Do not load originals in the grid. Use `grid-320`/`grid-640` previews with
`srcset`, explicit dimensions/aspect ratio, native lazy loading, and an error
placeholder. The item detail decides when a larger preview or original is
appropriate.

### Filter bar/drawer

The common controls stay one tap away:

- search;
- service;
- author account or linked person;
- source likes and bookmarks, with viewer-account selector or "any of mine";
- local favorites;
- rating range;
- tags (all/any/exclude);
- media type;
- archived/queued/failed/seen-only state;
- availability/deleted state;
- date range and sort.

Active filters render as removable chips. "Clear" resets to the product
default, not an ambiguous server default. The result header states the
meaning in plain language—for example, "Archived photos bookmarked by either
@owner account, tagged Reference."

Provide saved filter presets after the base query is stable. A preset stores
the API filter object and UI view preferences, not raw SQL.

### Pagination and scrolling

- Fetch pages with the API cursor; prefetch near the end using
  `IntersectionObserver`.
- Keep a bounded number of decoded image elements; start with ordinary DOM and
  `content-visibility:auto`, measure before adopting virtualization.
- Preserve cursor, approximate scroll anchor/item ID, and filters when opening
  a detail view and navigating back.
- Offer an explicit "Load more" fallback for accessibility/network recovery.
- Never implement infinite scroll with page-number offsets.

A uniform responsive grid is preferable for MVP correctness and stable order.
True masonry/justified layout can follow after keyboard order, scroll restore,
and performance are measured.

### Card interactions

- click/Enter opens item detail;
- one-click local favorite;
- keyboard-accessible 1–5 rating menu or quick control;
- tag action opens a searchable multi-select;
- archive/retry action when bytes are absent/failed;
- a menu can copy source URL or stable library URL;
- source liked/bookmarked indicators are read-only and never imply an action on
  Twitter.

Optimistic curation updates include the current resource version. On `409`,
refetch and show a concise conflict message instead of overwriting.

## Item detail

The detail route supports the complete review workflow:

1. large media area with ordered assets and keyboard/swipe navigation;
2. preview by default, explicit original/full-resolution action;
3. video player using authenticated range responses;
4. complete post text, alt text, source link, timestamps, and relationships;
5. author/account/person link and observed handle at capture when available;
6. source likes/bookmarks grouped by the owner's viewer accounts;
7. local rating, favorite, tags, note, and collections;
8. archive state per media asset plus retry/error details;
9. edited-version selector/diff-friendly view;
10. deletion/unavailability evidence with "observed at" language.

For a multi-media post, item-level curation is primary. Each asset has an
advanced/expanded section for media-level rating, favorite, tags, note, alt
text, dimensions, and stable media ID. Make the target of any edit visually
unambiguous.

Do not dump raw JSON into the normal interface. An admin diagnostics disclosure
may show sanitized normalized snapshots and IDs for troubleshooting.

## Seen-only and archive actions

All passively captured content is queryable, even when no bytes are archived.
For seen-only records:

- display provider-captured poster/metadata only if doing so does not create an
  unplanned provider request; otherwise use a metadata placeholder;
- expose "Archive" to queue server-side acquisition from stored candidates;
- show that the operation may fail if source media has disappeared;
- update through SSE/polling from queued to per-asset results;
- never have the UI ask the source API for missing data.

The default grid avoids a confusing sea of remote-only placeholders, but the
"Seen, not archived" filter makes this acquisition inbox easy to use.

## People and account history

### People list/detail

- cards show the curated label, current linked accounts/services, recent media
  preview strip, item count, and owner marker;
- person detail includes combined media-forward grid with a toggle to separate
  or include linked accounts;
- link-account flow searches existing unlinked accounts and previews the
  consequence (counts/services/current handles) before confirmation;
- unlink is reversible in history and does not delete either account/content;
- "merge people" is a previewed relink operation with an audit record, not row
  destruction.

### Account detail

- service/native ID and current observed handle/name;
- timeline of handle, display-name, and availability periods with first/last
  observed timestamps and evidence confidence;
- linked person and owner/viewer-account status;
- media-forward content grid scoped to that account;
- unavailable/deleted/suspended labels only when captured evidence supports
  them; otherwise say "not observed recently" rather than guessing.

The MVP is manual. If alias suggestions are added later, they appear as
untrusted proposals with reasons and never link automatically.

## Tags, ratings, notes, and collections

- Ratings are nullable integers 1–5. "Unrated" is not zero or one star.
- Local favorite is a separate boolean with its own icon/label; never reuse a
  Twitter heart/bookmark icon without text/context.
- Tag names are case-insensitively unique after normalization but preserve a
  display form. Autocomplete includes counts.
- Tag create/rename/merge flows preview affected item/media counts.
- Notes preserve plain text in MVP. Do not render arbitrary HTML.
- Collections support explicit ordered entries and can contain content items
  or individual media. Smart/saved searches are presets, not collection rows.
- Bulk curation may follow after single-item correctness. When added, it must
  show exact selection scope and be undoable/audited where practical.

## Activity and trust surfaces

An archive is only useful if failures are legible. The Activity route shows:

- queued/running/recent archive jobs;
- partial/failed items with normalized reason and safe retry action;
- preview/import job progress;
- capture devices with last sync, outbox count/oldest event/drop counters;
- missing/mismatched blob health alerts;
- migration/read-only/backup warnings supplied by the server.

Avoid raw logs as the primary UX. Link to request/job IDs for diagnostics.

## Settings

### Devices

- create one-time pairing code;
- list label, created/last-seen, extension version, service capabilities, and
  recent delivery health;
- revoke/rename;
- never display an existing device token after issuance.

### Owner accounts

- select which observed accounts belong to the owner/person "me";
- label accounts and mark active viewer accounts;
- explain that source likes/bookmarks are account-relative;
- resolve unattributed viewer-state evidence when possible.

### API tokens

- create named, scoped tokens and show once;
- list scope/created/last-used/revoked;
- default collage token recipe is read-only metadata+media.

### System

- server/build/schema version;
- configured roots as redacted/operator-friendly labels, not necessarily full
  paths to normal clients;
- database/original/preview sizes and integrity/backup timestamps;
- preview cache rebuild/clear action only after its server-side safe operation
  exists;
- no browser-triggered restore in MVP.

## Responsive and accessibility requirements

- Fully usable on desktop and phone; filter drawer and detail media controls
  adapt rather than shrink into desktop density.
- Semantic buttons/links, visible focus, logical DOM/tab order, skip links,
  labelled icons, and modal focus management.
- Rating communicates numeric value to assistive technology.
- Alt text from the source is used for archived media; missing alt text is
  distinguished from empty decorative media.
- Respect reduced motion; do not autoplay video/audio.
- Color is never the only archive/deleted/rating signal.
- Grid and detail work at 200% zoom.
- Keyboard shortcuts are optional enhancements and never the sole path.

## Error, loading, and offline behavior

- Skeletons preserve card dimensions; do not shift the grid as previews load.
- Route errors distinguish unauthenticated, server unavailable, query invalid,
  media missing, and permission/scope issues.
- Retry buttons retry the API read, not the provider fetch, unless explicitly
  labelled "Retry archive."
- If SSE disconnects, show a subtle stale/live indicator and poll/refetch active
  jobs; curation reads/writes still use HTTP.
- Do not promise an offline web library in MVP. A service worker/cache can be
  considered later, but private media cache behavior needs deliberate limits.

## Security in the browser

- no `dangerouslySetInnerHTML` for post text, notes, handles, or import paths;
- source links use fixed schemes and `rel="noopener noreferrer"`;
- no persistent secrets in localStorage; owner auth is HttpOnly cookie and
  explicit API tokens remain outside the bundled UI;
- CSP allows only the same application origin for scripts/media/API, plus no
  provider images by default;
- avoid loading third-party fonts, analytics, avatars, or scripts that leak
  private browsing/library metadata;
- sign-out clears the server session and in-memory application state.

## Testing and acceptance

### Component/route tests

- URL filter serialization and back/forward restoration;
- source relationship `unknown` versus false rendering;
- item-level versus media-level curation target;
- optimistic mutation success/conflict/rollback;
- pagination dedupe and cursor error recovery;
- account link/unlink previews;
- auth expiration and CSRF failure handling.

### Browser tests

Add a small Playwright suite against a seeded real API/database:

1. log in and load the default archived grid;
2. combine service/person/bookmark/tag/rating filters and reload the URL;
3. open an item, rate/tag/favorite it, navigate back, and see the card update;
4. queue a seen-only archive and observe a simulated job completion;
5. seek a video through the range endpoint;
6. link/unlink two accounts to a person and verify combined grid behavior;
7. exercise phone and keyboard navigation at key routes;
8. verify a deleted/partial/missing-preview item degrades clearly.

### MVP completion gate

The web MVP is complete when it supports daily review without SQL/CLI:
filter archived media per account/person or across all accounts, distinguish
source bookmarks/likes from local favorites, apply item/media curation, inspect
identity history, request/retry archive work, and open original media—while the
server remains the only component touching NAS paths.
