/**
 * App ingest (plan 06 §3) tested against the SAME normalized fixtures the
 * extension uses — the `expected/` outputs ARE TweetRecords.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TweetRecord } from '../packages/core/src/tweet-record.ts';
import { openDb, postKeyFor } from '../app/src/db.js';

const EXPECTED_DIR = path.join(__dirname, 'fixtures/graphql/expected');

function loadExpected(name: string): { tweets: TweetRecord[]; tombstones: unknown[] } {
  return JSON.parse(readFileSync(path.join(EXPECTED_DIR, name), 'utf8'));
}

function record(overrides: Partial<TweetRecord> = {}): TweetRecord {
  return {
    id_str: '100',
    created_at_ms: 1751630591000,
    lang: 'en',
    user: { id_str: '9', screen_name: 'someone', name: 'Some One' },
    full_text: 'hello world',
    urls: [],
    hashtags: [],
    mentions: [],
    in_reply_to_status_id_str: null,
    quoted_status_id_str: null,
    retweeted_status_id_str: null,
    conversation_id_str: '100',
    edit_initial_id_str: '100',
    counts: { replies: 1, retweets: 2, likes: 3, quotes: 0, bookmarks: 0, views: 42 },
    is_sensitive: false,
    media: [],
    source_op: 'TweetDetail',
    captured_at_ms: 1751800000000,
    ...overrides,
  };
}

let db: ReturnType<typeof openDb>;
afterEach(() => db?.close());

describe('seen ingest', () => {
  it('ingests every expected fixture without error and lands one post per edit-group', () => {
    db = openDb();
    const postKeys = new Set<string>();
    let total = 0;
    for (const file of readdirSync(EXPECTED_DIR)) {
      const { tweets } = loadExpected(file);
      for (const tweet of tweets) {
        db.ingestSeen(tweet);
        postKeys.add(postKeyFor(tweet));
        total += 1;
      }
    }
    expect(total).toBeGreaterThan(50); // sanity: fixtures are non-trivial
    expect(db.stats().posts).toBe(postKeys.size);
    expect(db.stats().versions).toBeGreaterThanOrEqual(postKeys.size);
  });

  it('re-seeing refreshes counts and last_seen_at without duplicating rows', () => {
    db = openDb();
    db.ingestSeen(record({}), 1000);
    db.ingestSeen(
      record({ counts: { replies: 9, retweets: 9, likes: 9, quotes: 9, bookmarks: 9, views: 9 } }),
      2000,
    );
    expect(db.stats().posts).toBe(1);
    expect(db.stats().versions).toBe(1);
    const post = db.getPost('100');
    expect(post.first_seen_at).toBe(1000);
    expect(post.last_seen_at).toBe(2000);
    const version = db.getVersions('100')[0];
    expect(JSON.parse(version.counts_json).likes).toBe(9);
  });

  it('groups edits: a new tweet id in an existing edit-group adds a versions row', () => {
    db = openDb();
    db.ingestSeen(record({ id_str: '100', edit_initial_id_str: '100', full_text: 'v1' }));
    db.ingestSeen(record({ id_str: '105', edit_initial_id_str: '100', full_text: 'v2 edited' }));
    expect(db.stats().posts).toBe(1);
    const versions = db.getVersions('100');
    expect(versions.map((v: { id_str: string }) => v.id_str)).toEqual(['100', '105']);
    expect(versions[1].full_text).toBe('v2 edited');
  });

  it('stores media rows with a synthetic key when media_key is null', () => {
    db = openDb();
    db.ingestSeen(
      record({
        media: [
          {
            type: 'photo',
            media_key: null,
            index: 1,
            image_url: 'https://pbs.twimg.com/media/AAA.jpg',
            alt_text: 'alt!',
            video_variants: [],
            width: 10,
            height: 10,
            duration_ms: null,
          },
        ],
      }),
    );
    const media = db.getMedia('100');
    expect(media).toHaveLength(1);
    expect(media[0].media_key).toBe('100:1');
    expect(media[0].orig_url).toBe('https://pbs.twimg.com/media/AAA.jpg');
  });

  it('full-text search finds posts by text, alt text, and author', () => {
    db = openDb();
    db.ingestSeen(record({ id_str: '1', edit_initial_id_str: null, full_text: 'the quick brown fox' }));
    db.ingestSeen(
      record({
        id_str: '2',
        edit_initial_id_str: null,
        full_text: 'nothing here',
        media: [
          {
            type: 'photo',
            media_key: '3_2',
            index: 1,
            image_url: 'https://pbs.twimg.com/media/BBB.jpg',
            alt_text: 'a sleeping capybara',
            video_variants: [],
            width: 1,
            height: 1,
            duration_ms: null,
          },
        ],
      }),
    );
    expect(db.searchPosts('fox').map((p: { post_key: string }) => p.post_key)).toEqual(['1']);
    expect(db.searchPosts('capybara').map((p: { post_key: string }) => p.post_key)).toEqual(['2']);
    expect(db.searchPosts('someone').length).toBe(2);
  });
});

describe('archive requests and state', () => {
  it('archive request moves seen → queued but never downgrades archived', () => {
    db = openDb();
    db.ingestSeen(record({}));
    expect(db.getPost('100').state).toBe('seen');
    db.ingestArchiveRequest(record({}));
    expect(db.getPost('100').state).toBe('queued');
    db.setPostState('100', 'archived');
    db.ingestArchiveRequest(record({}));
    expect(db.getPost('100').state).toBe('archived');
  });

  it('archive_failed can be re-queued', () => {
    db = openDb();
    db.ingestArchiveRequest(record({}));
    db.setPostState('100', 'archive_failed');
    db.ingestArchiveRequest(record({}));
    expect(db.getPost('100').state).toBe('queued');
  });
});

describe('passive deletion (Decision 18)', () => {
  it('tombstone for a known version flags the whole edit-group', () => {
    db = openDb();
    db.ingestSeen(record({ id_str: '105', edit_initial_id_str: '100' }));
    expect(db.markDeleted('105', 5000)).toBe(true);
    const post = db.getPost('100');
    expect(post.deleted).toBe(1);
    expect(post.deleted_detected_at).toBe(5000);
  });

  it('tombstone for an unknown id is a no-op (no phantom rows)', () => {
    db = openDb();
    expect(db.markDeleted('999')).toBe(false);
    expect(db.stats().posts).toBe(0);
  });

  it('does not overwrite an earlier detection time', () => {
    db = openDb();
    db.ingestSeen(record({}));
    db.markDeleted('100', 5000);
    db.markDeleted('100', 9000);
    expect(db.getPost('100').deleted_detected_at).toBe(5000);
  });
});

describe('files / dedupe support', () => {
  it('records files and finds them by sha256', () => {
    db = openDb();
    db.ingestSeen(
      record({
        media: [
          {
            type: 'photo',
            media_key: '3_100',
            index: 1,
            image_url: 'https://pbs.twimg.com/media/AAA.jpg',
            alt_text: null,
            video_variants: [],
            width: 1,
            height: 1,
            duration_ms: null,
          },
        ],
      }),
    );
    db.recordFile({
      media_key: '3_100',
      path: '/archive/someone/x-img1.jpg',
      bytes: 123,
      sha256: 'abc',
      downloaded_at: 1,
    });
    expect(db.findFileBySha('abc')?.path).toBe('/archive/someone/x-img1.jpg');
    expect(db.findFileBySha('zzz')).toBeNull();
    // UNIQUE(sha256): same content is never recorded twice
    expect(() =>
      db.recordFile({ media_key: '3_100', path: '/other', bytes: 123, sha256: 'abc' }),
    ).toThrow();
  });
});
