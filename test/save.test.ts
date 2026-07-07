import { describe, expect, it } from 'vitest';
import type { MediaRecord, TweetRecord } from '../packages/core/src/tweet-record.ts';
import { buildSaveManifest, SAVE_PORT_NAME } from '../extension/content/save.js';

function localEpoch(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

const CREATED = localEpoch(2026, 7, 4, 21, 3, 11);
const TS = '20260704_210311';

function photo(overrides: Partial<MediaRecord> = {}): MediaRecord {
  return {
    type: 'photo',
    media_key: '3_100',
    index: 1,
    image_url: 'https://pbs.twimg.com/media/AAA.jpg',
    alt_text: null,
    video_variants: [],
    width: 100,
    height: 100,
    duration_ms: null,
    ...overrides,
  };
}

function record(overrides: Partial<TweetRecord> = {}): TweetRecord {
  return {
    id_str: '123',
    created_at_ms: CREATED,
    lang: 'en',
    user: { id_str: '9', screen_name: 'furyutei', name: 'Furyu' },
    full_text: 'hello',
    urls: [],
    hashtags: [],
    mentions: [],
    in_reply_to_status_id_str: null,
    quoted_status_id_str: null,
    retweeted_status_id_str: null,
    conversation_id_str: '123',
    edit_initial_id_str: '123',
    counts: { replies: 0, retweets: 0, likes: 0, quotes: 0, bookmarks: 0, views: null },
    is_sensitive: false,
    media: [photo()],
    source_op: 'TweetDetail',
    captured_at_ms: Date.UTC(2026, 6, 6),
    ...overrides,
  };
}

describe('buildSaveManifest', () => {
  it('plans media files + a txt sidecar by default, under twMediaDownloader/<screen_name>/', () => {
    const manifest = buildSaveManifest(record({}));
    expect(manifest.media).toHaveLength(1);
    expect(manifest.media[0].basename).toBe(`furyutei-123-${TS}-img1.jpg`);
    expect(manifest.media[0].filename).toBe(`twMediaDownloader/furyutei/furyutei-123-${TS}-img1.jpg`);
    expect(manifest.media[0].plan.urls[0]).toBe(
      'https://pbs.twimg.com/media/AAA?format=jpg&name=orig',
    );
    expect(manifest.sidecars).toHaveLength(1);
    expect(manifest.sidecars[0].format).toBe('txt');
    expect(manifest.sidecars[0].filename).toBe(`twMediaDownloader/furyutei/furyutei-123-${TS}.txt`);
    expect(manifest.skipped).toEqual([]);
  });

  it('lists every saved file (media + sidecar) inside the sidecar text', () => {
    const manifest = buildSaveManifest(record({}), { sidecar: 'json' });
    const parsed = JSON.parse(manifest.sidecars[0].text);
    expect(parsed.saved_files).toEqual([
      `furyutei-123-${TS}-img1.jpg`,
      `furyutei-123-${TS}.json`,
    ]);
    expect(parsed.sidecar_version).toBe(1);
    expect(parsed.record.id_str).toBe('123');
  });

  it('supports both / none sidecar modes', () => {
    const both = buildSaveManifest(record({}), { sidecar: 'both' });
    expect(both.sidecars.map((s: { format: string }) => s.format)).toEqual(['txt', 'json']);
    const none = buildSaveManifest(record({}), { sidecar: 'none' });
    expect(none.sidecars).toEqual([]);
  });

  it('skips undownloadable media but still plans the sidecar', () => {
    const manifest = buildSaveManifest(
      record({
        media: [
          photo(),
          photo({ index: 2, media_key: '3_101', image_url: null }),
        ],
      }),
    );
    expect(manifest.media).toHaveLength(1);
    expect(manifest.skipped).toEqual([
      { media_key: '3_101', index: 2, reason: 'no downloadable URL' },
    ]);
    expect(manifest.sidecars).toHaveLength(1);
  });

  it('names video/gif files with the mp4 variant extension and prefix', () => {
    const manifest = buildSaveManifest(
      record({
        media: [
          photo({
            type: 'video',
            index: 1,
            video_variants: [
              { bitrate: 0, content_type: 'video/mp4', url: 'https://video.twimg.com/v.mp4' },
            ],
          }),
        ],
      }),
    );
    expect(manifest.media[0].basename).toBe(`furyutei-123-${TS}-vid1.mp4`);
    expect(manifest.media[0].plan.urls).toEqual(['https://video.twimg.com/v.mp4']);
  });

  it('exports the port name the worker listens on', () => {
    expect(SAVE_PORT_NAME).toBe('twmd-save');
  });
});
