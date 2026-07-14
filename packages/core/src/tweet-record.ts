/**
 * TweetRecord — the normalized tweet contract shared by the extension and the
 * companion app. Authoritative contract (documented in ARCHITECTURE.md);
 * every later layer (UI, save, bulk, app ingest) codes against this shape.
 *
 * Contract-stability rule: fields may be ADDED (with null-safe defaults);
 * existing fields must never be renamed or change meaning without updating
 * 00-overview.md in the same commit.
 */

export type MediaType = 'photo' | 'video' | 'animated_gif';

export interface VideoVariant {
  /** Bits per second; null for HLS playlists (application/x-mpegURL). */
  bitrate: number | null;
  content_type: string;
  url: string;
}

export interface MediaRecord {
  type: MediaType;
  media_key: string | null;
  /** 1-based position within the tweet. */
  index: number;
  /** pbs.twimg.com base URL, no size suffix (for videos/gifs: the poster image). */
  image_url: string | null;
  alt_text: string | null;
  /** All variants as captured — selection (max-bitrate mp4) happens at save time. */
  video_variants: VideoVariant[];
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  /** Users tagged on this media item, as captured; [] when absent. */
  tagged_users: { id_str: string | null; screen_name: string | null }[];
}

export interface UrlEntity {
  /** The t.co short URL as it appears in the raw text. */
  short: string;
  expanded: string;
}

export interface TweetCounts {
  replies: number;
  retweets: number;
  likes: number;
  quotes: number;
  bookmarks: number;
  /** null when X does not expose a view count for this tweet. */
  views: number | null;
}

export interface TweetUser {
  id_str: string | null;
  screen_name: string | null;
  name: string | null;
}

export interface TweetRecord {
  id_str: string;
  /** Epoch ms; falls back to snowflake-derived time if created_at is unparsable. */
  created_at_ms: number | null;
  lang: string | null;
  user: TweetUser;
  /**
   * note_tweet (long-form) text when present, else legacy full_text.
   * t.co URLs expanded in place; the trailing t.co media link stripped.
   */
  full_text: string;
  urls: UrlEntity[];
  hashtags: string[];
  /** Mentioned screen_names, without the leading @. */
  mentions: string[];
  in_reply_to_status_id_str: string | null;
  /** Author id of the tweet this replies to, when X includes it. */
  in_reply_to_user_id_str: string | null;
  quoted_status_id_str: string | null;
  /**
   * Set on the outer retweet record; the inner tweet is cached under its own
   * id. (Contract extension over the original 00-overview draft — see the
   * "record the relationship on the outer record" rule in plan 02 §3.)
   */
  retweeted_status_id_str: string | null;
  conversation_id_str: string | null;
  /**
   * edit_control initial tweet id — the logical-post key for edit grouping
   * (Decision 17 / plan 06 §3 post_key). Equals id_str for unedited tweets;
   * null when edit_control is absent from the payload.
   */
  edit_initial_id_str: string | null;
  /** Viewer-relationship flags as X sent them; null = absent from payload. */
  viewer: { liked: boolean | null; bookmarked: boolean | null };
  counts: TweetCounts;
  is_sensitive: boolean;
  media: MediaRecord[];
  /** GraphQL operation that produced this record (TweetDetail, UserMedia, …). */
  source_op: string;
  captured_at_ms: number;
}

/**
 * Emitted when a payload contains a TweetTombstone / TweetUnavailable result.
 * Plan 06 uses these to flag deleted posts passively (Decision 18).
 */
export interface TombstoneEvent {
  /** Derived from the timeline entryId when possible; null otherwise. */
  tweet_id: string | null;
  entry_id: string | null;
  /** "TweetTombstone" | "TweetUnavailable" (whatever __typename X sent). */
  typename: string;
  /** Human-readable tombstone text if present ("This Post was deleted…"). */
  text: string | null;
  source_op: string;
  captured_at_ms: number;
}

export interface NormalizeResult {
  tweets: TweetRecord[];
  tombstones: TombstoneEvent[];
}
