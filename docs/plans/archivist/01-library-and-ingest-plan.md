# Archivist — Plan A: Library Core & Ingest

Builds the Archivist service skeleton, its SQLite schema, the idempotent
ingest core, the snapshot-ingest CLI, and a Dockerfile. Exit criteria: a
copy of a real Archivist Client data dir can be ingested on the NAS (or
locally) and inspected via CLI; re-running ingest is a no-op.

Read `00-archivist-overview.md` first — its Decisions are binding.

## A-1 — Workspace & service skeleton

- New npm workspace `archivist/` (add to root `package.json` workspaces):
  `src/config.js`, `src/db.js`, `src/ingest.js`, `src/cli.js`,
  `src/main.js`. Plain JS, ESM, mirroring `app/`'s conventions.
- Bundled by `build.mjs` to `archivist/dist/main.mjs`; root script
  `"archivist": "node archivist/dist/main.mjs"`.
- Config: `$ARCHIVIST_DIR/config.json` (default `~/.archivist`), keys:
  `bind_host` (default `0.0.0.0` — it's a NAS container; the container
  boundary is the isolation), `port` (8470), `api_token` (random on first
  run, printed once), `archive_root` (`<dir>/archive`), `db_path`
  (`<dir>/library.sqlite3`), `thumbs_dir` (`<dir>/thumbs`), `log_level`.
  Env overrides `ARCHIVIST_*` for every key, runtime-only (same pattern as
  the client's `TWMD_*`).

## A-2 — Schema (`archivist/src/db.js`)

better-sqlite3, WAL, `foreign_keys = ON`, `PRAGMA user_version = 1` (all
future changes are numbered migrations). Ingest-owned vs curation-owned
tables per Decision 8.

```sql
-- registry ---------------------------------------------------------------
CREATE TABLE services (
  service TEXT PRIMARY KEY,        -- 'twitter'; 'archivist' reserved/local
  label   TEXT NOT NULL
);
CREATE TABLE relation_types (
  id              INTEGER PRIMARY KEY,
  service         TEXT NOT NULL REFERENCES services(service),
  key             TEXT NOT NULL,   -- 'like', 'bookmark', 'favorite', 'rating'
  label           TEXT NOT NULL,
  value_kind      TEXT NOT NULL CHECK(value_kind IN ('flag','tier','scalar')),
  value_meta_json TEXT,            -- tier: {"tiers":[...]} ; scalar: {"min":1,"max":5}
  UNIQUE(service, key)
);

-- identity ----------------------------------------------------------------
CREATE TABLE accounts (
  id                 INTEGER PRIMARY KEY,
  service            TEXT NOT NULL REFERENCES services(service),
  service_account_id TEXT NOT NULL,     -- twitter user id_str; 'me' for archivist/me
  is_me              INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'unknown'
                     CHECK(status IN ('active','deleted','suspended','unknown')),
  status_observed_at INTEGER,
  first_seen_at      INTEGER,
  last_seen_at       INTEGER,
  UNIQUE(service, service_account_id)
);
CREATE TABLE account_names (
  account_id        INTEGER NOT NULL REFERENCES accounts(id),
  kind              TEXT NOT NULL CHECK(kind IN ('screen_name','display_name')),
  value             TEXT NOT NULL,
  first_observed_at INTEGER NOT NULL,
  last_observed_at  INTEGER NOT NULL,
  UNIQUE(account_id, kind, value)
);
CREATE TABLE personas (                 -- curation-owned
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, notes TEXT
);
CREATE TABLE persona_accounts (         -- curation-owned; ≤1 persona per account
  persona_id INTEGER NOT NULL REFERENCES personas(id),
  account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id)
);

-- content -------------------------------------------------------------------
CREATE TABLE posts (
  id                  INTEGER PRIMARY KEY,
  service             TEXT NOT NULL REFERENCES services(service),
  service_post_key    TEXT NOT NULL,    -- twitter: edit-group post_key
  author_account_id   INTEGER REFERENCES accounts(id),
  created_at_ms       INTEGER,
  text                TEXT,
  lang                TEXT,
  url                 TEXT,             -- canonical permalink when derivable
  is_sensitive        INTEGER NOT NULL DEFAULT 0,
  deleted             INTEGER NOT NULL DEFAULT 0,
  deleted_detected_at INTEGER,
  counts_json         TEXT,
  raw_json            TEXT,             -- freshest service-native record
  first_ingested_at   INTEGER NOT NULL,
  last_ingested_at    INTEGER NOT NULL,
  UNIQUE(service, service_post_key)
);
CREATE INDEX idx_posts_author  ON posts(author_account_id, created_at_ms);
CREATE INDEX idx_posts_created ON posts(created_at_ms);

CREATE TABLE post_versions (
  post_id            INTEGER NOT NULL REFERENCES posts(id),
  service_version_id TEXT NOT NULL,     -- twitter: tweet id_str (one per edit)
  captured_at_ms     INTEGER,
  raw_json           TEXT,
  UNIQUE(post_id, service_version_id)
);

CREATE TABLE files (
  sha256      TEXT PRIMARY KEY,
  relpath     TEXT NOT NULL,            -- under archive_root (Decision 4 layout)
  bytes       INTEGER,
  mime        TEXT,
  ingested_at INTEGER,
  verified_at INTEGER
);
CREATE TABLE media_items (
  id          INTEGER PRIMARY KEY,
  post_id     INTEGER NOT NULL REFERENCES posts(id),
  position    INTEGER NOT NULL,         -- 1-based within the post
  type        TEXT,                     -- photo | video | animated_gif | ...
  sha256      TEXT REFERENCES files(sha256),  -- NULL = metadata-only, no bytes
  source_url  TEXT,
  alt_text    TEXT,
  width INTEGER, height INTEGER, duration_ms INTEGER,
  UNIQUE(post_id, position)
);
CREATE INDEX idx_media_post ON media_items(post_id);

-- relations (Decision 5/6): captured AND local curation --------------------
CREATE TABLE relations (
  id               INTEGER PRIMARY KEY,
  relation_type_id INTEGER NOT NULL REFERENCES relation_types(id),
  account_id       INTEGER NOT NULL REFERENCES accounts(id), -- always a real row;
                                        -- local curation uses archivist/me
  item_kind        TEXT NOT NULL CHECK(item_kind IN ('post','media')),
  item_id          INTEGER NOT NULL,
  value            TEXT,                -- NULL for flag; tier key; scalar as text
  observed_at      INTEGER NOT NULL,
  revoked_at       INTEGER,             -- passive un-like/removal; row is kept
  UNIQUE(relation_type_id, account_id, item_kind, item_id)
);
CREATE INDEX idx_relations_item ON relations(item_kind, item_id);

-- tags (curation-owned; deliberate non-relation, Decision 5) ---------------
CREATE TABLE tags (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE tag_items (
  tag_id    INTEGER NOT NULL REFERENCES tags(id),
  item_kind TEXT NOT NULL CHECK(item_kind IN ('post','media')),
  item_id   INTEGER NOT NULL,
  tagged_at INTEGER NOT NULL,
  UNIQUE(tag_id, item_kind, item_id)
);

-- search (rebuildable) ------------------------------------------------------
CREATE VIRTUAL TABLE posts_fts USING fts5(
  post_id UNINDEXED, text, alt_text, author_names
);

-- bookkeeping ----------------------------------------------------------------
CREATE TABLE ingest_runs (
  id INTEGER PRIMARY KEY, source TEXT, started_at INTEGER,
  finished_at INTEGER, posts_n INTEGER, files_n INTEGER, notes TEXT
);
```

Seeds (idempotent, on open): services `twitter`, `archivist`; account
`archivist/me` (`is_me=1`, status `active`); relation_types
`twitter/like` (flag), `twitter/bookmark` (flag), `archivist/favorite`
(flag), `archivist/rating` (scalar 1–5).

Notes for the implementer:

- `account_id` is NOT NULL on `relations` deliberately: SQLite UNIQUE
  treats NULLs as distinct, which would break the upsert key. Local
  curation always attaches to the seeded `archivist/me` row.
- Adding a new service later = insert `services` + `relation_types` rows
  (config-driven seed list), zero schema change. Prove it in a test with a
  fictional tiered-like service.
- `revoked_at` keeps history (we never write to external services, so a
  revoked relation is an observation, not an action).

## A-3 — The `ArchivistPost` envelope + Twitter mapper

The one ingest door (Decision 2). Versioned JSON, service-agnostic:

```jsonc
{
  "v": 1,
  "service": "twitter",
  "post_key": "1234567890",
  "author": { "service_account_id": "12345", "screen_name": "alice",
              "display_name": "Alice", "status": "active" },
  "created_at_ms": 0, "text": "…", "lang": "en",
  "url": "https://x.com/alice/status/1234567890",
  "is_sensitive": false, "deleted": false,
  "counts": { "likes": 1, "…": 0 },
  "versions": [ { "service_version_id": "1234567890",
                  "captured_at_ms": 0, "raw": { /* TweetRecord */ } } ],
  "media": [ { "position": 1, "type": "photo", "sha256": "…" ,
               "source_url": "…", "alt_text": null,
               "width": 0, "height": 0, "duration_ms": null } ],
  "relations": [ { "subject": { "service_account_id": "999",
                                "screen_name": "myacct" },
                   "key": "like", "value": null,
                   "observed_at": 0, "active": true } ]
}
```

- `packages/core/src/archivist-post.ts` —
  `toArchivistPost(records, filesBySha)` maps a post's TweetRecord
  versions + file hashes to this shape. Pure, fixture-tested. Relations
  come from `record.viewer` when present (plan 03 §C; absent until then —
  emit `[]`). Media `sha256` may be null (metadata-only media).
- Envelope changes follow the TweetRecord stability rule: fields may be
  added null-safe; never renamed/re-meant; bump `v` only for breaking
  shape changes (avoid).

## A-4 — Ingest core (`archivist/src/ingest.js`)

`ingestPost(envelope, { fileProvider })` in one transaction:

- Upsert account (+ `account_names` observation windows: extend
  `last_observed_at` on match, new row on new value — this is the rename
  history), upsert post (fresher `captured_at_ms` wins for
  `raw_json`/counts; `deleted` is sticky true), upsert versions, media.
- Files: for each media sha256 the DB lacks, ask `fileProvider(sha256)`
  for bytes/stream; verify the hash; write to
  `<archive_root>/<service>/<screen_name>/<original-basename>` (collision:
  keep existing — sha256 identity means same content); insert `files`.
  Existing sha256 = record the media link only (dedupe across posts).
- Relations: upsert by the UNIQUE key; `active:false` sets `revoked_at`
  (first observation wins), `active:true` clears it. Only
  ingest-service relation types are ever written here — the `archivist`
  service is refused (Decision 8 enforcement, tested).
- Refresh `posts_fts` row.
- Idempotent by construction: same envelope twice = identical DB.

## A-5 — Snapshot ingest (transport 1) + CLI

`node archivist/dist/main.mjs` subcommands (config-driven, like the
client's CLI):

- `ingest-client <dir>` — `<dir>` is a copy or mount of a client data dir
  (`library.sqlite3` + `archive/`). Open the client DB **read-only**;
  for every post `state='archived'`: reconstruct all versions'
  TweetRecords, join `files` rows, build the envelope via
  `toArchivistPost`, ingest with a fileProvider that resolves client
  `files.path` against `<dir>/archive` (tolerate recorded absolute paths
  by re-rooting; always verify sha256 before accepting). Report
  new/updated/skipped counts; record an `ingest_runs` row.
  Re-run safety is the acceptance test.
- `stats` — counts per table, per service, per state.
- `verify` — re-hash `files` vs disk, report missing/mismatched (no
  repair) — mirror of the client's verify.
- `rebuild-fts` and `rebuild-thumbs --clear` (thumbs lands in plan B;
  reserve the verb).

## A-6 — Dockerfile

`archivist/Dockerfile`: `node:22-slim`, copy built `archivist/dist` +
production node_modules (better-sqlite3, sharp), `VOLUME /data /archive`,
`ENV ARCHIVIST_DIR=/data ARCHIVIST_ARCHIVE_ROOT=/archive`, `EXPOSE 8470`,
entrypoint `main.mjs serve` (serve = A-1 skeleton; real API in plan B).
Compose/TrueNAS specifics are plan B §deploy.

## Tests (vitest, `test/archivist-*.test.ts`)

- Schema opens fresh + reopens existing; seeds idempotent.
- `toArchivistPost` against the repo's existing capture fixtures.
- Ingest: fresh envelope → full rows; second ingest → no-op; fresher
  capture updates raw/counts; new version accretes; rename produces two
  `account_names` rows with correct windows; revoked relation sets
  `revoked_at`; curation tables provably untouched (write a tag/rating
  first, re-ingest, assert intact); `archivist`-service relation via
  ingest refused.
- Snapshot ingest end-to-end against a synthetic client data dir built
  with the client's own `db.js` + disk-writer (real formats, no mocks).
- Fictional tiered-like service registered via seed config → relation
  with tier value round-trips (proves Decision 5).
