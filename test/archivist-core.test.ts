import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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

    expect(result).toMatchObject({ new: 1, updated: 0, errors: 0 });
    expect(library.stats()).toMatchObject({ posts: 1, files: 1 });
    expect(library.raw.prepare('SELECT COUNT(*) AS n FROM ingest_runs').get().n).toBe(1);
    library.close();
  });

  it('snapshot reads own_accounts from the client config and ingests relations', async () => {
    const clientDir = tempDir();
    writeFileSync(
      path.join(clientDir, 'config.json'),
      JSON.stringify({ own_accounts: [{ service_account_id: 'me-1', screen_name: 'me' }] }),
    );
    const client = openClientDb(path.join(clientDir, 'library.sqlite3'));
    client.ingestSeen(record({ media: [] }));
    client.setPostState('100', 'archived');
    client.close();

    const root = tempDir();
    const library = openArchivistDb(path.join(root, 'library.sqlite3'));
    const ingest = createIngest(library, { archiveRoot: path.join(root, 'archive') } as any);
    const result = await ingestClientDir(ingest, clientDir);
    expect(result).toMatchObject({ new: 1, errors: 0 });
    // record() has viewer { liked: true, bookmarked: false } → 2 relations
    expect(library.stats()).toMatchObject({ relations: 2 });
    library.close();
  });
});

describe('Archivist ingest regressions', () => {
  function envelopeFor(overrides: Record<string, unknown> = {}) {
    return {
      v: 1,
      service: 'twitter',
      post_key: 'A',
      author: { service_account_id: '9', screen_name: 'artist', display_name: 'Artist', status: 'unknown' },
      created_at_ms: 1,
      text: 'hi',
      lang: 'en',
      url: null,
      is_sensitive: false,
      deleted: false,
      counts: {},
      reply_to: { key: null, author_service_account_id: null },
      quoted_key: null,
      versions: [{ service_version_id: 'A', captured_at_ms: 1, raw: {} }],
      media: [
        {
          position: 1,
          type: 'photo',
          sha256: null,
          source_url: null,
          alt_text: null,
          width: 1,
          height: 1,
          duration_ms: null,
          original_basename: null,
        },
      ],
      relations: [],
      ...overrides,
    };
  }

  function openIngest() {
    const root = tempDir();
    const library = openArchivistDb(path.join(root, 'library.sqlite3'));
    const ingest = createIngest(library, { archiveRoot: path.join(root, 'archive') } as any);
    return { root, library, ingest, db: library.raw };
  }

  it('re-ingest keeps media ids stable so media-level curation survives', async () => {
    const { library, ingest, db } = openIngest();
    await ingest.ingestPost(envelopeFor({ post_key: 'A', versions: [{ service_version_id: 'A', captured_at_ms: 1, raw: {} }] }));
    await ingest.ingestPost(envelopeFor({ post_key: 'B', versions: [{ service_version_id: 'B', captured_at_ms: 1, raw: {} }] }));
    const mediaA = db
      .prepare("SELECT m.id FROM media_items m JOIN posts p ON p.id = m.post_id WHERE p.service_post_key = 'A'")
      .get();
    db.prepare("INSERT INTO tags (name) VALUES ('cool')").run();
    db.prepare("INSERT INTO tag_items (tag_id, item_kind, item_id, tagged_at) VALUES (1, 'media', ?, 1)").run(mediaA.id);

    await ingest.ingestPost(envelopeFor({ post_key: 'A', versions: [{ service_version_id: 'A', captured_at_ms: 1, raw: {} }] }));

    const mediaA2 = db
      .prepare("SELECT m.id FROM media_items m JOIN posts p ON p.id = m.post_id WHERE p.service_post_key = 'A'")
      .get();
    expect(mediaA2.id).toBe(mediaA.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tag_items WHERE item_kind = 'media' AND item_id = ?").get(mediaA.id).n).toBe(1);
    library.close();
  });

  it("refuses envelopes for the reserved 'archivist' service (Decision 8)", async () => {
    const { library, ingest, db } = openIngest();
    const evil = envelopeFor({
      service: 'archivist',
      post_key: 'evil',
      versions: [{ service_version_id: 'evil', captured_at_ms: 1, raw: {} }],
      media: [],
      relations: [{ subject: { service_account_id: 'me', screen_name: 'me' }, key: 'rating', value: '5', observed_at: 1, active: true }],
    });
    await expect(ingest.ingestPost(evil)).rejects.toThrow(/reserved 'archivist'/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relations').get().n).toBe(0);
    library.close();
  });

  it('rejects invalid envelopes before storing any file bytes', async () => {
    const { library, ingest, db } = openIngest();
    const bytes = Buffer.from('orphan bytes');
    const bad = envelopeFor({
      post_key: '', // invalid
      media: [
        {
          position: 1,
          type: 'photo',
          sha256: sha256(bytes),
          source_url: null,
          alt_text: null,
          width: 1,
          height: 1,
          duration_ms: null,
          original_basename: 'x.jpg',
        },
      ],
    });
    await expect(ingest.ingestPost(bad, (async () => ({ bytes })) as any)).rejects.toThrow(/post_key/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM files').get().n).toBe(0);
    library.close();
  });

  it('same basename with different content gets a sha suffix instead of overwriting', async () => {
    const { root, library, ingest, db } = openIngest();
    const bytes1 = Buffer.from('first bytes');
    const bytes2 = Buffer.from('second, different bytes');
    const mediaFor = (bytes: Buffer) => [
      {
        position: 1,
        type: 'photo',
        sha256: sha256(bytes),
        source_url: null,
        alt_text: null,
        width: 1,
        height: 1,
        duration_ms: null,
        original_basename: 'same-name.jpg',
      },
    ];
    await ingest.ingestPost(
      envelopeFor({ post_key: 'A', versions: [{ service_version_id: 'A', captured_at_ms: 1, raw: {} }], media: mediaFor(bytes1) }),
      (async () => ({ bytes: bytes1 })) as any,
    );
    await ingest.ingestPost(
      envelopeFor({ post_key: 'B', versions: [{ service_version_id: 'B', captured_at_ms: 1, raw: {} }], media: mediaFor(bytes2) }),
      (async () => ({ bytes: bytes2 })) as any,
    );
    const rows = db.prepare('SELECT sha256, relpath FROM files ORDER BY ingested_at, relpath').all();
    expect(rows).toHaveLength(2);
    expect(rows[0].relpath).not.toBe(rows[1].relpath);
    for (const row of rows) {
      expect(existsSync(path.join(root, 'archive', row.relpath))).toBe(true);
    }
    library.close();
  });

  it('toArchivistPost: unknown author status; ambiguous own accounts emit no relations', () => {
    const single = toArchivistPost(record(), [], [{ service_account_id: 'me-1', screen_name: 'me' }]);
    expect(single.author.status).toBe('unknown');
    expect(single.relations).toHaveLength(2);
    const ambiguous = toArchivistPost(record(), [], [
      { service_account_id: 'me-1', screen_name: 'me' },
      { service_account_id: 'me-2', screen_name: 'alt' },
    ]);
    expect(ambiguous.relations).toEqual([]);
  });
});
