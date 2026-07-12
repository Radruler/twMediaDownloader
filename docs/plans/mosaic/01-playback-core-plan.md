# Mosaic — Plan P: Playback Spike & Core Engine

The risk lives here: many concurrent, segment-precise, hardware-decoded
players. Prove it first (P-0), then build the engine that everything in
plan D drives. No dashboard UI in this plan — the deliverable is an
engine with a bare test harness.

Read `00-mosaic-overview.md` first — Decisions binding. New codebase
(likely its own repo when work starts; until then a `mosaic/` dir is
acceptable but must not entangle with the npm workspace).

## P-0 — The spike (gates the stack, Decision 7)

Throwaway Flutter + `media_kit` app, run on the owner's actual Windows 10
machine:

- 10 cells in a static grid, each an independent player looping a local
  1080p mp4; mixed frame rates; 2 cells doing tight segment loops
  (seek-heavy) and 1 cell alternating video→image→video on a timer.
- Measure: CPU %, GPU decode %, RAM, dropped frames (mpv stats), and the
  two failure smells: segment-boundary hiccups and player-recreation
  jank.
- Pass = smooth at 10 cells with headroom. Fail → repeat the same
  harness on fallback A (Tauri/WebView2, ten `<video>` elements) before
  any decision; record numbers in this doc either way.
- Keep the spike code in `spike/` — it is not the foundation, it is the
  evidence.

## P-1 — Domain model & dashboard file format

Plain-data classes + (de)serialization for the versioned dashboard JSON
(Decision 9). Shape (v1):

```jsonc
{
  "v": 1,
  "name": "evening wall",
  "settings": { "default_image_ms": 20000, "audio": "muted" },
  "pools": [
    { "id": "p1", "name": "favorites",
      "source": { "kind": "archivist_query",
                  "query": { "relation": "archivist:favorite", "has_media": 1 } } },
    { "id": "p2", "name": "handpicked",
      "source": { "kind": "media_list",
                  "items": [ { "media_id": 123, "sha256": "…" } ] } }
  ],
  "cells": [
    { "id": "c1", "rect": { "x": 0, "y": 0, "w": 0.4, "h": 0.6 },
      "fit": "cover",
      "mode": { "kind": "random", "pool": "p1",
                "video_segment_ms": [5000, 15000] },
      "playlist": null },
    { "id": "c2", "rect": { "x": 0.4, "y": 0, "w": 0.6, "h": 1.0 },
      "fit": "contain",
      "mode": { "kind": "playlist" },
      "playlist": [
        { "kind": "video", "media": { "media_id": 7, "sha256": "…" },
          "start_ms": 5000, "end_ms": 10000 },
        { "kind": "image", "media": { "media_id": 9, "sha256": "…" },
          "duration_ms": 20000 },
        { "kind": "video", "media": { "media_id": 7, "sha256": "…" },
          "start_ms": 35000, "end_ms": 55000 }
      ] }
  ]
}
```

Notes: rects are fractions of the canvas (resolution-independent); media
references always carry both `media_id` (for re-querying Archivist
metadata) and `sha256` (the durable byte address, Decision 1); the same
`sha256` appearing in many entries is the normal case (Decision 3).
Unknown fields are preserved on round-trip (forward compat).

## P-2 — Archivist client + media cache

- Thin read-only HTTP client: configured `base_url` + bearer token;
  `queryMedia(query)` (drives pools; paginates), `getMedia(id)`,
  `fetchFile(sha256)`, `fetchThumb(sha256, w)`. Every response is
  fixture-tested; no Archivist coupling beyond the public API
  (Decision 1).
- Cache (Decision 2): `<cache_dir>/<sha256>` files + a small JSON index
  (bytes, last_used); size-capped LRU eviction (default e.g. 20 GB,
  configurable); sha256-verified on write. `resolve(sha256)` → local
  path if cached; else enqueue fetch (bounded concurrency, e.g. 2) and
  report "not yet". **Playback never awaits the network** — an uncached
  entry is skipped in favor of the next cached one, with the placeholder
  only when a cell has nothing cached at all.
- Pool resolution: `refreshPool(pool)` runs the query, stores the media
  list snapshot in the dashboard's sidecar state (so random mode works
  offline from the last snapshot), and prefetches bytes LRU-warmly.
  Offline → snapshot untouched, no errors surfaced during playback.

## P-3 — Cell engine

Per cell, a `CellController` owning **two players** (active + preload,
alternating — segment/entry switches must be gapless):

- Entry lifecycle: video → open at `start_ms` (precise seek), play to
  `end_ms` (poll/position-stream guard), swap to preloaded next; image →
  texture display for `duration_ms` (dashboard default unless the entry
  overrides), preload next underneath.
- Playlist mode: ordered, looping. Random mode: draw next from the pool
  snapshot — no immediate repeat, uniform for MVP (weighting is
  roadmap); videos drawn as segments using the cell's
  `video_segment_ms` window (random in-file start, honest clamp on
  short files); a **decision log** (seed + drawn entries) is recorded
  per run — cheap now, required later by export (Decision 10).
- Controls surface (consumed by plan D): play/pause (cell + global),
  skip, solo-audio (Decision 8), reload.
- Failure honesty: decode error or missing cache → placeholder tile with
  reason, engine keeps going; a cell can never take down its neighbors.

## P-4 — Engine harness

A developer screen (not the real UI): load a dashboard JSON, run all
cells over the engine, overlay per-cell stats (entry, position, cache
state, dropped frames). This is the tool the owner uses to sanity-check
feel before plan D exists, and the regression rig thereafter.

## Tests

- Model: JSON round-trip incl. unknown-field preservation; rect/segment
  validation (end > start, clamping).
- Cache: hit/miss/evict/verify; corrupted file re-fetch; cap respected.
- Pool: query snapshot round-trip; offline refresh is a clean no-op.
- Engine (headless where possible, fake clock): playlist ordering and
  looping; same-file-many-segments; image timing incl. default vs
  override; random no-immediate-repeat and decision-log determinism
  given a seed; skip-uncached behavior.
- Playback correctness itself (gapless swaps, seek precision) is
  validated on the P-4 harness on real hardware — record findings in
  this doc.

## Implementer appendix (pinned choices)

- **Project scaffold:** `mosaic/` = `flutter create --platforms windows`
  output, package name `mosaic`. Dependencies: `media_kit`,
  `media_kit_video`, `media_kit_libs_windows_video`, `http`,
  `path_provider`, `crypto`; dev: `flutter_lints`. Nothing else without
  recording it here.
- **Source layout** (`mosaic/lib/src/`): `model/` (P-1: `dashboard.dart`,
  `cell.dart`, `entry.dart`, `pool.dart`, `media_ref.dart` +
  `json.dart` round-trip), `api/archivist_client.dart` (P-2),
  `cache/media_cache.dart` (P-2), `engine/` (P-3:
  `cell_controller.dart`, `random_draw.dart`, `decision_log.dart`,
  `player_port.dart`), `harness/` (P-4 screen). App entry
  `lib/main.dart` boots straight into the harness until plan D.
- **`PlayerPort`** is the seam that keeps everything testable on Linux:
  `open(path, {startMs})`, `play()`, `pause()`, `seek(ms)`,
  `positionStream`, `dispose()` — one implementation wraps
  `media_kit.Player`, one is a fake with a controllable clock. Cell
  logic depends only on the port; nothing outside `player_port_mpv.dart`
  imports media_kit.
- **Segment end enforcement:** subscribe to `positionStream`; on
  `position >= end_ms - 50ms`, swap to the preloaded player (already
  opened at the next entry's start and paused). Record measured swap
  gap in the harness overlay.
- **Config file:** `<app data>/mosaic/config.json` —
  `archivist_url`, `archivist_token`, `cache_dir`, `cache_max_bytes`
  (default 20 GiB), `default_image_ms` fallback (20000). App-data dir
  via `path_provider`; dashboards in `<app data>/mosaic/dashboards/
  <slug>.json`, pool snapshots in `…/snapshots/<pool id>.json`.
- **Archivist API:** consume exactly `docs/plans/archivist/API.md`
  (posts/media list + `/files`/`/thumbs` with `?token=`); pool
  `archivist_query` objects serialize the same param names as the API's
  query string. Record fixtures for tests from that doc's shapes, not
  from a live server.
- **Random draw:** seeded `Random`; state = (seed, draw index) in the
  decision log (`<app data>/mosaic/runs/<timestamp>.jsonl`, one line per
  drawn entry). No-immediate-repeat = reject-and-redraw against the
  previous entry's (sha256, start_ms).
