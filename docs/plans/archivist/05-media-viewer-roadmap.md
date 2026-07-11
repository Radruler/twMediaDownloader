# Archivist — Media Viewer Roadmap (ideation, NOT scoped work)

Where the viewer can go after the plan-04 MVP, organized by principle so
future scoping is fast. Nothing here is committed; V-6's owner retro
re-prioritizes this list before anything below becomes a plan. Each item
notes what it would need (schema / API / client capture) so we know its
real cost up front.

## Principle 1 — One work, many posts

The MVP already merges self-threads. The same instinct generalizes:

- **Cross-service crosspost detection.** The same image posted on two
  services is *one work*. Exact-duplicate detection is already free
  (`files.sha256` is global across services); surface it: "also posted
  on…" on the work view, optional merged display. Needs: API join, UI.
  Later: perceptual hashing (pHash) for re-encoded/resized crossposts —
  new derived table, rebuildable, cheap to add when wanted.
- **Quote/RT provenance chains.** Walk `quoted_key` chains across the
  library: "this work quotes → which quotes →". Needs: recursive query +
  UI affordance; data already captured.
- **Edit-aware display.** Versions exist in the schema; show "edited,
  N versions" with a diff view of text changes. Needs: UI only.

## Principle 2 — People, not accounts

- **Stub resolution / account merge tooling.** When a `~stub` account's
  person later shows up for real (or two accounts are discovered to be
  one), merge: re-point credits/relations/persona membership, keep the
  history. Needs: API + careful transaction; schema already tolerates it.
- **Same-person suggestions.** The owner's graph-network idea: shared
  media (both credited on many works), matching display names, mention
  reciprocity → suggest persona groupings. Explicitly future (owner
  call, 2026-07-11); suggestions must stay suggestions.
- **Name-history in the viewer.** Surface "was @oldname when this was
  posted" on works, from `account_names` windows vs post timestamps.
  Needs: UI only — the windows exist.

## Principle 3 — Curation at near-zero cost

Curation features only matter if they're cheaper than not curating:

- **Triage mode.** Full-keyboard rapid pass over the Unfiled feed: one
  work on screen, `1–5`/`f`/tag-autocomplete/`space`-skip, next. The
  single highest-leverage post-MVP feature for a growing archive.
- **Bulk operations.** Apply tag/rating/credit to a whole filter result
  ("everything by X this month"). Needs: bulk write endpoints with a
  dry-run count, same declarative semantics as single-item.
- **Saved smart feeds.** Persist named filter queries (the feed bar
  becomes user-extensible). Needs: one tiny table + CRUD; feeds are
  already just queries.
- **Auto-tag hooks.** Derive cheap tags at ingest-read time (media type,
  has-alt-text, service) as *virtual* tags rather than stored rows, so
  they're free and never stale.

## Principle 4 — Resurfacing

An archive nobody revisits is a backup, not a library:

- **Shuffle / on-this-day / least-recently-viewed** feeds. Needs: a
  local `view_history` table (work_id, viewed_at — Archivist-only,
  never leaves the box) + sort modes on the works query.
- **Best-of views.** "Best of person X" (rating-weighted), "best of
  2024". Needs: sort modes only once ratings exist.

## Principle 5 — Honesty about the archive

Carry the MVP's honesty markers further:

- **Coverage surfacing.** Per-person and global: how many works are
  metadata-only (no bytes), how many threads have missing parts, what
  `verify` found. The viewer is where the owner would actually *see*
  archive rot. Needs: stats endpoints over existing data.
- **Deleted-upstream browsing.** A feed of works whose source posts died
  (`deleted=only` filter exists in B-2) — often the most valuable
  archived content. UI only.

## Principle 6 — Exit doors (other consumers)

- **Collections.** Named, ordered, hand-picked sets of media items /
  works. This is the designed bridge to **Mosaic**, the collage viewer
  (now its own project — `docs/plans/mosaic/`): a Mosaic pool can
  reference an Archivist collection by stable id + `/files/<sha256>`.
  Mosaic's MVP works without collections (its pools use filter queries
  and its own media lists), so this stays optional — Archivist must
  never know Mosaic exists (Mosaic Decision 1).
- **Export bundles.** A work/collection → folder or zip with originals +
  sidecars in the frozen naming convention (round-trips with the
  client's formats). Needs: API endpoint reusing `@twmd/core` sidecar
  serializers.
- **PWA / offline shell.** The viewer as installable PWA with cached
  thumbs for browsing while the NAS is reachable but slow. Deliberately
  late — cosmetic until the library is big.

## Sequencing instinct (to be overridden by the V-6 retro)

Triage mode → collections (unblocks the collage app) → crosspost
detection → resurfacing feeds → merge tooling → the rest.
