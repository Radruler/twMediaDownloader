# Archivist — Overview: Decisions & Work Plan

**Status:** 2026-07-11 initial design, agreed with the owner. Everything in
this doc is current and binding for the Archivist workstream; each work
item has its own plan doc sized for a fresh session. The archiver-side
plans in `docs/plans/00-overview.md` remain binding for the archiver; where
this workstream touches archiver code, both apply.

## What Archivist is

**Archivist** is the owner's personal content library: a service-agnostic
data store + HTTP API + lightweight web frontend that organizes and serves
everything the archiver has archived. The existing system in this repo
(extension + content manager) is, from Archivist's point of view, the
**Archivist Client** — a producer that fetches content from services
(Twitter today, more later) and hands archived posts + media to Archivist.

```
DESKTOP (primary device)                     NAS (TrueNAS, Docker)
┌───────────────────────────────┐            ┌──────────────────────────────┐
│ Archivist Client (this repo)  │            │ Archivist                    │
│  extension ─ws─▶ content mgr  │──ingest──▶ │  SQLite library (canonical)  │
│  SQLite "seen" library        │  (snapshot │  archive files + thumbnails  │
│  local archive files          │   or push) │  HTTP API + web frontend     │
└───────────────────────────────┘            └──────────────┬───────────────┘
                                                            │ HTTP (LAN)
                                              browser UI, collage app,
                                              future frontends
```

Division of responsibility, agreed 2026-07-11:

- The **client** owns capture, the seen-tier library (everything scrolled
  past), selection, and polite downloading. Seen-only data stays on the
  client.
- **Archivist** ingests **archived / manually-chosen posts only**. It is
  the canonical store for archived content, captured *relations* (likes,
  bookmarks, …), identity history, and all user curation (tags, ratings,
  personas). If we later want seen-tier data in Archivist, that's a new
  decision.
- **Frontends** (the media grid shipped with Archivist, the people/traits
  view, the future collage app) consume only Archivist's HTTP API.

## Decisions (binding for the Archivist workstream)

1. **Archivist never sends a request to any external service.** All
   metadata and bytes arrive via client ingest. Media is served from local
   archive files only. (The client's own Decision 1 — nothing talks to
   x.com — is unaffected.)
2. **Separate service, own schema.** Archivist is not a grown content
   manager. It has its own service-agnostic SQLite database and its own
   archive tree; the client's library stays the client's. The handoff is
   the versioned `ArchivistPost` envelope (see 01), which is the one door
   every current and future producer goes through.
3. **Data store: SQLite (better-sqlite3, WAL) + plain files on disk.**
   Single tenant, single writer, compute-constrained NAS that is not on
   24/7 — an embedded, zero-admin store is correct. No Postgres, no
   document store. Extensibility comes from the relation-type registry as
   *rows, not schema changes* (Decision 5). Derived data (thumbnails, FTS)
   is rebuildable.
4. **Archive files keep the frozen human-readable convention**, one level
   deeper: `<archive_root>/<service>/<screen_name>/<frozen-name>.<ext>`.
   The NAS tree stays browsable without the app; the DB (sha256-keyed
   `files`) handles dedupe and lookup. Sidecars are ingested but not
   required — the DB is authoritative on the Archivist side.
5. **Relations are data, not schema.** A `relation_types` registry
   declares, per service, what relations exist and their value shape:
   `flag` (like, bookmark), `tier` (e.g. a service with like tiers 1–3),
   `scalar` (bounded number). Adding a service's relation = inserting a
   registry row. Captured service relations and local curation go through
   the same mechanism: a reserved built-in service `archivist` provides
   `favorite` (flag) and `rating` (scalar 1–5). Tags are the one deliberate
   exception — free many-to-many labels get their own tables.
6. **The subject of every relation is an account row.** Owned service
   accounts are `accounts.is_me = 1`; a seeded `archivist/me` account is
   the operator and the subject of all local curation. "Me" = the union of
   `is_me` accounts — no separate user model, and multiple owned accounts
   per service work for free. Single end user; API auth is one bearer
   token; no multi-tenancy anywhere.
7. **Identity model:** `accounts` (one per service identity, passive
   status active/deleted/suspended), `account_names` (observed
   screen-name/display-name history — rename tracking), `personas`
   (manual, user-curated grouping of accounts across services — the
   aliasing toggle in frontends). Graph-based alias *suggestions* are
   future ideation, not scoped.
8. **Ingest never writes curation.** Tags, ratings, personas, and
   `archivist`-service relations are only ever written by the API.
   Re-ingesting anything is always safe and idempotent.
9. **Two ingest transports, one core.** (a) *Snapshot ingest* (MVP): a CLI
   that reads a client data dir (its SQLite + archive files) and ingests
   all archived posts — no new client code needed, works over a copy or a
   mount. (b) *Push* (phase D): the client posts newly archived content to
   Archivist's ingest API opportunistically, tolerating the NAS being
   offline. Both call the same idempotent ingest core.
10. **Stack: lightweight and boring.** Node 22 (matches repo), plain JS
    service + `node:http` with a small hand-rolled router (no framework),
    better-sqlite3, `sharp` for thumbnails. Frontend: Preact + htm bundled
    by the repo's existing esbuild pipeline, served as static files by
    Archivist itself — one process, one container. Vitest for tests, same
    suite.
11. **Deployment: one Docker container on TrueNAS** (current release,
    Docker-based apps). Two volumes: `/data` (db, thumbnails, config) and
    `/archive` (media tree). One published port (default 8470). LAN-only,
    bearer-token auth, no TLS story of our own (a reverse proxy is the
    owner's option later).
12. **Thumbnails are Archivist's job** (the client's "no thumbnail store"
    decision stands for the client). Lazily generated, content-addressed
    (`<data>/thumbs/<sha256>-<w>.webp`), disposable cache.
13. **Naming:** the service is **Archivist**; this repo's
    extension+content-manager pipeline is the **Archivist Client**. No
    code/repo renames now — the name appears in new code, docs, and config
    only.

## Remaining work, in sequence

| # | Work | Plan | Status / gate |
|---|---|---|---|
| A | **Library core** — schema, ingest core, snapshot ingest CLI, Dockerfile | `01-library-and-ingest-plan.md` | ready to start |
| B | **API + frontend MVP** — HTTP API, ingest endpoints, thumbnails, media-grid/people UI, TrueNAS deploy notes | `02-api-and-frontend-plan.md` | after A |
| V | **Media viewer** — the consumer-grade viewing frontend (universal post view, threads, credits) | `04-media-viewer-plan.md` | after B |
| — | Viewer roadmap — principled feature exploration, NOT scoped work | `05-media-viewer-roadmap.md` | ideation |

A then B is the critical path to a usable MVP (snapshot-ingest a copy of
the client's data, browse it on the NAS).

**Client-side work is a separate workstream** (own doc, own session):
`docs/plans/archivist-client-plan.md` — the Archivist Client rename,
relation capture (viewer flags, tagged users, own-account config), and
the opportunistic push export. Its §C is independent and can run any
time; its §D needs plan A/B's ingest surface.

## Ground rules

- The archiver ground rules (`docs/plans/00-overview.md`) apply to any
  work touching `packages/core`, `extension/`, or `app/` — especially:
  TweetRecord fields may be added (null-safe) but never renamed/re-meant.
- Every commit: `npm test && npm run typecheck && npm run build` green in
  the devcontainer; push after every green commit.
- Archivist code lives in `archivist/` (npm workspace), its tests in
  `test/` alongside the existing suite (`archivist-*.test.js`).
- Schema changes after A ships require a migration (versioned pragma
  `user_version`), not a rebuild — the library is the owner's canonical
  data.
