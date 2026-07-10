# Archive Library — Plan Set Index

**Planning status:** proposed follow-on scope, written 2026-07-10. This plan
set is intentionally additive: it does not modify the downloader plans that
were active when it was written. When implementation begins,
`docs/plans/00-overview.md` should be updated in a separate, owner-approved
change to link this plan set and mark the precise supersessions below.

## Outcome

Turn the current Twitter capture/downloader into the first producer and
archive worker for a private, single-owner, multi-service content library.
The only required software on the browsing device is the Chrome extension.
A remote server (normally the owner's NAS or a machine with direct access to
NAS storage) will:

- receive durable capture events from the extension;
- retain normalized post, account, identity, and viewer-relationship data;
- download and verify selected original media;
- own tags, ratings, notes, local favorites, collections, and person/account
  aliasing;
- serve originals and generated previews through stable URLs;
- expose a private API for the bundled web UI and future collage clients;
- import older archives through a read-only, manifest-first workflow once
  their real directory and sidecar shapes have been sampled.

The first usable release is deliberately small: one remote server, one
SQLite database, one archive root, one extension device, and one web UI. The
schema and protocol admit more source services and owner accounts without
introducing multi-tenant product complexity.

## Architecture decision

Use the existing `app/` process and database as the seed of a **modular
monolith**, referred to in these plans as the **library server**. Do not add a
second library service or database.

This differs from an earlier plausible design in which a new generic service
periodically imported the content manager's SQLite and files. That split
would create two representations of every post/media item, a synchronization
protocol, stale archive state, and difficult ownership questions for purge,
re-ingest, and curation. Those costs buy nothing for a single-owner system
running beside its storage.

Internal modules still have firm boundaries:

1. capture adapters normalize provider-specific records;
2. ingest commits idempotent observations;
3. the library domain owns identities and curation;
4. persistent workers own downloads, hashing, previews, and imports;
5. HTTP/WebSocket surfaces expose those capabilities.

They can be split into processes later if measured load or fault isolation
requires it. They share one transaction boundary now.

## Relationship to current binding decisions

The following existing rules remain binding without qualification:

- no project-originated request to `x.com` or `api.x.com`;
- media fetches use provider-specific allowlists and never forward cookies or
  authorization credentials;
- no writes to Twitter or any future external source service;
- filename and sidecar compatibility for existing Twitter archives;
- passive capture for edits, deletions, account changes, likes, and
  bookmarks; no polling source services;
- Chrome-first, self-distributed operation;
- shared Twitter normalization and media URL logic remains in
  `@twmd/core` rather than being reimplemented.

The follow-on project intentionally changes two scope statements:

1. `docs/plans/00-overview.md` Decision 2 says this iteration is a downloader,
   not a browser. The existing downloader remains a bounded subsystem, but
   the new library server adds an API and browser UI around its stored data.
2. Decision 8 rejects a thumbnail store for the downloader. The archive still
   stores originals only; the library adds a disposable, versioned preview
   cache because an image grid cannot responsibly stream multi-megabyte
   originals. Every preview is reproducible and excluded from backup
   requirements.

No legacy code is removed by this plan. The live-browser verification and
cleanup gates in the current plans still apply to the extension rewrite.

## Assumptions made for autonomous planning

- "Remote" means an owner-controlled NAS/LAN or private-overlay-network
  host, not a public multi-tenant SaaS deployment.
- The library server runs on the same machine/filesystem as the SQLite file,
  or at least keeps SQLite on a local filesystem. SQLite must not live on an
  SMB/NFS mount. Media may live on a directly mounted NAS dataset.
- A secure `wss://`/`https://` origin is available through a reverse proxy or
  private-network ingress. Plain `ws://` remains allowed only for loopback
  development.
- The owner wants all passively seen posts represented in the library, while
  media-forward views default to items whose media bytes are archived.
- Twitter likes/bookmarks and app-local favorites are distinct concepts and
  must be independently filterable.
- "Me" is both the single authenticated application owner and a normal
  library person record linked to one or more service accounts.
- Account aliasing is manual in the MVP. Suggestions can be added later but
  never auto-merge identities.
- Old archive layouts are not guessed. The importer framework can be built
  and tested with synthetic fixtures, but format adapters wait for real
  samples.

## Plan documents

| Document | Responsibility |
|---|---|
| `01-architecture.md` | process boundaries, deployment topology, migration posture, invariants |
| `02-storage-and-files.md` | generic SQLite model, curation data, blob relationships, previews, migrations |
| `03-capture-ingest-and-jobs.md` | minimal device agent, durable protocol, provider adapters, persistent workers |
| `04-api-and-media.md` | authenticated HTTP API, queries, stable media URLs, collage client contract |
| `05-web-mvp.md` | media-forward UI, detail/curation flows, identity UI, implementation choices |
| `06-identity-and-curation.md` | accounts, people, handle history, owner accounts, ratings/tags/source state |
| `07-legacy-import.md` | discovery, manifest, parser adapters, reconciliation, safe execution |
| `08-operations-and-security.md` | NAS deployment, TLS/auth, backup/restore, observability, recovery |
| `09-roadmap-and-verification.md` | ordered milestones, file map, acceptance gates, test strategy |

## Non-goals for the first implementation

- multi-tenant accounts, sharing, public galleries, or social features;
- source-service write operations of any kind;
- automatic source polling, account crawling, or deletion checks;
- machine-learning tagging, face recognition, or automatic person merges;
- a visual collage editor (the API needed by a separate collage client is in
  scope; the editor itself is not);
- relocating every historical file into a new directory convention;
- Kubernetes, distributed queues, PostgreSQL, object storage, or separate
  microservices;
- perfect offline retention of an unbounded timeline. The device outbox is
  durable but quota-bounded and visibly reports pressure.

## Definition of success

The plan is complete when the following vertical slice works:

1. The extension observes a Twitter post, writes a durable event locally,
   and later receives a server acknowledgement over `wss://`.
2. The server idempotently stores the post, author account observation, media
   candidates, source operation, and viewer liked/bookmarked state.
3. An archive action from either the Twitter button or library UI creates one
   persistent download job; a restart neither loses nor duplicates it.
4. Original bytes are hashed, linked to every applicable media asset, and
   served with range requests through a stable authenticated URL.
5. The web grid can filter archived content, source bookmarks/likes, local
   favorites, tags, rating, service, author/person, and media type.
6. Local tags/ratings survive repeated capture, provider edits, archive
   retries, and account-handle changes.
7. A person can link multiple service accounts, including an owner/person
   record for "me," and the grid can include or separate those accounts.
8. A read-only client token can query media metadata and fetch previews for a
   future collage application without knowing filesystem paths.
9. Backup and restore instructions recover the database and originals on a
   clean server; previews rebuild on demand.
