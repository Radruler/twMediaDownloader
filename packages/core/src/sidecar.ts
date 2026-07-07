/**
 * sidecar.ts — the metadata sidecar serializers (plan 04 §3).
 *
 * `.txt` (default, human-readable): post URL on the first line, the full
 * text verbatim (multi-line preserved), then a stable greppable
 * `key: value` block. UTF-8, LF line endings, exactly one trailing newline.
 *
 * `.json` (optional, machine-readable): the full TweetRecord plus
 * sidecar_version, the saved filenames, and the chosen media URLs —
 * schema-versioned for downstream tooling.
 *
 * Partial records (plan 02 §5 DOM fallback — no network request is EVER
 * made to fill gaps): pass `{ partial: true }`; the txt gains a
 * `# (partial - reconstructed from DOM)` line and the json a
 * `"partial": true` field.
 */

import type { MediaRecord, TweetRecord } from './tweet-record.ts';
import { planMediaDownload } from './media-url.ts';

export const SIDECAR_VERSION = 1;

export interface SidecarOptions {
  /** Record was reconstructed from the DOM, not captured GraphQL. */
  partial?: boolean;
  /** Basenames of the files saved alongside (media + sidecar itself). */
  saved_files?: string[];
}

export const PARTIAL_MARKER = '# (partial - reconstructed from DOM)';

/** Canonical status URL; falls back to the /i/ redirect form when the screen_name is unknown. */
export function statusUrl(screenName: string | null, tweetId: string): string {
  return screenName
    ? `https://x.com/${screenName}/status/${tweetId}`
    : `https://x.com/i/status/${tweetId}`;
}

const KEY_WIDTH = 13; // "in_reply_to: " — the widest key, colon+space included

function kv(key: string, value: string): string {
  return `${`${key}:`.padEnd(KEY_WIDTH - 1)} ${value}`.replace(/ +$/, '');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `2026-07-04 21:03:11 +09:00 (2026-07-04T12:03:11.000Z)` — local + UTC. */
export function formatSidecarDate(epochMs: number | null): string {
  if (epochMs === null || !Number.isFinite(epochMs)) return 'unknown';
  const d = new Date(epochMs);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const local =
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return `${local} (${d.toISOString()})`;
}

function mediaTypeLabel(media: MediaRecord): string {
  if (media.type === 'photo') return 'photo';
  if (media.type === 'animated_gif') return 'gif';
  return 'video';
}

function mediaLine(media: MediaRecord): string {
  const plan = planMediaDownload(media);
  const url = plan ? plan.urls[0] : '(no downloadable url)';
  let line = `  ${media.index}. ${mediaTypeLabel(media).padEnd(5)} ${url}`;
  if (media.type !== 'photo') {
    const details: string[] = [];
    if (media.width !== null && media.height !== null) details.push(`${media.width}x${media.height}`);
    if (media.duration_ms !== null) details.push(`${media.duration_ms}ms`);
    if (details.length > 0) line += ` (${details.join(', ')})`;
  }
  if (media.alt_text) line += `   alt: ${media.alt_text}`;
  return line;
}

function countsLine(counts: TweetRecord['counts']): string {
  const parts = [
    `replies: ${counts.replies}`,
    `retweets: ${counts.retweets}`,
    `likes: ${counts.likes}`,
    `quotes: ${counts.quotes}`,
    `bookmarks: ${counts.bookmarks}`,
  ];
  if (counts.views !== null) parts.push(`views: ${counts.views}`);
  return parts.join(' | ');
}

/** Serialize the human-readable `.txt` sidecar. LF, one trailing newline. */
export function sidecarTxt(record: TweetRecord, options: SidecarOptions = {}): string {
  const lines: string[] = [];
  lines.push(statusUrl(record.user.screen_name, record.id_str));
  if (options.partial) lines.push(PARTIAL_MARKER);
  lines.push('');
  lines.push(record.full_text);
  lines.push('');
  lines.push('---');

  const author =
    `${record.user.name ?? '(unknown)'} (@${record.user.screen_name ?? 'unknown'})` +
    (record.user.id_str ? ` [id:${record.user.id_str}]` : '');
  lines.push(kv('author', author));
  lines.push(kv('date', formatSidecarDate(record.created_at_ms)));
  if (record.lang) lines.push(kv('lang', record.lang));
  lines.push(countsLine(record.counts));
  if (record.in_reply_to_status_id_str) {
    lines.push(kv('in_reply_to', statusUrl(null, record.in_reply_to_status_id_str)));
  }
  if (record.quoted_status_id_str) {
    lines.push(kv('quoting', statusUrl(null, record.quoted_status_id_str)));
  }
  if (record.retweeted_status_id_str) {
    lines.push(kv('retweet_of', statusUrl(null, record.retweeted_status_id_str)));
  }
  if (record.media.length > 0) {
    lines.push('media:');
    for (const media of record.media) lines.push(mediaLine(media));
  }
  if (record.hashtags.length > 0) {
    lines.push(kv('hashtags', record.hashtags.map((h) => `#${h}`).join(' ')));
  }
  if (record.mentions.length > 0) {
    lines.push(kv('mentions', record.mentions.map((m) => `@${m}`).join(' ')));
  }
  if (record.urls.length > 0) {
    lines.push(kv('links', record.urls.map((u) => u.expanded).join(' ')));
  }
  lines.push(
    kv(
      'captured',
      `${new Date(record.captured_at_ms).toISOString()} via GraphQL:${record.source_op}`,
    ),
  );
  return `${lines.join('\n')}\n`;
}

export interface SidecarJson {
  sidecar_version: number;
  partial: boolean;
  saved_files: string[];
  /** Chosen download URL + extension per media item (first-choice URL). */
  media_urls: { index: number; type: string; url: string | null; ext: string | null }[];
  record: TweetRecord;
}

/** Build the machine-readable sidecar object (serialize with sidecarJsonText). */
export function sidecarJsonObject(
  record: TweetRecord,
  options: SidecarOptions = {},
): SidecarJson {
  return {
    sidecar_version: SIDECAR_VERSION,
    partial: options.partial === true,
    saved_files: options.saved_files ?? [],
    media_urls: record.media.map((media) => {
      const plan = planMediaDownload(media);
      return {
        index: media.index,
        type: media.type,
        url: plan ? plan.urls[0] : null,
        ext: plan ? plan.ext : null,
      };
    }),
    record,
  };
}

/** Serialize the `.json` sidecar. Pretty-printed, LF, one trailing newline. */
export function sidecarJsonText(record: TweetRecord, options: SidecarOptions = {}): string {
  return `${JSON.stringify(sidecarJsonObject(record, options), null, 2)}\n`;
}
