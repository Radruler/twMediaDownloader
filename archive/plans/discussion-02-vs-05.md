# Discussion — Plan 02 vs Plan 05: What's Actually Different?

Working notes comparing [02-network-capture.md](02-network-capture.md) and
[05-alternative-architectures.md](05-alternative-architectures.md). Branch exists so this
discussion can evolve alongside the plans without touching the reviewed plan set.

## Different kinds of documents

- **Plan 02 is an implementation design.** It commits to one answer for *how the data layer works*:
  patch `fetch`/XHR in the page's MAIN world, observe the GraphQL responses the page already
  makes, normalize into a tweet cache. It specs modules, envelope shapes, fallback ladder,
  acceptance criteria. You could hand it to an agent and get code back.
- **Plan 05 is a decision survey.** It asks *where should the capture-and-save machinery live* —
  inside an extension (A/B), behind the debugger protocol (C), split with a desktop helper (D),
  or in a standalone CDP-driving desktop app (E) — and scores the options. Its Option A **is**
  plans 02+03+04; the rest are roads deliberately not taken (yet).

So they are not competing designs. 05 justifies *why* 02 is the design; 02 is the winner's spec.

## The one technical axis where they genuinely overlap

Both revolve around the same core idea: **never forge API traffic; read what the browser already
fetched.** The difference is the observation mechanism:

| | Plan 02 (extension interceptor) | Plan 05 C/E (CDP: `chrome.debugger` / desktop app) |
|---|---|---|
| Vantage point | JS monkey-patch inside the page world | Chrome DevTools Protocol, outside the page |
| Sees GraphQL JSON | ✅ | ✅ |
| Sees **media bytes** the page loaded | ❌ (would need to re-GET) | ✅ (`Network.getResponseBody`) |
| Media quality captured | orig, via 1 parity GET per file | displayed size only (`name=medium/large`, HLS segments) |
| In-page UI (the daily-use buttons) | native — it's a content script | must be faked via `Runtime.evaluate` or lives outside the page |
| User friction | none | debug infobar (C) / launch ritual + second app (E) |
| Breakage surface | X's JS bundling (patch timing), CustomEvent bridge | Chrome's ongoing lockdown of remote debugging, protocol churn |

The seductive-sounding advantage of the CDP side — *zero* media requests instead of *one per
file* — is a trap: the page loads downsized images and fragmented video, so zero-request capture
means **worse output quality plus a remux pipeline**. One plain, header-free GET for `name=orig`
(indistinguishable from "open image in new tab") is the cheaper *and* better trade. That single
observation is what collapses 05's matrix in favor of Option A / plan 02.

## Where 05 still earns its keep

1. **Disk freedom.** Plan 02+04 can only write into `Downloads/…` subfolders. If real archive
   layouts on other drives matter, 05's Option B (File System Access API) is the cheap add-on,
   and D (native host) is the full-freedom path. Neither changes plan 02's capture design at all.
2. **Reuse contract.** 05's Option E is viable *because* plan 01/02 keep `graphql-normalize.js`
   and the cache pure and dependency-free — a future desktop archiver reuses them verbatim over a
   CDP transport. That's a design constraint 05 imposes back onto 02's implementation.
3. **A recorded "no".** Option C (`chrome.debugger`) is documented as rejected so future agents
   don't rediscover and build it.

## Open questions (to resolve in this discussion)

- Is Downloads-folder-only saving acceptable for v1, or should Option B ship alongside plan 04?
- Does the user want the bulk archiver to eventually be a desktop tool (E/D), which would argue
  for TypeScript-ifying the shared normalize/cache modules earlier than plan 01 suggests?
- Firefox priority? (Option B is Chromium-only; plan 02's MAIN-world injection has a Firefox
  fallback but needs testing.)
