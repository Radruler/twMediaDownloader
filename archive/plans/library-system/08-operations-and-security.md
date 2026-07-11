# Archive Library — Operations, Security, Backup, and Recovery

## Operating stance

This is a private single-owner archive, but it contains sensitive browsing,
relationship, identity, and media history. "Only on my LAN" reduces exposure;
it does not justify plaintext long-lived tokens, arbitrary URL fetches, weak
file serving, or untested backups.

The first supported deployment is one server instance. High availability is
not a goal. Recoverability, integrity, and clear failure reporting are.

## Deployment contract

### Persistent roots

Keep these independently configurable:

- `config_root`: configuration, credential hashes/keys, instance ID;
- `db_path`: SQLite file on a local filesystem;
- `original_root`: verified archive blobs and/or registered legacy roots;
- `export_root`: compatibility aliases and generated sidecars if physically
  materialized;
- `preview_root`: disposable generated preview cache;
- `scratch_root`: same-filesystem temporary downloads when atomic promotion is
  needed;
- `backup_root`: application-created SQLite backups/manifests before external
  replication/snapshots.

The server validates on startup that roots exist or can be created, have the
expected ownership, are not accidentally nested in unsafe ways, and have
enough free space for configured thresholds. It reports filesystem/device IDs
so atomic rename/hardlink expectations are explicit.

SQLite, WAL, and SHM must be on a filesystem local to the server process. Media
can be on a NAS dataset directly mounted into that server/container. Do not run
SQLite over SMB/NFS.

### Container shape

Provide one supported Compose example after the server HTTP work exists:

- pinned Node/runtime image or repo-built app image;
- non-root UID/GID matching storage permissions;
- read-only container root filesystem where practical;
- writable mounts only for the declared persistent/scratch roots;
- health check against an internal liveness endpoint;
- restart policy for crashes/reboots, not a tight loop on migration/config
  failure;
- resource limits/observability for memory, CPU, PIDs, and open files;
- application port exposed only to the reverse-proxy/private network;
- no Docker socket, host network, privileged mode, or broad host mounts.

The current devcontainer remains the development/test story; do not confuse it
with the hardened deployment image.

### Native service alternative

Also document a systemd-style Node service for hosts where containers make
filesystem access harder. It uses a dedicated unprivileged account,
`UMask=0077` or deliberate group access, explicit writable paths, restart
limits, and the same reverse proxy. Feature behavior and migrations must not
depend on Docker.

## Network and TLS

Use one HTTPS origin. The reverse proxy:

- terminates TLS with a trusted private/public certificate;
- forwards HTTP and WebSocket upgrades;
- preserves streaming/range responses without buffering entire originals;
- applies sane request/header/time limits while permitting long video streams;
- redirects HTTP to HTTPS or does not bind HTTP at all;
- supplies a fixed, validated client IP/header chain only when configured;
- does not expose database/archive directories as static roots.

The Node server binds loopback or an internal container address. Binding to
`0.0.0.0` is an explicit deployment setting and still requires auth.

Recommended access choices:

1. private LAN DNS + internal CA certificate;
2. Tailscale/WireGuard DNS + HTTPS/Serve/reverse proxy;
3. public ingress only with deliberate firewall, patching, monitoring, and
   stronger login protection.

The extension accepts `wss://` remote endpoints. It rejects plaintext remote
WebSocket by default. Certificate validation is never disabled in production.

## Authentication and secret handling

- Generate instance, owner-session signing/encryption, device, and API token
  material with cryptographic randomness.
- Store token verifiers as strong keyed hashes or purpose-suitable password
  hashes; never store recoverable device/API token plaintext.
- Store owner password with a memory-hard password hash when password auth is
  used.
- Config/secret files are owner-readable only and excluded from normal logs,
  diagnostics, and source control.
- Display API/device tokens once at creation; rotation issues a new token and
  revokes the old one.
- Pairing codes are one-time, short-lived, rate-limited, and scoped to device
  enrollment only.
- Sessions and tokens carry explicit creation, last-used, expiry/revocation,
  label, and scope metadata.
- A reverse-proxy-auth mode must list trusted proxy addresses and exact header
  behavior; ignore forwarded identity from other sources.
- No auth bypass based solely on `Host`, LAN IP, or loopback proxy headers.

The extension keeps device secrets in background-only storage, never x.com
localStorage/page DOM. If `chrome.storage.local` is used, restrict its access
level to trusted extension contexts; background-owned IndexedDB is the fallback
when content scripts need a differently exposed storage area. Normal
diagnostics redact IDs/tokens sufficiently to be shareable after the owner
reviews content.

## Browser and API security

- Same-origin bundled UI by default; CORS disabled unless an explicit client
  origin is configured.
- If CORS is enabled, allow exact origins/methods/headers—never wildcard with
  credentials.
- Validate WebSocket `Origin` against extension origins/approved clients in
  addition to token authentication.
- Strict CSP: same-origin scripts/connect/media, no inline/eval in production,
  no third-party analytics/fonts.
- Owner cookie is Secure/HttpOnly/SameSite=Strict; mutations have CSRF defense
  and origin checks.
- JSON/body/frame/query/list limits are enforced before expensive work.
- Login, pairing, token issuance, imports, and expensive searches are
  rate-limited.
- Every SQL value is bound; FTS/search grammar is parsed/escaped.
- Every UI string is text by default; source/sidecar text is never trusted HTML.
- Destructive operations use dry-run impact previews and confirmation tokens
  bound to operation parameters and expiry.

## Media download and SSRF security

Captured media URLs are attacker-influenced input even when they normally come
from Twitter. The server must:

- route every URL through a provider adapter;
- require HTTPS and an exact allowlisted hostname/port/path policy;
- resolve/follow redirects manually, revalidating every hop;
- cap redirects, DNS/connect/header/body-idle/total time, and response bytes;
- never forward cookies, authorization, CSRF tokens, arbitrary observed
  headers, or internal service credentials;
- reject loopback, private/link-local/metadata IP destinations even if a future
  adapter permits broader host patterns; prefer exact hosts;
- validate content signature/type before final promotion;
- stream to a temp file with quota and abort handling;
- log only safe normalized host/error codes;
- optionally apply container/firewall egress allowlists as an additional layer.

Twitter's hard rule remains: no request to `x.com`/`api.x.com`; only approved
media CDN requests from explicit archive work.

## File-serving security

- Map opaque media IDs through database rows; never concatenate user path
  parameters into filesystem paths.
- Normalize and verify any stored relative path remains within its configured
  root after resolution.
- Do not follow aliases/symlinks outside registered roots. Prefer opening by a
  verified canonical path and compare filesystem facts when necessary.
- Sanitize response filenames separately from lookup paths.
- Enforce media-read auth before opening a file and before honoring ranges.
- Limit concurrent streams and abort on disconnect.
- Send `nosniff` and safe content types; attachments that could execute in a
  browser should download rather than render inline unless explicitly safe.
- Preview workers decode untrusted historical media with library/process limits;
  consider isolated subprocess/container boundaries for `ffmpeg`.

## Database operation

Startup sequence:

1. acquire a single-instance lock for the configured database;
2. open SQLite with foreign keys, WAL, busy timeout, and explicit synchronous
   policy appropriate to durability;
3. inspect schema version and refuse newer/unknown versions;
4. run migrations under the migration/backup rules;
5. reclaim expired job leases;
6. validate configured roots and token/key material;
7. start internal workers, then declare readiness.

Use short transactions, prepared statements, and one intentional write queue
where application concurrency would otherwise generate busy storms. Checkpoint
WAL on a measured schedule and before controlled backup/shutdown, not on every
request. Run `PRAGMA optimize`/`ANALYZE` as maintenance based on changes.

Liveness means the event loop responds. Readiness additionally means DB open,
schema current, required roots readable/writable, and no migration/restore
lock. Do not claim readiness merely because the port is listening.

## Backup strategy

### What must be backed up

Required:

- application-created consistent SQLite backup (not an arbitrary copy of a
  live WAL database);
- verified originals/registered legacy roots;
- sidecar exports/compatibility aliases that are not trivially rebuildable;
- config needed to locate storage and restore instance behavior;
- authentication/token metadata and cryptographic keys, protected as secrets;
- import manifests/reports and migration reports.

Optional/rebuildable:

- preview cache;
- scratch/temp files;
- transient logs beyond the chosen audit/diagnostic retention;
- FTS/derived projections if rebuild tooling is tested (though normally they
  remain inside the DB backup).

### Consistent backup procedure

For a basic filesystem backup:

1. ask the application to enter a short backup barrier: stop claiming new
   write-heavy jobs and finish/park file promotion transactions;
2. create a SQLite online backup using the database API into `backup_root`;
3. run integrity/foreign-key checks on the backup copy;
4. write a backup manifest containing schema/app version, DB hash/size, original
   root identity, latest job/import IDs, and timestamp;
5. release the barrier;
6. snapshot/replicate the SQLite backup, manifest, config secrets, and original
   datasets using NAS/ZFS/backup tooling;
7. record successful off-host/offsite completion separately.

If database and originals share an atomic ZFS snapshot boundary, still prefer
an online SQLite backup file inside that snapshot. It avoids restore surprises
around WAL state and provides a portable DB artifact.

Copying `library.sqlite3` alone while live is not the supported backup method.

### Retention and offsite

Use a 3-2-1 posture appropriate to the archive's value:

- local snapshots for fast accidental-deletion/migration rollback;
- a second device/backup target with versioned retention;
- encrypted offsite copy for box/site loss.

Database/config backups are small and frequent (for example daily plus before
every migration/import commit). Original-media replication can be continuous
or scheduled based on volume. Preview cache is excluded. Define retention in
deployment docs rather than silently deleting old backups.

Encryption at rest is supplied by NAS/disk/backup tooling unless the owner
chooses application-level encryption later. Offsite backups containing config
secrets and browsing metadata must be encrypted with recoverable, separately
stored keys.

## Restore procedure and drills

Restore is a documented, tested workflow:

1. install the target app version matching the backup manifest;
2. restore originals/registered roots and config/key material with correct
   ownership but keep server network ingress closed;
3. restore the SQLite online-backup artifact as the live DB;
4. run integrity/foreign-key checks, migration compatibility check, and full or
   sampled blob verification;
5. rebuild derived previews/search projection if needed;
6. start in read-only recovery mode and inspect counts, items, curation,
   identities, jobs, and a media sample;
7. resolve/park jobs whose source temp files or leases no longer apply;
8. enable normal workers and ingress only after validation;
9. rotate public/device/API secrets if backup exposure is suspected.

Perform a clean-host restore drill before declaring the archive safe, then at
least periodically and after material storage/migration changes. A backup that
has never been restored is unproven.

## Integrity maintenance

Extend the current `verify` command into layers:

- `db`: `quick_check`/`integrity_check`, foreign keys, schema invariants;
- `files --sample`: scheduled rotating sample of blob existence/size/hash;
- `files --full`: explicit full rehash with progress/resume and NAS-friendly
  concurrency;
- `aliases`: materialized alias/sidecar existence and hash;
- `previews`: optionally validate or simply evict/rebuild;
- `imports <batch>`: compare committed results to manifest.

Store last verification time/result per blob. Missing/mismatch marks health
state and raises an alert; it does not delete the row or overwrite the expected
hash. Repair is explicit from a known backup/source or a re-download job if
allowed and still available.

## Observability

### Structured logs

JSON or consistently structured text with:

- timestamp, level, component, event code, request/job/batch/device ID;
- route/status/duration/bytes, job transitions, migrations, backup/verify;
- normalized host and error class for media fetches;
- token/session/device admin actions without token contents;
- configurable levels and rotation supplied by container/system manager.

Do not log post text, search queries, sidecar contents, filesystem absolute
paths, header values, tokens, cookies, or raw provider payloads at normal
levels. A time-bounded debug mode must state its privacy cost.

### Metrics/status

Owner/admin-visible metrics:

- ingest accepted/duplicate/retry/rejected rates and latency;
- connected devices, last sync, oldest outbox event as reported;
- items/versions/media/blobs and bytes;
- job depth/age/outcomes by type/adapter;
- archive download bytes/rate/error classes;
- preview hit/miss/job rate;
- DB WAL/size/write latency/busy count;
- filesystem free space and configured thresholds;
- backup/verify last success and age.

Expose detailed metrics only on an authenticated/admin or internal endpoint.
Liveness/readiness endpoints reveal minimal information.

### Alerts

At minimum surface in the web UI/activity status:

- no successful backup beyond threshold;
- DB integrity/foreign-key failure;
- original root unavailable/read-only/low space;
- repeated job failure or oldest queue age beyond threshold;
- device delivery pressure/drop reports;
- missing/mismatched blobs;
- migration required/failed or server in read-only mode;
- clock skew large enough to confuse leases/observations.

External notification integration is future work; the status model should make
it possible without parsing logs.

## Upgrade and migration operations

- Pin dependency/runtime versions and commit lockfiles.
- Build/test an image/artifact before replacing the running instance.
- Create verified SQLite backup and storage manifest before every schema
  migration.
- Migrations are ordered, checksummed, transactional where SQLite permits, and
  refuse partial/unknown state.
- Do not automatically apply a large data rewrite at container boot without a
  documented maintenance step/progress path.
- Keep the prior application artifact and DB backup for rollback. Code rollback
  is only valid while its schema compatibility is documented.
- Run post-migration invariant counts and a smoke UI/media/ingest test before
  resuming workers.
- Security dependency updates receive the same fixture/protocol/media tests as
  feature changes.

## Failure/recovery scenarios

| Failure | Expected behavior | Recovery |
|---|---|---|
| server/NAS offline | extension queues bounded events; UI unavailable | reconnect/resend idempotently |
| crash during download | temp/orphan only; job lease expires | cleanup temp, retry by policy/manual |
| crash after blob promotion | orphan scanner finds hash/path or transaction relation exists | reconcile without duplicate bytes |
| DB unavailable/corrupt | readiness fails; workers stop; no writes to files | restore verified DB, reconcile post-backup files |
| original root read-only/full | downloads fail safely before promotion; captures/curation may continue if DB healthy | free/repair storage, explicit retry |
| preview root lost | originals/library unaffected | rebuild lazily/batch |
| device token leaked | revoke one device; other clients unaffected | re-pair, inspect ingest receipts |
| owner/API token leaked | revoke sessions/token, rotate relevant key | audit safe last-used/action metadata |
| bad schema migration | server stays maintenance/read-only | restore pre-migration backup + prior app |
| source import disappears | registered-in-place blobs marked missing; managed copies unaffected | remount source or restore/copy |
| one post purged | shared blobs remain until no references | dry-run/refcount query, restore metadata backup if mistaken |

## Operational acceptance gate

Before daily reliance:

1. run the server through reboot/crash and recover queued ingest/jobs;
2. verify WSS remote extension pairing and token revocation;
3. prove no app path contacts source APIs or non-allowlisted media hosts;
4. fill/disable original storage in a test and observe safe failure;
5. take a backup during normal ingest, restore to a clean isolated instance,
   and compare counts/hashes/curation;
6. delete preview cache and rebuild representative images/video posters;
7. corrupt/move a test blob and see verify/UI alert without destructive repair;
8. execute a schema migration failure simulation and rollback;
9. confirm normal logs/diagnostic export contain no secrets/private content or
   absolute paths beyond the owner's chosen disclosure.
