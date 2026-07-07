/**
 * filename.ts — all file naming for the save layer, in one pure module
 * (plan 04 §2). The convention is the legacy one users' archives rely on:
 *
 *   <screen_name>-<tweet_id>-<YYYYMMDD_hhmmss>-{img|gif|vid}<N>.<ext>   media
 *   <screen_name>-<tweet_id>-<YYYYMMDD_hhmmss>.txt                     sidecar
 *   <screen_name>-<tweet_id>-<YYYYMMDD_hhmmss>.json                    sidecar
 *
 * Matching src/js/main_react.user.js behavior exactly:
 *   - timestamp is the tweet CREATION time in the machine's LOCAL timezone,
 *     format_date('YYYYMMDD_hhmmss') zero-padding;
 *   - N is the media item's 1-based position within the tweet
 *     (MediaRecord.index);
 *   - prefixes: photo → img, animated_gif → gif, video → vid.
 *
 * Everything joined into a name goes through sanitizeForFilename() —
 * screen_names are normally [A-Za-z0-9_] but DOM-fallback records
 * (plan 02 §5) can carry arbitrary text.
 */

import type { MediaType } from './tweet-record.ts';

export type MediaPrefix = 'img' | 'gif' | 'vid';

export type SidecarFormat = 'txt' | 'json';

const MEDIA_PREFIX: Record<MediaType, MediaPrefix> = {
  photo: 'img',
  animated_gif: 'gif',
  video: 'vid',
};

export function mediaPrefixForType(type: MediaType): MediaPrefix {
  return MEDIA_PREFIX[type] ?? 'vid';
}

/**
 * Windows-reserved device names (any extension makes them invalid too, so a
 * bare-stem check is required). Case-insensitive.
 */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * Make one path SEGMENT safe on Windows/macOS/Linux (never a whole path —
 * slashes are replaced, not treated as separators):
 *   - control chars (0x00–0x1f, 0x7f) and `< > : " / \ | ? *` → `_`
 *   - leading/trailing whitespace trimmed; trailing dots stripped (Windows
 *     silently drops them, which would corrupt the convention)
 *   - Windows reserved device names get a `_` suffix
 *   - empty result → `_`
 * Emoji/RTL/other Unicode pass through unchanged — they are valid filename
 * characters everywhere we target.
 */
export function sanitizeForFilename(segment: string): string {
  let out = String(segment)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f<>:"\/\\|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (out === '') out = '_';
  if (WINDOWS_RESERVED.test(out)) out = `${out}_`;
  return out;
}

/**
 * format_date(date, 'YYYYMMDD_hhmmss') from the legacy code: local timezone,
 * zero-padded. Null/undefined/NaN input (created_at_ms is null for pre-2010
 * ids with no created_at) yields the sentinel '00000000_000000' — sortable,
 * greppable, obviously-not-a-date.
 */
export const UNKNOWN_TIMESTAMP = '00000000_000000';

export function formatFilenameTimestamp(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined || !Number.isFinite(epochMs)) {
    return UNKNOWN_TIMESTAMP;
  }
  const d = new Date(epochMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${pad(d.getFullYear(), 4)}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export interface TweetNameParts {
  screen_name: string | null;
  tweet_id: string;
  created_at_ms: number | null;
}

/** `<screen_name>-<tweet_id>-<YYYYMMDD_hhmmss>` — the shared stem. */
export function tweetFileStem(parts: TweetNameParts): string {
  const screenName = sanitizeForFilename(parts.screen_name ?? 'unknown');
  const tweetId = sanitizeForFilename(parts.tweet_id);
  return `${screenName}-${tweetId}-${formatFilenameTimestamp(parts.created_at_ms)}`;
}

/**
 * Media basename, e.g. `furyutei-1234567890-20260704_210311-img2.jpg`.
 * `index` is the 1-based position within the tweet (MediaRecord.index).
 * `ext` comes from the chosen URL (see media-url.ts helpers).
 */
export function mediaBasename(
  parts: TweetNameParts,
  media: { type: MediaType; index: number },
  ext: string,
): string {
  const sanitizedExt = sanitizeForFilename(ext.replace(/^\./, ''));
  const safeExt = sanitizedExt === '_' ? 'bin' : sanitizedExt;
  return `${tweetFileStem(parts)}-${mediaPrefixForType(media.type)}${media.index}.${safeExt}`;
}

/** Sidecar basename, e.g. `furyutei-1234567890-20260704_210311.txt`. */
export function sidecarBasename(parts: TweetNameParts, format: SidecarFormat): string {
  return `${tweetFileStem(parts)}.${format}`;
}

/**
 * Relative save path for standalone mode (Decision 9):
 * `twMediaDownloader/<screen_name>/<basename>` — handed to
 * chrome.downloads.download({filename}) which resolves under Downloads/.
 * Forward slashes: chrome.downloads requires them on every platform.
 */
export const STANDALONE_ROOT = 'twMediaDownloader';

export function standaloneRelativePath(screenName: string | null, basename: string): string {
  return `${STANDALONE_ROOT}/${sanitizeForFilename(screenName ?? 'unknown')}/${basename}`;
}
