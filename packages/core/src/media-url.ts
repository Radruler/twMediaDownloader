/**
 * media-url.ts — choosing WHAT to download for a MediaRecord (plan 04 §4).
 *
 * TweetRecord.image_url is the pbs.twimg.com URL as captured, ending in a
 * plain extension (`…/media/GqFG….jpg`). For originals X wants the extension
 * moved into query params: `…/media/GqFG…?format=jpg&name=orig` — REPLACE
 * the trailing `.ext`, never append to it (matches
 * src/js/media_extractor.js:90). On 404 the caller walks the fallback
 * chain: name=orig → name=4096x4096 → name=large.
 *
 * Videos/GIFs: pick the highest-bitrate `video/mp4` variant. HLS playlist
 * entries carry `bitrate: null` and content_type application/x-mpegURL —
 * never selected. Animated GIFs are stored by X as a single mp4 variant
 * (bitrate 0) — that one IS selected; only the filename prefix differs.
 */

import type { MediaRecord, VideoVariant } from './tweet-record.ts';

export const IMAGE_SIZE_FALLBACKS = ['orig', '4096x4096', 'large'] as const;

/**
 * Extension for the media FILENAME, from the chosen URL. `format=` query
 * param wins (post-transform orig URLs), else the path extension; query
 * string/fragment ignored. Defaults to jpg for images-without-extension
 * (matches the legacy behavior of assuming photo URLs are jpg).
 */
export function extensionFromUrl(url: string, fallback = 'jpg'): string {
  const fromFormat = /[?&]format=([A-Za-z0-9]+)/.exec(url);
  if (fromFormat) return fromFormat[1].toLowerCase();
  const fromPath = /\.([A-Za-z0-9]+)(?:[?#]|$)/.exec(url);
  return fromPath ? fromPath[1].toLowerCase() : fallback;
}

/**
 * `…/x.jpg` → `…/x?format=jpg&name=<size>`. A URL that already carries a
 * query string is returned unchanged (defensive — the normalizer stores
 * bare URLs, but DOM-fallback records may not be as clean).
 */
export function imageUrlForSize(imageUrl: string, size: string): string {
  if (imageUrl.includes('?')) return imageUrl;
  return imageUrl.replace(/\.([A-Za-z0-9]+)$/, `?format=$1&name=${size}`);
}

/** The ordered URLs to try for a photo: orig, then 4096x4096, then large. */
export function imageUrlFallbackChain(imageUrl: string): string[] {
  return IMAGE_SIZE_FALLBACKS.map((size) => imageUrlForSize(imageUrl, size));
}

/**
 * Highest-bitrate progressive mp4 variant, or null when there is none
 * (e.g. an HLS-only list — rare; plan 06 keeps an ffmpeg fallback stub for
 * that case, disabled). GIF variants with bitrate 0 are valid picks.
 */
export function pickMp4Variant(variants: VideoVariant[]): VideoVariant | null {
  let best: VideoVariant | null = null;
  for (const variant of variants ?? []) {
    if (variant.content_type !== 'video/mp4') continue;
    if (typeof variant.bitrate !== 'number') continue; // HLS-shaped stragglers
    if (best === null || variant.bitrate > (best.bitrate as number)) best = variant;
  }
  return best;
}

export interface MediaDownloadPlan {
  /** URLs to try in order; first success wins (photo fallback chain). */
  urls: string[];
  /** Filename extension for the chosen media. */
  ext: string;
}

/**
 * The full download decision for one MediaRecord, or null when the record
 * has nothing fetchable (no image_url and no usable variant).
 */
export function planMediaDownload(media: MediaRecord): MediaDownloadPlan | null {
  if (media.type === 'photo') {
    if (!media.image_url) return null;
    return {
      urls: imageUrlFallbackChain(media.image_url),
      ext: extensionFromUrl(media.image_url),
    };
  }
  const variant = pickMp4Variant(media.video_variants);
  if (!variant) return null;
  return { urls: [variant.url], ext: extensionFromUrl(variant.url, 'mp4') };
}
