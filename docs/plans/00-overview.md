# Archivist Client (twMediaDownloader) — Overview: Decisions & Remaining Work

**Status:** 2026-07-10 consolidation. Everything here is current and binding;
each remaining piece of work has its own plan doc sized for a fresh session.
Completed work is described in `ARCHITECTURE.md`; superseded plans are in
`archive/` and must not be treated as instructions.

## What this project is

Archivist Client is a ground-up rebuild of the (defunct)
twMediaDownloader extension into a personal, passive X/Twitter archiving
producer with two parts:

1. **Extension** (Chrome, unpacked): a MAIN-world interceptor observes the
   page's *own* GraphQL responses and normalizes every tweet the user
   scrolls past into an in-memory `TweetRecord` cache. A save layer can
   write any cached tweet's media + a metadata sidecar to `Downloads/` via
   `chrome.downloads`, standalone.
2. **Content manager** (Node service, `app/`): receives every captured
   tweet over a local WebSocket, keeps a SQLite library of everything seen,
   archives explicitly-selected posts to local disk — original-quality
   media + sidecars, deduped by content hash — and exposes a small
   operator CLI for status, manual requeue/archive, purge, and verify.

The extension works fully standalone; the service *upgrades* it, never
gates it.

## Decisions (binding — overrides everything else in docs/)

1. **No request to `x.com`/`api.x.com` from any code in this project,
   ever.** The browser's own traffic is the only API data source. Media
   fetches are plain GETs to `pbs.twimg.com`/`video.twimg.com` only,
   indistinguishable from normal browsing: no custom headers from the
   extension; the service uses only observed browser header shapes and
   never cookies. Nothing polls X for anything (deletion/edit detection is
   passive capture only).
2. **This iteration builds a downloader, not a browser.** The content
   manager's job is to fetch the right information and store it well —
   local files on the device, plus the SQLite library. No content-browsing
   UI, no Electron, no media server. Future apps/components will build on
   this data; the service must therefore be **standalone-complete for
   downloading/archiving** and keep its data (schema, files, sidecars)
   stable and documented for those future consumers.
3. **One consolidated service.** No split into relay + manager. Designed
   service-shaped so deployment options stay open: bind host/port and all
   paths configurable, runnable in Docker (devcontainer already does).
4. **The bulk-download feature is removed for now.** The legacy
   API-driven bulk is dead with the API. What replaces it (if anything) is
   future ideation only — not scoped work. The archived content-manager
   plan has the last captured notes.
5. **TypeScript only inside `packages/core`**; extension and app code are
   plain JS. All shared logic (TweetRecord contract, normalization,
   filenames, sidecars, media-URL selection) lives in core — never
   reimplemented elsewhere.
6. **Filename convention is frozen** (users have years of archives):
   `<screen_name>-<tweet_id>-<YYYYMMDD_hhmmss>-{img|gif|vid}<N>.<ext>`,
   sidecars `<same stem>.txt`/`.json` (txt on by default). Per-tweet saves
   are individual files. Standalone saves go to
   `Downloads/twMediaDownloader/<screen_name>/`.
7. **Download buttons grab ALL media in a post** (no "current item"
   mode), and sensitive-media interstitials are ignored. No open-in-tabs
   mode.
8. **Edited tweets** are one logical post (keyed by `edit_control` initial
   id) with one version row per edit. **Deleted posts** stay in the
   library flagged deleted (detected passively via tombstones/404s).
   **Retention is infinite**; purge is a manual tool. No thumbnail store.
9. **Chrome-first, self-distributed, unpacked** (`dist/`). Firefox
   best-effort later.
10. **Legacy `src/` code stays untouched** until the rebuilt paths are
    verified in a live browser (see `docs/VERIFICATION.md`); cleanup is
    its own later job (`cleanup-plan.md`).
11. **Nothing may hammer X.** Low-volume, human-shaped traffic only:
    service downloads run ≤2 concurrent with 500–1500 ms jittered gaps and
    never auto-retry failed archives later. ToS risk is acknowledged by
    the owner; the passive posture is the mitigation.

## Remaining work, in sequence

Each item is a self-contained plan a fresh session can execute. Order
reflects the owner's priorities.

| # | Work | Plan | Status / gate |
|---|---|---|---|
| 1 | **Live verification** — first real-Chrome run of capture, standalone save, service pairing | `docs/VERIFICATION.md` (walkthrough) | owner-driven; blocks cleanup |
| 2 | **Extension buttons** — add buttons to the few missing surfaces (details from owner pending), then rewrite ALL buttons onto the shared save path | `extension-buttons-plan.md` | phase 1 partially blocked on owner details |
| 3 | **Cleanup** — delete dead legacy code, write CLAUDE.md, final README refresh | `cleanup-plan.md` | blocked on 1 (and 2 for button code) |
| 4 | **Archivist Client** — rename, viewer-relation capture, push export to Archivist | `archivist-client-plan.md` | rename/§C ready; §D after Archivist plan A/B |
| 5 | **Security hardening** — audit findings S1–S8 (localStorage token, WS Origin, empty-token guard, path/header hardening) | `security-hardening-plan.md` | S1–S3 gate any non-localhost/NAS deployment; S4–S8 doable now |

Recently completed and archived: content-manager queue restart resume,
service-shaped config/deployment docs, extension-side service host
override, and the operator CLI were completed in commit `f6125d8`; the
completed plan now lives at `archive/plans/content-manager-plan.md`.

Deferred future idea, not active scoped work: legacy archive import from
old filename-convention folders.

## Related workstream: Archivist (2026-07-11)

The future-components ideation above is now a designed sibling project:
**Archivist**, the service-agnostic library service (NAS-deployed) that
ingests this system's archived output and serves frontends. This repo's
extension+content-manager pipeline is the **Archivist Client** in that
design. Plans live in `docs/plans/archivist/` (own overview, own binding
decisions). The archiver-side work for that workstream — the Archivist
Client rename, viewer-relation capture, opportunistic push export — is
its own plan, `archivist-client-plan.md` (row 4 above), and is bound by
THIS doc's decisions and ground rules as well: passive capture only, no
new requests to any content service, ever.

## Ground rules for all work

- Read `ARCHITECTURE.md` before touching anything — it documents the
  contracts (TweetRecord, ws protocol, DB schema), the build, and the
  sharp edges (e.g. why new extension↔worker messaging must use ports).
- Every commit: `npm test && npm run typecheck && npm run build` green
  (in the devcontainer). Push after every green commit.
- X's DOM and GraphQL surface rotate: selectors live only in
  `extension/content/dom-selectors.js`, payload parsing only in
  `packages/core/src/graphql-normalize.ts`, both fixture/live-verified
  before trusting.
- Do not delete or rewrite the legacy README attribution; the project is
  MIT, originally by furyu.
