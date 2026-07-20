# Archive Library — Legacy Archive Import

## Objective

Bring years of existing media and sidecars under library management without
guessing their structure, modifying source files, duplicating bytes
unnecessarily, or manufacturing provider metadata that was never captured.

The importer is a staged reconciliation system, not a one-shot recursive copy.
It separates discovery, parsing, planning, review, and commit so new historical
layouts can be added safely after real examples are available.

## Known and unknown inputs

Known from the repository and owner description:

- many files follow the frozen Twitter naming family:
  `<screen_name>-<tweet_id>-<YYYYMMDD_hhmmss>-{img|gif|vid}<N>.<ext>`;
- some have `.txt` and/or versioned `.json` sidecars;
- tweet ID, timestamp, media kind, and position are often recoverable from the
  basename;
- current library records may later enrich an imported stub with full captured
  data;
- other old directory/sidecar structures exist but have not been provided.

Unknown until sample collection:

- every root/subdirectory convention and whether directories imply source
  account, run, query, or date;
- legacy filename deviations, duplicate suffixes, and Windows sanitization
  history;
- exact sidecar generations/encodings/newline formats;
- whether files were renamed, edited, recompressed, or copied across trees;
- timezone meaning of basename timestamps;
- whether author IDs, original URLs, favorites/bookmarks, or tags exist in
  old metadata;
- collision/duplicate prevalence and whether hardlinks already exist;
- desired physical policy for archives currently on versus off the NAS.

No plan should invent answers. The framework can be implemented now; concrete
format adapters beyond the repository's verified current convention require
sample fixtures and an owner-reviewed mapping report.

## Safety invariants

1. Source roots are opened read-only from the application's perspective. The
   importer never renames, deletes, rewrites, timestamps, chmods, or embeds
   metadata into source files.
2. Scan and commit are separate commands/actions. A scan cannot mutate
   canonical content/media/curation tables.
3. Every planned entry has a stable source identity and idempotency record.
   Rerunning the same batch creates no duplicate objects or byte copies.
4. Ambiguous files remain unresolved; they are not silently assigned to a
   current handle/account.
5. Hash equality proves byte equality only, not that two provider media assets
   are semantically the same.
6. Filename/sidecar metadata is evidence with explicit confidence and
   provenance. It does not masquerade as live provider truth.
7. Any copy/hardlink/register action is explicitly chosen per import source or
   batch and previewed with byte counts.
8. Existing library curation is preserved. Import can add mapped curation only
   through a separately reviewed adapter rule.
9. Rollback removes relationships/objects created exclusively by a batch but
   never deletes a pre-existing/shared blob or a source file.
10. Paths in UI/API are source-relative/redacted; arbitrary server filesystem
    browsing is not exposed.

## End-to-end workflow

```mermaid
flowchart LR
    A["Read-only inventory"] --> B["Format adapters"]
    B --> C["Manifest + conflicts"]
    C --> D["Owner review"]
    D --> E["Idempotent commit"]
    E --> F["Verify + report"]
```

### Phase 0 — sample and specification

Collect a privacy-conscious fixture pack for each distinct layout:

- representative tree listing (relative paths, sizes, mtimes);
- 3–10 basename examples for photo/video/GIF/multi-media/sidecar;
- redacted sidecar examples preserving structure and encoding characteristics;
- examples of duplicate suffixes, collisions, damaged/partial files, and
  unknown extras;
- known ground truth for at least a few entries (tweet ID, author, media count,
  source URL if available);
- owner preference for register/copy/hardlink and whether source remains
  permanently mounted.

Write an adapter specification from those samples before parsing production
roots. Each parser fixture records expected extracted fields, confidence, and
warnings.

### Phase 1 — inventory

The scan walks configured roots and records into `import_entries`:

- source-relative normalized path and a path fingerprint;
- file type from extension and signature sniffing;
- size, mtime, inode/device when available, symlink status;
- candidate role (media, sidecar, unrelated, directory metadata, unknown);
- quick hash only if deliberately enabled; full SHA-256 occurs in a later
  bounded stage;
- scan errors/permission issues without aborting unrelated entries.

Rules:

- do not follow symlinks by default; if enabled, resolve and require the target
  to remain under an allowlisted source root;
- detect hardlink identity to avoid redundant reads while still retaining each
  relative entry;
- checkpoint large walks and expose progress/cancel;
- bound filesystem and hashing concurrency to protect NAS latency;
- treat hidden/temporary/system files through an explicit ignore policy and
  report ignored counts;
- never infer metadata solely from directory order.

The inventory can be resumed by batch ID. If source size/mtime changes between
scan and commit, re-hash/reclassify that entry or block it as stale.

### Phase 2 — adapter classification and grouping

Each format adapter receives source-relative path, safe file facts, and linked
sidecar candidates. It returns a proposal, never direct database writes:

```json
{
  "classification": "twitter_media",
  "confidence": "exact|strong|weak|unknown",
  "source": {
    "service": "twitter",
    "content_native_id": "123",
    "author_handle_observed": "old_name",
    "created_at_local_text": "20260704_210311",
    "timezone": null,
    "media_type": "photo",
    "position": 1
  },
  "sidecar": { "format": "twmd-json-v1", "parsed": {} },
  "warnings": [],
  "proposed_action": "register"
}
```

Adapter interface:

```js
{
  key,
  version,
  detect(entry, context),
  group(entries),
  parse(group, context),
  validate(proposal),
  reconcile(proposal, libraryLookup)
}
```

Initial adapters:

1. current frozen Twitter basename plus current `.txt`/`.json` sidecars;
2. generic media-only fallback that hashes/registers bytes as unresolved import
   assets without inventing a Twitter item;
3. additional legacy adapters only after Phase 0 fixtures.

### Phase 3 — hashing and reconciliation

Full SHA-256 is mandatory before a file becomes a verified blob. Stream rather
than load into memory. For each proposal:

1. find an existing blob by hash;
2. find a captured/imported item by service + native content ID;
3. find a media asset by provider media key if sidecar supplies one;
4. otherwise compare item/version/position/type only as a candidate, not proof;
5. reconcile account using native account ID, captured item author, approved
   historical handle map, or unresolved placeholder—in that order;
6. identify sidecar/current record conflicts field by field;
7. calculate physical action and required/free bytes;
8. generate a deterministic proposed object/link set.

Possible classifications:

- `exact_existing`: blob and semantic media relationship already exist;
- `attach_existing_blob`: bytes exist, new semantic relationship/provenance;
- `attach_to_captured_item`: new blob maps confidently to existing item/asset;
- `create_stub_item`: provider ID known but live metadata absent;
- `create_unresolved_asset`: bytes valid, semantic/provider identity unknown;
- `conflict`: evidence disagrees or multiple targets plausible;
- `invalid`: unreadable, unsupported, hash/signature failure;
- `ignored`: explicit policy.

Do not collapse distinct legacy copies with different bytes under one media
asset without an owner rule. They may be provider variants, edits, or local
modifications. Preserve each blob and flag preferred/original confidence.

### Phase 4 — manifest

Produce a machine-readable JSONL manifest plus a concise Markdown/JSON summary:

- source/batch/adapter versions and configuration;
- inventory and byte totals;
- counts/bytes by classification and proposed physical action;
- exact duplicates, semantic attaches, stubs, unresolved, conflicts, invalid,
  ignored, and stale entries;
- account/handle mappings with confidence;
- sidecar parse versions and warnings;
- collision list (same logical alias, different hash; same claimed media,
  different bytes; same provider ID, conflicting author);
- destination capacity estimate;
- deterministic manifest hash.

The owner reviews this artifact before commit. The server records the approved
manifest hash; commit refuses if input facts or adapter version/config changed.

### Phase 5 — commit

Supported physical policies:

- **register in place:** retain source path as the blob storage path; requires
  the source root to remain mounted/readable and included in backup;
- **copy managed:** stream/verify into the managed original root, leaving
  source untouched;
- **hardlink managed:** only on the same filesystem, explicitly allowed, and
  verified after creation; source deletion later could affect link-count
  expectations but not bytes while a link remains;
- **reflink managed:** optional filesystem capability, verified and treated as
  managed storage;
- **metadata only:** create stub/provider metadata without registering bytes
  only when sidecar data itself is useful.

Commit processes small groups transactionally:

1. revalidate source facts/hash as required;
2. perform/verify atomic managed-file promotion if copying;
3. insert/reuse blob;
4. insert/reuse stub item/version/account/media with import provenance;
5. attach media-blob/alias/sidecar relationships;
6. record `import_entry` resulting IDs and outcome;
7. commit and continue.

A batch can be resumed. An already committed entry verifies its recorded
source identity/hash and returns its prior result. Errors do not roll back the
entire multi-terabyte batch, but the summary makes partial completion explicit.

### Phase 6 — verification and reconciliation queue

After commit:

- verify every new managed/register-in-place blob is readable and hash-correct;
- run foreign-key/integrity checks and compare committed counts to manifest;
- generate unresolved/conflict work queues in the UI;
- rebuild affected search/cover projections;
- sample compatibility aliases/sidecars without rewriting originals;
- record batch completion/partial/error state and a durable report.

Later live capture of a stub's service/native ID enriches the same item/account
and retains import provenance, archived blob links, and curation.

## Stub semantics

A filename-only Twitter stub may safely know:

- service and native content/version ID;
- approximate/encoded creation timestamp with timezone confidence;
- observed filename handle (not account identity proof);
- media position/type/extension and verified bytes;
- import source/batch/path provenance.

It must not invent:

- author native account ID;
- post text, language, counts, relationships, sensitive flag;
- source liked/bookmarked state;
- deleted/account status;
- exact original URL or claim of original-quality bytes;
- a person/alias link.

Represent missing values as null/unknown and expose `import_stub` provenance.
When live data arrives, generic provider upsert fills provider-owned fields and
links native IDs while leaving blob/import/curation data intact.

## Timestamp and filename ambiguity

The frozen name uses local time but may not encode a timezone. Store:

- raw timestamp text;
- parsed local components;
- timezone/offset when known from source configuration or sidecar;
- UTC time only when conversion confidence is sufficient;
- confidence and parser version.

Do not silently assume the server's current timezone for files created years
ago on another device. The import source can declare a timezone after the
owner verifies it, and the manifest must show the conversion policy.

Filename parsing should work from structural anchors on the right (media
suffix, tweet ID/timestamp patterns) rather than naïvely splitting a handle
that may contain delimiters or sanitized text. Exact current-format tests must
round-trip through `@twmd/core` helpers where possible.

## Sidecar handling

- Detect encoding/BOM and parse without rewriting.
- Preserve original sidecar as a catalogued import artifact with hash.
- Treat `.json` version/schema explicitly; unknown JSON is not coerced into the
  current contract.
- Parse `.txt` only according to a fixture-verified layout. Free-form lines and
  multiline tweet text make heuristic field extraction risky.
- A sidecar value conflicting with a captured canonical record becomes
  evidence/conflict; it does not overwrite silently.
- Generating a new canonical sidecar is a later export action with a separate
  path/hash, never an in-place conversion.
- Tags/ratings from a future old sidecar format import only through explicit
  owner-approved field mapping into curation tables.

## Collision policies

- Same hash, different paths: one blob, multiple import entries/aliases.
- Same planned alias, same hash: reuse/record both provenance entries.
- Same planned alias, different hash: no overwrite; conflict requiring a
  deterministic alternate alias or owner choice.
- Same Twitter ID/position, different hash: retain both blob candidates, mark
  provenance/quality ambiguity, select preferred only with evidence.
- Same hash claimed by unrelated media assets: link both; hash does not merge
  semantic assets.
- Handle maps to multiple native accounts over time: unresolved unless item or
  sidecar account ID disambiguates.
- Source file changes after scan: mark stale and require rescan; never commit
  the old manifest entry against new bytes.

## Operator/UI commands

CLI first, UI after correctness:

```text
import source add --label ... --root ... --adapter ... --mode register|copy
import scan <source-id> [--resume]
import manifest <batch-id> --output ...
import commit <batch-id> --manifest-sha ... [--yes]
import verify <batch-id>
import rollback <batch-id> --dry-run [--yes]
```

Every destructive-looking command is dry-run by default. `rollback` never
touches source files and previews which batch-exclusive managed copies could
become unreferenced; blob garbage collection remains separate.

The web Imports route can later show summaries, conflicts, approvals, and
progress, but it must call the same application use cases rather than
reimplement parsing/reconciliation.

## Performance plan

- inventory metadata quickly before deciding what needs full hashing;
- cache hashes keyed by stable source identity plus size/mtime, while
  revalidating before commit;
- bounded sequential or low-parallel reads for spinning disks;
- resumable checkpoints and job leases;
- WAL transactions in small batches; no transaction spans a file hash/copy;
- backpressure when DB/job queues or destination free space are constrained;
- report throughput/ETA without logging private full paths at normal level.

## Test matrix

- exact current filename parser across hostile/sanitized handles and each media
  type/position;
- multi-media grouping and sidecar association;
- duplicate suffixes and filenames with extra hyphens/dots;
- UTF-8/BOM/legacy encoding, CRLF/LF, malformed/truncated sidecars;
- symlink escape, permission denied, disappearing/changing file;
- hardlinks, zero-byte files, extension/signature mismatch, very large video;
- same hash/multiple assets and same claimed asset/different hashes;
- register, copy, interrupted copy, resume, and no-extra-copy idempotency;
- stub enrichment by later live TweetRecord;
- unknown timezone and configured historical timezone;
- ambiguous handle/account mapping remains unresolved;
- commit manifest hash mismatch/refusal;
- rollback preserves shared/pre-existing blobs and all source files.

At least one scrubbed real fixture per historical layout is required before
that adapter can run outside dry-run/experimental mode.

## Owner decisions required when samples are available

1. Which roots/layouts exist and which are authoritative versus duplicate
   backups?
2. Will each source remain permanently mounted, or must bytes be copied into
   managed storage?
3. What timezone(s) generated filename timestamps?
4. Are any local modifications/re-encodes expected?
5. Which sidecar generations contain trustworthy text/account/source URLs or
   curation?
6. How should unresolved media appear in the library before it maps to a post?
7. Is preserving the old directory browse view important enough to
   materialize hardlink/reflink aliases?

These questions gate adapter approval, not the rest of the remote library.
