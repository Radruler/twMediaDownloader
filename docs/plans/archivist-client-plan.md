# Archivist Client — Plan: Rename, Relation Capture, Push Export

**Status:** 2026-07-11, split out of the Archivist plan set so it can run
as its own workstream in its own session. This is **archiver-side work**
(this repo's extension + content manager); the NAS-side service plans live
in `docs/plans/archivist/` and are not needed to execute §N/§C. §D targets
Archivist's ingest API and needs Archivist plan A done first (the endpoint
contract is restated inline below so this doc stays self-contained).

Read first: `ARCHITECTURE.md` (contracts, sharp edges),
`docs/plans/00-overview.md` (Decisions — binding here).

## The ethos this plan must carry through (do not dilute)

The archiver's identity does not change with its name. Everything in this
plan obeys the existing posture:

- **Passive capture only.** We observe the requests the page already
  makes; we never generate new requests to `x.com`/`api.x.com` or any
  other content service, ever. Nothing in §C adds a request — it reads
  fields already present in observed payloads. Nothing polls a service to
  ask "is this still liked?" — relation changes are learned only if the
  content is re-seen.
- The only sanctioned outbound fetches remain the polite, cookie-free
  media GETs to the CDN hosts, unchanged by this plan.
- §D's push talks only to **our own Archivist service on the LAN** —
  it is not service traffic and has no politeness implications, but it
  must never block or degrade capture/archiving when the NAS is off
  (the NAS being off is the normal case, not an error).
- TweetRecord contract-stability rule applies: fields may be ADDED with
  null-safe defaults; never renamed or re-meant (update `ARCHITECTURE.md`
  in the same commit as any contract addition).

## §N — Rename: this system is the "Archivist Client"

The repo's extension + content-manager pipeline is the **Archivist
Client** in the Archivist design. The rename is presentation-level:
identity in docs and user-facing strings, zero breakage of frozen or
deployed surfaces.

**N-1 — Docs.** README top section: title the rebuilt system "Archivist
Client (twMediaDownloader)" and state the relationship to Archivist in a
sentence (producer of archived content; `docs/plans/archivist/`).
`ARCHITECTURE.md`: same one-line framing at the top; terminology sweep so
"the extension" / "the service (content manager)" read as parts of the
Archivist Client. `docs/plans/00-overview.md`: retitle "What this project
is" accordingly. **Never touch the legacy README attribution** (ground
rule; the project remains MIT, originally by furyu).

**N-2 — User-facing strings.** Extension display name via the
`build.mjs` manifest patch (Sharp edge #2: `src/manifest.json` itself is
never edited): name → "Archivist Client", description mentions
twMediaDownloader lineage. Content-manager startup banner and CLI
`--help` header say "Archivist Client content manager". Debug overlay
title likewise.

**N-3 — Explicitly NOT renamed** (document this list in the README so
the decision is visible):

- The frozen filename convention and the standalone save folder
  `Downloads/twMediaDownloader/<screen_name>/` (owner has years of
  archives; Decision 6).
- `TWMD_*` env vars, `$TWMD_APP_DIR`, `localStorage.twmd_*` keys, the
  `twmd-save`/`twmd-template` port names, `@twmd/core`, `__twmdDebug`.
  Renaming these breaks deployments and muscle memory for zero function.
  If a deeper rename is ever wanted, it is its own plan with back-compat
  aliases — not part of this one.
- The repo name.

## §C — Relation capture (viewer flags into TweetRecord)

Today the normalizer drops the viewer-relationship fields X sends
(`legacy.favorited`, `legacy.bookmarked`), so "my likes/bookmarks" can
never reach Archivist. Fix at the contract level:

**C-1 — Contract:** add to `TweetRecord`
(`packages/core/src/tweet-record.ts`):

```ts
/** Viewer-relationship flags as X sent them; null = absent from payload. */
viewer: { liked: boolean | null; bookmarked: boolean | null };
/** Author id of the tweet this replies to (legacy.in_reply_to_user_id_str). */
in_reply_to_user_id_str: string | null;
```

(`in_reply_to_user_id_str` exists so Archivist can detect self-reply
threads even when the parent tweet was never archived — see Archivist
Decision 14. Populate it in the normalizer alongside the viewer flags.)

**C-2 — Normalizer:** populate in `graphql-normalize.ts` from the tweet
legacy object. Check which fixtures in `test/fixtures` carry these
fields; if none do, the owner captures a fresh fixture from a
Likes/Bookmarks timeline (`docs/CAPTURE_FIXTURES.md`) so this lands
tested-true, not assumed.

**C-3 — Own-account config:** a record with non-null viewer flags was
fetched as *some* logged-in user, but payloads identify the viewer only
indirectly — never guess identity. Add client config
`own_accounts: [{ service_account_id, screen_name }]`
(operator-declared; documented in the README config table). This is what
the Archivist mapper uses as the relation subject.

**C-4 — Media tagged-users capture (additive, supports Archivist credit
suggestions):** where observed payloads carry per-media tagged users
(X's media `tagged_users` / `ext_media_availability` neighborhood —
verify the real field name against fixtures before coding), add to
`MediaRecord`:

```ts
/** Users tagged on this media item, as captured; [] when absent. */
tagged_users: { id_str: string | null; screen_name: string | null }[];
```

Normalizer fills it; nothing else in the client consumes it — it rides
`raw_record_json` into Archivist, which uses it for credit suggestions
(Archivist plan 04). If the field does not appear in any capturable
payload, record that finding in this doc and drop the item.

**C-5 — Secondary evidence (document, don't build):** `source_op` is
already stored per version; a record seen via the Bookmarks timeline op
implies bookmarked even without flags. Leave a TODO with the op names in
`packages/core/src/archivist-post.ts` (created by Archivist plan A);
implement only if C-2's flags prove unreliable in live verification.

**Ordering note:** every post archived *after* §C carries relation data
into any later Archivist ingest for free; posts archived before simply
have no relations until re-seen. Land §C early if archiving sprees are
planned.

## §D — Push export (client → Archivist, opportunistic)

Requires Archivist plan A (ingest core + endpoints). Snapshot ingest
(Archivist reads a copy/mount of this client's data dir) is the fallback
forever; push makes the flow hands-off. Design constraints: NAS not on
24/7; never block or lose archives when Archivist is unreachable;
re-delivery is harmless because Archivist ingest is idempotent.

**D-1 — Config:** `archivist_url` (e.g. `http://nas.local:8470`),
`archivist_token` (Archivist's bearer token). Both empty by default =
push disabled, client behavior completely unchanged.

**D-2 — Export ledger:** client DB migration:

```sql
CREATE TABLE archivist_exports (
  post_key    TEXT PRIMARY KEY REFERENCES posts(post_key),
  dirty_since INTEGER NOT NULL,   -- archived/re-archived, not yet acked
  acked_at    INTEGER
);
```

Mark dirty when a post reaches `state='archived'` (and again on
requeue→re-archive). Migration backfills all currently-archived posts as
dirty so the first push uploads history.

**D-3 — Target contract** (implemented Archivist-side, plan B §B-7;
restated here for self-containment):

```
POST /api/ingest/post          body = ArchivistPost envelope (plan A-3);
                               response { missing_files: [sha256, …] }
PUT  /api/ingest/file/:sha256  raw bytes; hash-verified before accept
```

Bearer auth on both. Flow per post: POST → upload each missing file →
re-POST until `missing_files: []` → acked.

**D-4 — Pusher** (content-manager service): background loop,
single-flight, woken by archive-completion and a slow timer (~15 min).
Takes oldest dirty rows, builds envelopes via `toArchivistPost` (from
`@twmd/core`, added by Archivist plan A) with C-3's `own_accounts` as
relation subjects, pushes, sets `acked_at`. Failure = plain backoff to
the timer; log at debug only — NAS-off is normal, not an error. File
uploads capped at concurrency 1 (stay invisible on the client machine).

**D-5 — CLI:** `push-status` (dirty/acked counts, last success time) and
`push --now` (one forced sweep) subcommands on the service binary.

## Tests

- §N: build produces the patched manifest name; no test churn otherwise.
- §C: fixtures with/without viewer fields → correct tri-state; fixtures
  with tagged users → `tagged_users` populated, absent → `[]`; existing
  fixture expectations updated in the same commit.
- §D: ledger transitions (archive → dirty → acked; re-archive
  re-dirties); pusher against a stub Archivist server — happy path,
  missing-files round trip, unreachable-NAS backoff with no data loss;
  one end-to-end duplicate-delivery test against the REAL Archivist
  ingest core (no mock) asserting no-op.

Every commit: `npm test && npm run typecheck && npm run build` green in
the devcontainer; push after every green commit.
