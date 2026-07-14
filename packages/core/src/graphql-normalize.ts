/**
 * graphql-normalize — raw captured GraphQL payload -> TweetRecord[] + tombstones.
 *
 * THE one file that touches X's GraphQL field names (plan 02 §3). Pure
 * functions, no I/O, no globals. When X changes payload shape: drop a new
 * fixture into test/fixtures/graphql/ and fix this file until tests pass.
 *
 * Strategy: instead of hardcoding each operation's envelope path
 * (data.user.result.timeline_v2…, data.home.home_timeline_urt…, …), we walk
 * the whole payload looking for tweet result objects. This survives envelope
 * renames; only the tweet object shape itself matters here.
 */

import type {
  MediaRecord,
  MediaType,
  NormalizeResult,
  TombstoneEvent,
  TweetRecord,
  TweetUser,
  VideoVariant,
} from './tweet-record.ts';

type Json = Record<string, any>;

const TWEET_TYPENAMES = new Set(['Tweet', 'TweetWithVisibilityResults']);
const TOMBSTONE_TYPENAMES = new Set(['TweetTombstone', 'TweetUnavailable']);
const MEDIA_TYPES = new Set<string>(['photo', 'video', 'animated_gif']);
/** First tweet id minted by the snowflake scheme (2010-11); older ids carry no timestamp. */
const SNOWFLAKE_FIRST_ID = 29700859247n;
const SNOWFLAKE_EPOCH_MS = 1288834974657n;
const MAX_WALK_DEPTH = 64;

/**
 * Normalize one captured GraphQL response body.
 * @param payload  Parsed JSON of the response body.
 * @param sourceOp GraphQL operation name from the request URL.
 * @param capturedAtMs Capture timestamp (injectable for tests).
 */
export function normalizePayload(
  payload: unknown,
  sourceOp: string,
  capturedAtMs: number = Date.now(),
): NormalizeResult {
  const tweets = new Map<string, TweetRecord>();
  const tombstones: TombstoneEvent[] = [];

  walk(payload, null, 0);
  return { tweets: [...tweets.values()], tombstones };

  function walk(node: unknown, entryId: string | null, depth: number): void {
    if (node === null || typeof node !== 'object' || depth > MAX_WALK_DEPTH) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, entryId, depth + 1);
      return;
    }
    const obj = node as Json;
    if (typeof obj.entryId === 'string') entryId = obj.entryId;
    if (isTweetResult(obj)) {
      // processResult recurses into quoted/retweeted itself; stop walking so
      // nested tweets aren't emitted twice.
      processResult(obj, entryId);
      return;
    }
    for (const key of Object.keys(obj)) walk(obj[key], entryId, depth + 1);
  }

  /** Returns the tweet id it cached, or null. */
  function processResult(result: Json, entryId: string | null): string | null {
    const typename = result.__typename;
    if (typeof typename === 'string' && TOMBSTONE_TYPENAMES.has(typename)) {
      tombstones.push({
        tweet_id: tweetIdFromEntryId(entryId),
        entry_id: entryId,
        typename,
        text: asStringOrNull(result.tombstone?.text?.text),
        source_op: sourceOp,
        captured_at_ms: capturedAtMs,
      });
      return null;
    }
    return normalizeTweet(result);
  }

  function normalizeTweet(raw: Json): string | null {
    let result = raw;
    // TweetWithVisibilityResults wraps the real tweet in .tweet.
    if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) {
      result = result.tweet;
    }
    const legacy: Json = result.legacy ?? {};
    const idStr = asStringOrNull(result.rest_id) ?? asStringOrNull(legacy.id_str);
    if (!idStr) return null;

    // Nested tweets: cache them under their own ids, keep the relationship here.
    let retweetedId: string | null = null;
    const rtInner = legacy.retweeted_status_result?.result;
    if (rtInner && typeof rtInner === 'object') retweetedId = processResult(rtInner, null);
    let quotedInnerId: string | null = null;
    const quotedInner = result.quoted_status_result?.result;
    if (quotedInner && typeof quotedInner === 'object') {
      quotedInnerId = processResult(quotedInner, null);
    }

    const note = result.note_tweet?.note_tweet_results?.result;
    const noteText = asStringOrNull(note?.text);
    const usingNote = noteText !== null && noteText.length > 0;
    const entities: Json = (usingNote ? note.entity_set : legacy.entities) ?? {};

    const urls = (asArray(entities.urls) as Json[])
      .filter((u) => typeof u?.url === 'string')
      .map((u) => ({
        short: u.url as string,
        expanded: asStringOrNull(u.expanded_url) ?? (u.url as string),
      }));

    let text = usingNote ? noteText : asStringOrNull(legacy.full_text) ?? '';
    for (const u of urls) text = text.split(u.short).join(u.expanded);
    if (!usingNote) text = stripTrailingMediaLink(text, legacy);

    tweets.set(idStr, {
      id_str: idStr,
      created_at_ms: parseCreatedAt(legacy.created_at, idStr),
      lang: asStringOrNull(legacy.lang),
      user: normalizeUser(result),
      full_text: text,
      urls,
      hashtags: (asArray(entities.hashtags) as Json[])
        .map((h) => asStringOrNull(h?.text))
        .filter((t): t is string => t !== null),
      mentions: (asArray(entities.user_mentions) as Json[])
        .map((m) => asStringOrNull(m?.screen_name))
        .filter((s): s is string => s !== null),
      in_reply_to_status_id_str: asStringOrNull(legacy.in_reply_to_status_id_str),
      in_reply_to_user_id_str: asStringOrNull(legacy.in_reply_to_user_id_str),
      quoted_status_id_str: asStringOrNull(legacy.quoted_status_id_str) ?? quotedInnerId,
      retweeted_status_id_str: retweetedId,
      conversation_id_str: asStringOrNull(legacy.conversation_id_str),
      edit_initial_id_str: editInitialId(result),
      viewer: {
        liked: asBooleanOrNull(legacy.favorited),
        bookmarked: asBooleanOrNull(legacy.bookmarked),
      },
      counts: {
        replies: asNumber(legacy.reply_count),
        retweets: asNumber(legacy.retweet_count),
        likes: asNumber(legacy.favorite_count),
        quotes: asNumber(legacy.quote_count),
        bookmarks: asNumber(legacy.bookmark_count),
        views: parseViews(result.views),
      },
      is_sensitive: legacy.possibly_sensitive === true,
      media: normalizeMedia(result, legacy),
      source_op: sourceOp,
      captured_at_ms: capturedAtMs,
    });
    return idStr;
  }
}

/** X moved user screen_name/name between .legacy and .core across 2024/25 builds — read both. */
function normalizeUser(result: Json): TweetUser {
  const u = result.core?.user_results?.result;
  if (!u || typeof u !== 'object') return { id_str: null, screen_name: null, name: null };
  const core: Json = u.core ?? {};
  const legacy: Json = u.legacy ?? {};
  return {
    id_str: asStringOrNull(u.rest_id) ?? asStringOrNull(legacy.id_str),
    screen_name: asStringOrNull(core.screen_name) ?? asStringOrNull(legacy.screen_name),
    name: asStringOrNull(core.name) ?? asStringOrNull(legacy.name),
  };
}

function normalizeMedia(result: Json, legacy: Json): MediaRecord[] {
  let source: Json[] | null = null;
  const extended = asArray(legacy.extended_entities?.media) as Json[];
  const plain = asArray(legacy.entities?.media) as Json[];
  if (extended.length > 0) source = extended;
  else if (plain.length > 0) source = plain;
  else source = mediaFromUnifiedCard(result);

  const records: MediaRecord[] = [];
  for (const m of source ?? []) {
    if (!m || typeof m !== 'object' || !MEDIA_TYPES.has(m.type)) continue;
    const videoInfo: Json = m.video_info ?? {};
    records.push({
      type: m.type as MediaType,
      media_key: asStringOrNull(m.media_key),
      index: records.length + 1,
      image_url: asStringOrNull(m.media_url_https),
      alt_text: asStringOrNull(m.ext_alt_text),
      video_variants: (asArray(videoInfo.variants) as Json[])
        .filter((v) => typeof v?.url === 'string')
        .map(
          (v): VideoVariant => ({
            bitrate: typeof v.bitrate === 'number' ? v.bitrate : null,
            content_type: asStringOrNull(v.content_type) ?? '',
            url: v.url as string,
          }),
        ),
      width: asNumberOrNull(m.original_info?.width),
      height: asNumberOrNull(m.original_info?.height),
      duration_ms: asNumberOrNull(videoInfo.duration_millis),
      tagged_users: normalizeTaggedUsers(m),
    });
  }
  return records;
}

function normalizeTaggedUsers(media: Json): { id_str: string | null; screen_name: string | null }[] {
  // Fixture search on 2026-07-14 found ext_media_availability but no observed
  // tagged-users payload. Keep the contract additive and default-empty until a
  // live capture proves the current field path.
  const candidates = [
    media.tagged_users,
    media.mediaTagsResults?.result,
    media.media_tags,
    media.user_tags,
  ];
  const source = candidates.find((value) => asArray(value).length > 0);
  return (asArray(source) as Json[]).map((u) => ({
    id_str:
      asStringOrNull(u.id_str) ??
      asStringOrNull(u.rest_id) ??
      asStringOrNull(u.user_id_str) ??
      asStringOrNull(u.user_results?.result?.rest_id),
    screen_name:
      asStringOrNull(u.screen_name) ??
      asStringOrNull(u.user_results?.result?.core?.screen_name) ??
      asStringOrNull(u.user_results?.result?.legacy?.screen_name),
  }));
}

/**
 * unified_card fallback (ported from src/js/media_extractor.js): some
 * card-based tweets carry media only inside the JSON-encoded unified_card
 * binding value. Handles both array (newer) and object (legacy) forms of
 * binding_values, and both GraphQL (card.legacy.*) and REST (card.*) nesting.
 */
function mediaFromUnifiedCard(result: Json): Json[] | null {
  try {
    const bindingValues = result.card?.legacy?.binding_values ?? result.card?.binding_values;
    let cardString: string | null = null;
    if (Array.isArray(bindingValues)) {
      const entry = bindingValues.find(
        (v) => v?.key === 'unified_card' && typeof v?.value?.string_value === 'string',
      );
      if (entry) cardString = entry.value.string_value;
    } else if (typeof bindingValues?.unified_card?.string_value === 'string') {
      cardString = bindingValues.unified_card.string_value;
    }
    if (!cardString) return null;
    const card = JSON.parse(cardString);
    const mediaEntities = card?.media_entities;
    if (!mediaEntities || typeof mediaEntities !== 'object') return null;
    const mediaOneId = card.component_objects?.media_1?.data?.id;
    if (mediaOneId && mediaEntities[mediaOneId]) return [mediaEntities[mediaOneId]];
    return Object.values(mediaEntities) as Json[];
  } catch {
    return null;
  }
}

function isTweetResult(obj: Json): boolean {
  const typename = obj.__typename;
  if (typeof typename === 'string') {
    return TWEET_TYPENAMES.has(typename) || TOMBSTONE_TYPENAMES.has(typename);
  }
  // Older payloads omit __typename; a tweet has rest_id + legacy.full_text
  // (a User result also has rest_id + legacy, but no full_text).
  return (
    typeof obj.rest_id === 'string' &&
    obj.legacy != null &&
    typeof obj.legacy.full_text === 'string'
  );
}

/** "conversationthread-123-tweet-456" / "tweet-456" -> "456". */
export function tweetIdFromEntryId(entryId: string | null): string | null {
  if (!entryId) return null;
  const matches = entryId.match(/tweet-(\d+)/g);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return last.slice('tweet-'.length);
}

function editInitialId(result: Json): string | null {
  const control: Json = result.edit_control ?? {};
  // Edited (non-initial) versions nest the original list under edit_control_initial.
  const ids = control.edit_tweet_ids ?? control.edit_control_initial?.edit_tweet_ids;
  return Array.isArray(ids) && ids.length > 0 ? asStringOrNull(ids[0]) : null;
}

function parseCreatedAt(createdAt: unknown, idStr: string): number | null {
  if (typeof createdAt === 'string') {
    const t = Date.parse(createdAt); // "Mon Jul 01 12:34:56 +0000 2024"
    if (!Number.isNaN(t)) return t;
  }
  try {
    const id = BigInt(idStr);
    if (id >= SNOWFLAKE_FIRST_ID) return Number((id >> 22n) + SNOWFLAKE_EPOCH_MS);
  } catch {
    /* non-numeric id */
  }
  return null;
}

function parseViews(views: unknown): number | null {
  const count = (views as Json | undefined)?.count;
  if (typeof count === 'number') return count;
  if (typeof count === 'string' && /^\d+$/.test(count)) return parseInt(count, 10);
  return null;
}

/** Remove the trailing t.co media link X appends to legacy full_text. */
function stripTrailingMediaLink(text: string, legacy: Json): string {
  const media = asArray(legacy.extended_entities?.media ?? legacy.entities?.media) as Json[];
  for (const m of media) {
    const short = asStringOrNull(m?.url);
    if (short && text.endsWith(short)) {
      return text.slice(0, text.length - short.length).replace(/\s+$/, '');
    }
  }
  return text;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBooleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
