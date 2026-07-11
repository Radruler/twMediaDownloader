# Archive Library — HTTP API and Media Serving

## Role

The API is the stable boundary between the library server and:

- the bundled media-forward web UI;
- the account/person history UI;
- future scripts and maintenance clients;
- a separate collage application that needs filtered items and stable media
  references.

Clients never read SQLite or NAS paths directly. Files can move, preview
profiles can change, and schema migrations can run without breaking an API
object ID.

## Server choice

Add one HTTP server to `app/` and attach the ingest WebSocket upgrade path to
the same underlying server/origin. Use Fastify in plain JavaScript unless a
short implementation spike shows a blocker. It provides route encapsulation,
JSON-schema validation, payload limits, structured lifecycle hooks, and a
clean testing surface without turning the project into a framework-heavy
application.

Suggested boundaries:

- `/api/v1/*` — JSON application API;
- `/media/v1/*` — authenticated original/preview byte responses;
- `/ingest/v2` — extension WebSocket;
- `/events/v1` — owner UI server-sent events for job/status updates;
- `/` — built web UI with history fallback.

Version routes and representations explicitly. Adding nullable fields is
compatible; changing semantics or removing fields requires a new API version
or a documented transition.

## Authentication modes

### Owner web session

- Bootstrap creates the single owner credential or accepts an operator-set
  secret through a one-time CLI/environment flow.
- Successful login creates a random server-side session with a
  `Secure`, `HttpOnly`, `SameSite=Strict` cookie.
- Mutating requests require same-origin checks and a CSRF token/header.
- Sessions can be listed/revoked; password/secret rotation invalidates old
  sessions when requested.
- When a trusted reverse proxy supplies identity, support it only as an
  explicit deployment mode with a fixed proxy network/header contract. Never
  trust arbitrary forwarded identity headers by default.

### Client API tokens

Create independently revocable tokens, store only hashes, and support scopes:

- `library:read` — items, identities, tags, metadata;
- `media:read` — preview/original bytes;
- `curation:write` — local ratings/tags/notes/collections;
- `archive:write` — queue/retry archive work;
- `admin` — devices, imports, tokens, destructive operations.

The initial collage client receives only `library:read media:read`. Tokens are
sent in the `Authorization` header, never persistent query parameters. Audit
last-used time and a safe client label, not token contents.

Extension device tokens authenticate only `/ingest/v2` and pairing/status
operations. They cannot browse the library or mutate curation.

## Representation conventions

- Timestamps are integer epoch milliseconds in ingest/storage contracts and
  ISO 8601 UTC strings in human-facing JSON unless a route explicitly needs
  both. Be consistent per field.
- IDs are opaque strings. Provider IDs appear in a nested `source` object.
- Unknown provider facts are `null`; false means explicitly observed false.
- Enums are documented and clients must tolerate unknown future enum values.
- Every mutation returns the resulting resource and an `updated_at`/ETag
  suitable for optimistic concurrency.
- Filesystem paths, token hashes, raw headers, config secrets, and unrestricted
  provider payloads never appear in API responses.

Standard error body:

```json
{
  "error": {
    "code": "rating_out_of_range",
    "message": "Rating must be between 1 and 5.",
    "request_id": "...",
    "details": {}
  }
}
```

Use stable codes for programmatic decisions. Stack traces are development-only.

## Item listing and filtering

### `GET /api/v1/items`

This is the central grid/collage query. Initial filters:

- `service=twitter` (repeatable);
- `author_account_id=...` or `person_id=...`;
- `include_linked_accounts=true|false` when a person is selected;
- `viewer_account_id=...` plus `source_liked=true|false|unknown` and
  `source_bookmarked=true|false|unknown`;
- `local_favorite=true|false`;
- `rating_min=1` / `rating_max=5`;
- repeatable `tag=...` with `tag_mode=all|any|none`;
- repeatable `media_type=photo|video|animated_gif`;
- `archive_state=not_requested|queued|partial|archived|failed`;
- `availability=available|deleted|withheld|account_unavailable|unknown`;
- `created_after`, `created_before`, `seen_after`, `seen_before`;
- full-text `q` over provider text/alt text/author and optionally local notes;
- `sort=created_desc|created_asc|seen_desc|rating_desc|random_seeded`;
- opaque `cursor` and bounded `limit` (default 50, maximum 200).

The response includes `items`, `next_cursor`, and applied filter metadata. It
does not calculate an exact total for every query by default; exact counts over
millions of rows can be a separate endpoint or opt-in operation. Cursor values
encode the sort tuple and filter/query version, are URL-safe, and are validated
server-side. They are opaque to clients.

Default server semantics should be neutral (all captured items). The bundled
UI chooses its media-forward default of archived items with usable media.

Each card representation contains enough data to render without N+1 calls:

```json
{
  "id": "item-uuid",
  "service": "twitter",
  "source": { "native_key": "123", "canonical_url": "https://x.com/..." },
  "author": {
    "account_id": "account-uuid",
    "person_id": "person-uuid-or-null",
    "handle": "example",
    "display_name": "Example"
  },
  "created_at": "2026-07-10T01:02:03Z",
  "text_excerpt": "...",
  "availability": "available",
  "archive": { "state": "archived", "asset_count": 4, "archived_count": 4 },
  "curation": { "rating": 4, "favorite": true, "tags": [] },
  "viewer_state": { "viewer_account_id": "...", "liked": true, "bookmarked": null },
  "cover_media": {
    "id": "media-uuid",
    "type": "photo",
    "width": 2048,
    "height": 1365,
    "alt_text": null,
    "preview_url": "/media/v1/media-uuid/preview/grid-640",
    "original_available": true
  },
  "media_count": 4
}
```

### `GET /api/v1/items/:id`

Return full current text/entities, all versions, relationships, ordered media,
source observations/evidence summary, archive requests/outcomes, source viewer
state per owner account, and owner curation. Raw normalized snapshots are an
admin/debug expansion, not included by default.

Supporting item routes:

- `POST /items/:id/archive` — idempotently create/request archive work;
- `POST /items/:id/archive/retry` — explicit retry with reason;
- `PATCH /items/:id/curation` — rating/favorite/note with optimistic version;
- `PUT/DELETE /items/:id/tags/:tag_id`;
- `GET /items/:id/versions`;
- `GET /items/:id/archive-requests`;
- destructive purge is an admin preview/confirm workflow, not a generic
  `DELETE /items/:id` with surprising byte deletion.

## Media resources

### Metadata routes

- `GET /api/v1/media/:id` — metadata, owning items/versions, blob status,
  dimensions, alt text, curation, and available preview profiles;
- `PATCH /api/v1/media/:id/curation`;
- `PUT/DELETE /api/v1/media/:id/tags/:tag_id`;
- `POST /api/v1/media/:id/archive` for a targeted asset when supported.

### Original byte route

`GET|HEAD /media/v1/:media_id/original`

- resolve preferred `media_blobs` relation; never accept a path argument;
- require owner session or `media:read` token;
- support single HTTP byte ranges correctly (`206`, `Content-Range`,
  `Accept-Ranges: bytes`) for video seeking;
- reject invalid/multiple ranges initially with a correct response rather than
  reading the whole file;
- emit `Content-Length`, signature-derived `Content-Type`, and an ETag based on
  the immutable SHA-256;
- use `Cache-Control: private, max-age=..., immutable` for hashed originals;
- use safe `Content-Disposition: inline` plus a separately sanitized filename;
- handle `If-None-Match` and `If-Range`;
- stream with backpressure and abort file reads on client disconnect;
- return a typed `media_missing` error and update health evidence if the DB
  points to a missing blob.

Never proxy provider URLs through this route. It serves only locally verified
blobs. If an original is not archived, metadata says so and the UI may request
an archive job; the browser should not silently fetch provider media through
the server.

### Preview route

`GET|HEAD /media/v1/:media_id/preview/:profile`

- validate profile from a fixed registry;
- resolve source blob/poster and derived cache key;
- serve an existing preview with ETag/cache headers;
- if missing, enqueue one deduped preview job;
- return a small static placeholder plus `Retry-After`, or optionally wait a
  short bounded time for an in-process generation;
- never launch duplicate generation for a request stampede;
- account for orientation and never upscale beyond policy without a reason.

The route remains stable when preview encoding/version changes; ETag/cache key
changes underneath it. For a grid that must be immutable, item responses may
also expose a versioned URL containing a non-secret cache revision.

### Direct image use by external clients

Browser UIs on the same origin use the owner session cookie. Programmatic
clients use `Authorization` and stream/fetch bytes. If a future collage editor
needs to place URLs directly in `<img>` elements without a same-origin cookie,
add short-lived, narrowly scoped signed media capabilities. Do not put a
long-lived API token in query strings.

## Identity, curation, and collection routes

Initial resources:

- `GET /services`;
- `GET /accounts`, `GET /accounts/:id`, `GET /accounts/:id/history`;
- `GET/POST/PATCH /people`, link/unlink account actions with confirmation;
- `GET /viewer-accounts` and admin owner-account assignment;
- `GET/POST/PATCH/DELETE /tags` with merge/rename preview;
- `GET/POST/PATCH/DELETE /collections` and entry reorder/add/remove;
- `GET /people/:id/items` as a convenience redirect/query contract rather than
  a distinct incompatible list format.

Account/person merges do not rewrite provider identity. Linking changes only
the curated grouping and is reversible. Detailed rules are in
`06-identity-and-curation.md`.

## Devices, jobs, and operations routes

- pairing code create/consume (single use, short expiry);
- list/revoke/rename capture devices;
- server/library health summary without secrets;
- list archive/import/preview jobs with normalized errors;
- retry/cancel eligible jobs;
- import scan/manifest/commit controls from `07-legacy-import.md`;
- backup/restore remain CLI/operator actions initially, not browser buttons.

Use `POST` action resources (`/jobs/:id/retry`) where the operation has its
own audit semantics. All destructive/admin operations return a dry-run or
impact preview and require an explicit confirmation token tied to that exact
preview.

## Live status

Use Server-Sent Events for UI-only notifications:

- job state/progress changes;
- item/archive state changes;
- device connected/outbox pressure summary;
- import batch progress;
- server upgrade/read-only warnings.

Events contain resource IDs and small state deltas; the client refetches the
canonical JSON. Include monotonically increasing event IDs and support
`Last-Event-ID` within a bounded in-memory/recent-event window. Correctness
never depends on receiving SSE; reconnect/refetch repairs UI state.

Do not reuse the capture WebSocket for browser UI state.

## Collage client contract

The separate collage system needs a deliberately narrow stable workflow:

1. create a read-only client token;
2. call `GET /api/v1/items` with the same author/person/tag/rating/media/source
   relationship filters as the web UI;
3. use cursor pagination or request a bounded seeded-random selection;
4. read ordered media metadata and aspect ratios without fetching bytes;
5. fetch a suitable preview or original using the media resource ID;
6. store library item/media IDs in the collage document, not file paths or
   ephemeral URLs;
7. resolve those IDs again when reopening, so moved storage or regenerated
   previews do not break the document.

Add `POST /api/v1/selections/resolve` only if clients need to hydrate many
known item/media IDs efficiently. It accepts a bounded list and returns
ordered found/missing objects. Do not create a collage-specific shadow schema
inside the archive server.

For reproducible random layouts, accept a caller seed and define a stable
selection algorithm/version. Return that version with results.

## API documentation and compatibility

- Route schemas are the source of an OpenAPI document generated in tests/build.
- Commit a human-readable API guide or generated artifact only if the repo's
  build policy supports deterministic output.
- Add contract tests for the bundled UI and a tiny example collage client.
- Maintain fixture responses with secrets/paths removed.
- Deprecations return headers/warnings for at least one implementation phase.
- Database schema is not a public API; only `/api/v1` and provider capture
  contracts receive compatibility guarantees.

## Performance and abuse controls

- enforce global and route-specific body/parameter/list limits;
- cap concurrent original streams and preview work independently from archive
  downloads;
- use keyset pagination and prejoined card queries to avoid N+1 reads;
- prepare/bind all SQL; never interpolate filters or FTS expressions;
- parse a small documented search syntax rather than passing arbitrary FTS5
  syntax unchecked;
- rate-limit login, pairing, token creation, and expensive search endpoints;
- record request ID, route, status, duration, and byte count, but not query
  text containing private content unless debug is explicitly enabled;
- support cancellation/abort when a client abandons a long query or stream.

## Acceptance checks

- A one-million-row synthetic library can page a common archived-media query
  without growing latency with page number.
- Grid response uses a bounded number of SQL statements independent of card
  count.
- Range and conditional request behavior passes standards-focused tests and
  plays/seeks a real MP4 in Chrome/Safari-compatible clients.
- A traversal string, unknown ID, symlink escape, and forged path can never
  select arbitrary server files.
- Owner cookie, read-only token, device token, expired/revoked token, and CSRF
  cases are separately tested.
- Repeated archive POSTs produce one active request/job.
- Optimistic curation conflict returns `409` and never silently drops a newer
  edit.
- Collage example can filter, select, hydrate, and fetch previews using only
  documented API resources.
