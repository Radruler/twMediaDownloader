# Mosaic — Overview: Decisions & Work Plan

**Status:** 2026-07-11 initial design from the owner's braindump. Working
name **Mosaic** (owner asked for a proposal — specific but not
hyper-specific; rename is a find/replace away if he prefers another).
Plans live in this repo for now; the project itself is a **separate
codebase from Archivist and the Archivist Client** and will likely get
its own repo when implementation starts.

## What Mosaic is

A native, media-forward **collage viewer** for Windows 10: a full-screen
(or large-window) dashboard of cells, where every cell plays its own
playlist of media simultaneously and independently — 5–10 cells of mixed
video segments and timed images, all running at once. Think "wall of
living picture frames" over the owner's archive.

```
┌─────────────────────────── Mosaic (Windows app) ──────────────────────────┐
│  Dashboard "evening wall"                                                 │
│  ┌────────────┬──────────────────┐   cell = playlist of entries:          │
│  │ cell A     │ cell B           │    - video segment (file, 5s–10s)      │
│  │ (random:   │ (playlist:       │    - image (20s)                       │
│  │  favorites)│  hand-ordered)   │    - video segment (same file, 35–55s) │
│  ├────────────┤                  │   entries advance per cell,            │
│  │ cell C     │                  │   all cells play concurrently          │
│  └────────────┴──────────────────┘                                        │
│         │ read-only HTTP (LAN) + local sha256 media cache                 │
└─────────┼──────────────────────────────────────────────────────────────--┘
          ▼
   Archivist API  (/api/posts /api/media/:id /files/:sha256 /thumbs/:sha256)
```

## Decisions (binding for the Mosaic workstream; owner-confirmable)

1. **Strictly a consumer. Archivist never knows Mosaic exists.** Mosaic
   uses only Archivist's public read API (the plan-B contract: stable
   `media_id`s, immutable content-addressed `/files/:sha256`) plus its
   own local state. No Mosaic-specific endpoints, tables, or flags may be
   added to Archivist. "Kept in sync" is achieved by *addressing*, not
   coupling: sha256 is the durable reference, so nothing Archivist does
   internally (re-layout, re-ingest) can break a Mosaic dashboard.
2. **Local media cache, offline-first playback.** The NAS is not on
   24/7; a wall of video cannot depend on it. Mosaic keeps a local disk
   cache keyed by sha256 (size-capped, LRU), prefetches pool content when
   Archivist is reachable, and plays entirely from cache otherwise.
   Missing/uncached media renders an honest placeholder — never a stall,
   never a silent skip.
3. **The unit of content is the entry, not the file.**
   An entry is either an **image** (display duration, defaulting from
   dashboard config) or a **video segment** (`media` + `start_ms` +
   `end_ms`). The same file may appear any number of times as different
   entries (or in different cells). Playlists are ordered lists of
   entries; loop by default.
4. **Cells have two modes, mixable per dashboard:**
   *playlist* (hand-configured, ordered) and *random-within-constraints*
   (draws entries from a **pool**; no immediate repeats). A pool is a
   named content source: an Archivist filter query (favorites, rating≥N,
   tag, person — anything the works/posts API can express) or an
   explicit hand-picked media list. Pools are stored by Mosaic
   (Decision 1); if/when Archivist grows first-class collections
   (`archivist/05` roadmap), pools gain a third source type that
   references them.
5. **Layout is owner-designed, with an optimizer as a tool, not a boss.**
   Cells are freely sized/positioned (snap grid), any aspect ratio, goal
   of zero padding. Per-cell content fit: `cover` (crop) or `contain`
   (letterbox). An **Optimize** button suggests a re-pack of cell sizes
   from the aspect ratios of current content — one-shot, previewed,
   accept or tweak; it never runs behind the owner's back.
6. **Stack: Flutter + `media_kit` (libmpv), Windows-first.** Rationale:
   the hard requirement is many *simultaneous, precisely-seekable,
   hardware-decoded* players in one window — that is libmpv's home turf,
   and media_kit packages it for Flutter with a supported
   many-players-at-once pattern. Flutter gives the layout
   designer/dashboard UI cheaply and makes the "Mac later" door nearly
   free. Not browser/Electron (owner call: native performance for many
   concurrent files). Gate: Decision 7's spike. Fallbacks, in order, if
   the spike fails: Tauri/WebView2 (web `<video>` stack), C# WinUI 3 +
   Media Foundation.
7. **P-0 spike gates everything.** Before any real code: a throwaway
   Flutter/media_kit app playing 10 concurrent 1080p mp4 loops with
   segment seeking on the owner's actual Windows 10 machine. Measured,
   not assumed (CPU/GPU %, dropped frames, RAM). The stack decision is
   only final when the spike passes on target hardware.
8. **Audio is opt-in.** Ten simultaneous soundtracks is noise: global
   mute is the default state; a cell can be *solo'd* (exactly one audible
   cell at a time). Nothing else in MVP.
9. **Dashboards are files.** Named dashboards (layout + cells + pools +
   settings) persist as versioned JSON in the app data dir — trivially
   backed up, diffed, and hand-edited. No database in Mosaic; the only
   bulky local state is the media cache (disposable by definition).
10. **Video export (stitched dashboard → video file) is roadmap, not
    MVP.** It's feasible offline (ffmpeg compositing; random cells need a
    recorded decision log to be reproducible) but it's meaningful effort
    and the owner is lukewarm — decide after the MVP *feels* right.
    Sketched in `03-mosaic-roadmap.md` so the MVP doesn't design it out
    (the decision-log hook is cheap to keep).

## Work, in sequence

| # | Work | Plan | Status / gate |
|---|---|---|---|
| P-0 | **Playback spike** on owner's hardware | `01-playback-core-plan.md` §P-0 | first; gates the stack |
| P | **Playback core** — engine, entries/segments, Archivist client, cache | `01-playback-core-plan.md` | after P-0 |
| D | **Dashboard MVP** — layout designer, playlist/pool editors, runtime, persistence | `02-dashboard-mvp-plan.md` | after P |
| — | Roadmap — export, proxies, more sources/modes, Mac | `03-mosaic-roadmap.md` | ideation |

Archivist plan B (API + `/files`) must exist before P's Archivist client
is testable end-to-end, but P can develop against fixture files first —
the spike and engine need no Archivist at all.

## Open items for the owner (talk-over list)

1. The name — **Mosaic** is a proposal.
2. Decision 6/7 — comfortable with Flutter+libmpv pending the spike, or
   a preference among the fallbacks?
3. Audio policy (Decision 8) — global-mute + one solo cell enough for
   MVP?
4. Export priority (Decision 10) — confirm roadmap-not-MVP.
5. Target display(s): single monitor? multi-monitor spanning is a
   roadmap item unless it's actually day-one.
