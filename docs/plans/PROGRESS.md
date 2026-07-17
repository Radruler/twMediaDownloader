# Active Plan Progress

**Last updated:** 2026-07-17

This is the current ai-forward progress log for active plans in
`docs/plans/`. Start here for planning context, then open only the
specific plan or API contract needed for the task. Binding decisions
remain in each plan doc; this file is a handoff aid, not a replacement
for the plans.

## Current Execution State

### Archivist

- **Plan A: Library Core & Ingest** is complete and archived at
  `archive/plans/archivist/01-library-and-ingest-plan.md`.
- **Plan B: API + Frontend MVP** is partially implemented:
  HTTP server/auth, core read endpoints, curation writes, push ingest,
  byte serving/range support, and some V-shaped credit/works endpoints are
  present. The documented read-filter surface for `/api/posts` and
  `/api/works` is implemented with HTTP-level regression coverage.
  Remaining B work includes thumbnail generation, static Preact frontend,
  fuller write validation, account search/pagination, `relations=all`,
  documented conflict cases, and TrueNAS deployment walkthrough
  completion.
- **Plan V: Media Viewer MVP** is partially seeded:
  `/api/works`, credits, credit roles, and suggestion extraction exist.
  Remaining V work is the richer viewer UI, person/feed browse shell,
  full works filter matrix, and owner walkthrough.

### Archivist Client

- `docs/plans/archivist-client-plan.md` remains active. The client-side
  rename and relation capture pieces appear partially reflected in code
  (`toArchivistPost`, own account snapshot config, push-export support),
  but the plan should be re-audited before marking sections complete.
- Live extension verification still blocks cleanup per
  `docs/VERIFICATION.md`.

### Mosaic

- Mosaic remains greenfield and intentionally gated by the Windows 10
  Flutter/media_kit playback spike in
  `docs/plans/mosaic/01-playback-core-plan.md` §P-0.
- No Mosaic implementation was started in this session because the first
  real gate needs the owner's Windows hardware. Repo-local P-1/P-2 work
  can begin later, but should not pretend to validate the stack decision.

## 2026-07-17 Session

Executed a bounded Plan B/V API contract improvement:

- Added a shared post-filter builder in `archivist/src/server.js` used by
  both `/api/posts` and `/api/works`.
- Implemented documented filters for service, author, persona, tags,
  active relations, `favorite=1`, `rating_min`, FTS `q`, `has_media`,
  media `type`, `credited`, `credited_persona`, `role`, `deleted`,
  `sensitive`, and `sort=created|ingested`.
- Preserved `/api/works` collapse semantics: if a non-root thread part
  matches a filter, the API returns the complete work.
- Added HTTP-level regression coverage in `test/archivist-server.test.ts`
  for post filters and work filters, including the thread-child match and
  media-level credit match cases.

## Verification

Run inside the devcontainer, per project ground rules:

- `npm test` — 15 files, 172 tests passed.
- `npm run typecheck` — passed.
- `npm run build` — passed.

Host-side npm was not used for verification; the repo's devcontainer
provided the working dependency environment.

## Remaining Reasonable Next Steps

1. Finish Plan B endpoint parity against `docs/plans/archivist/API.md`:
   validate write payloads, account search/pagination, `relations=all`,
   relation value validation, and documented 409 cases.
2. Implement thumbnails (`archivist/src/thumbs.js`) and tests for width
   whitelist, cache reuse, unknown sha, and placeholder behavior.
3. Build the Preact frontend MVP once the API surface is stable enough
   for real browsing.
4. Re-audit `archivist-client-plan.md` against current code and mark the
   rename/relation/push subsections precisely.
5. Keep Mosaic paused until either the Windows playback spike can run or
   the owner explicitly asks to start the Linux-headless model/cache work
   before the spike.

## Archived This Session

- `docs/plans/archivist/01-library-and-ingest-plan.md` moved to
  `archive/plans/archivist/01-library-and-ingest-plan.md` because the
  workspace, schema, ingest core, snapshot CLI, Docker artifacts, and
  tests are implemented. Owner real-data/NAS walkthroughs remain
  verification activity, not active plan implementation.
