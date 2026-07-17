# Security Hardening — Plan

**Status:** 2026-07-16. Findings from a code audit of the extension↔app
WebSocket link, the Archivist HTTP service, ingest, and the downloader.
Read `00-overview.md` (Decisions are binding) and `ARCHITECTURE.md`
(Politeness/safety invariants) before touching anything here.

The codebase is already security-conscious: parameterized SQL everywhere,
sha256 verification before any bytes are stored, hex-validated route
params, a CDN host allowlist, and defense-in-depth credential-header
stripping. This plan closes the gaps that remain. Two audit findings were
**already fixed** in commit `bf367f7` and are recorded here only so agents
don't re-flag them:

- *Upload OOM* — `uploadFile` now streams to a temp file with an
  incremental hash (`archivist/src/server.js:483`), never buffering whole
  files in RAM. Done.
- *Validate-before-write* — `ingestPost` now calls `validateEnvelope`
  before writing any file, and rejects the reserved `archivist` service
  and unregistered services (`archivist/src/ingest.js:52`, `:322`). This
  narrows finding **S4** below but does not fully close it.

## How to use this plan

Each item **S1–S8** is self-contained and independently pickable. An agent
takes one item and runs its two phases:

- **Validate** — reproduce the issue against current code (a failing test,
  a curl/ws transcript, or a cited code path). If it no longer reproduces,
  record that in the item's checkbox and stop; do not "fix" a non-issue.
- **Implement** — make the change, add/extend a test that fails before and
  passes after, and satisfy the item's Acceptance criteria.

Verification for every item runs in the devcontainer, never host npm:

```sh
docker compose -f .devcontainer/docker-compose.yml run --rm app \
  sh -lc 'npm test && npm run typecheck && npm run build'
```

Ship each item as its own commit so regressions bisect cleanly. Items are
ordered by priority. **S1, S2, S3 gate any non-localhost / NAS deployment**
— they must land before the Archivist service or the app WebSocket is
reachable from anything but `127.0.0.1`. **S4–S8 are cheap to do now**
while the attack surfaces are still small.

Threat model in one line: the extension's content script shares an origin
(and `localStorage`) with `x.com`, and both local services listen on a host
port; so "any script on x.com" and "any web page in the browser" are the
adversaries to design against, plus a leaked/guessable API token once the
NAS service is remotely reachable.

---

## S1 — Move the pairing token and host out of page localStorage · **HIGH** · gates deploy

**Problem.** The content script reads the app pairing token and the
host/port override from page `localStorage`
(`extension/content/index.js:64-67`, keys `twmd_app_token`,
`twmd_app_host`, `twmd_app_port`; declared in
`extension/content/app-client.js:24-28`). The content script shares its
`localStorage` with the `x.com` page origin, so **any script running on
x.com — X's own code, or any XSS on the site — can read the token and
rewrite the host.** `normalizeAppHost` (`app-client.js:35-41`) blocks only
`*.x.com`, so an attacker can repoint the client at any *other* host and
receive the token plus the full capture stream over plaintext `ws://`.

**Validate.** In a page console on any origin, confirm
`localStorage.getItem('twmd_app_token')` returns the configured token, and
that setting `localStorage.twmd_app_host` to a non-x.com host changes the
connection target on reload.

**Implement.**
- Store token/host/port in `chrome.storage.local` (extension-private
  origin), not page `localStorage`. This is the storage the planned
  options page (`archivist-client-plan.md`) should read/write anyway —
  build that read path here even if the options UI lands later.
- Content script gets the values by messaging the background worker (which
  reads `chrome.storage`) over a `chrome.runtime.connect` **port** — never
  `chrome.runtime.sendMessage` (see `ARCHITECTURE.md` sharp-edge #1: legacy
  `background.js` answers unknown messages with `{result:'NG'}` and closes
  the channel). A `'twmd-config'` port mirrors the existing `'twmd-save'` /
  `'twmd-template'` patterns.
- Keep migration: on first run, if a legacy `localStorage.twmd_app_token`
  exists, copy it into `chrome.storage` **and delete it from
  `localStorage`** so it stops leaking.
- Require explicit opt-in for any non-`127.0.0.1` host: default host stays
  loopback; a remote host must be a distinct, deliberately-set key. The
  `*.x.com` refusal in `normalizeAppHost` stays.

**Acceptance.** No `twmd_app_*` value is ever read from or written to page
`localStorage`. A test drives the background config port and asserts the
token never appears in `window.localStorage`. The client still runs fully
standalone when no token is configured (invariant, `00-overview.md`).

---

## S2 — Enforce the WebSocket Origin on the app server · **HIGH** · gates deploy

**Problem.** `createAppServer` (`app/src/server.js:49-58`) accepts any
WebSocket upgrade; the pairing token is the only gate. Any web page open in
the browser can connect to `ws://127.0.0.1:8465`. Combined with S1 (a
token readable from x.com), an x.com-origin script gets full protocol
access: inject fabricated `seen`/`archive` records, trigger CDN downloads,
and poison `request_template` headers replayed to twimg.

**Validate.** From a browser page on an unrelated origin, open a WebSocket
to the app port and send a `hello`; confirm the server processes it (no
Origin rejection) — auth is the sole barrier.

**Implement.**
- In the `WebSocketServer` upgrade path, check the `Origin` header and
  accept only the extension's own origin (`chrome-extension://<id>`).
  Reject others with a close before `hello` is processed. Allow a
  configurable allowlist for headless/test clients (`scripts/fake-extension.mjs`
  and the protocol tests connect without a browser Origin — thread an
  `allowedOrigins`/`skipOriginCheck` option so tests still pass).
- The extension's own id is stable once packed; for unpacked dev, read it
  from the connecting client or make it configurable. Document the knob.

**Acceptance.** A connection with a foreign `Origin` is closed before any
frame is handled; a connection from the extension origin (or an explicitly
allowed test origin) still completes `hello`/`hello_ack`. Protocol tests in
`test/app-protocol.test.ts` still pass (extend them with an
Origin-rejection case).

---

## S3 — Refuse to start with a weak/empty API token · **HIGH** · gates deploy

**Problem.** `tokenMatches` hashes `String(value ?? '')` on both sides
(`archivist/src/server.js:53-59`), so if `api_token` is ever `""` in
`config.json`, an empty bearer token matches and **every `/api/`,
`/files/`, `/thumbs/` route opens with no credentials** — on a service
whose default `bind_host` is `0.0.0.0` (`archivist/src/config.js:14`,
deliberate per Plan A: "it's a NAS container; the container boundary is the
isolation"). The generated default token is random (good), but nothing
stops an operator from blanking it or the file from being hand-edited.

**Validate.** Set `api_token: ""` in the Archivist config and confirm
`GET /api/stats` with no `Authorization` header returns `200`.

**Implement.**
- At service startup (`archivist/src/main.js` / wherever `loadConfig`
  feeds `createArchivistServer`), refuse to bind if `api_token` is empty or
  shorter than the generated default (32 hex chars). Exit non-zero with a
  clear message telling the operator to set `ARCHIVIST_API_TOKEN` or let
  first-run generate one.
- Defense in depth in `tokenMatches`: treat an empty/absent *expected*
  token as "no match, always", independent of the startup guard.

**Acceptance.** The server process exits rather than serving unauthenticated
when `api_token` is empty/short. A test asserts an empty configured token
never authorizes a request. (The bearer-over-plain-HTTP and `?token=` in
media URLs concerns are tracked in **S7** as roadmap, not blockers.)

---

## S4 — Sanitize the `service` path segment in ingest storage · **MEDIUM**

**Problem.** `targetRelpath` builds a file path as
`path.join(envelope.service, screen, base)` (`archivist/src/ingest.js:243`).
`screen` and `base` go through `sanitizeForFilename`, but `envelope.service`
is joined raw. `bf367f7` narrowed this: `validateEnvelope` now runs before
any write and requires `envelope.service` to exist in the `services`
registry (seeded with only `twitter`/`archivist`, and `archivist` is
rejected), so a traversal value can't currently reach `storeFile`. But the
raw-join is one refactor or one added service row away from a remote
write-anywhere primitive, and defense-in-depth here is nearly free.

**Validate.** Confirm the registry gate holds: `POST /api/ingest/post`
with `service: "../../etc"` returns an error and writes nothing. Then note
that `targetRelpath` itself still trusts the segment.

**Implement.** Run `sanitizeForFilename` on the service segment inside
`targetRelpath` (and `placeStagedFile`), the same way author/basename are
sanitized. Add an assertion that the resolved `fullPath` stays under
`archiveRoot` (`path.resolve(fullPath).startsWith(path.resolve(archiveRoot) + path.sep)`)
as a belt-and-suspenders check before every `writeFile`/`rename`.

**Acceptance.** No path segment derived from an envelope reaches the
filesystem unsanitized; a unit test feeds a traversal-shaped service/basename
and asserts the write stays within `archiveRoot`.

---

## S5 — Browser-hardening headers on file serving and the HTML shell · **MEDIUM**

**Problem.** `serveFile` (`archivist/src/server.js:445-475`) sets
`content-type` from `files.mime`, now derived from an extension allowlist
(`mimeForBasename`, image/video only) — so no stored-XSS today. But there
is no `X-Content-Type-Options: nosniff`, so a browser may sniff bytes as
HTML; and once thumbnail generation or richer mime detection lands (Plan B/V),
any attacker-influenced `text/html` served on the authenticated origin
becomes stored XSS. The `/` HTML shell (`:529-532`) has no CSP, which the
Preact UI will need before it ships.

**Validate.** `curl -i` a `/files/<sha>` response and confirm no
`X-Content-Type-Options` header is present.

**Implement.**
- Add `X-Content-Type-Options: nosniff` to all `/files/` and `/thumbs/`
  responses (200, 206, and the 416 path).
- Add `Content-Security-Policy: sandbox; default-src 'none'` (or serve from
  a separate origin/port) on `/files/` and `/thumbs/` so served media can
  never execute as a document on the API origin.
- Add a baseline CSP to the `/` HTML shell now (`default-src 'self'`,
  no inline handlers) so the Preact UI inherits a safe default and the
  policy is not retrofitted under pressure later.

**Acceptance.** Every media response carries `nosniff` and a sandboxing CSP;
the HTML shell carries a restrictive CSP. A server test asserts the headers
on a `/files/<sha>` fetch.

---

## S6 — Constant-time token compare + resource limits on the app WebSocket · **MEDIUM**

**Problem.** The app server compares the pairing token with `!==`
(`app/src/server.js:101`) — a timing side channel, and inconsistent with the
Archivist server, which already uses the hash-then-`timingSafeEqual`
pattern. Separately, the `WebSocketServer` sets no `maxPayload`
(`app/src/server.js:58`) and never drops a socket that connects but never
sends a valid `hello`, so an unauthenticated peer can hold connections open
or send huge frames.

**Validate.** Point to the `!==` compare and the absence of `maxPayload` /
a hello timeout in `createAppServer`.

**Implement.**
- Reuse the Archivist `hashToken`/`timingSafeEqual` approach for the
  `hello` token check (lift a shared helper into `packages/core` if it
  keeps core dependency-free, or duplicate the tiny function — do not add a
  dependency).
- Set a `maxPayload` on the `WebSocketServer` sized to the largest legitimate
  frame (a `TweetRecord` archive frame; pick a generous but bounded cap).
- Drop any socket that hasn't sent a valid `hello` within a short timeout
  (e.g. 10s), mirroring the existing heartbeat's `terminate` handling.

**Acceptance.** Token comparison is constant-time; an oversized frame and an
idle-unauthenticated socket are both dropped. Protocol tests cover the hello
timeout.

---

## S7 — Transport & token-lifetime roadmap (Archivist remote access) · **LOW** · roadmap

**Not a code fix yet — a documented decision to make before remote NAS use.**
The Archivist API is a long-lived bearer token over plain HTTP, and media
URLs carry the token in the query string (`authToken` reads `?token=`,
`archivist/src/server.js:61-65`), which lands in browser history, proxy
logs, and `Referer`. Acceptable on a trusted home LAN; not for anything
reachable beyond it.

**Deliverable (docs, in `00-archivist-overview.md` or a new decision):**
- State the intended transport for remote access (reverse proxy with TLS is
  the expected answer; the service stays plain-HTTP behind it).
- Plan short-lived signed media URLs (HMAC over sha256 + expiry) so the
  long-lived token never rides in a URL. Capture as a follow-up work item
  under Plan B/V, not built here.

**Acceptance.** A written, referenced decision exists; no silent assumption
that plain-HTTP bearer auth is the final posture.

---

## S8 — Credential-header stripping: prefer an allowlist · **LOW**

**Problem.** Credential headers are dropped by the same regex blocklist in
three places (`app/src/server.js:35`, `app/src/downloader.js:29`,
`extension/background/request-template.js:25`:
`/cookie|authorization|auth[-_]?token|x-csrf/i`). Blocklists miss unknown
credential-bearing headers; the `request_template` only needs a small,
known set of headers for CDN fetches (UA, Accept, Accept-Language, Referer,
etc.).

**Validate.** Confirm all three sites share the blocklist regex and that
non-listed headers pass through into the replayed template.

**Implement.** Replace the blocklist with an **allowlist** of the headers
actually needed for a browser-shaped CDN GET, applied at capture
(`request-template.js`) and re-asserted at the downloader. Keep the
existing "never log header values" rule. Coordinate all three sites; a
single shared helper (core or a small app util) avoids drift.

**Acceptance.** Only allowlisted headers survive into a replayed CDN
request; a test feeds a template with an unexpected credential-shaped header
and asserts it is dropped. No change to the Decision-1 invariant (no custom
headers to x.com; CDN GETs stay browser-shaped, cookie-free).

---

## Out of scope / explicitly not findings

- **MAIN-world interception trusts page data.** The interceptor observes the
  page's own GraphQL and anything on the page can feed fabricated payloads.
  For a personal archive this is an integrity property, not a
  vulnerability; ingest already treats captured text as untrusted (validated,
  parameterized). No change.
- **SQL injection.** All queries use bound parameters; the dynamic
  `IN (...)` list in ingest uses placeholders. Verified clean.
- **Route param traversal on `/files/:sha256`.** The route regex pins a
  64-char hex sha and lower-cases it before any filesystem use. Safe.
