# Mosaic — Plan D: Dashboard MVP

The owner-facing app over the plan-P engine: design a dashboard, fill
cells, run the wall, save/load. Exit criteria: the owner designs a 5–10
cell dashboard mixing hand-built playlists and random-from-favorites
cells sourced from his real Archivist, runs it full-screen for an
evening, and it survives the NAS going to sleep.

Requires plan P (engine) and, for live sourcing, Archivist plan B.
`00-mosaic-overview.md` Decisions binding.

## D-1 — App shell & modes

One window, two top-level modes:

- **View mode** (default on open): the wall, chrome-free. Hover/keys
  reveal a minimal overlay: pause/play all, per-cell pause/skip/solo,
  dashboard switcher, edit-mode toggle, fullscreen (`F`/`F11`, `Esc`
  back). Multi-monitor: MVP targets one window on one display
  (roadmap: spanning/per-display dashboards — confirm with owner).
- **Edit mode**: the same canvas with designer affordances (D-2/D-3).
  Playback keeps running under the editor — layout tweaking is live,
  content edits apply on save.

Dashboards: named JSON files (P-1 format) in the app data dir; recent
list on launch; autosave-on-edit with explicit "save as".

## D-2 — Layout designer (Decision 5)

- Freeform rects on a snap grid (canvas fractions; e.g. 1/24 steps):
  drag to move, handles to resize, add/remove cell, z-order irrelevant
  (no overlap allowed — reject with a nudge, don't silently fix).
- Per-cell `fit`: cover (default, no padding) / contain.
- **Optimize button**: one-shot suggestion that re-packs cell rects to
  match the aspect ratios of each cell's *current/typical* content
  (playlist: median AR of entries; random: median AR of the pool
  snapshot) while minimizing whitespace and crop — greedy
  strip/treemap-style heuristic is enough, perfection is not the goal.
  Rendered as a preview overlay: accept, or dismiss and keep the
  hand-made layout untouched (never auto-applies).

## D-3 — Content editors

- **Playlist editor** (per cell): ordered entry list; add from the media
  picker (D-4); per-entry controls — image duration override; video
  segment with a scrub/trim strip (start/end handles over a filmstrip of
  thumbnails, numeric ms fields for precision); duplicate-entry button
  (the same-file-multiple-segments flow, Decision 3); reorder by drag;
  inline preview of a single entry.
- **Pool editor** (dashboard-level, cells reference pools): create/name
  pools; `archivist_query` kind built from the same filter vocabulary as
  Archivist's API (relation/favorite, rating≥N, tag, person, service,
  type) with a live result-count + thumbnail sample; `media_list` kind
  filled from the media picker. Refresh button per pool + refresh-all;
  shows snapshot age and cached-bytes coverage ("142/160 cached").
- **Random-cell config**: pool selector + `video_segment_ms` window +
  image duration; everything else is engine defaults.

## D-4 — Media picker (Archivist browser-lite)

A modal grid over Archivist's API: same filters as the pool editor,
thumbnails via `/thumbs`, multi-select, "add to playlist/pool". This is
deliberately a *picker*, not a viewer — no curation, no post detail
beyond a hover caption (author, date, duration). Offline: picker
restricted to cached-media browsing of existing pools (honest banner).

## D-5 — Runtime glue & resilience

- Start/stop all cells on dashboard open/switch; per-cell restart on
  edit apply.
- NAS sleep mid-run: pool refresh/prefetch quietly stops, playback
  continues from cache (engine already guarantees this — the MVP test is
  literally pulling the NAS's plug during an evening run).
- Config screen: Archivist URL + token (connection test), cache
  directory + size cap, default image duration.
- Update `sha256`-missing markers with a "re-fetch" action for when the
  NAS wakes.

## D-6 — Owner walkthrough & retro

Checklist doc in the Mosaic repo (mirrors the repo's VERIFICATION.md
style): design → fill → run → sleep-NAS → reopen next day → edit live.
Friction list feeds `03-mosaic-roadmap.md` re-prioritization, same ritual
as the Archivist viewer's V-6.

## Tests

- Layout: snap/no-overlap invariants; optimize is pure
  (same inputs → same suggestion) and never mutates without accept;
  round-trip through the dashboard file.
- Editors: playlist operations produce exactly the P-1 JSON shapes;
  segment validation surfaced in-UI (end>start, in-duration).
- Pool editor query-building against recorded Archivist fixtures.
- Runtime: dashboard switch tears down cleanly (no leaked players —
  assert via engine handles); edit-apply restarts only affected cells.
- Manual on target hardware: D-6 checklist is the real acceptance.
