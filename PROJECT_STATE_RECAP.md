# Project State Recap for Future Agents

Last updated: 2026-07-14 after commit `8d8cdb3`
(`Implement Archivist client and service foundations`).

This file is a handoff document for agents reviewing the current repo
state before plans are archived. It summarizes what exists now, which
plans it came from, and what remains incomplete or owner-gated.

## High-Level State

The repo now contains three related tracks:

1. **Archivist Client**: the rebuilt twMediaDownloader extension plus the
   local Node content manager in `app/`. It passively captures X/Twitter
   GraphQL payloads, caches normalized `TweetRecord`s, downloads selected
   media, stores a local seen/archive library, and can push archived posts
   to Archivist.
2. **Archivist**: a new NAS-side library service in `archivist/`. It has
   its own SQLite schema, ingest core, snapshot ingest CLI, authenticated
   HTTP API, minimal static shell, curation endpoints, works/credits
   basics, and file serving.
3. **Mosaic**: still plan-only. No Mosaic code exists yet because the
   Flutter/media_kit stack remains gated by a Windows 10 hardware spike.

The key plan sources are:

- Top-level decisions: `docs/plans/00-overview.md`
- Archivist Client work: `docs/plans/archivist-client-plan.md`
- Archivist overview: `docs/plans/archivist/00-archivist-overview.md`
- Archivist Plan A: `docs/plans/archivist/01-library-and-ingest-plan.md`
- Archivist Plan B: `docs/plans/archivist/02-api-and-frontend-plan.md`
- Archivist HTTP contract: `docs/plans/archivist/API.md`
- Archivist viewer Plan V: `docs/plans/archivist/04-media-viewer-plan.md`
- Mosaic plans: `docs/plans/mosaic/`
- Extension buttons: `docs/plans/extension-buttons-plan.md`
- Cleanup gate: `docs/plans/cleanup-plan.md`

## Verification Baseline

The latest full gate passed in the devcontainer:

```sh
docker compose -f .devcontainer/docker-compose.yml run --rm app \
  sh -lc 'npm test && npm run typecheck && npm run build'
```

Result at handoff:

- `162` tests passed
- `npm run typecheck` passed
- `npm run build` passed
- Build outputs include `dist/`, `app/dist/main.mjs`, and
  `archivist/dist/main.mjs`

Host `npm` is not the supported verification path for this checkout.
Use the devcontainer commands in `README.md`.

## Core Package: `packages/core`

State:

- Still the only place shared contracts and normalization logic belong.
- `TweetRecord` is additive-only and now includes:
  - `viewer: { liked, bookmarked }`
  - `in_reply_to_user_id_str`
  - `media[].tagged_users`
- `graphql-normalize.ts` now reads:
  - `legacy.favorited`
  - `legacy.bookmarked`
  - `legacy.in_reply_to_user_id_str`
  - media tagged-user candidate fields, defaulting to `[]`
- Fixture expected outputs were regenerated and locked.
- `scripts/update-expected.mjs` now bundles the TypeScript core entry
  with esbuild before importing it, because plain Node cannot import
  `.ts` directly.

New Archivist mapper:

- `packages/core/src/archivist-post.ts`
- Exported via `packages/core/src/index.ts`
- Main API:

```ts
toArchivistPost(records, filesBySha, ownAccounts)
postKeyForArchivist(record)
```

Notes for future agents:

- The mapper accepts one or more TweetRecord versions and emits a v1
  Archivist envelope.
- Relation output depends on both viewer flags and configured
  `own_accounts`.
- Older records without viewer fields naturally produce no relations.
- Do not rename existing TweetRecord fields. Add null-safe fields only.

## Extension: `extension/` and Legacy `src/`

State:

- Capture/save behavior is still the rebuilt extension path described in
  `ARCHITECTURE.md`.
- Debug overlay title now says `Archivist Client capture`.
- `build.mjs` patches generated `dist/manifest.json` to use:
  - name: `Archivist Client`
  - short name: `Archivist`
  - description mentioning twMediaDownloader lineage
- `src/manifest.json` remains untouched by design.
- The frozen standalone save path remains:
  `Downloads/twMediaDownloader/<screen_name>/`

Important compatibility rule:

- Do not rename `TWMD_*`, `twmd_*`, `@twmd/core`, port names, repo name,
  or frozen filename/save conventions unless a new compatibility plan is
  written.

Remaining owner-gated extension work:

- `docs/plans/extension-buttons-plan.md`
- Needs owner-provided missing surfaces and live x.com DOM verification.
- Cleanup must not run until button replacement and live Chrome Tier 3
  verification pass.

## Archivist Client Content Manager: `app/`

State:

- Existing WebSocket capture/archive service remains intact.
- Config now includes:
  - `own_accounts: []`
  - `archivist_url: ""`
  - `archivist_token: ""`
- Env overrides now include:
  - `TWMD_ARCHIVIST_URL`
  - `TWMD_ARCHIVIST_TOKEN`
- Startup banner and CLI usage now say `Archivist Client content manager`.

Database changes:

- `app/src/db.js` now introduces `PRAGMA user_version` migration handling.
- Current client DB version is `2`.
- New table:

```sql
archivist_exports(post_key, dirty_since, acked_at)
```

- Existing archived posts are backfilled dirty during migration.
- `setPostState(post_key, 'archived')` marks the export dirty.
- `purgePosts` deletes export ledger rows for purged posts.

Push export:

- Implemented in `app/src/pusher.js`.
- Flow:
  1. Build envelope with `toArchivistPost`
  2. `POST /api/ingest/post`
  3. Upload each missing file with `PUT /api/ingest/file/:sha256`
  4. Re-POST
  5. Mark ledger acked when `missing_files` is empty
- Service wakeup:
  - archive completion calls `pusher.wake()`
  - background timer runs when push config is present
- CLI:
  - `node app/dist/main.mjs push-status`
  - `node app/dist/main.mjs push --now`

Tests:

- `test/app-pusher.test.ts` uses the real Archivist HTTP ingest API.
- `test/app-db.test.ts` covers ledger migration/dirty behavior.

## Archivist Service: `archivist/`

State:

- New npm workspace: `archivist`
- Build target: `archivist/dist/main.mjs`
- Runtime deps: `better-sqlite3`, `minimist`
- Docker artifacts:
  - `archivist/Dockerfile`
  - `archivist/compose.yml`
- Local docs:
  - `archivist/README.md`
  - `archivist/VERIFICATION.md`

Config:

- `$ARCHIVIST_DIR/config.json`, default `~/.archivist`
- Env overrides:
  - `ARCHIVIST_DIR`
  - `ARCHIVIST_BIND_HOST`
  - `ARCHIVIST_PORT`
  - `ARCHIVIST_API_TOKEN`
  - `ARCHIVIST_ARCHIVE_ROOT`
  - `ARCHIVIST_DB_PATH`
  - `ARCHIVIST_THUMBS_DIR`
  - `ARCHIVIST_LOG_LEVEL`

SQLite:

- Implemented in `archivist/src/db.js`
- `PRAGMA user_version = 1`
- Seeds:
  - services: `twitter`, `archivist`
  - account: `archivist/me`
  - relation types: twitter like/bookmark, archivist favorite/rating
  - credit roles: creator, subject, commissioner, collaborator
- Tables include accounts, name history, posts, versions, files,
  media_items, relations, credits, tags, FTS, ingest_runs.

Ingest core:

- Implemented in `archivist/src/ingest.js`
- Main API:

```js
createIngest(library, { archiveRoot, log })
```

- Provides:
  - `ingestPost(envelope, fileProvider)`
  - `rebuildFts()`
  - `rebuildThreads()`
- It verifies sha256 before storing bytes.
- It is idempotent for duplicate envelopes.
- It refuses `archivist` service relations through ingest.

Snapshot transport:

- Implemented in `archivist/src/snapshot.js`
- CLI:

```sh
node archivist/dist/main.mjs ingest-client <client-dir>
```

- Reads a client `library.sqlite3` read-only and ingests archived posts.
- Re-roots recorded file paths against `<client-dir>/archive`.

HTTP API:

- Implemented in `archivist/src/server.js`
- Auth:
  - Bearer token header
  - `?token=` for media URLs
- Implemented read routes include:
  - `/api/stats`
  - `/api/relation-types`
  - `/api/posts`
  - `/api/posts/:id`
  - `/api/works`
  - `/api/works/:post_id`
  - `/api/media/:id`
  - `/api/accounts`
  - `/api/personas`
  - `/api/tags`
  - `/api/credit-roles`
  - `/files/:sha256`
  - `/thumbs/:sha256` currently serves original bytes as a placeholder
- Implemented write/curation routes include:
  - personas CRUD basics
  - persona account assignment
  - tags
  - local Archivist relations
  - account `is_me`
  - stub account creation
  - credit roles
  - declarative credits
- Implemented ingest routes:
  - `POST /api/ingest/post`
  - `PUT /api/ingest/file/:sha256`

Frontend state:

- `/` serves a minimal static shell saying the API is ready.
- The full media-forward Preact UI from Plan B/V is not complete yet.
- Thumbnail generation with `sharp`/video poster extraction is not fully
  implemented; `/thumbs/:sha256` is a functional placeholder.

Tests:

- `test/archivist-core.test.ts`
- `test/archivist-server.test.ts`

## Mosaic

State:

- No implementation exists.
- Plans remain in `docs/plans/mosaic/`.
- The first real step is still P-0: Windows 10 Flutter/media_kit spike on
  owner hardware.

Do not build full Mosaic until the P-0 hardware evidence exists.

## Incomplete or Gated Work

Keep these plans active until their gates are cleared:

- **Archivist UI polish and thumbnails**
  - Plan references:
    - `docs/plans/archivist/02-api-and-frontend-plan.md`
    - `docs/plans/archivist/04-media-viewer-plan.md`
  - Current API is usable and tested, but frontend is minimal and
    thumbnail generation is placeholder-level.
- **Mosaic**
  - Plan references: `docs/plans/mosaic/`
  - Hardware-gated by P-0.
- **Extension buttons**
  - Plan reference: `docs/plans/extension-buttons-plan.md`
  - Needs owner surface list and live DOM verification.
- **Cleanup**
  - Plan reference: `docs/plans/cleanup-plan.md`
  - Blocked until live Chrome Tier 3 and button Phase 2 are verified.
- **TrueNAS deployment**
  - Artifacts exist, but real hardware deploy remains owner-gated.

## AI Consumption Notes

Before changing code:

1. Read `ARCHITECTURE.md`.
2. Read `docs/plans/00-overview.md`.
3. For Archivist work, read:
   - `docs/plans/archivist/00-archivist-overview.md`
   - `docs/plans/archivist/API.md`
4. Use the devcontainer verification command, not host npm.
5. Keep shared logic in `packages/core`.
6. Do not add requests to `x.com` or `api.x.com`.
7. Do not delete legacy `src/` until cleanup gates are cleared.

Useful command set:

```sh
docker compose -f .devcontainer/docker-compose.yml run --rm app \
  sh -lc 'npm test && npm run typecheck && npm run build'

node app/dist/main.mjs push-status
node app/dist/main.mjs push --now

node archivist/dist/main.mjs stats
node archivist/dist/main.mjs ingest-client <client-dir>
node archivist/dist/main.mjs serve
```

When archiving old plans, preserve or migrate any incomplete items listed
above before deleting plan documents.
