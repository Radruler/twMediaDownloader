import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TweetRecord } from '../packages/core/src/tweet-record.ts';
import { toArchivistPost } from '@twmd/core';
import { openDb as openClientDb } from '../app/src/db.js';
import { openDb as openArchivistDb } from '../archivist/src/db.js';
import { createIngest } from '../archivist/src/ingest.js';
import { ingestClientDir } from '../archivist/src/snapshot.js';

const CREATED = Date.UTC(2026, 6, 4, 21, 3, 11);

function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

function record(overrides: Partial<TweetRecord> = {}): TweetRecord {
  return {
    id_str: '100',
    created_at_ms: CREATED,
    lang: 'en',
    user: { id_str: '9', screen_name: 'artist', name: 'Artist' },
    full_text: 'hello archivist',
    urls: [],
    hashtags: [],
    mentions: ['friend'],
    in_reply_to_status_id_str: null,
    in_reply_to_user_id_str: null,
    quoted_status_id_str: null,
    retweeted_status_id_str: null,
    conversation_id_str: '100',
    edit_initial_id_str: '100',
    viewer: { liked: true, bookmarked: false },
    counts: { replies: 1, retweets: 2, likes: 3, quotes: 0, bookmarks: 4, views: 5 },
    is_sensitive: false,
    media: [
      {
        type: 'photo',
        media_key: '3_100',
        index: 1,
        image_url: 'https://pbs.twimg.com/media/AAA.jpg',
        alt_text: 'alt',
        video_variants: [],
        width: 100,
        height: 80,
        duration_ms: null,
        tagged_users: [],
      },
    ],
    source_op: 'TweetDetail',
    captured_at_ms: Date.UTC(2026, 6, 5),
    ...overrides,
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'archivist-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('toArchivistPost', () => {
  it('maps TweetRecord versions, media hashes, and viewer relations', () => {
    const envelope = toArchivistPost(
      [record({ id_str: '100', full_text: 'v1', captured_at_ms: 1 }), record({ id_str: '101', full_text: 'v2', captured_at_ms: 2 })],
      [{ media_key: '3_100', sha256: 'abc', path: '/archive/artist/file.jpg' }],
      [{ service_account_id: 'me-twitter', screen_name: 'me' }],
    );
    expect(envelope.post_key).toBe('100');
    expect(envelope.text).toBe('v2');
    expect(envelope.media[0]).toMatchObject({ sha256: 'abc', original_basename: 'file.jpg' });
    expect(envelope.relations).toEqual([
      {
        subject: { service_account_id: 'me-twitter', screen_name: 'me' },
        key: 'like',
        value: null,
        observed_at: 2,
        active: true,
      },
      {
        subject: { service_account_id: 'me-twitter', screen_name: 'me' },
        key: 'bookmark',
        value: null,
        observed_at: 2,
        active: false,
      },
    ]);
  });
});

describe('Archivist ingest core', () => {
  it('opens schema with idempotent seeds', () => {
    const dbPath = path.join(tempDir(), 'library.sqlite3');
    let library = openArchivistDb(dbPath);
    expect(library.stats()).toMatchObject({ services: 2, accounts: 1, posts: 0 });
    library.close();
    library = openArchivistDb(dbPath);
    expect(library.stats()).toMatchObject({ services: 2, accounts: 1, posts: 0 });
    library.close();
  });

  it('ingests an envelope idempotently with verified files and relations', async () => {
    const root = tempDir();
    const library = openArchivistDb(path.join(root, 'library.sqlite3'));
    const ingest = createIngest(library, { archiveRoot: path.join(root, 'archive') } as any);
    const bytes = Buffer.from('image bytes');
    const hash = sha256(bytes);
    const envelope = toArchivistPost(
      record(),
      [{ media_key: '3_100', sha256: hash, path: '/client/artist/original.jpg' }],
      [{ service_account_id: 'owner', screen_name: 'owner' }],
    );

    await ingest.ingestPost(envelope, (async () => ({ bytes })) as any);
    await ingest.ingestPost(envelope, (async () => ({ bytes })) as any);

    expect(library.stats()).toMatchObject({ posts: 1, versions: 1, media: 1, files: 1, relations: 2 });
    const post = library.raw.prepare('SELECT * FROM posts').get();
    expect(post.thread_key).toBe('100');
    expect(library.raw.prepare('SELECT revoked_at FROM relations WHERE revoked_at IS NOT NULL').get()).toBeTruthy();
    library.close();
  });

  it('snapshot-ingests archived rows from a client data dir', async () => {
    const clientDir = tempDir();
    const archiveDir = path.join(clientDir, 'archive', 'artist');
    mkdirSync(archiveDir, { recursive: true });
    const bytes = Buffer.from('snapshot bytes');
    const hash = sha256(bytes);
    const mediaPath = path.join(archiveDir, 'artist-100-img1.jpg');
    writeFileSync(mediaPath, bytes);

    const client = openClientDb(path.join(clientDir, 'library.sqlite3'));
    client.ingestSeen(record());
    client.recordFile({ media_key: '3_100', path: mediaPath, bytes: bytes.length, sha256: hash });
    client.setPostState('100', 'archived');
    client.close();

    const root = tempDir();
    const library = openArchivistDb(path.join(root, 'library.sqlite3'));
    const ingest = createIngest(library, { archiveRoot: path.join(root, 'archive') } as any);
    const result = await ingestClientDir(ingest, clientDir);

    expect(result).toMatchObject({ updated: 1, errors: 0 });
    expect(library.stats()).toMatchObject({ posts: 1, files: 1 });
    library.close();
  });
});
