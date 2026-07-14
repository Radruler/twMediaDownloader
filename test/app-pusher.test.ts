import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TweetRecord } from '../packages/core/src/tweet-record.ts';
import { openDb as openClientDb } from '../app/src/db.js';
import { createArchivistPusher } from '../app/src/pusher.js';
import { openDb as openArchivistDb } from '../archivist/src/db.js';
import { createArchivistServer } from '../archivist/src/server.js';

function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

function record(): TweetRecord {
  return {
    id_str: 'push-1',
    created_at_ms: Date.UTC(2026, 6, 4, 21, 3, 11),
    lang: 'en',
    user: { id_str: '9', screen_name: 'push_artist', name: 'Push Artist' },
    full_text: 'push me',
    urls: [],
    hashtags: [],
    mentions: [],
    in_reply_to_status_id_str: null,
    in_reply_to_user_id_str: null,
    quoted_status_id_str: null,
    retweeted_status_id_str: null,
    conversation_id_str: 'push-1',
    edit_initial_id_str: 'push-1',
    viewer: { liked: true, bookmarked: null },
    counts: { replies: 0, retweets: 0, likes: 1, quotes: 0, bookmarks: 0, views: null },
    is_sensitive: false,
    media: [
      {
        type: 'photo',
        media_key: '3_push',
        index: 1,
        image_url: 'https://pbs.twimg.com/media/PUSH.jpg',
        alt_text: null,
        video_variants: [],
        width: 10,
        height: 10,
        duration_ms: null,
        tagged_users: [],
      },
    ],
    source_op: 'TweetDetail',
    captured_at_ms: Date.now(),
  };
}

const tempDirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'app-pusher-'));
  tempDirs.push(dir);
  return dir;
}

describe('Archivist Client pusher', () => {
  it('pushes dirty archived posts through the real Archivist ingest API and acks them', async () => {
    const clientDir = tempDir();
    const archivistDir = tempDir();
    const bytes = Buffer.from('push image');
    const hash = sha256(bytes);
    const mediaPath = path.join(clientDir, 'archive', 'push_artist', 'push.jpg');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(mediaPath), { recursive: true }));
    writeFileSync(mediaPath, bytes);

    const client = openClientDb(path.join(clientDir, 'library.sqlite3'));
    client.ingestSeen(record());
    client.recordFile({ media_key: '3_push', path: mediaPath, bytes: bytes.length, sha256: hash });
    client.setPostState('push-1', 'archived');
    expect(client.exportStats()).toMatchObject({ dirty: 1, acked: 0 });

    const archivist = openArchivistDb(path.join(archivistDir, 'library.sqlite3'));
    const server = createArchivistServer({
      library: archivist,
      config: {
        api_token: 'secret',
        archive_root: path.join(archivistDir, 'archive'),
        bind_host: '127.0.0.1',
        port: 0,
      },
      host: '127.0.0.1',
      port: 0,
    } as any);
    await server.ready;
    cleanups.push(async () => {
      await server.close();
      archivist.close();
      client.close();
    });

    const pusher = createArchivistPusher({
      db: client,
      config: {
        archivist_url: `http://127.0.0.1:${server.port}`,
        archivist_token: 'secret',
        own_accounts: [{ service_account_id: 'owner', screen_name: 'owner' }],
      },
      autoStart: false,
    });
    await expect(pusher.sweep()).resolves.toEqual({ pushed: 1, skipped: 0 });
    expect(client.exportStats()).toMatchObject({ dirty: 0, acked: 1 });
    expect(archivist.stats()).toMatchObject({ posts: 1, files: 1, relations: 1 });
  });
});
