import { describe, expect, it } from 'vitest';
import type { MediaRecord, VideoVariant } from '../packages/core/src/tweet-record.ts';
import {
  IMAGE_SIZE_FALLBACKS,
  extensionFromUrl,
  imageUrlFallbackChain,
  imageUrlForSize,
  pickMp4Variant,
  planMediaDownload,
} from '../packages/core/src/media-url.ts';

const JPG = 'https://pbs.twimg.com/media/GqFGr2xWMAArtgU.jpg';
const PNG = 'https://pbs.twimg.com/media/GqFGr2xWMAArtgU.png';

describe('imageUrlForSize', () => {
  it('REPLACES the trailing extension with format+name params (never appends)', () => {
    expect(imageUrlForSize(JPG, 'orig')).toBe(
      'https://pbs.twimg.com/media/GqFGr2xWMAArtgU?format=jpg&name=orig',
    );
    expect(imageUrlForSize(PNG, 'orig')).toBe(
      'https://pbs.twimg.com/media/GqFGr2xWMAArtgU?format=png&name=orig',
    );
    expect(imageUrlForSize(JPG, 'orig')).not.toContain('.jpg?');
  });

  it('supports the fallback sizes', () => {
    expect(imageUrlForSize(JPG, '4096x4096')).toBe(
      'https://pbs.twimg.com/media/GqFGr2xWMAArtgU?format=jpg&name=4096x4096',
    );
    expect(imageUrlForSize(JPG, 'large')).toBe(
      'https://pbs.twimg.com/media/GqFGr2xWMAArtgU?format=jpg&name=large',
    );
  });

  it('leaves an already-parameterized URL unchanged', () => {
    const parameterized = 'https://pbs.twimg.com/media/GqFG?format=jpg&name=small';
    expect(imageUrlForSize(parameterized, 'orig')).toBe(parameterized);
  });
});

describe('imageUrlFallbackChain', () => {
  it('yields orig → 4096x4096 → large, in order', () => {
    expect(IMAGE_SIZE_FALLBACKS).toEqual(['orig', '4096x4096', 'large']);
    expect(imageUrlFallbackChain(JPG)).toEqual([
      'https://pbs.twimg.com/media/GqFGr2xWMAArtgU?format=jpg&name=orig',
      'https://pbs.twimg.com/media/GqFGr2xWMAArtgU?format=jpg&name=4096x4096',
      'https://pbs.twimg.com/media/GqFGr2xWMAArtgU?format=jpg&name=large',
    ]);
  });
});

describe('extensionFromUrl', () => {
  it('reads the path extension, ignoring query and fragment', () => {
    expect(extensionFromUrl(JPG)).toBe('jpg');
    expect(extensionFromUrl(PNG)).toBe('png');
    expect(
      extensionFromUrl('https://video.twimg.com/amplify_video/1/vid/avc1/720x1280/x.mp4?tag=28'),
    ).toBe('mp4');
  });

  it('prefers the format= query param when present', () => {
    expect(extensionFromUrl('https://pbs.twimg.com/media/GqFG?format=webp&name=orig')).toBe(
      'webp',
    );
  });

  it('lowercases and applies the fallback for extensionless URLs', () => {
    expect(extensionFromUrl('https://pbs.twimg.com/media/GqFG.JPG')).toBe('jpg');
    expect(extensionFromUrl('https://pbs.twimg.com/media/GqFG')).toBe('jpg');
    expect(extensionFromUrl('https://video.twimg.com/x/playlist', 'mp4')).toBe('mp4');
  });
});

const HLS: VideoVariant = {
  bitrate: null,
  content_type: 'application/x-mpegURL',
  url: 'https://video.twimg.com/amplify_video/1/pl/x.m3u8?tag=28',
};
const MP4_LOW: VideoVariant = {
  bitrate: 632000,
  content_type: 'video/mp4',
  url: 'https://video.twimg.com/amplify_video/1/vid/avc1/480x852/low.mp4?tag=28',
};
const MP4_HIGH: VideoVariant = {
  bitrate: 2176000,
  content_type: 'video/mp4',
  url: 'https://video.twimg.com/amplify_video/1/vid/avc1/720x1280/high.mp4?tag=28',
};

describe('pickMp4Variant', () => {
  it('picks the highest-bitrate video/mp4 variant', () => {
    expect(pickMp4Variant([HLS, MP4_LOW, MP4_HIGH])).toBe(MP4_HIGH);
    expect(pickMp4Variant([MP4_HIGH, MP4_LOW])).toBe(MP4_HIGH);
  });

  it('skips HLS entries (bitrate null / non-mp4 content type)', () => {
    expect(pickMp4Variant([HLS])).toBeNull();
    expect(pickMp4Variant([])).toBeNull();
  });

  it('accepts bitrate 0 (animated GIF single variant)', () => {
    const gif: VideoVariant = {
      bitrate: 0,
      content_type: 'video/mp4',
      url: 'https://video.twimg.com/tweet_video/x.mp4',
    };
    expect(pickMp4Variant([gif])).toBe(gif);
  });
});

function mediaRecord(overrides: Partial<MediaRecord>): MediaRecord {
  return {
    type: 'photo',
    media_key: '3_1',
    index: 1,
    image_url: JPG,
    alt_text: null,
    video_variants: [],
    width: null,
    height: null,
    duration_ms: null,
    ...overrides,
  };
}

describe('planMediaDownload', () => {
  it('plans a photo with the orig fallback chain and path extension', () => {
    const plan = planMediaDownload(mediaRecord({}));
    expect(plan).toEqual({
      urls: imageUrlFallbackChain(JPG),
      ext: 'jpg',
    });
  });

  it('plans a video with the single best mp4 URL', () => {
    const plan = planMediaDownload(
      mediaRecord({ type: 'video', video_variants: [HLS, MP4_LOW, MP4_HIGH] }),
    );
    expect(plan).toEqual({ urls: [MP4_HIGH.url], ext: 'mp4' });
  });

  it('plans an animated gif via its mp4 variant', () => {
    const gif: VideoVariant = {
      bitrate: 0,
      content_type: 'video/mp4',
      url: 'https://video.twimg.com/tweet_video/x.mp4',
    };
    const plan = planMediaDownload(mediaRecord({ type: 'animated_gif', video_variants: [gif] }));
    expect(plan).toEqual({ urls: [gif.url], ext: 'mp4' });
  });

  it('returns null when nothing is fetchable', () => {
    expect(planMediaDownload(mediaRecord({ image_url: null }))).toBeNull();
    expect(planMediaDownload(mediaRecord({ type: 'video', video_variants: [HLS] }))).toBeNull();
    expect(planMediaDownload(mediaRecord({ type: 'video', video_variants: [] }))).toBeNull();
  });
});
