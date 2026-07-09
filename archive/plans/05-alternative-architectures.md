# Plan 05 — Alternative Architectures for "Browser Internals" Access & Disk Writing

The user asked: can newer browser APIs (or a different app shape, e.g. a desktop app driving the browser) get post data and save files to disk **without additional network requests**? Short answer: **yes — and the recommended MV3 design (plans 02/04) already achieves it for all metadata/text**, because passive interception *is* zero-additional-requests. The remaining question is media **bytes**: the page usually loads images at reduced size (`name=small/medium/large`) and video as HLS segments, so "capture what the browser already downloaded" gives you *displayed* quality for free, while **original** quality inherently costs one plain GET per file no matter the architecture. Every option below is evaluated against that reality.

## Option A — MV3 extension: passive capture + `chrome.downloads` ✅ RECOMMENDED (= plans 02–04)

- **Additional requests:** zero for text/metadata; one parity-identical GET per media file (needed for orig quality).
- **Disk:** `Downloads/twMediaDownloader/<user>/…` subfolders only. No arbitrary paths — acceptable for this product.
- **Effort/risk:** lowest; everything stays in one deliverable, store-distributable, Firefox-portable.

## Option B — A + File System Access API (direct-to-folder saving)

`window.showDirectoryPicker()` is available to the content-script/page context on Chrome (user gesture required). Persist the `FileSystemDirectoryHandle` in extension IndexedDB; `queryPermission()/requestPermission()` re-arms it per session (Chrome's persistent-permission prompt for sites makes this smoother in current Chrome).

- Lets the user pick **any folder** (e.g. their archive drive), writes media+sidecar directly, no Downloads-bar spam, real subdirectory layouts.
- Chromium-only (Firefox/Safari don't ship the picker); keep Option A as the fallback path. Failure modes: permission expiry, handle invalidation after folder moves.
- **Verdict: ship as an optional "save to folder" mode after A works.** Small, additive module (`save-fsa.js`).

## Option C — A + `chrome.debugger` (CDP inside the extension): true zero-request media capture

An extension with the `"debugger"` permission can attach CDP to its own tab and use `Network.enable` + `Network.getResponseBody` to read the **bytes the page already downloaded** — including images and video segments — with genuinely zero additional requests.

- Costs: Chrome shows a persistent "…is debugging this browser" infobar (users hate it); bodies are evicted quickly so you must capture eagerly; video arrives as fMP4/HLS segments that need reassembly (doable: concatenate matching init+media segments, or remux — but that's real work); images captured are the size the page requested, i.e. **not orig**.
- **Verdict: not worth it for this product.** Its only unique win (media bytes with zero requests) delivers *worse quality* than one parity GET. Document, don't build.

## Option D — A + Native Messaging desktop helper

`chrome.runtime.connectNative` to a small installed binary (Go/Rust; JSON-over-stdio). Extension stays the capture/UI brain; helper does disk work.

- Unlocks: arbitrary paths, dedupe against an on-disk library (hash DB), ffmpeg remux (if C-style segment capture is ever wanted), embedding metadata into files (EXIF/XMP), post-processing.
- Costs: per-OS installer + signed binary + host-manifest registration; two artifacts to version; support burden. **Verdict: only if this grows into an "archiver" product. Spec'd here as the sanctioned path to full disk access; don't build in v1.**

## Option E — Standalone desktop app driving a real browser via CDP (no extension)

The "different-shaped app" the user asked about. Spec:

- **Shape:** desktop app (Tauri/Electron shell, or headless CLI) that launches/attaches to the user's Chrome with `--remote-debugging-port` (or `--remote-debugging-pipe`), using Playwright/puppeteer-core *attach* mode against the user's real profile so the real login session is used.
- **Capture:** identical in spirit to plan 02 — subscribe to `Network.responseReceived` for `/i/api/graphql/*`, pull bodies via `Network.getResponseBody`, normalize with the *same* `graphql-normalize.js` (share the module!), build the same tweet cache, write media+sidecars anywhere on disk with full filesystem freedom. Bulk = drive scrolling via `Input.dispatchMouseEvent`/`Runtime.evaluate` — again the page's own pagination.
- **Is it valid? Yes, technically sound**, and it's how several archiving tools work. Zero forged API requests, full disk access, no store review.
- **Why it's still not the recommendation:**
  - UX: user must run a second app and a specially-launched browser; the in-page download button (the actual daily-use feature, plan 03) would have to be injected via `Runtime.evaluate` — rebuilding a worse extension inside CDP.
  - Fragility: profile-attach with debugging enabled fights Chrome's increasing lockdown of the debugging port (remote-debugging on the default profile is restricted in recent Chrome; needs a dedicated profile dir → separate login session).
  - Same media-quality math as C: orig quality still needs its own GET.
- **Verdict:** valid to build *later* as a bulk-archiver companion that reuses the extension's normalize/cache/filename modules (a strong argument for keeping those modules pure and dependency-free, plan 01). Not the vehicle for the interactive feature set.

## Decision matrix

| | Extra API reqs | Extra media reqs | Orig quality | Save anywhere | UX friction | Maint. risk |
|---|---|---|---|---|---|---|
| **A: MV3 + downloads** | 0 | 1 GET/file (parity) | ✅ | Downloads subfolders | none | low |
| **B: + File System Access** | 0 | same | ✅ | ✅ user-picked folder | one picker prompt | low (Chromium-only) |
| C: + chrome.debugger | 0 | 0 | ❌ displayed size | Downloads | debug infobar | high |
| D: + native host | 0 | same as A | ✅ | ✅ full | installer | medium |
| E: CDP desktop app | 0 | same as A | ✅ | ✅ full | launch ritual, no in-page UI | medium-high |

~~**Recommendation: A now, B as fast-follow, D/E only if the product grows into a full archiver; C never.**~~

**Superseded by owner decisions (2026-07-07, see 00-overview Decisions Log): A now, then plan 06
(the D+E hybrid: local companion app over a localhost WebSocket) as the target end-state. B is
deprioritized — the app covers arbitrary-path saving. C stays never. Distribution is
self-distributed/unpacked, personal use only (Decision 11) — no store-review constraints on
permissions; optimize for fast local iteration.**
