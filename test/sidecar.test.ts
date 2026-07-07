import { describe, expect, it } from 'vitest';
import type { MediaRecord, TweetRecord } from '../packages/core/src/tweet-record.ts';
import {
  PARTIAL_MARKER,
  SIDECAR_VERSION,
  formatSidecarDate,
  sidecarJsonObject,
  sidecarJsonText,
  sidecarTxt,
  statusUrl,
} from '../packages/core/src/sidecar.ts';

function localEpoch(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

const CREATED = localEpoch(2026, 7, 4, 21, 3, 11);
const CAPTURED = Date.UTC(2026, 6, 6, 10, 0, 0);

function photo(overrides: Partial<MediaRecord> = {}): MediaRecord {
  return {
    type: 'photo',
    media_key: '3_100',
    index: 1,
    image_url: 'https://pbs.twimg.com/media/GqFGr2xWMAArtgU.jpg',
    alt_text: null,
    video_variants: [],
    width: 1080,
    height: 867,
    duration_ms: null,
    ...overrides,
  };
}

function record(overrides: Partial<TweetRecord> = {}): TweetRecord {
  return {
    id_str: '1234567890123456789',
    created_at_ms: CREATED,
    lang: 'ja',
    user: { id_str: '9876543210', screen_name: 'furyutei', name: 'ふうり' },
    full_text: 'こんにちは world',
    urls: [],
    hashtags: [],
    mentions: [],
    in_reply_to_status_id_str: null,
    quoted_status_id_str: null,
    retweeted_status_id_str: null,
    conversation_id_str: '1234567890123456789',
    edit_initial_id_str: '1234567890123456789',
    counts: { replies: 12, retweets: 345, likes: 6789, quotes: 10, bookmarks: 22, views: 123456 },
    is_sensitive: false,
    media: [photo()],
    source_op: 'TweetDetail',
    captured_at_ms: CAPTURED,
    ...overrides,
  };
}

describe('statusUrl', () => {
  it('builds the canonical URL, with the /i/ form when screen_name is unknown', () => {
    expect(statusUrl('furyutei', '123')).toBe('https://x.com/furyutei/status/123');
    expect(statusUrl(null, '123')).toBe('https://x.com/i/status/123');
  });
});

describe('formatSidecarDate', () => {
  it('prints local time with offset plus the UTC instant', () => {
    const s = formatSidecarDate(CREATED);
    expect(s).toMatch(
      /^2026-07-04 21:03:11 [+-]\d{2}:\d{2} \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z\)$/,
    );
    expect(s).toContain(`(${new Date(CREATED).toISOString()})`);
  });

  it('returns "unknown" for null', () => {
    expect(formatSidecarDate(null)).toBe('unknown');
  });
});

describe('sidecarTxt', () => {
  it('produces the plan 04 §3 layout', () => {
    const txt = sidecarTxt(
      record({
        full_text: 'こんにちは world #a #b @x https://example.com/page',
        hashtags: ['a', 'b'],
        mentions: ['x'],
        urls: [{ short: 'https://t.co/abc', expanded: 'https://example.com/page' }],
        in_reply_to_status_id_str: '111',
        quoted_status_id_str: '222',
      }),
    );
    expect(txt).toBe(
      [
        'https://x.com/furyutei/status/1234567890123456789',
        '',
        'こんにちは world #a #b @x https://example.com/page',
        '',
        '---',
        'author:      ふうり (@furyutei) [id:9876543210]',
        `date:        ${formatSidecarDate(CREATED)}`,
        'lang:        ja',
        'replies: 12 | retweets: 345 | likes: 6789 | quotes: 10 | bookmarks: 22 | views: 123456',
        'in_reply_to: https://x.com/i/status/111',
        'quoting:     https://x.com/i/status/222',
        'media:',
        '  1. photo https://pbs.twimg.com/media/GqFGr2xWMAArtgU?format=jpg&name=orig',
        'hashtags:    #a #b',
        'mentions:    @x',
        'links:       https://example.com/page',
        'captured:    2026-07-06T10:00:00.000Z via GraphQL:TweetDetail',
        '',
      ].join('\n'),
    );
  });

  it('keeps multi-line note_tweet text verbatim', () => {
    const longText = [
      'Long-form line one.',
      '',
      'Paragraph two with 絵文字 🦊 and https://example.com/a-very-long-expanded-url',
      'Final line — no truncation, the note_tweet full text is used.',
    ].join('\n');
    const txt = sidecarTxt(record({ full_text: longText }));
    expect(txt).toContain(`\n\n${longText}\n\n---\n`);
    expect(txt.startsWith('https://x.com/furyutei/status/1234567890123456789\n')).toBe(true);
  });

  it('marks partial (DOM-reconstructed) records right below the URL line', () => {
    const txt = sidecarTxt(record({}), { partial: true });
    const lines = txt.split('\n');
    expect(lines[0]).toBe('https://x.com/furyutei/status/1234567890123456789');
    expect(lines[1]).toBe(PARTIAL_MARKER);
    expect(PARTIAL_MARKER).toBe('# (partial - reconstructed from DOM)');
  });

  it('renders video and gif media with dimensions, duration, and alt text', () => {
    const txt = sidecarTxt(
      record({
        media: [
          photo({ index: 1, alt_text: 'a fox' }),
          photo({
            index: 2,
            type: 'video',
            width: 1280,
            height: 720,
            duration_ms: 30012,
            video_variants: [
              { bitrate: null, content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/pl.m3u8' },
              { bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/hi.mp4' },
            ],
          }),
          photo({ index: 3, type: 'animated_gif', width: 480, height: 480, video_variants: [
            { bitrate: 0, content_type: 'video/mp4', url: 'https://video.twimg.com/tweet_video/g.mp4' },
          ] }),
        ],
      }),
    );
    expect(txt).toContain(
      '  1. photo https://pbs.twimg.com/media/GqFGr2xWMAArtgU?format=jpg&name=orig   alt: a fox',
    );
    expect(txt).toContain('  2. video https://video.twimg.com/hi.mp4 (1280x720, 30012ms)');
    expect(txt).toContain('  3. gif   https://video.twimg.com/tweet_video/g.mp4 (480x480)');
  });

  it('notes media without any downloadable URL', () => {
    const txt = sidecarTxt(
      record({ media: [photo({ image_url: null })] }),
    );
    expect(txt).toContain('  1. photo (no downloadable url)');
  });

  it('omits optional lines when data is absent', () => {
    const txt = sidecarTxt(
      record({
        lang: null,
        media: [],
        counts: { replies: 0, retweets: 0, likes: 0, quotes: 0, bookmarks: 0, views: null },
      }),
    );
    expect(txt).not.toContain('lang:');
    expect(txt).not.toContain('views:');
    expect(txt).not.toContain('media:');
    expect(txt).not.toContain('in_reply_to:');
    expect(txt).not.toContain('quoting:');
    expect(txt).not.toContain('hashtags:');
    expect(txt).not.toContain('mentions:');
    expect(txt).not.toContain('links:');
    expect(txt).toContain('replies: 0 | retweets: 0 | likes: 0 | quotes: 0 | bookmarks: 0');
  });

  it('handles unknown users and dates (worst-case DOM fallback)', () => {
    const txt = sidecarTxt(
      record({
        created_at_ms: null,
        user: { id_str: null, screen_name: null, name: null },
      }),
      { partial: true },
    );
    expect(txt.startsWith('https://x.com/i/status/1234567890123456789\n')).toBe(true);
    expect(txt).toContain('author:      (unknown) (@unknown)');
    expect(txt).toContain('date:        unknown');
  });

  it('uses LF only, with exactly one trailing newline', () => {
    const txt = sidecarTxt(record({ full_text: 'line1\nline2' }));
    expect(txt).not.toContain('\r');
    expect(txt.endsWith('\n')).toBe(true);
    expect(txt.endsWith('\n\n')).toBe(false);
  });
});

describe('sidecar json', () => {
  it('wraps the full record with version, partial flag, files, and chosen URLs', () => {
    const rec = record({
      media: [
        photo(),
        photo({
          index: 2,
          type: 'video',
          video_variants: [
            { bitrate: 632000, content_type: 'video/mp4', url: 'https://video.twimg.com/lo.mp4' },
            { bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/hi.mp4' },
          ],
        }),
        photo({ index: 3, image_url: null }),
      ],
    });
    const obj = sidecarJsonObject(rec, {
      saved_files: ['furyutei-1-x-img1.jpg', 'furyutei-1-x.txt'],
    });
    expect(obj.sidecar_version).toBe(SIDECAR_VERSION);
    expect(obj.partial).toBe(false);
    expect(obj.saved_files).toEqual(['furyutei-1-x-img1.jpg', 'furyutei-1-x.txt']);
    expect(obj.media_urls).toEqual([
      {
        index: 1,
        type: 'photo',
        url: 'https://pbs.twimg.com/media/GqFGr2xWMAArtgU?format=jpg&name=orig',
        ext: 'jpg',
      },
      { index: 2, type: 'video', url: 'https://video.twimg.com/hi.mp4', ext: 'mp4' },
      { index: 3, type: 'photo', url: null, ext: null },
    ]);
    expect(obj.record).toBe(rec);
  });

  it('serializes to parseable pretty JSON with one trailing newline', () => {
    const text = sidecarJsonText(record({}), { partial: true });
    expect(text.endsWith('}\n')).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.partial).toBe(true);
    expect(parsed.record.id_str).toBe('1234567890123456789');
    expect(parsed.record.full_text).toBe('こんにちは world');
  });
});
