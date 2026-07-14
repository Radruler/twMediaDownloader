# Archivist

Archivist is the NAS-side personal archive library. It ingests archived
content from Archivist Client snapshots or push delivery and serves a
LAN-only HTTP API.

## Run

Build from the repo root first:

```sh
npm run build
node archivist/dist/main.mjs serve
```

On first run it creates `$ARCHIVIST_DIR/config.json` (default
`~/.archivist`) and prints the bearer token. Durable state is the SQLite
DB in `/data` and archive files in `/archive`; thumbnails are disposable.

## Snapshot Ingest

Copy or mount an Archivist Client data dir containing `library.sqlite3`
and `archive/`, then run:

```sh
node archivist/dist/main.mjs ingest-client /path/to/client-data
```

Re-running snapshot ingest is safe and idempotent.

## API

All `/api/*`, `/files/*`, and `/thumbs/*` routes require
`Authorization: Bearer <token>` or `?token=<token>`. The normative API
contract is `docs/plans/archivist/API.md`.

## TrueNAS Shape

`compose.yml` is the intended custom-app shape: one container, port 8470,
volumes `/data` and `/archive`, restart unless stopped.
