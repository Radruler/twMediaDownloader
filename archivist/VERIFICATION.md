# Archivist Verification

## Headless

```sh
npm test
npm run typecheck
npm run build
node archivist/dist/main.mjs stats
```

## Snapshot

1. Copy an Archivist Client data dir with `library.sqlite3` and `archive/`.
2. Run `node archivist/dist/main.mjs ingest-client <dir>`.
3. Re-run the same command and confirm counts do not duplicate.
4. Run `node archivist/dist/main.mjs verify`.

## Browser/API

1. Start `node archivist/dist/main.mjs serve`.
2. Open `/` and confirm the static shell loads.
3. Call `/api/stats` with the bearer token.
4. Browse `/api/posts`, `/api/works`, `/api/media/:id`, and `/files/:sha`.
5. Confirm missing-byte push flow: `POST /api/ingest/post`, `PUT /api/ingest/file/:sha`, re-`POST`.
