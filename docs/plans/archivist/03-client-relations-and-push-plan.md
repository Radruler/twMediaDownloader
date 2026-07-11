# Archivist — Plan C/D: Client Relation Capture & Push Transport

Two client-side (this repo's archiver) work items. §C is independent and
can run before plan A; §D requires plan A's ingest API surface. All
archiver ground rules apply (`docs/plans/00-overview.md`), above all
Decision 1: nothing here sends any request to `x.com`/`api.x.com` — both
items only capture more from traffic we already observe, or talk to
Archivist on the LAN.

## §C — Relation capture (viewer flags into TweetRecord)

Today the normalizer drops the viewer-relationship fields X sends
(`legacy.favorited`, `legacy.bookmarked`), so "my likes/bookmarks" cannot
reach Archivist. Fix at the contract level:

- **C-1 — Contract:** add to `TweetRecord` (additive, null-safe — allowed
  by the stability rule; update `ARCHITECTURE.md`'s contract section in
  the same commit):

  ```ts
  /** Viewer-relationship flags as X sent them; null = absent from payload. */
  viewer: { liked: boolean | null; bookmarked: boolean | null };
  ```

- **C-2 — Normalizer:** populate from the tweet legacy object in
  `graphql-normalize.ts`. Capture fixtures currently in `test/fixtures`
  may predate these fields — verify which fixtures carry them; if none
  do, the owner captures a fresh fixture from a Likes/Bookmarks timeline
  (`docs/CAPTURE_FIXTURES.md`) before this lands as tested-true rather
  than assumed.
- **C-3 — Flow-through:** no schema change in the client DB —
  `versions.raw_record_json` already carries whatever the record carries.
  The freshest record's `viewer` is what `toArchivistPost` (plan A-3)
  turns into `relations` entries, with the client's **own account** as
  subject. The client learns its own account(s) passively: a captured
  record where `viewer.liked/bookmarked` is non-null was necessarily
  fetched as *some* logged-in user, but the payload identifies the viewer
  only indirectly — so add config `own_accounts: [{service_account_id,
  screen_name}]` to the client (operator-declared, mirrored as
  `is_me` accounts at ingest). Do not guess identity from payloads.
- **C-4 — Secondary evidence (document, don't build):** `source_op`
  (already stored per version) implies relations — a record seen via the
  Bookmarks timeline op is bookmarked even if flags are missing. Note the
  mapping in `archivist-post.ts` as a TODO with the op names; implement
  only if C-2's flags prove unreliable in live verification.

Ordering note: land §C before archiving sprees, not before plan A — every
post archived *after* §C carries relation data into any later ingest for
free; posts archived before §C simply have `relations: []` until re-seen.

## §D — Push transport (client → Archivist, opportunistic)

Snapshot ingest (plan A-5) is the fallback forever; push makes the flow
hands-off. Constraints that shape the design: the NAS is **not on 24/7**,
the client must never block or lose archives when Archivist is
unreachable, and re-delivery must be harmless (it is — ingest is
idempotent).

- **D-1 — Client config:** `archivist_url` (e.g.
  `http://nas.local:8470`), `archivist_token` (the ingest bearer token),
  both empty by default = push disabled, everything else unchanged.
- **D-2 — Export ledger:** client DB migration adding

  ```sql
  CREATE TABLE archivist_exports (
    post_key    TEXT PRIMARY KEY REFERENCES posts(post_key),
    dirty_since INTEGER NOT NULL,   -- archived/re-archived and not yet acked
    acked_at    INTEGER
  );
  ```

  Rows are marked dirty when a post reaches `state='archived'` (and on
  requeue→re-archive). Backfill on migration: all currently-archived
  posts marked dirty so first push uploads history.
- **D-3 — Archivist ingest endpoints** (Archivist side, small addition to
  plan B's server):

  ```
  POST /api/ingest/post          body = ArchivistPost envelope;
                                 response {missing_files: [sha256…]}
  PUT  /api/ingest/file/:sha256  raw bytes; hash-verified before accept
  ```

  Post-then-files, then re-POST confirms `missing_files: []` → ack. Same
  bearer auth as the rest of the API.
- **D-4 — Pusher** (client service): a background loop, single-flight,
  that wakes on archive-completion and on a slow timer (e.g. 15 min),
  takes the oldest dirty rows, builds envelopes via `toArchivistPost`,
  pushes post → missing files → ack (`acked_at`, clear dirty). Failure =
  plain backoff to the timer; log at debug, never at info spam — NAS-off
  is the normal case, not an error. No politeness rules apply (LAN,
  our own service) but cap file-upload concurrency at 1 to stay invisible
  on the client machine.
- **D-5 — CLI:** client `push-status` (dirty/acked counts, last success)
  and `push --now` (one forced sweep) subcommands for the operator.

## Tests

- §C: normalize fixtures with/without viewer fields → correct
  tri-state; `toArchivistPost` emits like/bookmark relations with the
  configured own account as subject; no own-account config → flags map to
  no relations (and a one-time warning), never a guessed subject.
- §D: ledger transitions (archive → dirty → acked; re-archive re-dirties);
  pusher against a stub Archivist — happy path, missing-files round trip,
  unreachable-NAS backoff without data loss, duplicate delivery is a
  no-op end-to-end (real ingest core, not a mock, for that last one).
