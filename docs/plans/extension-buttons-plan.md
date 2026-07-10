# Extension Buttons — Plan

Two phases. The premise (owner-corrected 2026-07-09): the legacy code
already injects working download buttons on most surfaces — only a couple
of pages are missing them. So phase 1 is small and additive; the real body
of work is phase 2, a rewrite of ALL buttons onto the shared resources.

## Phase 1 — Add buttons to the missing surfaces (partially blocked)

**Blocked on owner details:** which surfaces exactly are missing. Believed
to be the media-viewer overlays (`/<user>/status/<id>/photo/<n>` and the
immersive video view) — the legacy scan only looks inside `primaryColumn`
and the viewer renders in `#layers` — but do not assume; get the list from
the owner first.

Starting material already in the repo (behind
`localStorage.twmd_experimental_buttons = '1'`, inert otherwise):

- `extension/content/dom-selectors.js` — candidate selector lists per
  surface. **Every CSS selector in it is UNVERIFIED against the live
  DOM** (written without a browser). The URL-based tweet-id extractors are
  tested and trusted.
- `extension/content/ui-buttons.js` — injection skeleton: debounced
  MutationObserver batch scan, `data-twmd` dedupe marker, history/popstate
  SPA hooks, re-entrancy-guarded button that re-reads the viewer URL at
  click time (a viewer button always saves ALL media of the post; the
  `/photo/<n>` index only identifies the tweet).

Work: owner names the surfaces → verify/fix the selectors against live
x.com (the owner can probe candidates from any Chrome's console, no
extension install needed) → inject on those surfaces → owner walkthrough.

## Phase 2 — Rewrite ALL buttons onto shared resources

Every download button in every location (the existing legacy ones
included) should go through the same shared machinery instead of the
legacy per-button logic in `src/js/main_react.user.js` (which still
attempts dead API endpoints before DOM-scraping, has no sidecars, and
duplicates naming/URL logic):

- Data: `TweetCache.get(id)` (capture layer) — DOM extraction only as the
  documented fallback, never an API call.
- Save: `saveTweet(id, {sidecar})` from `extension/content/save.js`
  (standalone) and `appClient.sendArchive(record, 'button')` (service
  connected) — both already wired in `extension/content/index.js`; the
  `__twmdDebug.save/.archive` handlers show the exact calls.
- Injection: one framework (`ui-buttons.js`), one selectors module
  (`dom-selectors.js`), one dedupe marker. Button states: idle →
  in-progress → success flash / error, small toast instead of `alert()`.

The legacy button code is NOT deleted in this phase — it's disabled once
the replacement is verified live, and removed later by
`cleanup-plan.md` (Decision 10).

## Phase 3 — Options page (small, after phase 2)

Move the console-only settings into the extension options page:
pairing token + service host/port (currently `localStorage.twmd_app_token`
/ `twmd_app_host` / `twmd_app_port`), sidecar format (txt default / json /
both / none), per-surface button toggles if wanted. Localized en/ja like
the existing options.

## Owner input needed before/while executing

1. The list of surfaces currently missing buttons (phase 1 gate).
2. Live-DOM verification of `dom-selectors.js` candidates (console
   probing is enough; paste results back).
3. A walkthrough per surface after injection (`docs/VERIFICATION.md`
   covers the save-path checks).
