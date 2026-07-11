# Archivist — Plan V: Media Viewer MVP (universal post view)

The consumer-grade viewing frontend: bring together what a person has
posted across services and display it media-forward. Grows inside the
plan-B UI (Decision 16) against the same API. Exit criteria: the owner
browses real archived data through works/people/feeds, collapses threads,
credits people on media, and comes back with a friction list (V-5) that
feeds `05-media-viewer-roadmap.md`.

Requires plans A and B. Decisions 14 (linkage/threads), 15 (credits), 16
(same-process frontend) in `00-archivist-overview.md` are the design
ground for this plan. Client-plan §C improves the data (viewer flags,
`in_reply_to_user_id_str`, tagged users) but nothing here may *require*
it — every view must degrade gracefully on pre-§C records.

## The display model: works

The unit of display is the **work**, not the post: a root post plus its
collapsed self-reply chain (Decision 14), presented as

- **media**: all media items across the chain, in chain-then-position
  order, as one pager/gallery;
- **description**: the text of each part in order — a thread reads as one
  long description that didn't fit in one post. Each part keeps a subtle
  provenance marker (part index, timestamp, permalink out);
- **people**: author (persona-aware) + credits (Decision 15) — "by X ·
  featuring Y · commissioned by Z";
- **honesty markers**: "thread — 3 of 5 parts archived" when
  `reply_to_key`s point at posts we don't have; deleted-upstream badge;
  metadata-only media rendered as labeled placeholders, never hidden.

Replies to *other* people are never collapsed — a work is one author's
chain. Quotes render as a compact embedded reference when the quoted post
is archived, else as a permalink stub.

## V-1 — Works API

- `GET /api/works` — same filter surface as `/api/posts` (B-2) plus:
  `credited=<account_id>` / `credited_persona=<id>`, `role=<role>`
  (filter by credit role), `thread=collapse` semantics built in (posts
  that are non-root thread parts fold into their root's work; a part
  matching a filter surfaces its whole work). Cursor-paginated on the
  root post's `created_at_ms`.
- `GET /api/works/:post_id` — the full work for any post id (resolves to
  its thread root): parts in order, aggregated media, credits (stored +
  computed suggestions, each suggestion with provenance: `mention` /
  `tagged_user`), relations, tags.
- Implementation: SQL over `thread_key` (indexed) + a small assembly
  layer; no new tables. Suggestion computation reads `raw_json`
  (mentions, media tagged users when client §C-4 data exists).

## V-2 — Credits API (write) + roles

- `PUT /api/items/:kind/:id/credits` — declarative set:
  `[{account_id | new_account: {service, screen_name}, role}]`;
  `new_account` creates a stub account (sentinel id, plan A-2 note) and
  credits it in one call. Accepting a suggestion posts it with
  `source='accepted_suggestion'`.
- `GET /api/credit-roles`, `POST /api/credit-roles` (user-extensible
  registry, Decision 15).
- Mirror rule tests: ingest can't write credits; API can't write
  captured-service relations (existing rule, extended to credits).

## V-3 — Work view (UI)

The centerpiece screen. Media pager (originals via `/files`, native
`<video>`; preloads neighbors, nothing else), description column with the
stitched thread text and provenance markers, people row (author chip +
credit chips, persona-aware display honoring the persona⇄account toggle),
counts/date/service badge, curation strip (favorite, 1–5 stars, tags) —
all optimistic writes. Keyboard: `←/→` media, `j/k` next/previous work,
`f` favorite, `1–5` rate. Deep-linkable route per work.

## V-4 — Credits editor (UI)

In the work view: suggestion chips rendered from V-1's computed
suggestions with one-tap accept (choosing a role); manual add by
account/persona search or new-stub creation; per-media vs whole-post
scope toggle (default: whole post; media scope from the pager). Show
`~stub` accounts visibly distinct so unresolved identities are obvious.

## V-5 — Browse shell (UI)

- **Person page** (account or persona, toggle-aware): tabs **Posted**
  (authored works), **Featured in** (credited as subject/any role —
  this is the "picture of two people shows under both people" behavior),
  **Liked/Bookmarked** (captured relations, per owned account), with the
  plan-B filter bar throughout.
- **Feeds**: All, Favorites, Best (rating ≥ N), per-tag, Unfiled
  (archived but no tags/rating — the triage entry point), each just a
  works query with a name.
- Grid (plan B) remains the density view; clicking through lands on the
  work view; grid tiles for thread works show a part-count chip.
- URL-encoded state everywhere (shareable/bookmarkable views).

## V-6 — Owner walkthrough & retro

Extend `archivist/VERIFICATION.md` with a viewer checklist (thread
collapse correctness on real threads, credits round-trip, person-page
tabs, keyboard flow, honesty markers on partial threads). Then a
drawing-board session: friction list + feature gaps →
`05-media-viewer-roadmap.md` gets re-prioritized before any further
viewer work is scoped.

## Tests

- Works assembly: single post; in-order chain; child-first-ingested
  chain; chain with missing middle part (honesty count correct);
  other-author reply excluded; quote stub vs embedded.
- Filter matrix on `/api/works` including `credited`/`role` and the
  fold-into-root rule.
- Credits: declarative set semantics, stub creation, suggestion
  accept provenance, mirror-rule refusals.
- UI: query-building and works-model rendering component tests only;
  interaction correctness is V-6's live checklist.
