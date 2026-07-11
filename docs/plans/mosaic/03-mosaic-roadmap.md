# Mosaic — Roadmap (ideation, NOT scoped work)

Post-MVP directions, priced so future scoping is fast. Re-prioritized by
the D-6 owner retro before anything becomes a plan.

## Video export (the "maybe" the owner flagged, Decision 10)

Render a dashboard run to a single video file. Feasible offline, no
realtime capture needed:

- A run is fully described by layout rects + each cell's entry timeline;
  random cells are reproducible from the P-3 decision log (already
  recorded in MVP for exactly this reason).
- Renderer: drive ffmpeg — per-cell concat/trim chains composited with
  `xstack`/`overlay` at the target resolution/duration. CPU-bound and
  slow-but-fine as a background job; no UI beyond pick-run → progress →
  file.
- Cost: moderate (ffmpeg filter-graph assembly + edge cases: images,
  mixed fps/AR, very long runs). Decide after the wall *feels* right;
  the alternative "just screen-record it" (OBS) costs us nothing and may
  satisfy.

## Playback & performance

- **Proxy transcodes** for high-count walls: pre-shrunk 540/720p H.264
  copies cached alongside originals (generated locally by Mosaic,
  ffmpeg; Archivist stays untouched per Decision 1), used when cell
  size is small — decode cost tracks display size, not source size.
  This is the first lever if P-0 passes at 10 cells but the owner wants
  20.
- **Stagger/schedule starts** to smooth decoder spikes on dashboard
  open.
- **Multi-monitor**: window-per-display running distinct dashboards, or
  one spanning canvas — owner input needed on which he actually wants.

## Content & modes

- **Local-folder source** for pools/playlists (media not in Archivist) —
  cheap: the cache/resolve layer already deals in files; add a
  `local_path` media reference kind with its own hashing.
- **Weighted random**: bias draws by Archivist rating / recency /
  least-recently-shown-in-Mosaic (needs a tiny local shown-history —
  Mosaic-side only).
- **Constraint mixes** per random cell: "80% pool A, 20% pool B",
  time-of-day pools, no-two-cells-same-file-simultaneously (global draw
  coordinator).
- **Archivist collections as a pool source** once Archivist grows them
  (`archivist/05` Principle 6) — the designed third `source.kind`;
  Mosaic keeps working if they never happen.
- **Playlist sync back**: intentionally NOT planned — Decision 1 keeps
  the arrow one-way; curation belongs in Archivist's own frontend.

## Sessions & feel

- **Scenes/schedules**: rotate dashboards on a timer or hotkeys
  (1..9 = saved dashboards).
- **Ambient polish**: fade/cut transition choice per cell, Ken Burns for
  long-displayed stills, clock/blank cells as first-class cell kinds.
- **Screensaver-ish idle launch** (Windows: launch-on-idle rather than a
  real .scr — real screensavers constrain the runtime brutally).

## Platform

- **macOS** second platform: Flutter + media_kit keeps this mostly a
  build-and-QA exercise; revisit after Windows MVP settles.
- **Packaging/updates**: MSIX or plain installer + manual updates;
  single-user app, keep it boring.
