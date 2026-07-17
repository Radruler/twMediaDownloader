# Archivist — API Contract (v1, normative)

The single source of truth for every HTTP surface Archivist exposes.
Plans B and V implement it; the Archivist Client (§D push) and Mosaic
consume it. Implementations must match this doc; if an implementer needs
to deviate, update this doc in the same commit and note why.
Additive evolution only (new fields null-safe, new endpoints); never
rename or re-mean.

## Conventions

- Base: `http://<host>:8470`. All bodies JSON (UTF-8) except `/files`,
  `/thumbs`, and `PUT /api/ingest/file`.
- **Auth:** every route except static UI assets requires the configured
  token — header `Authorization: Bearer <token>`, or query `?token=`
  (for URLs embedded in `<img>/<video>` tags). Failure → 401.
- **Errors:** non-2xx bodies are
  `{ "error": { "code": "<snake_case>", "message": "<human text>" } }`.
  Codes used below: `unauthorized`, `not_found`, `bad_request`,
  `conflict`, `refused`.
- **Timestamps** are epoch milliseconds (integer). **Booleans** are JSON
  booleans (SQLite 0/1 mapped at the edge). Absent/unknown = `null`,
  never omitted keys.
- **Lists** return `{ "items": [...], "next_cursor": "<opaque>" | null }`.
  Cursor = base64url of `{"k": <sort-key-value>, "id": <row id>}`;
  clients treat it as opaque. Default `limit` 60, max 200.
- **Item kinds** in paths: `:kind` ∈ `post` | `media`.

## Shared object shapes

```jsonc
// AccountRef — embedded wherever an account appears
{ "id": 1, "service": "twitter", "service_account_id": "12345",
  "screen_name": "alice",          // current (latest observed); null possible
  "display_name": "Alice",         // current; null possible
  "is_me": false, "is_stub": false,           // is_stub: sentinel '~' id (A-2)
  "status": "active",                          // active|deleted|suspended|unknown
  "persona": { "id": 3, "name": "Alice" } | null }

// MediaItem
{ "id": 10, "post_id": 5, "position": 1, "type": "photo",
  "sha256": "ab12…" | null,                    // null = metadata-only
  "available": true,                           // sha256 present AND file recorded
  "bytes": 123456 | null, "mime": "image/jpeg" | null,
  "source_url": "…", "alt_text": null,
  "width": 2048, "height": 1536, "duration_ms": null }
// Byte/thumb URLs are constructed by the client:
//   /files/<sha256>?token=…   /thumbs/<sha256>?w=<320|640|1280>&token=…

// Relation (as attached to a post/media)
{ "service": "twitter", "key": "like", "value": null,   // tier/scalar as string
  "account_id": 7, "observed_at": 0, "revoked_at": null }

// Post
{ "id": 5, "service": "twitter", "service_post_key": "111",
  "author": AccountRef | null,
  "created_at_ms": 0, "text": "…", "lang": "en", "url": "…" | null,
  "is_sensitive": false, "deleted": false, "deleted_detected_at": null,
  "counts": { /* verbatim counts_json */ } | null,
  "reply_to_key": null, "quoted_key": null, "thread_key": "111",
  "media": [ MediaItem, … ],                   // ordered by position
  "relations": [ Relation, … ],               // ACTIVE only unless ?relations=all
  "tags": [ "tagname", … ],                   // post-level tags
  "rating": 4 | null, "favorite": true,        // convenience: archivist/me relations
  "first_ingested_at": 0, "last_ingested_at": 0 }

// Credit
{ "account": AccountRef, "role": "subject",
  "item_kind": "media", "item_id": 10,
  "source": "manual" | "accepted_suggestion" }

// Work (plan V)
{ "thread_key": "111", "root_post_id": 5,
  "parts": [ Post, … ],                        // chain order (created_at_ms asc)
  "media": [ { "part_index": 0, …MediaItem }, … ],
  "description": [ { "post_id": 5, "text": "…", "created_at_ms": 0,
                     "url": "…" | null }, … ],
  "credits": [ Credit, … ],                    // stored credits
  "suggestions": [ … ] | null,                 // computed (see /credits endpoint
                                               //   shape); populated ONLY on
                                               //   GET /api/works/:id, null in lists
  "missing_parts": 1,                          // reply_to_keys we can't resolve
  "quoted": [ { "key": "222", "post": Post | null }, … ] }
```

## Read endpoints (plan B-2)

```
GET /api/stats
  → { "posts": n, "media": n, "files": n, "accounts": n, "personas": n,
      "tags": n, "by_service": { "twitter": { "posts": n } },
      "deleted": n, "db_bytes": n, "archive_bytes": n }

GET /api/relation-types
  → { "items": [ { "service": "twitter", "key": "like", "label": "Like",
                   "value_kind": "flag", "value_meta": null | {…} } ] }

GET /api/posts?…            → list of Post
GET /api/works?…            → list of Work           (plan V-1)
  Shared filters (all AND-composed; repeatable params noted):
    service=twitter
    author=<account_id>            persona=<persona_id>
    credited=<account_id>          credited_persona=<persona_id>
    role=<credit role>             (only with credited*)
    relation=<service>:<key>[:<value>]        (active only; repeatable)
    tag=<name> (repeatable)        rating_min=1..5      favorite=1
    q=<FTS5 query>                 has_media=1
    type=photo|video|animated_gif
    deleted=exclude|include|only   (default exclude)
    sensitive=include|exclude      (default include)
    sort=created|ingested          (default created, desc)
    cursor=…  limit=…
  /api/works only: a non-root thread part matching the filters surfaces
  its whole work; each work appears at most once per page set.
  With sort=ingested, works sort by the root post's last_ingested_at;
  newly ingested replies do not currently bubble an existing work.

GET /api/posts/:id           → Post  (404 not_found)
GET /api/works/:post_id      → Work for the post's thread root
GET /api/media/:id           → MediaItem + { "post": Post }
GET /api/accounts?service=&q=&cursor=&limit=   → list of AccountRef +
      { "posts_n": n, "names_n": n }
GET /api/accounts/:id
  → AccountRef + { "posts_n": n,
      "names": [ { "kind": "screen_name", "value": "alice",
                   "first_observed_at": 0, "last_observed_at": 0 } ] }
GET /api/personas            → { "items": [ { "id":1, "name":"…", "notes":null,
                                 "accounts": [ AccountRef ] } ] }
GET /api/tags                → { "items": [ { "id":1, "name":"…", "uses": n } ] }
GET /api/credit-roles        → { "items": [ { "role":"creator","label":"Creator" } ] }
GET /api/items/:kind/:id/credits
  → { "credits": [ Credit ], "suggestions": [
        { "account": AccountRef | null,        // null if no account resolvable
          "screen_name": "bob", "provenance": "mention" | "tagged_user" } ] }

GET /files/:sha256           → bytes; Content-Type from files.mime; supports
                               Range; Cache-Control: public,max-age=31536000,immutable
GET /thumbs/:sha256?w=320    → image/webp; widths whitelist {320,640,1280};
                               404 not_found for unknown sha; 400 bad width
```

## Write endpoints (curation only, plans B-3 / V-2)

All return the updated resource (or `{ "ok": true }` for deletes).

```
POST   /api/personas                      { "name": "…", "notes": null }
PATCH  /api/personas/:id                  { "name"?, "notes"? }
DELETE /api/personas/:id
PUT    /api/personas/:id/accounts/:accId  (moves account if already grouped)
DELETE /api/personas/:id/accounts/:accId
PATCH  /api/accounts/:id                  { "is_me": true }        // only key allowed
POST   /api/accounts                      { "service": "twitter",
                                            "screen_name": "bob" } // stub creation:
                                          // service_account_id = "~bob"; 409 if exists
POST   /api/tags                          { "name": "…" }
PUT    /api/items/:kind/:id/tags          { "names": ["a","b"] }   // declarative set
PUT    /api/items/:kind/:id/relations/:service/:key
                                          { "value"?: "3", "active": true }
       // service MUST be "archivist" → else 403 refused
       // value validated against value_kind/value_meta → else 400
PUT    /api/items/:kind/:id/credits       { "credits": [                 // declarative
         { "account_id": 7, "role": "subject" },
         { "new_account": { "service":"twitter","screen_name":"bob" },
           "role": "creator" },
         { "accept_suggestion": { "screen_name":"bob",
           "provenance":"mention" }, "role": "subject" } ] }
POST   /api/credit-roles                  { "role": "muse", "label": "Muse" }
```

## Ingest endpoints (plan B-6; client §D and snapshot share the core)

```
POST /api/ingest/post        body = ArchivistPost envelope (plan A-3)
  → 200 { "ok": true, "post_id": 5, "missing_files": ["<sha256>", …] }
  → 400 bad_request  { …, "detail": "<which field failed validation>" }
  → 403 refused      (envelope tries to write archivist-service relations,
                      or unknown service)
PUT  /api/ingest/file/:sha256   raw bytes, Content-Length required
  → 200 { "ok": true }         (also when sha already present — idempotent)
  → 409 conflict               (hash of received bytes ≠ :sha256; nothing stored)
```

Envelope validation (reject whole post on failure): `v == 1`; `service`
registered; `post_key`, `author.service_account_id`, `versions[]`
(non-empty, each with `service_version_id`) present; `media[]` entries
have unique positive `position`. Unknown envelope fields are ignored
(forward compat). Per-item tolerance inside a valid post: unknown
relation `key` → skip that relation with a warning; media `sha256`
absent → metadata-only media. Duplicate delivery of anything is a no-op.
