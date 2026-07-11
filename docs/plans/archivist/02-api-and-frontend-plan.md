# Archivist — Plan B: HTTP API, Thumbnails & Frontend MVP

Turns the plan-A library into a browsable system: HTTP API, thumbnail
cache, a media-forward web UI, and the TrueNAS deployment story. Exit
criteria: ingested content is browsable and curatable from a LAN browser
against the NAS container.

Requires plan A. Read `00-archivist-overview.md` — Decisions binding.

## B-1 — HTTP server & auth

- `archivist/src/server.js`: `node:http` + a small hand-rolled router
  (method + path pattern → handler; JSON body limit ~1 MB). No framework
  (Decision 10).
- Auth: every `/api/*` and `/files|/thumbs` request requires the bearer
  token (`Authorization: Bearer <api_token>` or `?token=` for media URLs
  embedded in `<img>`/`<video>` tags). Static frontend assets are
  unauthenticated; the UI asks for the token once and keeps it in
  localStorage. Constant-time compare. Single user, LAN — this is enough
  (Decision 6/11).
- Cache headers: `/files` and `/thumbs` are content-addressed →
  `Cache-Control: public, max-age=31536000, immutable`. Range requests
  supported on `/files` (video seeking).

## B-2 — Read API

Design rule: everything the three known frontends (grid, people/traits,
collage app) need is a *filter on one posts query* plus small lookups —
keep it one well-indexed query builder, cursor-paginated
(`?cursor=<opaque>&limit=`, default 60, ordered by `created_at_ms DESC,
id DESC`).

```
GET /api/stats                 counts per service/state, db/archive sizes
GET /api/relation-types        the registry (frontends render filters from this)
GET /api/posts                 filters, all AND-composable:
    service=twitter
    author=<account_id> | persona=<persona_id>   (persona = expand to accounts)
    relation=<service>:<key>[:<value>]           (active, i.e. revoked_at IS NULL;
                                                  repeatable)
    tag=<name> (repeatable)    rating_min=1..5
    q=<fts query>              has_media=1        type=photo|video|animated_gif
    deleted=include|only|exclude (default exclude…author-deleted posts stay
                                  browsable via include; UI default shows them
                                  with a badge — see B-5)
    sensitive=include|exclude  (default include — single-owner archive)
GET /api/posts/:id             full detail: versions, media(+sha256), active
                               relations, tags, author with current names
GET /api/media/:id             one media item (for the collage app's
                               per-item references)
GET /api/accounts?service=&q=  list w/ current names, status, post counts
GET /api/accounts/:id          detail: name history windows, persona, counts
GET /api/personas              list w/ member accounts
GET /api/tags                  list w/ use counts
GET /files/:sha256             media bytes (mime from files.mime)
GET /thumbs/:sha256?w=320      thumbnail (B-4)
```

Responses are plain JSON, ids are Archivist row ids (stable), media
always carries `sha256` so clients can build `/files`/`/thumbs` URLs.
The collage app needs nothing beyond this surface — stable
`/api/media/:id` + immutable `/files/:sha256` is its contract.
Plan 04 (media viewer) extends this API with `/api/works` and credits —
build B-2 with that in mind (shared query builder), don't pre-build it.

## B-3 — Write API (curation only)

```
POST   /api/personas                       {name, notes}
PATCH  /api/personas/:id                   rename/notes
DELETE /api/personas/:id                   (memberships released, accounts kept)
PUT    /api/personas/:id/accounts/:accId   assign (moves if already grouped)
DELETE /api/personas/:id/accounts/:accId
POST   /api/tags                           {name} (case-insensitive unique)
PUT    /api/items/:kind/:id/tags           {names:[...]} declarative set
PUT    /api/items/:kind/:id/relations/:service/:key
                                           {value?, active} — archivist-service
                                           types only; captured-service types
                                           are read-only here (mirror-image of
                                           the ingest rule; both tested)
PATCH  /api/accounts/:id                   {is_me} only (marking own accounts)
```

No endpoint writes posts/media/files — ingest is the only content door.

## B-4 — Thumbnails

`archivist/src/thumbs.js` (Decision 12): on `/thumbs/:sha256?w=` miss,
generate with `sharp` from the archived file →
`<thumbs_dir>/<sha256>-<w>.webp`, then serve. Allowed widths fixed
(e.g. 320/640/1280) to keep the cache bounded. Single generation queue,
concurrency 2 — thumbnailing must never starve the NAS box. Videos/GIFs:
poster frame via `ffmpeg-static` single-frame extract if available,
else a type-glyph placeholder tile (frontend renders duration badge
regardless). `rebuild-thumbs --clear` CLI wipes the cache (it's
disposable derived data).

## B-5 — Frontend MVP (`archivist/ui/`)

Preact + htm, bundled by `build.mjs` to `archivist/dist/static/`, served
at `/`. No CSS framework; one hand-written stylesheet, CSS grid. MVP is
deliberately plain — design iteration comes later; correctness of the
*data interactions* is the point.

Views:

1. **Grid** (default): media-forward tile wall (thumbs, lazy-loaded,
   infinite scroll on the cursor). Filter bar driven by `/api/stats` +
   `/api/relation-types` + `/api/tags`: service, author/persona picker
   with a **persona⇄account toggle** (the aliasing mirror the owner
   specified), relation chips (Twitter likes/bookmarks, local favorite,
   rating≥N), tags, media type, text search, deleted badge toggle.
   Deleted-upstream posts show a small badge; sensitive shown by default.
2. **Post detail** (overlay route on tile click): full media
   pager (`/files` originals, native `<video>` for mp4), text, author,
   counts, capture/version info, permalink out to the service. Curation
   controls: tag editor (post- and media-level), 1–5 star rating,
   favorite toggle — all optimistic writes to B-3.
3. **People**: account list (current screen_name, display name, status
   badge, post count, rename count); account detail with the
   `account_names` history windows (the username-change timeline),
   persona assignment; persona list/create/rename. Deletions/suspensions
   surface here from passive status.

State: URL-encoded filters (shareable/bookmarkable), token prompt on 401,
no client-side cache layer beyond the browser's.

## B-6 — Ingest endpoints (push transport, server side)

The server half of the client's push export
(`docs/plans/archivist-client-plan.md` §D); same bearer auth as the rest
of the API, calls the plan-A ingest core:

```
POST /api/ingest/post          body = ArchivistPost envelope (plan A-3);
                               response { missing_files: [sha256, …] }
PUT  /api/ingest/file/:sha256  raw bytes; hash-verified before accept,
                               refused (409) on hash mismatch
```

Post-then-files: the client re-POSTs until `missing_files` is empty.
Duplicate delivery must be a provable no-op (ingest core is idempotent —
test it through the HTTP layer too). Body limit on `PUT` sized for video
(configurable, default 2 GB, streamed to a temp file, hashed, then moved
into the archive tree).

## B-7 — Deployment (TrueNAS)

- `archivist/compose.yml` (the TrueNAS "custom app" YAML): the plan-A
  image, volumes `/data` + `/archive` on the pool, port 8470, restart
  unless-stopped. Document: box is not 24/7 — Archivist tolerates
  arbitrary stop/start (SQLite WAL; no in-memory state worth losing).
- Docs: `archivist/README.md` — first-run token retrieval (container
  logs), snapshot-ingest walkthrough (copy client dir to the pool → run
  `ingest-client` in the container), backup guidance (`/data` +
  `/archive` are the whole system; thumbs are disposable).

## Tests

- Router/auth: 401 without token, constant-time path exercised; static
  unauthenticated.
- `/api/posts` filter matrix over a seeded library (each filter alone +
  AND combinations, cursor pagination stability under new ingests).
- Curation writes round-trip; captured-service relation write via API
  refused (mirror of ingest-side test).
- Thumbs: generated once, cached, bad sha 404, width whitelist enforced.
- Frontend: component tests only where cheap (filter-bar query building);
  the owner does a live walkthrough against real ingested data —
  add an `archivist/VERIFICATION.md` checklist mirroring the repo's
  existing live-verification style.
