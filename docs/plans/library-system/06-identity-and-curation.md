# Archive Library — Identity and Curation Model

## Terminology

- **Owner:** the one human authorized to administer this deployed library.
- **Person:** a curated library identity representing a human, organization,
  character, or other owner-chosen grouping. One special person represents the
  owner as "me."
- **Account:** one provider identity, keyed by service plus immutable/native
  account ID. Handles are observations, not identity keys.
- **Viewer account:** an account linked to the owner and used to interpret
  viewer-relative source state such as liked/bookmarked.
- **Item:** one logical provider post/content object; provider edits are
  versions of the item.
- **Media asset:** one semantic image/video/GIF associated with a version.
- **Source relationship:** provider-observed state from a particular viewer
  account. It is read-only in this application.
- **Curation:** owner-authored rating, local favorite, tags, note, collection,
  or account-person link.

These concepts must stay separate even in a single-user app. Authentication
has one owner, but source data contains many accounts and may contain several
accounts controlled by that owner.

## Core decisions

1. Accounts are never keyed by handle. A rename updates the current projection
   and appends history; it does not create a new account or rewrite old source
   observations.
2. A person is an owner-curated grouping, not a provider fact. Capture never
   automatically links, unlinks, or merges people.
3. "Me" is a normal person record with `is_owner=1`, plus one or more linked
   viewer accounts. This avoids special-case queries and lets the same identity
   UI show the owner's cross-service accounts.
4. Provider deletion/suspension/unavailability is evidence-based and passive.
   "Not seen lately" is not deletion.
5. Twitter likes/bookmarks are keyed by viewer account and item. App-local
   favorite is one owner-curation value and never writes back.
6. Item and media curation are independent. The UI defaults to item-level
   edits and requires an explicit media target for media-level edits.
7. Curation attaches to stable internal item/media/account/person IDs and
   survives provider refresh, edit versions, handle changes, blob dedupe, and
   filesystem relocation.

## Account projection and observation history

### Incoming identity fields

The current `TweetRecord.user` contains provider ID, handle, and display name.
Extend provider capture additively as fixtures allow:

- profile description/bio;
- avatar/banner media references;
- provider account creation time;
- verified/type labels if useful and stable;
- explicit account availability/tombstone type;
- provider canonical/profile URL inputs;
- observation/source operation and capture time.

Every field is nullable. Missing fields in a tweet payload do not erase values
previously observed from a richer payload.

### Upsert algorithm

For `(service,native_account_id)`:

1. create/find the account;
2. normalize only for comparison (case rules per provider, empty-to-null,
   canonical URL shape); preserve original observed display values;
3. merge non-null current projection fields according to adapter evidence
   precedence;
4. compute a meaningful profile fingerprint over fields actually present and
   authoritative in this event;
5. if the event confirms the latest profile period, extend
   `last_confirmed_at`;
6. if it proves a changed handle/name/state, close/extend prior evidence and
   append a new profile period beginning at `observed_at`;
7. retain source snapshot/evidence reference;
8. update `last_seen_at` independently from profile change time.

Partial observations require care. A tweet payload containing handle/name but
no bio cannot prove that the bio became null. The adapter declares field
presence/evidence, rather than passing a flat object whose nulls overwrite
everything.

### History semantics

The library knows observation intervals, not exact provider mutation times.
Display language should be "first observed as @new on July 10" rather than
"renamed on July 10." If an account changes A → B → A, retain three contiguous
periods; do not collapse both A periods into one row.

Account current state may be:

- `active_observed`;
- `unavailable_observed` with evidence subtype (suspended, deleted, withheld,
  protected, unknown unavailable) when captured;
- `unknown` when evidence is insufficient.

Never mark an account deleted because one post was deleted, media returned
404, a handle search failed, or the account has not appeared recently.

## People and account aliasing

### Manual link flow

Linking an account to a person:

1. choose an existing person or create one;
2. preview account service/native ID, current and historical handles, existing
   active link, item/media counts, and whether it is a viewer account;
3. if already linked elsewhere, require explicit move confirmation;
4. close any old active `person_accounts` link and create the new link in one
   transaction;
5. record timestamp, owner action, and optional reason/note;
6. invalidate combined person query caches/projections.

Unlink closes the association; it does not delete the account, content,
curation, or old link history.

### Person merge/split

A merge is a batch relink into a surviving person after an impact preview. The
source person can be archived/tombstoned for undo/reference rather than
immediately deleted. A split is a set of account relinks. Item authorship does
not change; combined person views resolve through current account links.

Person notes/labels are owner data. A merge must define conflicts deliberately:

- choose/compose label and notes;
- union collections/tags only if person-level curation is later introduced;
- preserve link histories;
- keep an audit/undo record for the operation.

The MVP need not expose a one-click merge if link/move operations suffice, but
the data model must not make a later merge destructive.

### Alias suggestions (future)

Potential signals—matching profile links, explicit self-reference, stable
display names, imported mapping files—may produce candidates. Suggestions:

- include reason/evidence and confidence;
- never auto-link;
- never use shared avatar/display name alone as strong proof;
- can be dismissed without hiding the underlying accounts;
- remain entirely optional and out of the MVP milestone.

## Owner and viewer accounts

One active owner person exists. Accounts linked to that person are not
automatically viewer accounts; the owner explicitly marks which browser/source
accounts should interpret relationship flags.

For each viewer account store:

- service account link;
- owner-friendly label;
- active/inactive status;
- which capture devices/browser profiles claim to use it;
- last verified viewer identity observation;
- attribution mismatch/error state.

If the extension cannot prove the logged-in account, it may use an explicit
configured binding, but contradictory observed evidence pauses attribution.
Unattributed relationship observations remain repairable records rather than
being assigned to "me" generically.

## Source viewer relationships

### Three-valued state

For each `(viewer_account,item)`:

- `true`: positive/explicitly observed;
- `false`: explicitly observed false;
- `null`: unknown/not observed.

Store evidence type, source operation, observed time, and source snapshot. A
Likes/Bookmarks timeline can prove true membership for returned items, but the
absence of an item from any finite timeline response proves nothing. Only an
explicit false should clear a known true.

If the owner later likes/unlikes something directly on Twitter, passive
capture may update the library when a payload containing that state is seen.
The library never sends that action.

### History

Append viewer-state history only when known state changes or attribution is
repaired. Repeated identical observations update confirmation time. The UI
can initially expose current state and a compact "observed" timestamp; full
history is retained for future audit.

### Aggregation

Across owner accounts, filters must define quantifiers:

- `any`: at least one selected viewer account has true;
- `all`: every selected account is explicitly true;
- `none`: every selected account is explicitly false (unknown does not count);
- `unknown`: at least one selected account is unknown, optionally combined
  with stricter query controls.

The default "bookmarked by me" UX means `any` across active viewer accounts
and shows which accounts matched.

## Item/version identity

Twitter edited posts remain one logical item. Curation attaches to the logical
item by default, so a new edit does not lose rating/tags. Version-specific
provider text, entities, counts, and media membership remain accessible.

Media-level curation attaches to stable media asset identity. If a Twitter
edit removes an asset, the asset and its curation remain linked to the old
version and archive history. A new asset does not inherit removed asset
curation by position alone.

Retweets/reposts are distinct logical provider items related to the original
item. Decide presentation at query/UI time:

- account pages can include authored repost items;
- media grids may collapse to the underlying original media while retaining
  evidence of which account/repost led to capture;
- ratings/tags on a repost item do not silently become ratings/tags on the
  original item;
- a later explicit "also apply to original" action can exist if useful.

## Local curation semantics

### Rating

- nullable integer 1–5;
- one current value at item level and one at media level;
- optional change audit can retain old value/time;
- bulk rating overwrites only after a preview and explicit command;
- no automatic inheritance from item to media or vice versa.

### Local favorite

- separate item/media boolean;
- intended as a fast local shortlist;
- independent from tags, collections, rating, Twitter likes, and Twitter
  bookmarks;
- not reset by re-ingest or provider false relationship state.

### Tags

- normalized uniqueness (trim, Unicode normalization, case-folded comparison)
  with preserved display spelling;
- explicit item and media join tables with foreign keys;
- rename changes display/normalized name while retaining tag ID;
- merge previews counts and rewrites joins transactionally;
- deletion is blocked or previewed when in use;
- no hierarchy/synonyms in MVP. Those can be additive later.

### Notes

- plain text, nullable/empty semantics defined consistently;
- item and media notes independent;
- no provider writeback;
- included in owner-only search but visually distinguished from source text;
- optimistic concurrency prevents two open tabs from silently clobbering.

### Collections

- explicit, owner-curated ordered grouping;
- entries can target an item or individual media asset;
- entry may have its own collage/use note and position;
- an item/media can appear in multiple collections;
- saved filters are separate query presets, because materialized membership and
  dynamic query results have different expectations.

## Ingest/curation ownership matrix

| Field group | Capture may write | Worker/import may write | Owner UI may write |
|---|---:|---:|---:|
| provider item/version/account projection | yes | import with provenance | no |
| account profile observation history | yes | import with evidence | no |
| person/account links | no | proposed only | yes |
| viewer liked/bookmarked state | yes, with viewer evidence | import with provenance | repair attribution only |
| archive request/job state | archive intent only | yes | request/retry/cancel |
| blob/media relationships | no | yes | no |
| item/media rating/favorite/note | no | preserve only | yes |
| tags/collections | no | preserve/import only when explicitly mapped | yes |
| availability/deletion | evidence only | download/import evidence | repair/annotate, not falsify provider evidence |

Repository code should reflect this matrix: provider upsert functions should
not accept curation columns at all.

## Import reconciliation

Old filenames may contain a handle that no longer matches the account's
current name. Import treats filename handles as observed labels at the file's
timestamp/provenance, not immutable account keys.

Reconciliation order:

1. service + native account ID from sidecar if present;
2. service + native content ID already linked to a captured item, then use that
   item's author;
3. an owner-approved mapping from historical handle/time to account;
4. unresolved imported account placeholder scoped to service/source batch.

Never merge two account IDs because filenames share a handle. Never assign an
old handle-only file to the current holder of that handle without evidence.
The import manifest must make unresolved and ambiguous identity cases visible.

## API/UI acceptance scenarios

1. An account changes from `@old` to `@new`: one account remains, history shows
   two observed periods, existing item URLs/ratings/tags do not change.
2. Two Twitter accounts and one future-service account are manually linked to
   one person: combined grid includes all three and can toggle each one.
3. The owner links two of their own accounts to "me": a source bookmark on one
   and like on another are separately visible; local favorite is unchanged.
4. A Bookmarks timeline proves `true`; later unrelated capture omits the field:
   state remains true rather than becoming false.
5. An explicit false for the same verified viewer account creates a history
   transition and current false; no external request is sent.
6. A tweet edit changes text and removes one image: item-level rating survives,
   old version/media and media-level tags remain inspectable.
7. An account becomes unavailable in a captured tombstone: UI says when and
   why it was observed, without claiming an exact deletion time.
8. An imported handle-only archive cannot be uniquely mapped: files enter an
   unresolved account bucket and can be linked later without rehashing.
9. Replaying old capture events changes no curation rows and produces no
   duplicate person/account links.
